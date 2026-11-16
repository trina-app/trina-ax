// A person shares a FOLDER in their own files with teammates or groups, view only (docs/decisions/
// 20261116-folder-share-server.md; the design: docs/AGENTS/plan/20261116-1147-folder-sharing.md; migration 360).
//
// The share is a row of file_shares with kind 'folder' (the same table as a shared file: the link id, the people on it,
// requests, notices, the trash and the account cleanup all work by the row's path already). The folder itself is
// shared: whatever is in it now or is added later opens for the people on the row, while its owner still has it.
// Nothing here changes the folder rules: users/<id>/ carries none, so by PATH another person's folder stays closed to
// everyone, admins included. A shared folder opens only by its LINK ID, for the people on it:
//
//   GET /api/files/shared/:id                 the folder's name and who shared it (files/shares.ts page)
//   GET /api/files/shared/:id/list?sub=       one level of names, sizes and modified times
//   GET /api/files/shared/:id/entry?sub=      one file's name, size and type
//   GET /api/files/shared/:id/download?sub=   the file's current bytes, from the one checked descriptor
//
// What a receiver ever gets: names inside the folder, sizes, modified times and current bytes. Never an absolute path,
// a team path, the names of folders above the shared folder, versions, history, extracted text, search or the owner's
// other folders.
//
// - Where: only users/<owner>/<name>/… and never a place the server keeps (share-places.ts neverShared), checked when
//   sharing and again on every open.
// - Which folder: its identity on disk, saveFolderId ('<dev>:<ino>:<birth time in ns>'). A disk that keeps no birth
//   times cannot tell a folder from one made again under its name, so there a folder is not shared at all. When the
//   folder at the path is no longer the one shared, the share is PAUSED: nobody opens it, the people on it are kept, the
//   owner is told and resumes it. Nothing is deleted (a file proves itself by its content hash; a folder cannot, and a
//   backup restore would otherwise end every folder share in the team for good).
// - Nested shares add up: a person passes when a live, unpaused folder row at or above the path reaches them.
// - Children resolve as the OWNER, by the link id and a path inside the folder, through authorize() like every file
//   access, plus three things authorize does not do: the path's syntax is checked before it touches the disk
//   (childSegs), the result must still be inside the shared folder, and receiverSees() must accept it.
// - Stopping is always the owner's: taking people off and Stop never ask the team switch.
// - The gate: until config.folderShares is true nobody can share a folder (PUT answers 400 folder_shares_soon; the
//   dialog's read and the link answer is_folder as before this work).
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import type { AppContext } from '../context'
import { audit } from '../admin/audit'
import { alwaysOn, teamAllowsAlways } from '../chat/always-allow'
import { saveFolderId } from './folder-id'
import { folderSharesOpen } from './folder-share-gate'
import { HttpError } from '../http/errors'
import type { Principal, RuleSet } from '../policy/access'
import { authorize, type Authorized } from '../policy/authorize'
import { foldKey } from '../policy/names'
import { checkRegular } from '../team-files/place'
import { mimeOf } from '../team-files/service'
import { notificationsOf } from '../notifications/service'
import {
  FILE_SHARE_MAX, FOLDER_HOLDS_MAX, FOLDER_LIST_PAGE, FOLDER_LIST_SCAN, FOLDER_OPENS_PER_MIN, FOLDER_SHARES_PER_OWNER, fileLinkUrl, plainLabel,
  type FileLink, type FileShareRow, type FileShares as FileSharesView, type FolderShareBlock, type Locale, type SharedFolderEntry, type SharedFolderItem, type SharedFolderList,
} from '@mycel/shared/api'
import { COLS, fileSharesOf, markDead, msg, newLinkId, REACHES, sharesTouched, type ShareRow, type Subject, type Via } from './shares'
import { childSegs, hiddenName, neverShared, personalProjectFolders, receiverSees, sharePlaceBlock, withinPathLimits } from './share-places'
import { saveUndo } from './share-undo'

const now = () => new Date().toISOString()
const segsOf = (p: string) => (p ? p.split('/') : [])
const baseName = (p: string) => p.split('/').pop() ?? p
/** `users/<owner>/…`: the owner a personal path names */
const ownerIn = (segs: readonly string[]): string | null => (segs[0] === 'users' && segs.length >= 3 ? segs[1]! : null)
/** the folders at or above `segs` that can carry a share (depth 3 or deeper), nearest first */
const sharePaths = (segs: readonly string[], self = true): string[] => {
  const out: string[] = []
  for (let n = self ? segs.length : segs.length - 1; n >= 3; n--) out.push(segs.slice(0, n).join('/'))
  return out
}
const WITH_PEOPLE = 'EXISTS(SELECT 1 FROM file_share_grants g WHERE g.share_id = s.id)'

// ---------------- the row's life with the folder (inside other areas' steps: no ctx, only the database) ----------------

/** who tells an owner that the server paused or ended their share: set by the service of that database */
const tellers = new WeakMap<Database, (owner: string, auditId: number) => void>()
const tellOwner = (db: Database, owner: string | null, auditId: number) => { if (owner) tellers.get(db)?.(owner, auditId) }

/** The share is paused: the folder at its path is not the one shared (`identity`), or a new folder was made there
 * (`new_folder`). No access from now on; the people on it stay; its owner is told once. */
export function pauseFolderShare(db: Database, row: Pick<ShareRow, 'id' | 'owner_id'>, reason: 'identity' | 'new_folder'): void {
  if (!db.query("UPDATE file_shares SET paused_at = ? WHERE id = ? AND kind = 'folder' AND paused_at IS NULL").run(now(), row.id).changes) return
  const id = audit(db, { actor: null, action: 'folder_share.paused', target: `file-share:${row.id}`, detail: { personal: true, reason } })
  tellOwner(db, row.owner_id, id)
  sharesTouched(db)
}

/** Inside a move's step, or a trash restore's (files/shares.ts sharesMoved, sharesRestored): the folder rows now at or
 * under `to`. One that is no longer inside its owner's own files (`left_personal`), or is at or under a place that is
 * never shared (`project`, `moved_excluded`), ends: its link answers no access, its people and waiting requests go,
 * the owner is told. It is the owner's own move (nobody else can move it). */
export function folderRowsLanded(db: Database, to: string): void {
  const rows = db.query(`SELECT id, path, owner_id FROM file_shares WHERE kind = 'folder' AND state = 'live' AND (path = ? OR substr(path, 1, length(?) + 1) = ? || '/')`).all(to, to, to) as Pick<ShareRow, 'id' | 'path' | 'owner_id'>[]
  for (const r of rows) {
    const segs = segsOf(r.path)
    const block = ownerIn(segs) !== r.owner_id || !r.owner_id ? 'left' : sharePlaceBlock(db, segs)
    if (!block) continue
    const removed = (db.query('SELECT COUNT(*) n FROM file_share_grants WHERE share_id = ?').get(r.id) as { n: number }).n
    markDead(db, r.id)
    const id = audit(db, { actor: r.owner_id, action: 'folder_share.ended', target: `file-share:${r.id}`, detail: { personal: true, removed, reason: block === 'left' || block === 'team_folder' || block === 'root' ? 'left_personal' : block === 'project' ? 'project' : 'moved_excluded' } })
    if (removed) tellOwner(db, r.owner_id, id)
  }
}

/** A folder was made in the app at `rel` (a file event: create, folder, not a move). A live folder row at that path
 * belonged to a folder that is gone: the new one is never served on the old share without its owner's Resume. */
export function folderMadeAt(db: Database, rel: string): void {
  const row = db.query("SELECT id, owner_id FROM file_shares WHERE kind = 'folder' AND state = 'live' AND paused_at IS NULL AND path = ?").get(rel) as Pick<ShareRow, 'id' | 'owner_id'> | null
  if (row) pauseFolderShare(db, row, 'new_folder')
}

// ---------------- the service ----------------

const instances = new WeakMap<AppContext, FolderShares>()
export function folderSharesOf(ctx: AppContext): FolderShares {
  let s = instances.get(ctx)
  if (!s) { s = new FolderShares(ctx); instances.set(ctx, s) }
  return s
}

export type ChildOpen =
  /** `via`: the row whose grant lets the caller in (this row, or a shared folder above it); `st`: the child's lstat,
   * taken after every check (the descriptor a download opens must be this very file) */
  | { kind: 'open'; row: ShareRow; by: 'owner' | 'grant'; via: string; root: Authorized; child: Authorized; st: fs.Stats; name: string; crumbs: string[] }
  | { kind: 'no_access' }
  | { kind: 'unknown' }

type Pin = 'same' | 'missing' | 'differs'

export class FolderShares {
  constructor(readonly ctx: AppContext) {
    // (after the step that paused or ended a share has returned: the notice is not part of its transaction)
    tellers.set(ctx.db, (owner, auditId) => queueMicrotask(() => {
      try { notificationsOf(this.ctx).fileShareNotice(owner, 'file.unshared_by_move', String(auditId), true) } catch (err) { this.ctx.log.warn('folder share notice failed', { err }) }
    }))
  }
  private get db() { return this.ctx.db }
  private get fx() { return this.ctx.files.fx }
  private get shares() { return fileSharesOf(this.ctx) }
  /** the rollout gate (app-config.ts folderShares): off on every server until the web part opens it */
  gateOn(): boolean { return folderSharesOpen(this.ctx.config) }

  /** Does a call about the folder at `segs` come here? With the gate closed nothing does but a change on the caller's
   * own files (answered `folder_shares_soon`): the dialog's read and the link answer is_folder, as before this work.
   * A team folder's read comes here once the gate is open (`blocked: team_folder`); its change and link never do. */
  takes(_me: Principal, segs: readonly string[], what: 'view' | 'change' | 'link'): boolean {
    if (what === 'view') return this.gateOn()
    if (segs[0] !== 'users') return false
    return what === 'change' || this.gateOn()
  }

  // ---------------- which folder ----------------

  /** Is the folder at `segs` (actual names) still the one `row` was made for? Compared by inode and birth time; the
   * device number alone may differ (a remount or a move to another host renumbers every folder at once and changes
   * neither): the row then takes the new id. `missing`: nothing is at the path (no access, not a pause). */
  private pin(row: Pick<ShareRow, 'id' | 'folder_id'>, segs: readonly string[]): Pin {
    try { fs.lstatSync(path.join(this.fx.root, ...segs)) } catch (e: any) { return e?.code === 'ENOENT' || e?.code === 'ENOTDIR' ? 'missing' : 'differs' }
    const cur = saveFolderId(this.fx, segs)
    if (!cur || !row.folder_id) return 'differs'
    if (cur === row.folder_id) return 'same'
    const [d1, i1, b1] = row.folder_id.split(':'), [d2, i2, b2] = cur.split(':')
    if (i1 !== i2 || b1 !== b2 || d1 === d2) return 'differs'
    this.db.query('UPDATE file_shares SET folder_id = ?, dev = ? WHERE id = ?').run(cur, Number(d2), row.id)
    return 'same'
  }
  private liveAt(rel: string): ShareRow | null {
    const s = this.shares.liveAt(rel)
    return s?.kind === 'folder' ? s : null
  }

  // ---------------- who may share ----------------

  /** The caller's own folder at `rel0`, resolved for a change: a real directory (never a link) inside their own files
   * that they may write. Anything else is refused as a path they may not share. */
  private mine(me: Principal, rel0: string, L: Locale): Authorized {
    const r = authorize(this.fx, this.shares.rules(), me, rel0, 'write')
    if (!r.st?.isDirectory() || r.segs[0] !== 'users') throw new HttpError('validation', msg('folder', L), { params: { reason: 'is_folder' } })
    if (r.segs[1] !== me.id) throw new HttpError('forbidden', msg('notOwner', L), { params: { reason: 'file_share_not_owner' } })
    return r
  }
  private refusePlace(block: FolderShareBlock, L: Locale): never {
    throw new HttpError('validation', msg(block === 'disk' ? 'folderDisk' : 'folderPlace', L), { params: { reason: block === 'disk' ? 'folder_share_disk' : 'folder_share_place', block } })
  }
  /** Why the folder cannot be shared: where it is, or the disk (no birth times). */
  private blockOf(segs: readonly string[]): FolderShareBlock | null {
    return sharePlaceBlock(this.db, segs) ?? (saveFolderId(this.fx, segs) === null ? 'disk' : null)
  }
  /** Is the live folder row `s` still `me`'s to change (the undo, files/share-undo.ts)? */
  ownedBy(me: Principal, s: ShareRow): boolean {
    if (s.kind !== 'folder' || s.owner_id !== me.id || me.role === 'guest') return false
    const segs = segsOf(s.path)
    if (ownerIn(segs) !== me.id || neverShared(this.db, segs)) return false
    try { return !!authorize(this.fx, this.shares.rules(), me, s.path, 'write').st?.isDirectory() } catch { return false }
  }
  /** May a request to open `s` reach its owner (a folder that could still be shared)? */
  askable(s: ShareRow): boolean {
    const segs = segsOf(s.path)
    return s.kind === 'folder' && !!s.owner_id && ownerIn(segs) === s.owner_id && !neverShared(this.db, segs)
  }
  /** Shared with me lists the folder row `s` (a grant reaches the caller: the SQL said so) while it would open: its
   * owner's account active, not paused, a place that may be shared, a folder on disk. The identity waits for the click. */
  listable(s: ShareRow, memo?: Map<string, Principal | null>): boolean {
    if (s.kind !== 'folder' || s.state !== 'live' || s.paused_at || !s.owner_id) return false
    const segs = segsOf(s.path)
    const o = this.shares.principal(s.owner_id, memo)
    if (!o || o.role === 'guest' || ownerIn(segs) !== s.owner_id || neverShared(this.db, segs)) return false
    try { return fs.lstatSync(path.join(this.fx.root, ...segs)).isDirectory() } catch { return false }
  }

  /** The folder's link (POST /api/files/link): its owner only, only a folder that can be shared. Makes the row with
   * nobody on it. */
  linkFor(me: Principal, rel0: string, L: Locale): FileLink {
    const r = this.mine(me, rel0, L)
    const block = this.blockOf(r.segs)
    if (block) this.refusePlace(block, L)
    const s = this.ensure(me, r)
    return { id: s.id, url: fileLinkUrl(s.id) }
  }
  /** The live folder row of the caller's folder, made on first use. A row whose folder is no longer the one it was made
   * for is paused here and stays the path's row (the owner resumes it; nothing is made beside it). */
  private ensure(me: Principal, r: Authorized): ShareRow {
    const at = this.shares.liveAt(r.rel)
    if (at?.kind === 'folder') {
      if (!at.paused_at && this.pin(at, r.segs) === 'differs') pauseFolderShare(this.db, at, 'identity')
      return this.shares.row(at.id)!
    }
    // (a file's row left at a path where a folder is now: not this folder's)
    if (at) markDead(this.db, at.id)
    const id = newLinkId()
    const st = r.st!
    this.db.query('INSERT INTO file_shares (id, path, ino, dev, owner_id, state, created_by, created_at, kind, folder_id) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, r.rel, st.ino, st.dev, me.id, 'live', me.id, now(), 'folder', saveFolderId(this.fx, r.segs))
    return this.shares.row(id)!
  }

  /** The people (ids) a live, unpaused folder row at or above `segs` lets in now. */
  private reached(segs: readonly string[]): Set<string> {
    const out = new Set<string>()
    const paths = sharePaths(segs)
    if (!paths.length) return out
    const rows = this.db.query(`SELECT id FROM file_shares s WHERE s.kind = 'folder' AND s.state = 'live' AND s.paused_at IS NULL AND s.path IN (${paths.map(() => '?').join(',')})`).all(...paths) as { id: string }[]
    for (const r of rows) for (const u of this.shares.grantees(r.id)) out.add(u)
    return out
  }

  /**
   * Add and remove people and groups on the caller's own folder, stop sharing it, or resume a paused share (PUT
   * /api/files/shares; the AI tool later). Every check runs on every call:
   *   everyone: an active member, not a guest; the folder is users/<caller>/…, a real directory they may write;
   *   add:      the gate; the place may be shared; the disk keeps birth times; the team switch is on; the share is not
   *             paused; one send token before the people are checked; the people as for a file; at most 50 on it and
   *             100 shared folders per owner;
   *   remove, stop: nothing more (an owner can always stop, also with the team switch off, also when paused);
   *   resume:   the place and the disk; the row takes the folder that is there now.
   */
  change(me: Principal, rel0: string, add: readonly Subject[], remove0: readonly Subject[], L: Locale, via: Via = 'dialog', o: { quiet?: boolean; tokenTaken?: boolean; stop?: boolean; resume?: boolean; stepId?: string | null } = {}): { view: FileSharesView; added: string[] } {
    if (!this.gateOn()) throw new HttpError('validation', msg('folderSoon', L), { params: { reason: 'folder_shares_soon' } })
    const r = this.mine(me, rel0, L)
    const place = sharePlaceBlock(this.db, r.segs)
    const view = (undo?: { id: string; until: string } | null) => ({ view: { ...this.view(me, this.shares.rules(), r, L), ...(undo ? { undo } : {}) }, added: [] as string[] })

    if (o.resume) {
      const block = place ?? (saveFolderId(this.fx, r.segs) === null ? 'disk' : null)
      if (block) this.refusePlace(block, L)
      const s = this.liveAt(r.rel)
      if (!s) throw new HttpError('not_found')
      if (s.paused_at) {
        const st = fs.lstatSync(r.abs)
        this.db.query('UPDATE file_shares SET folder_id = ?, ino = ?, dev = ?, paused_at = NULL WHERE id = ?').run(saveFolderId(this.fx, r.segs), st.ino, st.dev, s.id)
        audit(this.db, { actor: me.id, action: 'folder_share.resumed', target: `file-share:${s.id}`, detail: { personal: true } })
        this.shares.changedSoon()
      }
      return view()
    }

    if (!add.length) {
      // taking people off, or stopping: the owner's, whatever the switch, the place or the disk say
      const s = this.liveAt(r.rel)
      if (!s) return view()
      const held = this.db.query('SELECT subject_type, subject_id FROM file_share_grants WHERE share_id = ?').all(s.id) as { subject_type: 'user' | 'group'; subject_id: string }[]
      const have = new Set(held.map((g) => `${g.subject_type}:${g.subject_id}`))
      const gone: Subject[] = o.stop ? held.map((g) => ({ subjectType: g.subject_type, subjectId: g.subject_id })) : remove0.filter((x) => have.has(`${x.subjectType}:${x.subjectId}`))
      if (!gone.length) return view()
      let undo: { id: string; until: string } | null = null
      this.db.transaction(() => {
        undo = saveUndo(this.db, me.id, s.id, gone, o.stepId ?? null)
        for (const x of gone) this.db.query('DELETE FROM file_share_grants WHERE share_id = ? AND subject_type = ? AND subject_id = ?').run(s.id, x.subjectType, x.subjectId)
      })()
      const all = gone.length === held.length
      audit(this.db, { actor: me.id, action: o.stop || all ? 'folder_share.stop' : 'folder_share.remove', target: `file-share:${s.id}`, detail: { personal: true, removed: gone.length, ...(o.stop || all ? { keptOwn: this.ownShares(r.rel)?.files ?? 0, keptOwnFolders: this.ownShares(r.rel)?.folders ?? 0 } : {}), via } })
      this.shares.changedSoon()
      return view(undo)
    }

    // ---- an add ----
    const block = place ?? (saveFolderId(this.fx, r.segs) === null ? 'disk' : null)
    if (block) this.refusePlace(block, L)
    if (!this.shares.teamOn()) throw new HttpError('forbidden', msg('off', L), { params: { reason: 'file_shares_off' } })
    // the room sending budget before the people are checked: an add is no free probe of who exists (as for a file)
    if (!o.tokenTaken) this.shares.takeToken(me.id)
    this.shares.checkSubjects(me, add, L)
    const s = this.ensure(me, r)
    if (s.paused_at) throw new HttpError('conflict', msg('folderPaused', L), { params: { reason: 'folder_share_paused' } })
    // an entry of a group that is gone is not one of the 50, and goes
    this.db.query("DELETE FROM file_share_grants WHERE share_id = ? AND subject_type = 'group' AND subject_id != '*' AND subject_id NOT IN (SELECT id FROM groups)").run(s.id)
    const held = this.db.query('SELECT subject_type, subject_id FROM file_share_grants WHERE share_id = ?').all(s.id) as { subject_type: 'user' | 'group'; subject_id: string }[]
    const have = new Set(held.map((g) => `${g.subject_type}:${g.subject_id}`))
    const fresh = add.filter((x) => !have.has(`${x.subjectType}:${x.subjectId}`))
    const gone = remove0.filter((x) => have.has(`${x.subjectType}:${x.subjectId}`))
    if (have.size + fresh.length - gone.length > FILE_SHARE_MAX) throw new HttpError('validation', msg('folderFull', L), { params: { reason: 'file_share_full' } })
    if (!have.size && fresh.length) {
      const n = (this.db.query(`SELECT COUNT(*) n FROM file_shares s WHERE s.kind = 'folder' AND s.state = 'live' AND s.owner_id = ? AND ${WITH_PEOPLE}`).get(me.id) as { n: number }).n
      if (n >= FOLDER_SHARES_PER_OWNER) throw new HttpError('validation', msg('foldersMany', L), { params: { reason: 'folder_shares_full' } })
    }
    const before = fresh.length ? this.reached(r.segs) : null
    const at = now()
    let undo: { id: string; until: string } | null = null
    this.db.transaction(() => {
      for (const x of fresh) this.db.query('INSERT INTO file_share_grants (share_id, subject_type, subject_id, role, granted_by, granted_at, via) VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING').run(s.id, x.subjectType, x.subjectId, 'view', me.id, at, via)
      undo = saveUndo(this.db, me.id, s.id, gone, o.stepId ?? null)
      for (const x of gone) this.db.query('DELETE FROM file_share_grants WHERE share_id = ? AND subject_type = ? AND subject_id = ?').run(s.id, x.subjectType, x.subjectId)
      // a waiting request of someone now added is answered by the add
      if (fresh.length) for (const req of this.db.query("SELECT id, requester_id FROM file_access_requests WHERE share_id = ? AND state = 'pending'").all(s.id) as { id: string; requester_id: string }[]) {
        if (this.shares.grantedTo(s.id, req.requester_id)) this.db.query("UPDATE file_access_requests SET state = 'approved', decided_by = ?, decided_at = ? WHERE id = ?").run(me.id, at, req.id)
      }
    })()
    // newly reached: people no shared folder at or above this one let in before
    const added = before ? [...this.reached(r.segs)].filter((id) => !before.has(id) && id !== me.id) : []
    if (fresh.length || gone.length) {
      this.shares.changedSoon()
      const everyone = fresh.some((x) => x.subjectType === 'group' && x.subjectId === '*')
      if (fresh.length) audit(this.db, { actor: me.id, action: 'folder_share.add', target: `file-share:${s.id}`, detail: { personal: true, people: fresh.filter((x) => x.subjectType === 'user').length, groups: fresh.filter((x) => x.subjectType === 'group' && x.subjectId !== '*').length, ...(everyone ? { everyone: true } : {}), via } })
      if (gone.length) audit(this.db, { actor: me.id, action: 'folder_share.remove', target: `file-share:${s.id}`, detail: { personal: true, removed: gone.length, via } })
    }
    const named = new Set(fresh.filter((x) => x.subjectType === 'user').map((x) => x.subjectId))
    if (!o.quiet) for (const id of added) this.shares.notify(id, 'file.shared', s.id, true, named.has(id))
    return { view: { ...this.view(me, this.shares.rules(), r, L), ...(undo ? { undo } : {}) }, added }
  }

  // ---------------- the dialog's read ----------------

  /** What the folder holds at its first level, as its owner sees it (hidden and temp names left out), up to the cap. */
  private holds(abs: string): { files: number; folders: number; more: boolean } {
    let files = 0, folders = 0, more = false
    let dir: fs.Dir | null = null
    try {
      dir = fs.opendirSync(abs)
      for (let e = dir.readSync(); e; e = dir.readSync()) {
        if (hiddenName(e.name) || e.isSymbolicLink()) continue
        if (files + folders >= FOLDER_HOLDS_MAX) { more = true; break }
        if (e.isDirectory()) folders++
        else if (e.isFile()) files++
      }
    } catch {} finally { try { dir?.closeSync() } catch {} }
    return { files, folders, more }
  }
  /** The files AND folders inside `rel` that have people of their own (they keep them when this share stops). */
  private ownShares(rel: string): FileSharesView['ownShares'] {
    const rows = this.db.query(`SELECT s.id, s.path, s.kind FROM file_shares s WHERE s.state = 'live' AND substr(s.path, 1, length(?) + 1) = ? || '/' AND ${WITH_PEOPLE} ORDER BY s.path LIMIT 500`).all(rel, rel) as { id: string; path: string; kind: 'file' | 'folder' }[]
    if (!rows.length) return undefined
    const people = new Set<string>()
    for (const r of rows) for (const u of this.shares.grantees(r.id)) people.add(u)
    return {
      files: rows.filter((r) => r.kind === 'file').length, folders: rows.filter((r) => r.kind === 'folder').length, people: people.size,
      names: rows.slice(0, 5).map((r) => ({ name: plainLabel(baseName(r.path), 200), folder: r.kind === 'folder' })),
    }
  }
  /** For something in the caller's own files: the shared folders above it, nearest first (GET /api/files/shares). */
  throughOf(me: Principal, segs: readonly string[], L: Locale): { through?: NonNullable<FileSharesView['through']> } {
    if (!this.gateOn() || ownerIn(segs) !== me.id) return {}
    const paths = sharePaths(segs, false)
    if (!paths.length) return {}
    const rows = this.db.query(`SELECT s.id, s.path FROM file_shares s WHERE s.kind = 'folder' AND s.state = 'live' AND s.paused_at IS NULL AND s.path IN (${paths.map(() => '?').join(',')}) AND ${WITH_PEOPLE}`).all(...paths) as { id: string; path: string }[]
    if (!rows.length) return {}
    rows.sort((a, b) => b.path.length - a.path.length)
    return { through: rows.slice(0, 8).map((r) => ({ path: r.path, name: plainLabel(baseName(r.path), 200), people: this.shares.rows(r.id, L) })) }
  }
  /** In a listing of the caller's own folder `parent`: which entries have people of their own ('own') and whether a
   * shared folder at or above the listed one covers them all ('through'). One query (GET /api/files/tree). */
  entryMarks(me: Principal, parent: readonly string[]): ((name: string) => 'own' | 'through' | undefined) | null {
    if (!this.gateOn() || parent[0] !== 'users' || parent[1] !== me.id) return null
    const rel = parent.join('/')
    const above = sharePaths(parent)
    const rows = this.db.query(`SELECT s.path, s.kind, s.paused_at FROM file_shares s WHERE s.state = 'live' AND ${WITH_PEOPLE}
        AND (${above.length ? `s.path IN (${above.map(() => '?').join(',')}) OR ` : ''}(substr(s.path, 1, length(?) + 1) = ? || '/' AND instr(substr(s.path, length(?) + 2), '/') = 0))`).all(...above, rel, rel, rel) as { path: string; kind: string; paused_at: string | null }[]
    if (!rows.length) return null
    const own = new Set(rows.filter((r) => r.path.length > rel.length).map((r) => r.path.slice(rel.length + 1)))
    const through = rows.some((r) => r.path.length <= rel.length && r.kind === 'folder' && !r.paused_at)
    return (name) => (own.has(name) ? 'own' : through ? 'through' : undefined)
  }

  /** GET /api/files/shares?path= for a folder the caller can read (`r`: authorized for them). */
  view(me: Principal, _rules: RuleSet, r: Authorized, L: Locale): FileSharesView {
    const personal = r.segs[0] === 'users'
    const mine = personal && r.segs[1] === me.id
    const base = { path: r.rel, kind: 'folder' as const, teamFile: !personal, mine, owner: mine ? { id: me.id, name: me.name } : null }
    // a team folder (admins share those in their own dialog), or a folder inside another person's files that the
    // caller happens to read: never shared here, and nothing about it is said
    if (!mine) return { ...base, link: null, canShare: false, people: [], blocked: 'team_folder' }
    const block = this.blockOf(r.segs)
    let s = block && block !== 'disk' ? null : this.liveAt(r.rel)
    if (s && !s.paused_at && this.pin(s, r.segs) === 'differs') { pauseFolderShare(this.db, s, 'identity'); s = this.shares.row(s.id) }
    const off = !this.shares.teamOn()
    const own = this.ownShares(r.rel)
    const wide = teamAllowsAlways(this.db) && alwaysOn(this.db, me.id, 'save_wider')
    return {
      ...base, link: s ? { id: s.id, url: fileLinkUrl(s.id) } : null,
      canShare: !block && !off, ...(off ? { off: true as const } : {}),
      people: s ? this.shares.rows(s.id, L) : [],
      ...(block ? { blocked: block } : {}),
      ...(s?.paused_at ? { paused: true as const } : {}),
      holds: this.holds(r.abs),
      ...(own ? { ownShares: own } : {}),
      ...this.throughOf(me, r.segs, L),
      ...(wide ? { wideSavesOn: true as const } : {}),
    }
  }

  // ---------------- opening ----------------

  /** The row that lets `me` into the folder at `root` (actual names): the nearest live folder row at or above it with
   * a grant that reaches them. Each row that grants is checked like the row opened: not paused, the same owner, a
   * place that may be shared, the folder at its own path still the one shared. */
  private grantFor(me: Principal, row: ShareRow, owner: string, root: Authorized, projects: readonly string[]): string | null {
    const paths = sharePaths(root.segs)
    const rows = this.db.query(`SELECT ${COLS} FROM file_shares s WHERE s.kind = 'folder' AND s.state = 'live' AND s.path IN (${paths.map(() => '?').join(',')})
        AND EXISTS(SELECT 1 FROM file_share_grants g WHERE g.share_id = s.id AND ${REACHES('g')})`).all(...paths, me.id, me.id, me.id) as ShareRow[]
    rows.sort((a, b) => b.path.length - a.path.length)
    for (const a of rows) {
      if (a.id === row.id) return a.id
      if (a.paused_at || a.owner_id !== owner) continue
      const segs = segsOf(a.path)
      if (neverShared(this.db, segs, projects)) continue
      const pin = this.pin(a, segs)
      if (pin === 'differs') pauseFolderShare(this.db, a, 'identity')
      if (pin === 'same') return a.id
    }
    return null
  }

  /**
   * Open the shared folder `id` (`sub` ''), or something inside it (`sub`: names joined by '/'), for `userId`. In this
   * order; any failure answers no_access (or unknown for an id that is no link) with nothing about why:
   *  1. the row: a folder row, live, not paused;
   *  2. the caller: active, not a guest;
   *  3. the owner: users/<owner> of the row's path equals its owner_id; their account active, not a guest;
   *  4. the row's path is not a place that is never shared (else the row is dead: its owner moved it there);
   *  5. the folder resolves as its owner, is a directory, and is still the folder that was shared (else paused);
   *  6. who: the owner, or someone a grant reaches on a folder row at or above the path (grantFor);
   *  7. `sub`'s syntax, before it touches the disk (childSegs: whole-path limits too);
   *  8. the child resolves as the owner through authorize (symlinks at any level, temp names, .system, missing, case
   *     and Unicode twins), and is lstat'ed;
   *  9. its resolved path is the shared folder or inside it;
   * 10. receiverSees() accepts it;
   * 11. a file: regular, one link (checkRegular); a folder: a directory. The caller serves bytes only through
   *     streamChecked with this lstat.
   */
  openChild(userId: string, id: string, sub: unknown): ChildOpen {
    const row = this.shares.row(id)
    if (!row) return { kind: 'unknown' }
    const no: ChildOpen = { kind: 'no_access' }
    if (row.kind !== 'folder' || row.state !== 'live' || row.paused_at) return no
    const me = this.shares.principal(userId)
    if (!me || me.role === 'guest') return no
    const rowSegs = segsOf(row.path)
    const owner = ownerIn(rowSegs)
    if (!owner || owner !== row.owner_id) return no
    const ownerP = this.shares.principal(owner)
    if (!ownerP || ownerP.role === 'guest') return no
    const projects = personalProjectFolders(this.db, owner)
    const place = sharePlaceBlock(this.db, rowSegs, projects)
    if (place) {
      markDead(this.db, row.id)
      audit(this.db, { actor: null, action: 'folder_share.ended', target: `file-share:${row.id}`, detail: { personal: true, reason: place === 'project' ? 'project' : 'moved_excluded' } })
      return no
    }
    const rules = this.shares.rules()
    let root: Authorized
    try { root = authorize(this.fx, rules, ownerP, row.path, 'read') } catch { return no }
    if (!root.st?.isDirectory()) return no
    const pin = this.pin(row, root.segs)
    if (pin === 'differs') pauseFolderShare(this.db, row, 'identity')
    if (pin !== 'same') return no
    const via = me.id === owner ? row.id : this.grantFor(me, row, owner, root, projects)
    if (!via) return no
    const names = childSegs(root.rel, sub)
    if (!names) return no
    let child = root
    if (names.length) {
      try { child = authorize(this.fx, rules, ownerP, [...root.segs, ...names].join('/'), 'read') } catch { return no }
    }
    let st: fs.Stats
    try { st = fs.lstatSync(child.abs) } catch { return no }
    if (child.rel !== root.rel && !child.rel.startsWith(root.rel + '/')) return no
    if (child.segs.length !== root.segs.length + names.length || !receiverSees(this.db, child.segs, projects)) return no
    if (st.isDirectory()) { if (st.isSymbolicLink()) return no }
    else { try { st = checkRegular(child.abs) } catch { return no } }
    const crumbs = [baseName(root.rel), ...child.segs.slice(root.segs.length)]
    return { kind: 'open', row, by: me.id === owner ? 'owner' : 'grant', via, root, child, st, name: crumbs[crumbs.length - 1]!, crumbs }
  }

  // ---- one bucket for list, entry and download: each walks the path with a directory read per level ----
  private opens = new Map<string, { at: number; n: number }>()
  /** Counts one list, entry or download of a shared folder for `userId`; above FOLDER_OPENS_PER_MIN a minute: 429. */
  take(userId: string, L: Locale): void {
    const t = Date.now()
    let b = this.opens.get(userId)
    if (!b || t - b.at >= 60_000) {
      if (this.opens.size > 5000) for (const [k, v] of this.opens) if (t - v.at >= 60_000) this.opens.delete(k)
      this.opens.set(userId, (b = { at: t, n: 0 }))
    }
    if (b.n >= FOLDER_OPENS_PER_MIN) throw new HttpError('rate_limited', msg('opensTooMany', L), { retryAfter: Math.max(1, Math.ceil((b.at + 60_000 - t) / 1000)) })
    b.n++
  }

  /**
   * GET /api/files/shared/:id/list: one level of the shared folder. At most FOLDER_LIST_SCAN entries of the directory
   * are read (more: `truncated`; nothing unbounded is read or sorted). Dropped: hidden, temp and refused names,
   * symbolic links, anything that is not a file or a folder, files with more than one link, whatever receiverSees
   * refuses, and an entry whose whole team path passes the path limits (it could never open). Folders first, then by
   * name; a page of at most FOLDER_LIST_PAGE, with one lstat per entry of the page. `next`: the last entry looked at.
   */
  list(userId: string, id: string, sub: unknown, cursor: string | undefined, limit: number, L: Locale): SharedFolderList {
    this.take(userId, L)
    const o = this.openChild(userId, id, sub)
    if (o.kind !== 'open' || !o.st.isDirectory()) throw new HttpError('not_found')
    const projects = personalProjectFolders(this.db, o.root.segs[1]!)
    const found: { name: string; dir: boolean; key: string }[] = []
    let truncated = false
    let dir: fs.Dir | null = null
    try {
      dir = fs.opendirSync(o.child.abs)
      let read = 0
      for (let e = dir.readSync(); e; e = dir.readSync()) {
        if (++read > FOLDER_LIST_SCAN) { truncated = true; break }
        if (hiddenName(e.name) || e.isSymbolicLink() || (!e.isDirectory() && !e.isFile())) continue
        const segs = [...o.child.segs, e.name]
        if (!withinPathLimits(segs) || !receiverSees(this.db, segs, projects)) continue
        found.push({ name: e.name, dir: e.isDirectory(), key: foldKey(e.name) })
      }
    } catch { throw new HttpError('not_found') } finally { try { dir?.closeSync() } catch {} }
    const order = (a: { name: string; dir: boolean; key: string }, b: { name: string; dir: boolean; key: string }) =>
      a.dir !== b.dir ? (a.dir ? -1 : 1) : a.key < b.key ? -1 : a.key > b.key ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    found.sort(order)
    let start = 0
    if (cursor) {
      const after = decodeListCursor(cursor)
      if (!after) throw new HttpError('validation', 'Bad cursor', { params: { reason: 'cursor' } })
      const at = { ...after, key: foldKey(after.name) }
      while (start < found.length && order(found[start]!, at) <= 0) start++
    }
    const max = Math.min(Math.max(1, Math.floor(limit)), FOLDER_LIST_PAGE)
    const items: SharedFolderItem[] = []
    let i = start
    for (; i < found.length && items.length < max; i++) {
      const e = found[i]!
      let st: fs.Stats
      try { st = fs.lstatSync(path.join(o.child.abs, e.name)) } catch { continue }
      // (the entry as it is now: a link put there since the directory was read, or a hard-linked file, is dropped)
      if (st.isSymbolicLink() || (e.dir ? !st.isDirectory() : !st.isFile() || st.nlink !== 1)) continue
      items.push({ name: e.name, dir: e.dir, size: e.dir ? null : st.size, modifiedAt: st.mtime.toISOString(), mime: e.dir ? null : mimeOf(e.name) })
    }
    const last = i > start ? found[i - 1]! : null
    return { crumbs: o.crumbs, items, next: i < found.length && last ? encodeListCursor(last) : null, ...(truncated ? { truncated: true as const } : {}) }
  }

  /** GET /api/files/shared/:id/entry: one file inside the shared folder. */
  entry(userId: string, id: string, sub: unknown, L: Locale): SharedFolderEntry {
    this.take(userId, L)
    const o = this.openChild(userId, id, sub)
    if (o.kind !== 'open' || !o.st.isFile()) throw new HttpError('not_found')
    return { name: o.name, size: o.st.size, mime: mimeOf(o.name) }
  }

  /** GET /api/files/shared/:id/download?sub=: the file to serve, with the lstat its descriptor must match. */
  file(userId: string, id: string, sub: unknown, L: Locale): { abs: string; name: string; expect: { ino: number; dev: number } } {
    this.take(userId, L)
    const o = this.openChild(userId, id, sub)
    if (o.kind !== 'open' || !o.st.isFile()) throw new HttpError('not_found')
    return { abs: o.child.abs, name: o.name, expect: { ino: o.st.ino, dev: o.st.dev } }
  }
}

/** A listing's cursor: the last entry looked at ("d|name" or "f|name"), opaque to the client. */
const encodeListCursor = (e: { name: string; dir: boolean }) => Buffer.from(`${e.dir ? 'd' : 'f'}|${e.name}`).toString('base64url')
function decodeListCursor(c: string): { name: string; dir: boolean } | null {
  if (!/^[A-Za-z0-9_-]{1,400}$/.test(c)) return null
  const s = Buffer.from(c, 'base64url').toString('utf8')
  return /^[df]\|./s.test(s) ? { dir: s[0] === 'd', name: s.slice(2) } : null
}
