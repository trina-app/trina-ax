// A member shares a file they own with chosen people or groups, Drive style (QA TC-3093, docs/DECISIONS.md "A member
// shares their own files", plan docs/AGENTS/plan/20261115-1407-file-share-links.md; migration 355).
//
// A file gets a link /f/<id> the first time someone shares it or copies its link (file_shares). The link opens for:
//   - whoever the folder rules let read the file (RuleSet.access, unchanged), and
//   - the people and groups on it (file_share_grants, view only), while its owner can still edit the file.
// Everyone else gets "Ask for access" (file_access_requests), answered by the file's owner, or, for a team file with no
// owner known, by the team owner and admins. Guests never get anything through a link (their one place is a room or a
// project). RuleSet.decide is not changed: a grant is read only by the id endpoints here, which serve the current bytes
// (no versions, history, extracted text, path or folder). Search, the AI's read tools and the file list stay on RuleSet.
//
// Who owns a file: its person for a file under users/<id>/; for a team file, whoever added it (creatorOf: the event
// walk below). Never who made the link, never who moved it. Who may share: the owner with edit access now (members only
// while the team's "Members can share files they own" is on), and the team owner and admins for any team file.
//
// The row follows the file: moves rewrite its path in the move's transaction (relocate), the trash parks it
// (state 'trashed', trash_id) and a restore brings it back, a purge deletes it. ino / dev / sha256 pin it to the file
// (like team_file_refs): every in-app change refreshes them (onFileEvent); a different file at the same path (put
// there on the disk outside the app) matches neither and the link answers no access. A move by someone other than the
// owner to where fewer people can read it removes the grants (audit + a notice to the owner); the owner's own move
// keeps them (the move confirm says how many people have it by its link).
//
// "Everyone on the team" (QA TC-3509, docs/decisions/20261116-file-share-everyone.md) is a group grant with the reserved
// id '*' (FILE_SHARE_EVERYONE): every active member now and later, never a guest. The same rules as any group: whoever
// may share the file may add it (a member too: it is their own team), it counts as one of the 50, and every way a grant
// goes takes it. Several files shared in one press (shareMany, QA TC-3510) tell each person once.
import fs from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import type { AppContext } from '../context'
import { audit } from '../admin/audit'
import { getTeamSettings } from '../admin/settings'
import { HttpError } from '../http/errors'
import { atLeast, isStaff, loadPrincipal, RuleSet, SYSTEM_PRINCIPAL, type Principal } from '../policy/access'
import { authorize, type Authorized } from '../policy/authorize'
import { checkRegular } from '../team-files/place'
import { toHttp } from '../team-files/errors'
import { mimeOf } from '../team-files/service'
import { newId } from '../db'
import { onFileEvent } from './store'
import { FILE_SHARE_TEXT } from './share-text'
import { folderMadeAt, folderReadersLost, folderRowsLanded, folderSharesOf } from './folder-shares'
import { folderGranteesUnder, shareGrantees } from './share-readers'
import { saveUndo, undosClosed } from './share-undo'
import { registerAccountCleanup } from '../auth/account-removal'
import { onAccessChange } from '../admin/folders'
import { notificationsOf } from '../notifications/service'
import { roomsOf } from '../rooms/service'
import { FILE_REQUESTS_PER_HOUR, FILE_REQUESTS_PER_OWNER_DAY, FILE_SHARE_EVERYONE, FILE_SHARE_MAX, fileLinkUrl, plainLabel, type FileLink, type FileShareRow, type FileShares as FileSharesView, type InboxNotification, type Locale, type ShareCardState, type SharedBatchView, type SharedFileView, type SharedWithMe, type SharedWithMeItem, type ShareFilesBatchResult } from '@mycel/shared/api'

/** `kind`, `folder_id`, `paused_at` (migration 360): a folder in a person's own files (files/folder-shares.ts) */
export interface ShareRow { id: string; path: string; ino: number | null; dev: number | null; sha256: string | null; size: number | null; mtime_ms: number | null; ctime_ms: number | null; owner_id: string | null; state: 'live' | 'trashed' | 'dead'; trash_id: string | null; created_by: string; created_at: string; kind: 'file' | 'folder'; folder_id: string | null; paused_at: string | null }
export const COLS = 'id, path, ino, dev, sha256, size, mtime_ms, ctime_ms, owner_id, state, trash_id, created_by, created_at, kind, folder_id, paused_at'
export type Subject = { subjectType: 'user' | 'group'; subjectId: string }
export type Via = 'dialog' | 'ai' | 'request'
/** accounts looked at for "who can still open it" after a stop (stillOpens) */
export const RESIDUAL_SCAN = 200
/** A person who can still open a file after being taken off it, and through what (stillOpens). */
export interface StillOpens { userId: string; name: string; avatarVersion?: number; through: { kind: 'folder' } | { kind: 'group'; name: string } | { kind: 'everyone' } }

const now = () => new Date().toISOString()
const segsOf = (p: string) => (p ? p.split('/') : [])
const baseName = (p: string) => p.split('/').pop() ?? p
const personalOwner = (segs: readonly string[]): string | null => (segs[0] === 'users' && segs.length >= 3 ? segs[1]! : null)
/** The sha256 of a file, read in pieces (a big file is never held whole). */
const HASH_MAX = 32 * 1024 * 1024
function sha256File(abs: string): string {
  // (a bigger file is pinned by its inode alone: hashing it here would hold the server's thread)
  if (fs.lstatSync(abs).size > HASH_MAX) throw new Error('too big to hash here')
  const h = createHash('sha256')
  const fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024)
    for (;;) { const n = fs.readSync(fd, buf, 0, buf.length, null); if (!n) break; h.update(buf.subarray(0, n)) }
  } finally { fs.closeSync(fd) }
  return h.digest('hex')
}
/** 16 random bytes, base64url: 22 characters, never guessed */
export const newLinkId = () => randomBytes(16).toString('base64url')

/** people one "Ask <owner>" may ask for (FileShares.requestFor) */
export const FILE_REQUEST_FOR_MAX = 20
/** files listed in the AI's turn context ("Files shared with you") */
export const SHARED_WITH_MAX = 20
/** grant rows looked at for that list, newest first */
const SHARED_WITH_SCAN = 500
/** `to`: how it reaches the person: shared with them, with a group they are in (its name), or with everyone on the team */
export interface SharedWithFile { id: string; name: string; url: string; sharedBy: string | null; at: string; to: { kind: 'you' } | { kind: 'group'; name: string } | { kind: 'everyone' }; /** a folder shared from its owner's files (files/shared-folder-reads.ts) */ kind?: 'folder' }
/** The link id in a file link the AI was given: /f/<id>, f/<id> or https://<any host>/f/<id> (a query or # after it
 * is fine), or null. */
export function linkIdOf(input: string): string | null {
  const m = /^(?:https?:\/\/[^/\s]+)?\/?f\/([A-Za-z0-9_-]{22})\/?(?:[?#][^\s]*)?$/.exec(input.trim())
  return m ? m[1]! : null
}
/** A team path as the AI wrote it, as file_shares keeps it (NFC, no leading ./ or /, no empty segments). */
const teamPathOf = (input: string) => input.normalize('NFC').trim().split('/').filter((x) => x && x !== '.').join('/')

const MSG = FILE_SHARE_TEXT
export const msg = (k: keyof typeof MSG, L: Locale) => MSG[k]![L] ?? MSG[k]!.en

// ---------------- who owns a file: the event walk ----------------

interface Ev { id: number; user_id: string; path: string; action: string; detail: Record<string, unknown> }
const evDetail = (s: string | null): Record<string, unknown> => { try { const v = s ? JSON.parse(s) : null; return v && typeof v === 'object' ? v : {} } catch { return {} } }
const ancestors = (p: string): string[] => { const s = segsOf(p); const out: string[] = []; for (let i = s.length - 1; i >= 1; i--) out.push(s.slice(0, i).join('/')); return out }

/**
 * Who added the file now at `path` (a team file), or null when nobody is known. Walks back from the current path,
 * newest event first:
 * - update / an upload over it (detail.replaced) / a conflict / a version restore: the same file, keep going back;
 * - a plain create or upload: that event's person;
 * - a copy (copiedFrom, sourcePaths, conflictCopyOf): the copier (a copy is a new file);
 * - a move's create (movedFrom, service.ts relocate): never an authorship; continue at the source path before it,
 *   skipping that move's own delete there. A folder's move (an ancestor's create with movedFrom) the same, the rest of
 *   the path kept;
 * - a trash restore (restore with originalPath): continue at the original path before it, skipping the delete that put
 *   it in the trash;
 * - any other delete first (the path was reused, the walk found no creation of this file): null.
 */
type Seek = { movedTo: string } | { trashId: string } | null
export function creatorOf(db: Database, path: string): string | null {
  let cur = path
  let before = Number.MAX_SAFE_INTEGER
  /** after a hop at the file's own path: the delete that took it from there (a move's movedTo, the trash's trashId);
   * events of other files that had the path in between are passed over until it */
  let seek = null as Seek
  for (let hops = 0; hops < 64; hops++) {
    const anc = ancestors(cur)
    const marks = anc.map(() => '?').join(',')
    // the file's own events, and its folders' moves and restores (a folder's move records the folder alone)
    const rows = db.query(`SELECT id, user_id, path, action, detail FROM file_events WHERE id < ? AND (path = ?${anc.length ? ` OR (path IN (${marks}) AND action IN ('create','restore'))` : ''}) ORDER BY id DESC LIMIT 2000`)
      .all(before, cur, ...anc) as { id: number; user_id: string; path: string; action: string; detail: string | null }[]
    let next: { path: string; before: number; seek: Seek } | null = null
    for (const r of rows) {
      const d = evDetail(r.detail)
      if (seek) {
        // only the file's own delete ends the search ('trashId' or 'movedTo' of this hop)
        if (r.path === cur && r.action === 'delete' && (('trashId' in seek && d.trashId === seek.trashId) || ('movedTo' in seek && d.movedTo === seek.movedTo))) seek = null
        continue
      }
      if (r.path !== cur) {
        // a folder above: only its move or its trash restore changes where the file was
        const suffix = cur.slice(r.path.length)
        if (r.action === 'create' && typeof d.movedFrom === 'string') { next = { path: d.movedFrom + suffix, before: r.id, seek: null }; break }
        if (r.action === 'restore' && typeof d.originalPath === 'string') { next = { path: d.originalPath + suffix, before: r.id, seek: null }; break }
        continue
      }
      // a delete before any creation of this file: the path was reused, nobody known
      if (r.action === 'delete') return null
      if (r.action === 'create') {
        if (typeof d.movedFrom === 'string') { next = { path: d.movedFrom, before: r.id, seek: { movedTo: cur } }; break }
        if (d.folder === true) return null
        return r.user_id
      }
      if (r.action === 'upload') {
        if (d.replaced === true) continue
        return r.user_id
      }
      if (r.action === 'restore') {
        if (typeof d.originalPath === 'string') { next = { path: d.originalPath, before: r.id, seek: typeof d.trashId === 'string' ? { trashId: d.trashId } : null }; break }
        continue
      }
      // update, conflict, rejected: the same file
    }
    if (!next) return null
    cur = next.path
    before = next.before
    seek = next.seek
  }
  return null
}

/** The owner of the file at `path`: a personal file's person, else creatorOf. */
export function ownerOf(db: Database, path: string): string | null {
  const segs = segsOf(path)
  const own = personalOwner(segs)
  if (own) return own
  if (segs[0] === 'users') return null
  return creatorOf(db, path)
}

// ---------------- the rows' life with the file (called by team-files/service.ts) ----------------

export const UNDER = (col: string) => `(${col} = ? OR substr(${col}, 1, length(?) + 1) = ? || '/')`
const ALL = FILE_SHARE_EVERYONE
/** The DB steps below change share rows inside other areas' transactions (a move, the trash, a folder save) and have
 * no ctx: they only flag the team here (in memory, no I/O in the transaction). The service registered for that
 * database (FileShares) then sends the content-free file_shares_changed after the step has returned (changedSoon). */
const touchedHooks = new WeakMap<Database, () => void>()
export const sharesTouched = (db: Database) => { touchedHooks.get(db)?.() }
/** A Share press of several files takes one send token per this many files (shareMany) */
export const BATCH_FILES_PER_TOKEN = 10
/** SQL: a grant row `g` that reaches the person whose id is the bound `?` (twice): their own, a group's they are in, or
 * the whole team's (for an active member who is not a guest) */
export const REACHES = (g: string) => `((${g}.subject_type = 'user' AND ${g}.subject_id = ?) OR (${g}.subject_type = 'group' AND (${g}.subject_id IN (SELECT group_id FROM group_members WHERE user_id = ?)
  OR (${g}.subject_id = '${ALL}' AND EXISTS(SELECT 1 FROM users ux WHERE ux.id = ? AND ux.status = 'active' AND ux.deleted_at IS NULL AND ux.guest = 0)))))`
/** Inside a move's transaction: the shares at or under `from` follow to `to`. */
export function sharesMoved(db: Database, from: string, to: string): void {
  // a live row already at the target (its file went on the disk outside the app) is another file's: it dies first
  db.query(`UPDATE file_shares SET state = 'dead' WHERE state = 'live' AND ${UNDER('path')} AND NOT ${UNDER('path')}`).run(to, to, to, from, from, from)
  const n = db.query(`UPDATE file_shares SET path = ? || substr(path, length(?) + 1) WHERE state = 'live' AND ${UNDER('path')}`).run(to, from, from, from, from).changes
  if (n) { folderRowsLanded(db, to); sharesTouched(db) }
}
/** Inside the trash's step: the shares at or under `rel` are parked with the trash item. */
export function sharesTrashed(db: Database, rel: string, trashId: string): void {
  // the people of a folder share parked now stop reaching it: fresh AI sessions (files/folder-shares.ts)
  folderReadersLost(db, folderGranteesUnder(db, rel))
  if (db.query(`UPDATE file_shares SET state = 'trashed', trash_id = ? WHERE state = 'live' AND ${UNDER('path')}`).run(trashId, rel, rel, rel).changes) sharesTouched(db)
}
/** A trash item restored from `from` to `to`: its shares come back at the new place. One already live there (a new file
 * shared meanwhile at that path) wins; the parked one goes. */
export function sharesRestored(db: Database, trashId: string, from: string, to: string): void {
  const rows = db.query("SELECT id, path FROM file_shares WHERE state = 'trashed' AND trash_id = ?").all(trashId) as { id: string; path: string }[]
  for (const r of rows) {
    const at = to + r.path.slice(from.length)
    // a live row there is another file's (the restore puts this one where that one's file is gone): it dies
    db.query("UPDATE file_shares SET state = 'dead' WHERE state = 'live' AND path = ?").run(at)
    db.query("UPDATE file_shares SET state = 'live', trash_id = NULL, path = ? WHERE id = ?").run(at, r.id)
    restoredOf(db).add(r.id)
  }
  if (rows.length) { folderRowsLanded(db, to); sharesTouched(db) }
}
export interface UnsharedByMove { owner: string | null; auditId: number }
/** Inside a move's step (TeamFiles.relocate), when the moved files' new place is read by fewer people: the grants of
 * every live shared file at or under `to` that the mover does not own go, with their waiting requests, each audited
 * (`file.unshare`, reason moved_narrower). Throws with the move (never logged and passed over). The owner's own move
 * keeps them: its confirm said how many people have them by their link. */
export function sharesNarrowedByMove(db: Database, mover: string, to: string): UnsharedByMove[] {
  const out: UnsharedByMove[] = []
  const rows = db.query(`SELECT id, path, owner_id FROM file_shares WHERE state = 'live' AND ${UNDER('path')}`).all(to, to, to) as { id: string; path: string; owner_id: string | null }[]
  for (const s of rows) {
    if (s.owner_id === mover) continue
    const n = db.query('DELETE FROM file_share_grants WHERE share_id = ?').run(s.id).changes
    if (!n) continue
    db.query("UPDATE file_access_requests SET state = 'closed', decided_at = ? WHERE share_id = ? AND state = 'pending'").run(now(), s.id)
    const auditId = audit(db, { actor: mover, action: 'file.unshare', target: `file-share:${s.id}`, detail: { ...(s.path.startsWith('users/') ? { personal: true } : { path: s.path }), removed: n, reason: 'moved_narrower' } })
    out.push({ owner: s.owner_id, auditId })
  }
  if (out.length) sharesTouched(db)
  return out
}

/** The people (by name or through a group) who have files at or under `rel` by their links: a folder's Share dialog
 * says how many when a save narrows who can open it, and offers to remove those links too. */
export function linkPeopleIn(db: Database, rel: string): number {
  const ids = rel ? [rel, rel, rel] : []
  const where = rel ? `AND ${UNDER('s.path')}` : ''
  return (db.query(`SELECT COUNT(*) n FROM (
      SELECT g.subject_id id FROM file_share_grants g JOIN file_shares s ON s.id = g.share_id WHERE s.state = 'live' AND g.subject_type = 'user' ${where}
      UNION SELECT m.user_id FROM file_share_grants g JOIN file_shares s ON s.id = g.share_id JOIN group_members m ON m.group_id = g.subject_id WHERE s.state = 'live' AND g.subject_type = 'group' ${where}
      UNION SELECT uu.id FROM users uu WHERE EXISTS(SELECT 1 FROM file_share_grants g JOIN file_shares s ON s.id = g.share_id WHERE s.state = 'live' AND g.subject_type = 'group' AND g.subject_id = '${ALL}' ${where})
    ) x JOIN users u ON u.id = x.id WHERE u.status = 'active' AND u.deleted_at IS NULL AND u.guest = 0`).get(...ids, ...ids, ...ids) as { n: number }).n
}
/** Inside a folder save's step, after the new rules are written: does the save take `rel` away from someone who could
 * read it before (`before`: the rules as they were) while files there are shared by link? Then the save must say what
 * to do with those links (removeFileLinks true or false); saying nothing is refused (review of #979). */
export function narrowsWithLinks(db: Database, before: RuleSet, rel: string): boolean {
  if (linkPeopleIn(db, rel) === 0) return false
  const after = RuleSet.load(db)
  const segs = segsOf(rel)
  return (db.query("SELECT id FROM users WHERE status = 'active' AND deleted_at IS NULL").all() as { id: string }[]).some((u) => {
    const p = loadPrincipal(db, u.id)
    return !!p && atLeast(before.access(p, segs), 'read') && !atLeast(after.access(p, segs), 'read')
  })
}
/** A folder save's "Remove those links too" (admin/access save, inside its step): every grant of a shared file at or
 * under `rel` goes, with the waiting requests, audited once (`file.unshare`, reason folder_narrowed). */
export function removeLinksIn(db: Database, actor: string, rel: string): number {
  const ids = (db.query(`SELECT DISTINCT s.id FROM file_shares s JOIN file_share_grants g ON g.share_id = s.id WHERE s.state = 'live' AND ${UNDER('s.path')}`).all(rel, rel, rel) as { id: string }[]).map((r) => r.id)
  let n = 0
  for (const id of ids) {
    n += db.query('DELETE FROM file_share_grants WHERE share_id = ?').run(id).changes
    db.query("UPDATE file_access_requests SET state = 'closed', decided_at = ? WHERE share_id = ? AND state = 'pending'").run(now(), id)
  }
  // an earlier removal's Undo must not bring back what the folder save removes (second security review P6-2): every
  // share under the folder, also one whose people were all taken off before (it has no grant now, but an open Undo)
  db.query(`UPDATE file_share_undos SET used_at = ? WHERE used_at IS NULL AND share_id IN (SELECT s.id FROM file_shares s WHERE ${UNDER('s.path')})`).run(now(), rel, rel, rel)
  if (ids.length) { audit(db, { actor, action: 'file.unshare', target: rel.startsWith('users/') ? null : rel, detail: { files: ids.length, removed: n, reason: 'folder_narrowed' } }); sharesTouched(db) }
  return ids.length
}

/** rows a trash restore brought back, until its restore event re-pins them (the only rows that event may re-pin) */
const restored = new WeakMap<Database, Set<string>>()
const restoredOf = (db: Database) => { let s = restored.get(db); if (!s) restored.set(db, (s = new Set())); return s }
/** A trash item deleted for good: its shares, grants, requests and notices go. */
export function sharesPurged(db: Database, trashId: string): void {
  const ids = (db.query('SELECT id FROM file_shares WHERE trash_id = ?').all(trashId) as { id: string }[]).map((r) => r.id)
  folderReadersLost(db, ids.flatMap((id) => [...shareGrantees(db, id)]))
  for (const id of ids) dropShare(db, id)
  if (ids.length) sharesTouched(db)
}
/** A personal folder's records forgotten (an account removed): its shares go. */
export function sharesForgotten(db: Database, prefix: string): void {
  const ids = (db.query(`SELECT id FROM file_shares WHERE ${UNDER('path')}`).all(prefix, prefix, prefix) as { id: string }[]).map((r) => r.id)
  folderReadersLost(db, ids.flatMap((id) => [...shareGrantees(db, id)]))
  for (const id of ids) dropShare(db, id)
  if (ids.length) sharesTouched(db)
}
/** The row's file is gone (another file took its path, or the file changed outside the app): its link answers no
 * access from now on, and its grants and waiting requests go. */
export function markDead(db: Database, id: string) {
  // a folder share's people stop reaching it: fresh AI sessions (every way a folder share ends goes through here or
  // through the steps above: files/folder-shares.ts folderReadersLost)
  if ((db.query('SELECT kind FROM file_shares WHERE id = ?').get(id) as { kind: string } | null)?.kind === 'folder') folderReadersLost(db, shareGrantees(db, id))
  db.query("UPDATE file_shares SET state = 'dead' WHERE id = ?").run(id)
  db.query('DELETE FROM file_share_grants WHERE share_id = ?').run(id)
  db.query("UPDATE file_access_requests SET state = 'closed', decided_at = ? WHERE share_id = ? AND state = 'pending'").run(now(), id)
  sharesTouched(db)
}
function dropShare(db: Database, id: string) {
  const reqs = (db.query('SELECT id FROM file_access_requests WHERE share_id = ?').all(id) as { id: string }[]).map((r) => r.id)
  db.query('DELETE FROM file_share_notices WHERE source_id = ? OR source_id LIKE ?').run(id, `${id}:%`)
  for (const r of reqs) db.query('DELETE FROM file_share_notices WHERE source_id = ?').run(r)
  db.query('DELETE FROM file_shares WHERE id = ?').run(id)
}

/** A deleted account's part (auth/account-removal.ts): their notices and requests, every grant naming them, and the
 * shares of the files they owned (a team file they added keeps no link of theirs; its link can be made again). */
export function registerFileShareCleanup(ctx: AppContext): void {
  registerAccountCleanup(ctx, {
    name: 'file-shares',
    // (file_shares.owner_id: the shares of their files go, and with them their grants, requests and notices' rows)
    rows: ['file_share_notices.user_id', 'file_access_requests.requester_id', 'file_shares.owner_id', 'file_share_batches.by_user', 'file_share_undos.user_id', 'share_fix_offers.user_id'],
    // (the people a removed share reached learn it from file_shares_changed: their Shared with me reads again)
    after: (c, userId) => { c.db.query("DELETE FROM file_share_grants WHERE subject_type = 'user' AND subject_id = ?").run(userId); c.db.query("DELETE FROM file_share_stops WHERE (subject_type = 'user' AND subject_id = ?) OR stopped_by = ?").run(userId, userId); fileSharesOf(c).changedSoon() },
  })
}

// ---------------- the service ----------------

const instances = new WeakMap<AppContext, FileShares>()
export function fileSharesOf(ctx: AppContext): FileShares {
  let s = instances.get(ctx)
  if (!s) { s = new FileShares(ctx); instances.set(ctx, s) }
  return s
}

/** The content-free notice that some file share changed (docs/decisions/20261116-files-shared-with-me.md): a person's
 * Shared with me reads again. No id, path, count or person, so it may go to every member. */
export const FILE_SHARES_CHANGED = { type: 'notice', data: { level: 'info', code: 'file_shares_changed', message: '' } } as const
/** at most one file_shares_changed a second per team */
export const SHARES_CHANGED_GAP_MS = 1000
/** Shared with me (GET /api/files/shared-with-me): rows listed per call, at most; SQL rows read; files looked at on disk */
export const SHARED_WITH_ME_MAX = 50
export const SHARED_WITH_ME_SQL_ROWS = 2000
export const SHARED_WITH_ME_LSTATS = 100
/** after every access change (a folder save, a group's people, someone's groups or role): lists may change */
const ACCESS_HOOK = (ctx: AppContext) => { fileSharesOf(ctx).changedSoon() }

/** Is the file on disk still the one the row was pinned to? 'same': the inode verified last time, untouched since;
 * 'dead': plainly another file (a size change, or no content hash to check it by); 'needs_hash': only its content can
 * tell (open() hashes it; Shared with me lists it without hashing, and a click answers). Pure: no write, no read. */
export function pinState(s: Pick<ShareRow, 'ino' | 'dev' | 'size' | 'mtime_ms' | 'ctime_ms' | 'sha256'>, st: Pick<fs.Stats, 'ino' | 'dev' | 'size' | 'mtimeMs' | 'ctimeMs'>): 'same' | 'dead' | 'needs_hash' {
  if (s.ino === null || s.dev === null) return 'same'
  // the inode verified last time, untouched since (size, mtime and ctime as recorded; ctime cannot be set back by
  // hand): the same file, nothing hashed. An inode number alone proves nothing: a filesystem reuses a freed one for the
  // next file (Linux at once), and an equal size and time on another inode prove nothing either (review of #979)
  if (st.ino === s.ino && st.dev === s.dev && st.size === s.size && st.mtimeMs === s.mtime_ms && st.ctimeMs === s.ctime_ms) return 'same'
  if (s.size !== null && st.size !== s.size) return 'dead'
  if (!s.sha256 || st.size > HASH_MAX) return 'dead'
  return 'needs_hash'
}
/** Shared with me lists a row under the name it has now only while that name cannot be one picked for another file
 * (QA TC-4008): not plainly another file (pinState ≠ dead), and a row waiting for a hash check whose file was moved or
 * renamed in the app since its last check (afterRename clears ctime_ms) only while the inode, size and mtime are still
 * the pinned ones (a rename changes the ctime alone). A file replaced outside the app with one of the same size and
 * then renamed is left out: its new name is not shown to someone it may not open for. Pure, like pinState. */
export function listable(s: Pick<ShareRow, 'ino' | 'dev' | 'size' | 'mtime_ms' | 'ctime_ms' | 'sha256'>, st: Pick<fs.Stats, 'ino' | 'dev' | 'size' | 'mtimeMs' | 'ctimeMs'>): boolean {
  const p = pinState(s, st)
  if (p === 'dead') return false
  if (p === 'needs_hash' && s.ctime_ms === null) return st.ino === s.ino && st.dev === s.dev && st.size === s.size && st.mtimeMs === s.mtime_ms
  return true
}

const CURSOR = /^(?:([ng])\|)?(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\|([A-Za-z0-9_-]{22})$/
/** Shared with me's cursor: where the last call stopped, opaque to the client (base64url). The list reads in two
 * parts: the grants by name ('n'), then the group and whole-team grants of files with none by name ('g'); a cursor is
 * "<part>|<time>|<link id>" (the key of the last row read), or "g" alone (the second part from its start). A cursor
 * of an earlier build ("<time>|<link id>") reads on in the first part. */
export type SharedCursor = { part: 'n' | 'g'; at: string; id: string } | { part: 'g'; at: null; id: null }
export const encodeSharedCursor = (at: string | null, id: string | null, part: 'n' | 'g' = 'n') =>
  Buffer.from(at && id ? `${part}|${at}|${id}` : 'g').toString('base64url')
export function decodeSharedCursor(c: string): SharedCursor | null {
  if (!/^[A-Za-z0-9_-]{1,96}$/.test(c)) return null
  const s = Buffer.from(c, 'base64url').toString('utf8')
  if (s === 'g') return { part: 'g', at: null, id: null }
  const m = CURSOR.exec(s)
  return m ? { part: (m[1] as 'n' | 'g' | undefined) ?? 'n', at: m[2]!, id: m[3]! } : null
}

export type OpenResult =
  | { kind: 'open'; share: ShareRow; abs: string; st: fs.Stats; name: string; size: number; by: 'rules' | 'grant' | 'owner' }
  /** a folder row that opens for the caller (files/folder-shares.ts): never a file to serve. `via`: the row whose grant
   * lets them in (this one, or a shared folder above it) */
  | { kind: 'folder'; share: ShareRow; name: string; by: 'grant' | 'owner'; via: string }
  | { kind: 'no_access'; share: ShareRow | null }
  | { kind: 'trashed'; share: ShareRow }
  | { kind: 'unknown' }

export class FileShares {
  constructor(readonly ctx: AppContext) {
    // The link follows its file through the app's own changes (onFileEvent). Only an event that keeps the SAME file
    // re-pins the row to what is at the path now: a save (update), an upload over it (upload, replaced), a version
    // restore, a conflict, and a trash restore of the row that restore brought back. Anything that puts a NEW file at
    // the path (a plain create or upload, a copy, a conflict copy, a trash restore of another item) makes a live row
    // there dead: its link answers no access, and the new file starts unshared (review of #979: a file uploaded where a
    // shared one had been deleted outside the app inherited its link). A move's own create is the moved row (sharesMoved).
    touchedHooks.set(ctx.db, () => this.changedSoon())
    // (the folder side tells an owner when the server pauses or ends their folder share: its service must exist)
    folderSharesOf(ctx)
    onAccessChange(ACCESS_HOOK)
    onFileEvent(ctx.db, (e) => {
      const d = (e.detail ?? {}) as Record<string, unknown>
      // a move (a file, or a folder with files in it): the rows moved with it (sharesMoved); the rename may change the
      // inode's ctime, so each row on the same inode takes its times again after the rename (nothing else changed)
      if (typeof d.movedFrom === 'string') { queueMicrotask(() => this.afterRename(e.path)); return }
      // a folder made where a shared folder's row lives: that share pauses (files/folder-shares.ts)
      if (d.folder === true) { if (e.action === 'create') folderMadeAt(this.db, e.path); return }
      const same = e.action === 'update' || e.action === 'conflict' || (e.action === 'upload' && d.replaced === true)
        || (e.action === 'restore' && typeof d.versionId === 'string')
      const trashBack = e.action === 'restore' && typeof d.trashId === 'string'
      const fresh = e.action === 'create' || (e.action === 'upload' && d.replaced !== true)
      if (!same && !trashBack && !fresh) return
      const row = this.db.query("SELECT id FROM file_shares WHERE state = 'live' AND path = ?").get(e.path) as { id: string } | null
      if (!row) return
      const back = trashBack && restoredOf(this.db).delete(row.id)
      if (same || back) this.repin(row.id, e.path, e.sha256 ?? null)
      else markDead(this.db, row.id)
    })
  }
  private get db() { return this.ctx.db }
  rules() { return RuleSet.load(this.db) }
  principal(id: string, memo?: Map<string, Principal | null>): Principal | null {
    if (!memo) return loadPrincipal(this.db, id)
    if (!memo.has(id)) memo.set(id, loadPrincipal(this.db, id))
    return memo.get(id)!
  }

  private sentAt = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  /** Some share changed (a grant added or removed, a row moved, trashed, restored, purged or dead, an access change):
   * every connected active member who is not a guest gets file_shares_changed, at most once a second, from a timer that
   * runs after the change's step has returned (its transaction committed). */
  changedSoon(): void {
    if (this.timer) return
    const wait = Math.max(0, this.sentAt + SHARES_CHANGED_GAP_MS - Date.now())
    this.timer = setTimeout(() => {
      this.timer = null
      this.sentAt = Date.now()
      try {
        // (a guest has no list; a switched-off or deleted account no window)
        const off = new Set((this.db.query("SELECT id FROM users WHERE guest = 1 OR status != 'active' OR deleted_at IS NOT NULL").all() as { id: string }[]).map((r) => r.id))
        this.ctx.services.realtime.publishEach((u) => (off.has(u) ? null : FILE_SHARES_CHANGED))
      } catch (err) { this.ctx.log.warn('file_shares_changed failed', { err }) }
    }, wait)
    ;(this.timer as { unref?: () => void }).unref?.()
  }
  teamOn() { return getTeamSettings(this.db).memberFileShares !== false }

  /** The file at `rel` resolved on disk without anyone's access (a personal file as its person, a team file as the
   * system): symlinks, temp names, .system/ and missing paths refused as everywhere. */
  private resolve(rel: string, rules: RuleSet, memo?: Map<string, Principal | null>, folder = false): Authorized | null {
    const segs = segsOf(rel)
    const own = personalOwner(segs)
    const as = own ? this.principal(own, memo) : segs[0] === 'users' ? null : SYSTEM_PRINCIPAL
    if (!as) return null
    try {
      const r = authorize(this.ctx.files.fx, rules, as, rel, 'read')
      // (`folder`: a folder row's own directory, for its requests and notices; never a file to serve)
      if (folder) return r.st?.isDirectory() ? r : null
      if (!r.st || r.st.isDirectory()) return null
      checkRegular(r.abs)
      return r
    } catch { return null }
  }

  /** The row is this file again: what is at the path now (the same file, written by the app). */
  private repin(id: string, rel: string, sha: string | null) {
    const set = () => {
      let st: fs.Stats
      const abs = this.absOf(rel)
      try { st = fs.lstatSync(abs) } catch { return }
      if (!st.isFile()) return
      // the content's hash as it is now (the event's, else read here; none above 32 MB: such a file is then judged by its
      // inode, size and times alone, and a change outside the app makes it dead)
      let h = sha
      if (!h) { try { h = sha256File(abs) } catch { h = null } }
      this.db.query("UPDATE file_shares SET ino = ?, dev = ?, size = ?, mtime_ms = ?, ctime_ms = ?, sha256 = ? WHERE id = ? AND state = 'live'").run(st.ino, st.dev, st.size, st.mtimeMs, st.ctimeMs, h, id)
    }
    set()
    // a file event recorded just before its file lands (the rename is the step's last): once more after it
    queueMicrotask(set)
  }
  /** After a move's rename: the rows at or under `rel` are not re-pinned (the inode alone proves nothing: a file replaced
   * outside the app on the same inode must not pass as checked; review of #979). Up to 32 MB the next open hashes
   * once (ctime_ms cleared); above, the times are taken again only while the size and mtime are still the recorded
   * ones (the rename changes the ctime alone), else the row is left and the next open makes it dead. */
  private afterRename(rel: string) {
    const rows = this.db.query(`SELECT id, path, ino, dev, size, mtime_ms FROM file_shares WHERE state = 'live' AND ${UNDER('path')}`).all(rel, rel, rel) as { id: string; path: string; ino: number | null; dev: number | null; size: number | null; mtime_ms: number | null }[]
    for (const r of rows) {
      let st: fs.Stats
      try { st = fs.lstatSync(this.absOf(r.path)) } catch { continue }
      if (!st.isFile()) continue
      if (st.size <= HASH_MAX) { this.db.query('UPDATE file_shares SET ctime_ms = NULL WHERE id = ?').run(r.id); continue }
      if (st.ino === r.ino && st.dev === r.dev && st.size === r.size && st.mtimeMs === r.mtime_ms) this.db.query('UPDATE file_shares SET ctime_ms = ? WHERE id = ?').run(st.ctimeMs, r.id)
    }
  }
  private absOf(rel: string) { return [this.ctx.files.fx.root, ...segsOf(rel)].join('/') }

  row(id: string): ShareRow | null {
    if (!/^[A-Za-z0-9_-]{22}$/.test(id)) return null
    return this.db.query(`SELECT ${COLS} FROM file_shares WHERE id = ?`).get(id) as ShareRow | null
  }
  liveAt(rel: string): ShareRow | null {
    return this.db.query(`SELECT ${COLS} FROM file_shares WHERE state = 'live' AND path = ?`).get(rel) as ShareRow | null
  }

  /** Is the file at the share's path still the one it was made for (decision 9)? The inode, else the last content
   * recorded through the app. A match by content records the new inode. */
  private same(s: ShareRow, st: fs.Stats, abs: string): boolean {
    // pinState decides; anything but 'same' is checked here, at most once (a match re-pins what is there now, so the
    // next open takes the fast path again; a mismatch makes the row dead and the next open answers at once)
    const p = pinState(s, st)
    if (p === 'same') return true
    const repin = () => { this.db.query('UPDATE file_shares SET ino = ?, dev = ?, size = ?, mtime_ms = ?, ctime_ms = ? WHERE id = ?').run(st.ino, st.dev, st.size, st.mtimeMs, st.ctimeMs, s.id); return true }
    const dead = () => { markDead(this.db, s.id); return false }
    if (p === 'dead') return dead()
    let h: string
    try { h = sha256File(abs) } catch { return dead() }
    return h === s.sha256 ? repin() : dead()
  }

  /** The file's link, made on first use by anyone who can open it (never sets who owns it: creatorOf does). */
  linkFor(userId: string, rel0: string): FileLink {
    const me = this.principal(userId)
    if (!me || me.role === 'guest') throw new HttpError('not_found')
    const rules = this.rules()
    const r = authorize(this.ctx.files.fx, rules, me, rel0, 'read')
    if (r.st?.isDirectory()) {
      const f = folderSharesOf(this.ctx)
      if (f.takes(me, r.segs, 'link')) return f.linkFor(me, r.rel, 'en')
      throw new HttpError('validation', msg('folder', 'en'), { params: { reason: 'is_folder' } })
    }
    checkRegular(r.abs)
    const s = this.ensure(r.rel, userId, r.st!)
    return { id: s.id, url: fileLinkUrl(s.id) }
  }
  private ensure(rel: string, by: string, st: fs.Stats): ShareRow {
    const have = this.liveAt(rel)
    // (a folder's row left at a path where a file is now: not this file's)
    if (have && have.kind === 'folder') markDead(this.db, have.id)
    else if (have) {
      // a row whose file was replaced on the disk outside the app is not this file's: it starts again
      // (same() makes a row whose file changed outside the app dead)
      if (this.same(have, st, this.absOf(rel))) return have
    }
    const id = newLinkId()
    let sha: string | null = null
    try { sha = sha256File(this.absOf(rel)) } catch {}
    this.db.query('INSERT INTO file_shares (id, path, ino, dev, sha256, size, mtime_ms, ctime_ms, owner_id, state, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, rel, st.ino, st.dev, sha, st.size, st.mtimeMs, st.ctimeMs, ownerOf(this.db, rel), 'live', by, now())
    return this.row(id)!
  }

  /** What `me` may do with the people on the file at `rel` (a regular file they can read). `may`: add (its owner with
   * edit access, a member only while the team switch is on; the team owner and admins for a team file). `stop` (alias
   * `mayRemove`): take people off and stop: whoever may share, and the file's owner always, WHATEVER the team switch
   * says and also without edit access, so an owner can always end their own share (docs/decisions/
   * 20261116-folder-share-server.md, 20261116-ai-share-card-and-stop.md). */
  shareRight(me: Principal, rules: RuleSet, segs: string[]): { may: boolean; mayRemove: boolean; owner: string | null; off: boolean; stop: boolean } {
    const rel = segs.join('/')
    const owner = this.liveAt(rel)?.owner_id ?? ownerOf(this.db, rel)
    const team = segs[0] !== 'users'
    const edits = atLeast(rules.access(me, segs), 'write')
    const mine = me.role !== 'guest' && owner === me.id
    if (me.role === 'guest' || !edits) return { may: false, mayRemove: mine, owner, off: false, stop: mine }
    if (team && isStaff(me)) return { may: true, mayRemove: true, owner, off: false, stop: true }
    if (owner !== me.id) return { may: false, mayRemove: false, owner, off: false, stop: false }
    const off = !this.teamOn()
    return { may: !off, mayRemove: true, owner, off, stop: true }
  }

  /** The dialog's state for a file the caller can open. */
  view(userId: string, rel0: string, L: Locale = 'en'): FileSharesView {
    const me = this.principal(userId)
    if (!me || me.role === 'guest') throw new HttpError('not_found')
    const rules = this.rules()
    const r = authorize(this.ctx.files.fx, rules, me, rel0, 'read')
    if (r.st?.isDirectory()) {
      const f = folderSharesOf(this.ctx)
      if (f.takes(me, r.segs, 'view')) return f.view(me, rules, r, L)
      throw new HttpError('validation', msg('folder', L), { params: { reason: 'is_folder' } })
    }
    const right = this.shareRight(me, rules, r.segs)
    const s0 = this.liveAt(r.rel)
    const s = s0?.kind === 'folder' ? null : s0
    const ownerName = right.owner ? (this.db.query("SELECT name FROM users WHERE id = ? AND deleted_at IS NULL").get(right.owner) as { name: string } | null)?.name ?? null : null
    const people = s ? this.rows(s.id, L) : []
    // the rows: for whoever may share, and for someone on the list (they see who else has it; the whole team: everyone
    // but a guest, and a guest never gets here)
    const listed = right.may || right.stop || right.owner === me.id || people.some((p) => (p.subjectType === 'user' && p.subjectId === me.id) || (p.subjectType === 'group' && (me.groups.includes(p.subjectId) || p.subjectId === ALL)))
    return {
      path: r.rel, link: s ? { id: s.id, url: fileLinkUrl(s.id) } : null, canShare: right.may, canStop: right.stop,
      owner: right.owner && ownerName ? { id: right.owner, name: ownerName } : null, mine: right.owner === me.id,
      teamFile: r.segs[0] !== 'users', ...(right.off ? { off: true as const } : {}), people: listed ? people : [],
      // a file inside a shared folder: the folders above that share it (its owner only)
      ...folderSharesOf(this.ctx).throughOf(me, r.segs, L),
    }
  }
  rows(shareId: string, L: Locale): FileShareRow[] {
    const out: FileShareRow[] = []
    for (const g of this.db.query('SELECT subject_type, subject_id FROM file_share_grants WHERE share_id = ? ORDER BY granted_at, subject_id').all(shareId) as { subject_type: 'user' | 'group'; subject_id: string }[]) {
      if (g.subject_type === 'user') {
        const u = this.db.query('SELECT u.name, p.title, p.avatar_version, u.status FROM users u LEFT JOIN user_profiles p ON p.user_id = u.id WHERE u.id = ? AND u.deleted_at IS NULL').get(g.subject_id) as { name: string; title: string | null; avatar_version: number | null; status: string } | null
        if (!u) continue
        out.push({ subjectType: 'user', subjectId: g.subject_id, name: u.name, ...(u.title ? { title: u.title } : {}), ...(u.avatar_version ? { avatarVersion: u.avatar_version } : {}), ...(u.status !== 'active' ? { inactive: true as const } : {}) })
      } else if (g.subject_id === ALL) {
        out.push({ subjectType: 'group', subjectId: ALL, name: msg('everyone', L), everyone: true })
      } else {
        const gr = this.db.query('SELECT name FROM groups WHERE id = ?').get(g.subject_id) as { name: string } | null
        if (gr) out.push({ subjectType: 'group', subjectId: g.subject_id, name: gr.name })
      }
    }
    return out
  }

  /** Add and remove people and groups (the dialog, the AI tool). `via` for the audit. Returns the people newly given
   * access (by name or through a group). */
  /**
   * PUT /api/files/shares, and a request's approval: a file as change() does it, or the caller's own FOLDER
   * (files/folder-shares.ts). Only these two reach a folder: a press of several files (shareMany) and the AI's file
   * tool (chat/share-with-person.ts) call change(), which refuses every folder, so a folder is never shared through a
   * path that may skip its confirmation. `stop`: everyone at once, never with an add; `resume`: a paused folder's, alone.
   */
  put(userId: string, rel0: string, add: readonly Subject[], remove: readonly Subject[], L: Locale, via: Via = 'dialog', o: { stop?: boolean; resume?: boolean; stepId?: string | null; turnId?: string | null } = {}): { view: FileSharesView; added: string[] } {
    const me = this.principal(userId)
    if (!me || me.role === 'guest') throw new HttpError('not_found')
    if ((o.stop && add.length) || (o.resume && (add.length || remove.length || o.stop))) throw new HttpError('validation')
    const r = authorize(this.ctx.files.fx, this.rules(), me, rel0, 'read')
    if (r.st?.isDirectory()) {
      const f = folderSharesOf(this.ctx)
      if (f.takes(me, r.segs, 'change')) return f.change(me, r.rel, add, remove, L, via, o)
      throw new HttpError('validation', msg('folder', L), { params: { reason: 'is_folder' } })
    }
    if (o.resume) throw new HttpError('validation')
    return this.change(userId, rel0, add, remove, L, via, o)
  }
  change(userId: string, rel0: string, add: readonly Subject[], remove0: readonly Subject[], L: Locale, via: Via = 'dialog', o: { quiet?: boolean; tokenTaken?: boolean; stop?: boolean; stepId?: string | null } = {}): { view: FileSharesView; added: string[]; removed: Subject[]; share: ShareRow } {
    const me = this.principal(userId)
    if (!me || me.role === 'guest') throw new HttpError('not_found')
    if (o.stop && add.length) throw new HttpError('validation')
    const rules = this.rules()
    const r = authorize(this.ctx.files.fx, rules, me, rel0, 'read')
    // never a folder here (see put())
    if (r.st?.isDirectory()) throw new HttpError('validation', msg('folder', L), { params: { reason: 'is_folder' } })
    checkRegular(r.abs)
    const right = this.shareRight(me, rules, r.segs)
    // adding needs the right to share (the team switch on, for a member); taking people off and stopping are always the
    // owner's, also with the switch off or without edit access (a call that adds nobody is a removal)
    if (add.length ? !right.may : !right.stop) throw new HttpError('forbidden', msg(right.off && add.length ? 'off' : 'notOwner', L), { params: { reason: right.off && add.length ? 'file_shares_off' : 'file_share_not_owner' } })
    // the room sending budget (chat sharing's rule) before the people are checked: an add is no free probe of who
    // exists, and a refused name costs the same token as a real one (security review of #1038). A press of several
    // files paid for its files already (shareMany)
    if (add.length && !o.tokenTaken) this.takeToken(userId)
    this.checkSubjects(me, add, L)
    const share = this.ensure(r.rel, userId, r.st!)
    const held = this.db.query('SELECT subject_type, subject_id FROM file_share_grants WHERE share_id = ?').all(share.id) as { subject_type: 'user' | 'group'; subject_id: string }[]
    const have = new Set(held.map((g) => `${g.subject_type}:${g.subject_id}`))
    const remove: readonly Subject[] = o.stop ? held.map((g) => ({ subjectType: g.subject_type, subjectId: g.subject_id })) : remove0
    const fresh = add.filter((s) => !have.has(`${s.subjectType}:${s.subjectId}`))
    const gone = remove.filter((s) => have.has(`${s.subjectType}:${s.subjectId}`))
    if (have.size + fresh.length - gone.length > FILE_SHARE_MAX) throw new HttpError('validation', msg('full', L), { params: { reason: 'file_share_full' } })
    // who may open it before and after: only when someone is added (each walks every account; a press re-sharing files
    // that have them already, or a removal, skips it: security review of #1038)
    const before = fresh.length ? this.openers(share, r.segs) : null
    const at = now()
    let undo: { id: string; until: string } | null = null
    this.db.transaction(() => {
      for (const s of fresh) this.db.query('INSERT INTO file_share_grants (share_id, subject_type, subject_id, role, granted_by, granted_at, via) VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING').run(share.id, s.subjectType, s.subjectId, 'view', userId, at, via)
      // what the removal takes is kept for its Undo (files/share-undo.ts)
      undo = saveUndo(this.db, userId, share.id, gone, o.stepId ?? null)
      for (const s of gone) this.db.query('DELETE FROM file_share_grants WHERE share_id = ? AND subject_type = ? AND subject_id = ?').run(share.id, s.subjectType, s.subjectId)
      // who stopped it, for the link page of the people it reached ("<name> stopped sharing this file"); an add ends it
      for (const s of gone) this.db.query('INSERT INTO file_share_stops (share_id, subject_type, subject_id, stopped_by, stopped_at) VALUES (?,?,?,?,?) ON CONFLICT(share_id, subject_type, subject_id) DO UPDATE SET stopped_by = excluded.stopped_by, stopped_at = excluded.stopped_at').run(share.id, s.subjectType, s.subjectId, userId, at)
      for (const s of fresh) this.db.query('DELETE FROM file_share_stops WHERE share_id = ? AND subject_type = ? AND subject_id = ?').run(share.id, s.subjectType, s.subjectId)
      // a waiting request of someone now added is answered by the add
      if (fresh.length) for (const req of this.db.query("SELECT id, requester_id FROM file_access_requests WHERE share_id = ? AND state = 'pending'").all(share.id) as { id: string; requester_id: string }[]) {
        if (this.grantedTo(share.id, req.requester_id)) this.db.query("UPDATE file_access_requests SET state = 'approved', decided_by = ?, decided_at = ? WHERE id = ?").run(userId, at, req.id)
      }
    })()
    const added = before ? [...this.openers(share, r.segs)].filter((id) => !before.has(id) && id !== userId) : []
    if (fresh.length || gone.length) {
      // the people it reaches (or reached) read their Shared with me again
      this.changedSoon()
      const everyone = fresh.some((s) => s.subjectType === 'group' && s.subjectId === ALL)
      audit(this.db, { actor: userId, action: fresh.length ? 'file.share' : 'file.unshare', target: this.auditTarget(share), detail: { ...this.auditPath(share), people: fresh.filter((s) => s.subjectType === 'user').length, groups: fresh.filter((s) => s.subjectType === 'group' && s.subjectId !== ALL).length, ...(everyone ? { everyone: true } : {}), removed: gone.length, via, ...(gone.length ? { reason: 'removed' } : {}) } })
    }
    const named = new Set(fresh.filter((s) => s.subjectType === 'user').map((s) => s.subjectId))
    if (!o.quiet) for (const id of added) this.notify(id, 'file.shared', share.id, true, named.has(id))
    return { view: { ...this.view(userId, r.rel, L), ...(undo ? { undo } : {}) }, added, removed: gone.map((s) => ({ subjectType: s.subjectType, subjectId: s.subjectId })), share: this.row(share.id)! }
  }

  /**
   * After a stop (the AI's result card, chat/stop-sharing.ts): the people among `removed` who can still open the file,
   * and through what: its folder's rules, a group still on it, or the whole team. A person taken off by name, and a
   * removed group's members (the first RESIDUAL_SCAN accounts looked at). Read as the server, for the card of whoever
   * may stop the share (they see the file's list of people anyway); never a guest, never the owner.
   */
  stillOpens(share: ShareRow, removed: readonly Subject[]): StillOpens[] {
    const segs = segsOf(share.path)
    const rules = this.rules()
    const ids = new Set<string>()
    for (const s of removed) {
      if (ids.size >= RESIDUAL_SCAN) break
      if (s.subjectType === 'user') { ids.add(s.subjectId); continue }
      const rows = s.subjectId === ALL
        ? this.db.query(`SELECT id FROM users WHERE status = 'active' AND deleted_at IS NULL AND guest = 0 ORDER BY id LIMIT ${RESIDUAL_SCAN}`).all() as { id: string }[]
        : this.db.query(`SELECT user_id id FROM group_members WHERE group_id = ? ORDER BY user_id LIMIT ${RESIDUAL_SCAN}`).all(s.subjectId) as { id: string }[]
      for (const r of rows) { if (ids.size >= RESIDUAL_SCAN) break; ids.add(r.id) }
    }
    const grants = this.ownerStillEdits(share, rules, segs)
      ? this.db.query('SELECT subject_type, subject_id FROM file_share_grants WHERE share_id = ?').all(share.id) as { subject_type: string; subject_id: string }[]
      : []
    const everyone = grants.some((g) => g.subject_type === 'group' && g.subject_id === ALL)
    const groups = grants.filter((g) => g.subject_type === 'group' && g.subject_id !== ALL).map((g) => g.subject_id)
    const out: StillOpens[] = []
    for (const id of ids) {
      if (id === share.owner_id) continue
      const p = this.principal(id)
      if (!p || p.role === 'guest') continue
      const u = this.db.query('SELECT u.name, p.avatar_version FROM users u LEFT JOIN user_profiles p ON p.user_id = u.id WHERE u.id = ? AND u.deleted_at IS NULL').get(id) as { name: string; avatar_version: number | null } | null
      if (!u) continue
      const who = { userId: id, name: u.name, ...(u.avatar_version ? { avatarVersion: u.avatar_version } : {}) }
      if (atLeast(rules.access(p, segs), 'read')) { out.push({ ...who, through: { kind: 'folder' } }); continue }
      if (grants.some((g) => g.subject_type === 'user' && g.subject_id === id)) continue // still on it by name: not a leftover
      const gid = groups.find((g) => p.groups.includes(g))
      if (gid) {
        const name = (this.db.query('SELECT name FROM groups WHERE id = ?').get(gid) as { name: string } | null)?.name
        if (name) { out.push({ ...who, through: { kind: 'group', name } }); continue }
      }
      if (everyone) out.push({ ...who, through: { kind: 'everyone' } })
    }
    return out
  }

  /**
   * POST /api/files/shares/cards: the files of an AI share card as the caller may see them now, by their link ids (the
   * card stores ids; chat/share-card.ts). A file the folder rules let the caller read and whose people they may change
   * (add or take off): its path (for the Share dialog), the people on it and what the caller may do. Anything else (no
   * such link, a dead or trashed one, a file they cannot read by the rules or may not change) is `gone`, with nothing
   * about it.
   */
  cards(userId: string, ids: readonly string[], L: Locale): ShareCardState[] {
    return [...new Set(ids)].map((id): ShareCardState => {
      const s = this.row(id)
      if (!s || s.state !== 'live') return { id, gone: true }
      try {
        const v = this.view(userId, s.path, L)
        // (the row is this file's: the path's live row is the one asked for)
        if (v.link?.id !== id) return { id, gone: true }
        // only for whoever may act on it (the card's button): a reader of the folder learns nothing new from a link id
        if (!v.canShare && !v.canStop) return { id, gone: true }
        return { id, path: v.path, name: plainLabel(baseName(v.path), 200), canShare: v.canShare, canStop: !!v.canStop, people: v.people }
      } catch { return { id, gone: true } }
    })
  }
  takeToken(userId: string) {
    roomsOf(this.ctx).takeSendToken(userId)
  }
  /** Every subject checked before anything is written: an active member (never a guest, never me), a group that exists
   * and, for a member, one of their own (admins any), or the whole team (anyone who may share: it is their own team). */
  checkSubjects(me: Principal, add: readonly Subject[], L: Locale) {
    for (const s of add) {
      const ok = s.subjectType === 'user'
        ? s.subjectId !== me.id && !!this.db.query("SELECT 1 FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL AND guest = 0").get(s.subjectId)
        : s.subjectId === ALL || (!!this.db.query('SELECT 1 FROM groups WHERE id = ?').get(s.subjectId) && (isStaff(me) || me.groups.includes(s.subjectId)))
      if (!ok) throw new HttpError('validation', msg('unknownSubject', L), { params: { reason: 'unknown_subject' } })
    }
  }

  /**
   * Several files with the same people and groups in one press (POST /api/files/shares/batch; Find work files' step).
   * Each file is change()'s add with its own rules; a file refused is listed with the server's words and the rest go
   * on. The send budget by size, one token per 10 files (a press of 20 takes 2; 100, 10), taken before anything is
   * checked: the budget is about probing who exists (the people are the same for every file), and each file costs a
   * hash on its first share and a walk over the accounts (security review of #1038). The people are checked only once
   * one of the files is one the caller may share (a press of paths nobody may share learns nothing about who exists).
   * Then each person newly given access is told once: one file as before
   * (its own notice), several as one notice of the press ("<name> shared 5 files with you", file_share_batches), pushed
   * when they were added by name.
   */
  shareMany(userId: string, paths: readonly string[], add: readonly Subject[], L: Locale): ShareFilesBatchResult {
    const me = this.principal(userId)
    if (!me || me.role === 'guest') throw new HttpError('not_found')
    const unique = [...new Set(paths)]
    for (let i = 0; i < Math.max(1, Math.ceil(unique.length / BATCH_FILES_PER_TOKEN)); i++) this.takeToken(userId)
    const rules = this.rules()
    const mayAny = unique.some((p) => {
      try {
        const r = authorize(this.ctx.files.fx, rules, me, p, 'read')
        return !!r.st && !r.st.isDirectory() && this.shareRight(me, rules, r.segs).may
      } catch { return false }
    })
    if (mayAny) this.checkSubjects(me, add, L)
    const out: ShareFilesBatchResult = { shared: [], failed: [] }
    const got = new Map<string, string[]>()
    for (const p of unique) {
      try {
        const r = this.change(userId, p, add, [], L, 'dialog', { quiet: true, tokenTaken: true })
        out.shared.push(r.view.path)
        for (const id of r.added) got.set(id, [...(got.get(id) ?? []), r.share.id])
      } catch (e) {
        // the words the single call would answer with (a path the caller cannot read: not found, as there)
        const h = toHttp(e, L)
        if (!(h instanceof HttpError)) throw h
        const body = h.body(L)
        const reason = body.params?.reason
        out.failed.push({ path: p, message: body.message, ...(typeof reason === 'string' ? { reason } : {}) })
      }
    }
    const named = new Set(add.filter((s) => s.subjectType === 'user').map((s) => s.subjectId))
    let batch: string | null = null
    for (const [id, shares] of got) {
      if (shares.length === 1) { this.notify(id, 'file.shared', shares[0]!, true, named.has(id)); continue }
      if (!batch) {
        batch = newLinkId()
        const all = [...new Set([...got.values()].flat())]
        this.db.transaction(() => {
          this.db.query('INSERT INTO file_share_batches (id, by_user, created_at) VALUES (?,?,?)').run(batch, userId, now())
          for (const s of all) this.db.query('INSERT OR IGNORE INTO file_share_batch_items (batch_id, share_id) VALUES (?,?)').run(batch, s)
        })()
      }
      this.notify(id, 'file.shared', `b:${batch}`, true, named.has(id))
    }
    return out
  }
  /** The files of a press that `userId` can open now, for someone the press told (its notice); else not found. */
  batchFiles(userId: string, batchId: string): { by: string | null; files: { share: ShareRow; name: string; size: number }[] } {
    if (!/^[A-Za-z0-9_-]{22}$/.test(batchId)) throw new HttpError('not_found')
    const told = this.db.query("SELECT 1 FROM file_share_notices WHERE user_id = ? AND event_type = 'file.shared' AND source_id = ?").get(userId, `b:${batchId}`)
    const b = told ? this.db.query('SELECT by_user FROM file_share_batches WHERE id = ?').get(batchId) as { by_user: string | null } | null : null
    if (!b) throw new HttpError('not_found')
    const files: { share: ShareRow; name: string; size: number }[] = []
    for (const r of this.db.query('SELECT share_id FROM file_share_batch_items WHERE batch_id = ? ORDER BY rowid').all(batchId) as { share_id: string }[]) {
      const o = this.open(userId, r.share_id)
      if (o.kind === 'open') files.push({ share: o.share, name: o.name, size: o.size })
    }
    const by = b.by_user ? (this.db.query('SELECT name FROM users WHERE id = ? AND deleted_at IS NULL').get(b.by_user) as { name: string } | null)?.name ?? null : null
    return { by, files }
  }
  /** GET /api/files/shared-batch/:id */
  batchPage(userId: string, batchId: string): SharedBatchView {
    const b = this.batchFiles(userId, batchId)
    return { by: b.by, files: b.files.map((f) => ({ linkId: f.share.id, name: plainLabel(f.name, 200), size: f.size })) }
  }
  /** The ids of the active people a grant lets in (people by name, a group's people), not counting folder rules. */
  grantees(shareId: string): Set<string> {
    const out = new Set<string>()
    for (const r of this.db.query(`SELECT u.id FROM file_share_grants g JOIN users u ON u.id = g.subject_id WHERE g.share_id = ? AND g.subject_type = 'user' AND u.status = 'active' AND u.deleted_at IS NULL AND u.guest = 0
        UNION SELECT u.id FROM file_share_grants g JOIN group_members m ON m.group_id = g.subject_id JOIN users u ON u.id = m.user_id WHERE g.share_id = ? AND g.subject_type = 'group' AND u.status = 'active' AND u.deleted_at IS NULL AND u.guest = 0
        UNION SELECT u.id FROM users u WHERE u.status = 'active' AND u.deleted_at IS NULL AND u.guest = 0 AND EXISTS(SELECT 1 FROM file_share_grants g WHERE g.share_id = ? AND g.subject_type = 'group' AND g.subject_id = '${ALL}')`).all(shareId, shareId, shareId) as { id: string }[]) out.add(r.id)
    return out
  }
  grantedTo(shareId: string, userId: string): boolean {
    return !!this.db.query(`SELECT 1 FROM file_share_grants g WHERE g.share_id = ? AND ${REACHES('g')} LIMIT 1`).get(shareId, userId, userId, userId)
  }
  /** Everyone who may open it now (rules and grants), for "who was newly added" */
  private openers(share: ShareRow, segs: string[]): Set<string> {
    const rules = this.rules()
    const out = new Set<string>()
    const ok = this.ownerStillEdits(share, rules, segs)
    const g = ok ? this.grantees(share.id) : new Set<string>()
    for (const u of this.db.query("SELECT id FROM users WHERE status = 'active' AND deleted_at IS NULL AND guest = 0").all() as { id: string }[]) {
      const p = this.principal(u.id)
      if (!p) continue
      if (atLeast(rules.access(p, segs), 'read') || g.has(u.id)) out.add(u.id)
    }
    return out
  }
  /** Grants count while the file's owner (when one is known) can still edit it: an owner who lost access stops sharing. */
  private ownerStillEdits(share: ShareRow, rules: RuleSet, segs: string[], memo?: Map<string, Principal | null>): boolean {
    if (!share.owner_id) return true
    const o = this.principal(share.owner_id, memo)
    return !!o && o.role !== 'guest' && atLeast(rules.access(o, segs), 'write')
  }
  private auditTarget(s: ShareRow) { return `file-share:${s.id}` }
  /** a team file by its path; a personal file never (admins read the audit) */
  private auditPath(s: ShareRow): Record<string, unknown> { return s.path.startsWith('users/') ? { personal: true } : { path: s.path } }

  /** What the link page shows `userId`, and the file to serve when it opens. */
  open(userId: string, id: string): OpenResult {
    const s = this.row(id)
    if (!s) return { kind: 'unknown' }
    const me = this.principal(userId)
    // a guest gets nothing through a link (P1), the same answer as no access
    if (!me || me.role === 'guest') return { kind: 'no_access', share: null }
    if (s.state === 'dead') return { kind: 'no_access', share: s }
    if (s.state === 'trashed') return s.owner_id === me.id ? { kind: 'trashed', share: s } : { kind: 'no_access', share: s }
    // a folder in a person's own files: it opens, or it does not, by its own rules (never a file to serve)
    if (s.kind === 'folder') {
      const f = folderSharesOf(this.ctx).openChild(userId, id, '')
      return f.kind === 'open' ? { kind: 'folder', share: f.row, name: f.name, by: f.by, via: f.via } : { kind: 'no_access', share: this.row(id) }
    }
    const rules = this.rules()
    const r = this.resolve(s.path, rules)
    if (!r || !this.same(s, r.st!, r.abs)) return { kind: 'no_access', share: s }
    const name = baseName(r.rel)
    const by = this.grantOpens(me, rules, s, r.segs, () => this.grantedTo(s.id, me.id))
    if (by === 'rules') return { kind: 'open', share: s, abs: r.abs, st: r.st!, name, size: r.st!.size, by: s.owner_id === me.id ? 'owner' : 'rules' }
    if (by === 'grant') return { kind: 'open', share: s, abs: r.abs, st: r.st!, name, size: r.st!.size, by: 'grant' }
    return { kind: 'no_access', share: s }
  }
  /** Does the share open for `me` (the row live, its file resolved), and how: by the folder rules, by a grant that
   * reaches them (`reach`, asked only when the rules do not open it) while the owner can still edit the file, or not.
   * Pure: open() and Shared with me both decide with it. */
  private grantOpens(me: Principal, rules: RuleSet, s: ShareRow, segs: string[], reach: () => boolean, memo?: Map<string, Principal | null>): 'rules' | 'grant' | null {
    if (atLeast(rules.access(me, segs), 'read')) return 'rules'
    if (reach() && this.ownerStillEdits(s, rules, segs, memo)) return 'grant'
    return null
  }
  /** SQL for grant rows `g` that reach `me`, bound with the server's own Principal.groups (never the request): their own
   * grant, or, unless `namedOnly`, one of a group they are in or the whole team's (an active member who is not a guest:
   * loadPrincipal returns only active accounts, and a guest never gets here) */
  private reachSql(me: Principal, g: string, namedOnly: boolean): { sql: string; args: string[] } {
    const named = `(${g}.subject_type = 'user' AND ${g}.subject_id = ?)`
    if (namedOnly) return { sql: named, args: [me.id] }
    const groups = me.role === 'guest' ? [] : me.groups
    const team = me.role === 'guest' ? '' : ` OR (${g}.subject_type = 'group' AND ${g}.subject_id = '${ALL}')`
    const inGroups = groups.length ? ` OR (${g}.subject_type = 'group' AND ${g}.subject_id IN (${groups.map(() => '?').join(',')}))` : ''
    return { sql: `(${named}${inGroups}${team})`, args: [me.id, ...groups] }
  }
  /**
   * Who shared the share with `me`, as Shared with me and the link page name them (one rule for both, review of the P2
   * plan F5; QA TC-4009): their grant by name when there is one; else, only when the folder rules do not already let
   * `me` read the file (`readable`: a group's or the whole team's grant changes nothing for them then), the newest
   * grant of a group they are in or of the whole team. Shared with me orders its rows by this same grant's time.
   * `name` null: the granter's account is gone ("A former member"). null: no qualifying grant.
   */
  sharerFor(me: Principal, shareId: string, readable: boolean): { name: string | null; at: string } | null {
    const r = this.reachSql(me, 'g', readable)
    const row = this.db.query(`SELECT g.granted_at at, u.name FROM file_share_grants g LEFT JOIN users u ON u.id = g.granted_by AND u.deleted_at IS NULL WHERE g.share_id = ? AND ${r.sql} ORDER BY g.subject_type = 'user' DESC, g.granted_at DESC, g.subject_id DESC LIMIT 1`).get(shareId, ...r.args) as { at: string; name: string | null } | null
    return row ? { name: row.name ?? null, at: row.at } : null
  }

  /**
   * Files › Shared with me (GET /api/files/shared-with-me; docs/decisions/20261116-files-shared-with-me.md): the files a
   * grant gives `userId` now. Listed when a grant reaches them (by name, a group they are in, the whole team), the row
   * is live, its owner (when known) still edits it, it is not theirs, its file is at its path and not plainly another
   * file (pinState ≠ dead; QA TC-4008: nor moved in the app since its last check while looking changed), and — for a
   * file the folder rules already let them read — the grant is by name.
   * Two parts, each newest first by the time of the grant that qualifies the row (sharerFor; QA TC-4009): the files
   * shared with them by name, then the files that reach them only through a group or the whole team (QA TC-4010: no
   * number of Everyone shares can push a by-name share out of reach). Never writes, never hashes, never walks the
   * accounts, never counts: at most SHARED_WITH_ME_SQL_ROWS grant rows (one per file, no grouping over all of them)
   * and SHARED_WITH_ME_LSTATS files looked at per call; `next` is where the call stopped.
   */
  sharedWithMe(userId: string, cursor: string | undefined, limit = SHARED_WITH_ME_MAX): SharedWithMe {
    const me = this.principal(userId)
    if (!me || me.role === 'guest') throw new HttpError('forbidden')
    const after = cursor ? decodeSharedCursor(cursor) : null
    if (cursor && !after) throw new HttpError('validation', 'Bad cursor', { params: { reason: 'cursor' } })
    const max = Math.min(Math.max(1, Math.floor(limit)), SHARED_WITH_ME_MAX)
    const rules = this.rules()
    const memo = new Map<string, Principal | null>([[me.id, me]])
    const items: SharedWithMeItem[] = []
    const cols = `s.${COLS.split(', ').join(', s.')}`
    const notMine = "s.state = 'live' AND (s.owner_id IS NULL OR s.owner_id != ?)"
    const keyset = (k: { at: string | null; id: string | null } | null) => (k?.at ? { sql: ' AND (g.granted_at < ? OR (g.granted_at = ? AND g.share_id < ?))', args: [k.at, k.at, k.id!] } : { sql: '', args: [] as string[] })
    // the groups that reach them: their own groups and the whole team (an active member who is not a guest: a guest
    // never gets here). Bound with the server's Principal.groups, never the request.
    const reach = [...me.groups, ALL]
    const inReach = reach.map(() => '?').join(',')
    let budget = SHARED_WITH_ME_SQL_ROWS
    let looked = 0
    /** Reads one part's rows; listed rows go to `items`. Returns the key of the last row read when the call stops
     * inside this part (a cap reached), else null (the part is done). */
    const scan = (part: 'n' | 'g', k: { at: string | null; id: string | null } | null): { at: string; id: string } | null => {
      const ks = keyset(k)
      const rows = (part === 'n'
        // a person has at most one grant by name per file (the primary key): one row per file, in index order
        ? this.db.query(`SELECT ${cols}, g.granted_at at FROM file_share_grants g JOIN file_shares s ON s.id = g.share_id AND ${notMine}
            WHERE g.subject_type = 'user' AND g.subject_id = ?${ks.sql} ORDER BY g.granted_at DESC, g.share_id DESC LIMIT ${budget}`).all(me.id, me.id, ...ks.args)
        // a file's newest reaching group grant only (the one sharerFor names), and only files with no grant by name to them
        : this.db.query(`SELECT ${cols}, g.granted_at at FROM file_share_grants g JOIN file_shares s ON s.id = g.share_id AND ${notMine}
            WHERE g.subject_type = 'group' AND g.subject_id IN (${inReach})
              AND NOT EXISTS (SELECT 1 FROM file_share_grants n WHERE n.share_id = g.share_id AND n.subject_type = 'user' AND n.subject_id = ?)
              AND NOT EXISTS (SELECT 1 FROM file_share_grants o WHERE o.share_id = g.share_id AND o.subject_type = 'group' AND o.subject_id IN (${inReach})
                AND (o.granted_at > g.granted_at OR (o.granted_at = g.granted_at AND o.subject_id > g.subject_id)))${ks.sql}
            ORDER BY g.granted_at DESC, g.share_id DESC LIMIT ${budget}`).all(me.id, ...reach, me.id, ...reach, ...ks.args)) as (ShareRow & { at: string })[]
      let last: { at: string; id: string } | null = null
      for (const s of rows) {
        if (items.length >= max || looked >= SHARED_WITH_ME_LSTATS) return last ?? (k?.at ? { at: k.at, id: k.id! } : null)
        budget--
        last = { at: s.at, id: s.id }
        const segs = segsOf(s.path)
        // cheapest first: the folder rule in memory, the owner's edit right (memoised), then the disk. A grant reaches
        // them (the SQL), so grantOpens says 'grant' while the owner still edits it. 'rules' (the folder lets them read
        // it): listed only for their grant by name (the first part), and only while that grant counts
        const how = this.grantOpens(me, rules, s, segs, () => true, memo)
        if (how === null) continue
        const readable = how === 'rules'
        if (readable && (part === 'g' || !this.ownerStillEdits(s, rules, segs, memo))) continue
        looked++
        if (s.kind === 'folder') {
          // a shared folder: listed while it would open (its owner active, not paused, a place that may be shared, a
          // folder on disk); the identity check waits for the click
          if (!folderSharesOf(this.ctx).listable(s, memo)) continue
        } else {
          const r = this.resolve(s.path, rules, memo)
          if (!r || !listable(s, r.st!)) continue
        }
        const by = this.sharerFor(me, s.id, readable)
        if (!by) continue
        items.push({ linkId: s.id, name: plainLabel(baseName(s.path), 200), sharedBy: by.name, sharedAt: by.at, ...(s.kind === 'folder' ? { kind: 'folder' as const } : {}) })
      }
      // every row read and the SQL cap reached: more may follow in this part
      return budget <= 0 && last ? last : null
    }
    // a page that stops at the very start of a part (a cap met by the rows before it) reads on from there
    const startOf = (part: 'n' | 'g') => encodeSharedCursor(null, null, part)
    if (!after || after.part === 'n') {
      const stop = scan('n', after)
      if (stop) return { items, next: encodeSharedCursor(stop.at, stop.id, 'n') }
      if (budget <= 0 || items.length >= max || looked >= SHARED_WITH_ME_LSTATS) return { items, next: startOf('g') }
    }
    const stop = scan('g', after?.part === 'g' ? after : null)
    return { items, next: stop ? encodeSharedCursor(stop.at, stop.id, 'g') : null }
  }

  /** GET /api/files/shared/:id. Opening the file marks the caller's own "shared with you" notices of it read (its own,
   * and a press's that holds it): only here, never in open(), which every Inbox row, a press's list and push run. */
  page(userId: string, id: string): SharedFileView {
    const o = this.open(userId, id)
    if (o.kind === 'unknown') return { status: 'unknown' }
    if (o.kind === 'trashed') return { status: 'trashed' }
    if (o.kind === 'folder') {
      this.markRead(userId, o.share.id)
      const me = o.by === 'owner' ? null : this.principal(userId)
      const g = me ? this.sharerFor(me, o.via, false) : null
      return { status: 'open', kind: 'folder', name: o.name, sharedBy: g?.name ?? null, ...(g && !g.name ? { formerSharer: true as const } : {}), mine: o.share.owner_id === userId }
    }
    if (o.kind === 'open') {
      this.markRead(userId, o.share.id)
      const me = o.by === 'owner' ? null : this.principal(userId)
      // "Shared by": the qualifying grant (sharerFor), whether the file opens by a grant or by the folder rules; a grant
      // counts only while the owner can still edit the file
      const g = me && this.ownerStillEdits(o.share, this.rules(), segsOf(o.share.path)) ? this.sharerFor(me, o.share.id, o.by === 'rules') : null
      return { status: 'open', name: o.name, size: o.size, mime: mimeOf(o.name), sharedBy: g?.name ?? null, ...(g && !g.name ? { formerSharer: true as const } : {}), mine: o.share.owner_id === userId }
    }
    const me = this.principal(userId)
    const asked = o.share ? this.db.query("SELECT created_at FROM file_access_requests WHERE share_id = ? AND requester_id = ? AND state = 'pending'").get(o.share.id, userId) as { created_at: string } | null : null
    const stoppedBy = me && me.role !== 'guest' && o.share ? this.stoppedFor(me, o.share.id) : null
    return { status: 'no_access', canAsk: !!me && me.role !== 'guest' && !!o.share && this.requestTargets(o.share).length > 0, askedAt: asked?.created_at ?? null, ...(stoppedBy ? { stoppedBy } : {}) }
  }

  /** Who took `me` off the share (by name, with a group they are in, or with the whole team), newest first: their name,
   * only while no grant reaches `me` again. null: nobody did, or that account is gone. */
  private stoppedFor(me: Principal, shareId: string): string | null {
    const r = this.reachSql(me, 'g', false)
    if (this.db.query(`SELECT 1 FROM file_share_grants g WHERE g.share_id = ? AND ${r.sql} LIMIT 1`).get(shareId, ...r.args)) return null
    const row = this.db.query(`SELECT u.name FROM file_share_stops g JOIN users u ON u.id = g.stopped_by AND u.deleted_at IS NULL WHERE g.share_id = ? AND ${r.sql} ORDER BY g.stopped_at DESC LIMIT 1`).get(shareId, ...r.args) as { name: string } | null
    return row?.name ?? null
  }

  /** Who answers a request on this share: its owner while they can still edit the file and are active (a member only
   * while the team switch is on), else the team owner and admins for a team file. Never for a personal file whose
   * person cannot be asked. */
  private requestTargets(s: ShareRow): string[] {
    const rules = this.rules()
    const segs = segsOf(s.path)
    // a paused folder: nobody is asked until its owner resumes it; a folder that may not be shared: nobody at all
    if (s.kind === 'folder' && (s.paused_at || !folderSharesOf(this.ctx).askable(s))) return []
    if (s.owner_id) {
      const o = this.principal(s.owner_id)
      if (o && o.role !== 'guest' && atLeast(rules.access(o, segs), 'write')) {
        if (isStaff(o) || this.teamOn()) return [o.id]
        if (segs[0] === 'users') return []
      } else if (segs[0] === 'users') return []
    }
    if (segs[0] === 'users') return []
    // (the role as the policy reads it: loadPrincipal, a guest never staff)
    return (this.db.query("SELECT id FROM users WHERE status = 'active' AND deleted_at IS NULL").all() as { id: string }[]).map((r) => r.id).filter((id) => { const p = this.principal(id); return !!p && isStaff(p) })
  }

  /** POST /api/files/shared/:id/request */
  request(userId: string, id: string, message: string | undefined, L: Locale): { status: 'sent' | 'already'; askedAt: string } {
    const o = this.open(userId, id)
    if (o.kind === 'unknown') throw new HttpError('not_found')
    const me = this.principal(userId)
    if (!me || me.role === 'guest' || o.kind !== 'no_access' || !o.share) throw new HttpError('forbidden', msg('requestOff', L), { params: { reason: 'file_request_off' } })
    const s = o.share
    const targets = this.requestTargets(s)
    if (!targets.length) throw new HttpError('forbidden', msg('requestOff', L), { params: { reason: 'file_request_off' } })
    const waiting = this.db.query("SELECT created_at FROM file_access_requests WHERE share_id = ? AND requester_id = ? AND state = 'pending'").get(s.id, userId) as { created_at: string } | null
    if (waiting) return { status: 'already', askedAt: waiting.created_at }
    const t = Date.now()
    // (with the chat and project requests: one set of limits for every ask, chat/access-requests.ts; a request someone
    // else asked for this person, requestFor, is not theirs: asked_by IS NULL)
    const hourAgo = new Date(t - 3600_000).toISOString(), dayAgo = new Date(t - 86400_000).toISOString()
    const hour = (this.db.query('SELECT COUNT(*) n FROM file_access_requests WHERE requester_id = ? AND asked_by IS NULL AND created_at > ?').get(userId, hourAgo) as { n: number }).n
      + (this.db.query('SELECT COUNT(*) n FROM access_requests WHERE requester_id = ? AND created_at > ?').get(userId, hourAgo) as { n: number }).n
    const ownerKey = s.owner_id ?? ''
    const day = (this.db.query('SELECT COUNT(*) n FROM file_access_requests WHERE requester_id = ? AND asked_by IS NULL AND owner_id = ? AND created_at > ?').get(userId, ownerKey, dayAgo) as { n: number }).n
      + (this.db.query('SELECT COUNT(*) n FROM access_requests WHERE requester_id = ? AND owner_id = ? AND created_at > ?').get(userId, ownerKey, dayAgo) as { n: number }).n
    if (hour >= FILE_REQUESTS_PER_HOUR || day >= FILE_REQUESTS_PER_OWNER_DAY) throw new HttpError('rate_limited', msg('tooMany', L), { retryAfter: 3600 })
    const note = message?.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 500) || null
    const rid = newId()
    const at = now()
    this.db.query('INSERT INTO file_access_requests (id, share_id, requester_id, owner_id, message, state, created_at) VALUES (?,?,?,?,?,?,?)').run(rid, s.id, userId, ownerKey, note, 'pending', at)
    audit(this.db, { actor: userId, action: 'file.access_request', target: this.auditTarget(s), detail: { ...this.auditPath(s) } })
    // one Activity row per person and file, brought back up by each new request
    for (const to of targets) this.notify(to, 'file.access_requested', `${s.id}:${userId}`, true)
    return { status: 'sent', askedAt: at }
  }

  /** POST /api/files/requests/:id: Share or Decline by whoever may share the file now. */
  answer(userId: string, requestId: string, answer: 'approve' | 'decline', L: Locale): { state: 'approved' | 'declined' | 'closed' } {
    const q = this.db.query('SELECT id, share_id, requester_id, state, asked_by FROM file_access_requests WHERE id = ?').get(requestId) as { id: string; share_id: string; requester_id: string; state: 'pending' | 'approved' | 'declined' | 'closed'; asked_by: string | null } | null
    if (!q) throw new HttpError('not_found')
    const s = this.row(q.share_id)
    const me = this.principal(userId)
    if (!s || !me) throw new HttpError('not_found')
    // only someone the request went to (or who may share the file now) learns anything about it
    const rules = this.rules()
    const segs = segsOf(s.path)
    const r = s.state === 'live' ? this.resolve(s.path, rules, undefined, s.kind === 'folder') : null
    const may = !!r && this.shareRight(me, rules, segs).may
    const told = !!this.db.query("SELECT 1 FROM file_share_notices WHERE user_id = ? AND event_type = 'file.access_requested' AND source_id = ?").get(userId, `${s.id}:${q.requester_id}`)
    if (!may && !told) throw new HttpError('not_found')
    if (q.state !== 'pending') return { state: q.state }
    // the file gone: the request closes. Someone it went to who may not share the file now (an admin without edit
    // access there) changes nothing: the owner, or whoever may, answers it (review of #979)
    if (!r) {
      this.db.query("UPDATE file_access_requests SET state = 'closed', decided_at = ? WHERE id = ?").run(now(), q.id)
      return { state: 'closed' }
    }
    if (!may) throw new HttpError('forbidden', msg('notOwner', L), { params: { reason: 'file_share_not_owner' } })
    if (answer === 'approve') {
      this.put(userId, s.path, [{ subjectType: 'user', subjectId: q.requester_id }], [], L, 'request')
      this.db.query("UPDATE file_access_requests SET state = 'approved', decided_by = ?, decided_at = ? WHERE id = ? AND state = 'pending'").run(userId, now(), q.id)
      audit(this.db, { actor: userId, action: 'file.access_approved', target: this.auditTarget(s), detail: { ...this.auditPath(s) } })
      return { state: 'approved' }
    }
    this.db.query("UPDATE file_access_requests SET state = 'declined', decided_by = ?, decided_at = ? WHERE id = ?").run(userId, now(), q.id)
    audit(this.db, { actor: userId, action: 'file.access_declined', target: this.auditTarget(s), detail: { ...this.auditPath(s) } })
    // (asked for them by someone else, requestFor: the one who asked is told)
    this.notify(q.asked_by ?? q.requester_id, 'file.access_answered', q.id, false)
    return { state: 'declined' }
  }

  // ---- one-tap next steps (files/share-fixes.ts; docs/decisions/20261116-ai-share-who-can-open.md) ----

  /** The live link row of the file at `rel` (a team path as stored), or null. No access is checked here. */
  liveRow(rel: string): ShareRow | null { return this.liveAt(teamPathOf(rel)) }

  /** The link id of the file at `rel` when it opens for `userId` by a grant and NOT by the folder rules (a path link in
   * a room message, opened by someone the file was shared with): the app then opens /f/<id>. Else null, the same for a
   * path with nothing shared, a file they can read anyway and one they may not open. */
  grantedLinkId(userId: string, rel: string): string | null {
    if (typeof rel !== 'string' || !rel || rel.length > 4096) return null
    const s = this.liveAt(teamPathOf(rel))
    if (!s) return null
    const o = this.open(userId, s.id)
    return o.kind === 'open' && o.by === 'grant' ? s.id : null
  }

  /** Who a request on this share would go to (the owner, else the team owner and admins), for someone who can open
   * the file; none when nobody can be asked. `owner`: it is the file's owner alone. */
  askable(userId: string, shareId: string): { ids: string[]; owner: boolean } {
    const o = this.open(userId, shareId)
    if (o.kind !== 'open') return { ids: [], owner: false }
    const ids = this.requestTargets(o.share).filter((id) => id !== userId)
    return { ids, owner: ids.length === 1 && ids[0] === o.share.owner_id }
  }

  /** Who a request on this share would go to now (requestTargets), with no access check: for a caller that already
   * decided the person may ask (rooms/file-ask.ts: a link in a room message they see). */
  requestTargetsOf(shareId: string): string[] {
    const s = this.row(shareId)
    return s && s.state === 'live' ? this.requestTargets(s) : []
  }

  /**
   * "Ask <owner>" for other people (after a post to a room, or under a refused share): `askerId`, who can open the file
   * but may not share it, asks whoever answers its requests (requestTargets) to give `forIds` view access. One request
   * row per person (asked_by = the asker), so the owner's Share / Decline are the existing ones, and an approval is the
   * existing view-only grant. Only active members who are not guests and cannot open the file now; nobody is added.
   * One ask (all its people) counts once toward the asker's budget (FILE_REQUESTS_PER_HOUR, _PER_OWNER_DAY).
   */
  requestFor(askerId: string, shareId: string, forIds: readonly string[], L: Locale, via: 'ai' | 'dialog' = 'ai'): { asked: string[]; already: string[]; to: string[] } {
    const me = this.principal(askerId)
    const o = this.open(askerId, shareId)
    if (!me || me.role === 'guest' || o.kind !== 'open') throw new HttpError('not_found')
    const s = o.share
    const rules = this.rules()
    const segs = segsOf(s.path)
    // someone who may share it shares it (Let them view): asking is for the others
    if (this.shareRight(me, rules, segs).may) throw new HttpError('conflict', msg('requestOff', L), { params: { reason: 'file_request_can_share' } })
    const to = this.requestTargets(s).filter((id) => id !== askerId)
    if (!to.length) throw new HttpError('forbidden', msg('requestOff', L), { params: { reason: 'file_request_off' } })
    const t = Date.now()
    const ownerKey = s.owner_id ?? ''
    const asks = (since: number, owner?: string) => (this.db.query(`SELECT COUNT(DISTINCT created_at) n FROM file_access_requests WHERE COALESCE(asked_by, requester_id) = ? AND created_at > ?${owner !== undefined ? ' AND owner_id = ?' : ''}`)
      .get(...[askerId, new Date(since).toISOString(), ...(owner !== undefined ? [owner] : [])]) as { n: number }).n
    if (asks(t - 3600_000) >= FILE_REQUESTS_PER_HOUR || asks(t - 86400_000, ownerKey) >= FILE_REQUESTS_PER_OWNER_DAY) throw new HttpError('rate_limited', msg('tooMany', L), { retryAfter: 3600 })
    const at = now()
    const asked: string[] = [], already: string[] = []
    for (const id of [...new Set(forIds)].slice(0, FILE_REQUEST_FOR_MAX)) {
      if (id === askerId) continue
      const p = this.principal(id)
      if (!p || p.role === 'guest') continue
      if (this.grantOpens(p, rules, s, segs, () => this.grantedTo(s.id, id))) continue
      if (this.db.query("SELECT 1 FROM file_access_requests WHERE share_id = ? AND requester_id = ? AND state = 'pending'").get(s.id, id)) { already.push(id); continue }
      this.db.query('INSERT INTO file_access_requests (id, share_id, requester_id, owner_id, message, state, created_at, asked_by) VALUES (?,?,?,?,?,?,?,?)').run(newId(), s.id, id, ownerKey, null, 'pending', at, askerId)
      asked.push(id)
      for (const target of to) this.notify(target, 'file.access_requested', `${s.id}:${id}`, true)
    }
    if (asked.length) audit(this.db, { actor: askerId, action: 'file.access_request', target: this.auditTarget(s), detail: { ...this.auditPath(s), for: asked.length, via } })
    return { asked, already, to }
  }

  /** The owners of shared files whose grants a move removed (sharesNarrowedByMove, inside the move) are told. */
  tellUnshared(list: readonly UnsharedByMove[]): void {
    for (const u of list) if (u.owner) this.notify(u.owner, 'file.unshared_by_move', String(u.auditId), true)
  }

  /** Admin › Team settings: the counts, and the team owner's Remove all. */
  counts(): { files: number; people: number; folders?: number } {
    const n = (kind: 'file' | 'folder') => (this.db.query("SELECT COUNT(DISTINCT g.share_id) n FROM file_share_grants g JOIN file_shares s ON s.id = g.share_id WHERE s.state = 'live' AND s.kind = ?").get(kind) as { n: number }).n
    // files and folders are counted apart
    const files = n('file'), folders = n('folder')
    let people = 0
    for (const r of this.db.query("SELECT DISTINCT g.share_id id FROM file_share_grants g JOIN file_shares s ON s.id = g.share_id WHERE s.state = 'live'").all() as { id: string }[]) people += this.grantees(r.id).size
    return { files, people, folders }
  }
  removeAll(userId: string, L: Locale): { files: number; people: number; folders?: number } {
    const me = this.principal(userId)
    if (!me || me.role !== 'owner') throw new HttpError('forbidden', msg('ownerOnly', L), { params: { reason: 'owner_only' } })
    const c = this.counts()
    // the people folder shares let in: fresh engine sessions once their grants are gone (files/folder-shares.ts)
    const lost = new Set<string>()
    for (const r of this.db.query("SELECT DISTINCT g.share_id id FROM file_share_grants g JOIN file_shares s ON s.id = g.share_id WHERE s.kind = 'folder'").all() as { id: string }[]) for (const u of this.grantees(r.id)) lost.add(u)
    this.db.transaction(() => {
      this.db.query('DELETE FROM file_share_grants').run()
      this.db.query("UPDATE file_access_requests SET state = 'closed', decided_by = ?, decided_at = ? WHERE state = 'pending'").run(userId, now())
      // a removal made before this can no longer be undone
      undosClosed(this.db)
    })()
    folderReadersLost(this.db, lost)
    audit(this.db, { actor: userId, action: 'file.shares_removed_all', target: null, detail: { files: c.files, people: c.people, ...(c.folders !== undefined ? { folders: c.folders } : {}) } })
    this.changedSoon()
    return c
  }

  // ---------------- Activity ----------------
  /** The caller's unread "shared with you" notices of this share, and of every press that holds it, turn read. */
  markRead(userId: string, shareId: string) {
    try {
      const n = this.db.query(`UPDATE file_share_notices SET read_at = ? WHERE user_id = ? AND event_type = 'file.shared' AND read_at IS NULL
          AND (source_id = ? OR source_id IN (SELECT 'b:' || batch_id FROM file_share_batch_items WHERE share_id = ?))`).run(now(), userId, shareId, shareId).changes
      if (n) notificationsOf(this.ctx).changed(userId)
    } catch (err) { this.ctx.log.warn('file share notice read failed', { err }) }
  }
  notify(to: string, event: 'file.shared' | 'file.access_requested' | 'file.access_answered' | 'file.unshared_by_move', source: string, rearm: boolean, named = false) {
    try {
      notificationsOf(this.ctx).fileShareNotice(to, event, source, rearm, named)
    } catch (err) { this.ctx.log.warn('file share notice failed', { err }) }
  }

  // ---- the recipient's AI (docs/decisions/20261116-shared-files-for-the-ai.md) ----

  /** A file shared with `userId` by a grant, for their AI's read tools, named by its team path: the file as the
   * owner's side resolves it (the link's own checks: live, the same file, the owner still edits it, never a guest), or
   * null. Only a file the folder rules do NOT let them read (those take the normal path); never a folder; view only
   * (nothing here writes). */
  grantedFile(userId: string, input: string): Authorized | null {
    if (typeof input !== 'string' || !input || linkIdOf(input)) return null
    const s = this.liveAt(teamPathOf(input))
    if (!s) return null
    const o = this.open(userId, s.id)
    return o.kind === 'open' && o.by === 'grant' ? this.resolve(s.path, this.rules()) : null
  }

  /** The file behind a file link (/f/<id>, any origin) the AI was given, when it opens for `userId` now (by the folder
   * rules or a grant, as the link page decides), or null. */
  fileOfLink(userId: string, input: string): Authorized | null {
    const id = typeof input === 'string' ? linkIdOf(input) : null
    if (!id) return null
    const o = this.open(userId, id)
    return o.kind === 'open' ? this.resolve(o.share.path, this.rules()) : null
  }

  /** The files shared with `userId` by a grant (their own, a group's, or the whole team's) that open for them now and that the folder
   * rules do not already show them, the most recently shared first, at most `max`. For the AI's turn context. */
  sharedWith(userId: string, max = SHARED_WITH_MAX): { files: SharedWithFile[]; more: boolean } {
    // (SQLite: with MAX(), the bare columns are the newest grant's that reaches the person)
    const rows = this.db.query(`SELECT g.share_id id, MAX(g.granted_at) at, g.granted_by gb, g.subject_type st, g.subject_id sid
      FROM file_share_grants g JOIN file_shares s ON s.id = g.share_id
      WHERE s.state = 'live' AND ${REACHES('g')}
      GROUP BY g.share_id ORDER BY at DESC, g.share_id LIMIT ?`).all(userId, userId, userId, SHARED_WITH_SCAN) as { id: string; at: string; gb: string; st: 'user' | 'group'; sid: string }[]
    // shared with them or a group of theirs first, then the whole team's (everyone's shares cannot push out the
    // person's own); files the folder rules already show are skipped, so the scan goes on until `max` are found
    rows.sort((x, y) => Number(x.st === 'group' && x.sid === ALL) - Number(y.st === 'group' && y.sid === ALL))
    const files: SharedWithFile[] = []
    let more = rows.length >= SHARED_WITH_SCAN
    for (const r of rows) {
      const o = this.open(userId, r.id)
      if (o.kind !== 'open' || o.by !== 'grant') continue
      if (files.length >= max) { more = true; break }
      const by = this.db.query('SELECT name FROM users WHERE id = ? AND deleted_at IS NULL').get(r.gb) as { name: string } | null
      const grp = r.st === 'group' && r.sid !== ALL ? this.db.query('SELECT name FROM groups WHERE id = ?').get(r.sid) as { name: string } | null : null
      const to: SharedWithFile['to'] = r.st === 'user' ? { kind: 'you' } : r.sid === ALL ? { kind: 'everyone' } : { kind: 'group', name: grp?.name ?? '' }
      files.push({ id: r.id, name: o.name, url: fileLinkUrl(r.id), sharedBy: by?.name ?? null, at: r.at, to })
    }
    return { files, more }
  }

  /** An access request notice's source (`<shareId>:<requesterId>`) as its receiver sees it now: the live share, the
   * newest request of that person for it, and whether the receiver may answer it now (Share / Decline). Null: the share,
   * the request or the receiver is gone, or the file is no longer where it was. Reads only. */
  private askedOf(userId: string, sourceId: string) {
    const [shareId, requester] = sourceId.split(':')
    const s = shareId ? this.row(shareId) : null
    const q = s && requester ? this.db.query('SELECT id, message, state, asked_by FROM file_access_requests WHERE share_id = ? AND requester_id = ? ORDER BY created_at DESC LIMIT 1').get(s.id, requester) as { id: string; message: string | null; state: 'pending' | 'approved' | 'declined' | 'closed'; asked_by: string | null } | null : null
    const me = this.principal(userId)
    if (!s || !q || !requester || !me || s.state !== 'live') return null
    const rules = this.rules()
    const r = this.resolve(s.path, rules, undefined, s.kind === 'folder')
    if (!r) return null
    return { share: s, request: q, requester, may: this.shareRight(me, rules, r.segs).may }
  }
  /** The file at `path` is inside a live team project (projects/<name>/…) whose folder `personId` cannot open now. */
  private outsideProject(path: string, personId: string): boolean {
    const segs = segsOf(path)
    if (segs[0] !== 'projects' || segs.length < 3) return false
    const folder = segs.slice(0, 2).join('/')
    if (!this.db.query('SELECT 1 FROM projects WHERE folder_path = ? AND trashed_with IS NULL').get(folder)) return false
    const p = this.principal(personId)
    if (!p) return false
    try { authorize(this.ctx.files.fx, this.rules(), p, folder, 'read'); return false } catch { return true }
  }
  /** The push of an access request (files/share-push.ts): only while the request still waits and this person may answer
   * it now, and the asker's account is still active (an admin or the owner answered, the file went, the person lost the
   * right to share it, the asker was switched off: no push). */
  requestWaitsOn(userId: string, sourceId: string): boolean {
    const a = this.askedOf(userId, sourceId)
    if (!a || !a.may || a.request.state !== 'pending') return false
    // an asker switched off or removed meanwhile: nobody waits any more (the Activity row stays as it is)
    return !!this.db.query("SELECT 1 FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL").get(a.requester)
  }

  /** A "shared with you" notice whose file no longer opens for its reader (docs/decisions/20261120-file-share-gone-notice.md):
   * who shared it while their account is there, and why when the server recorded it: `stopped` (the reader was taken
   * off, by name, with a group or the whole team, after this share), `deleted` (the file is in the trash), `moved` (a
   * move put it where the reader cannot open it, or ended the folder share). Anything else (the owner lost edit access,
   * the file changed or went outside the app, a folder's access was narrowed) has no reason. Never the file's name or
   * link. Reads only. */
  private goneShare(row: { user_id: string; created_at: string }, s: ShareRow | null): NonNullable<InboxNotification['fileShare']> {
    const out = { by: null as string | null, name: null, linkId: null, gone: true as const }
    if (!s) return out
    const name = (id: string | null) => id ? (this.db.query('SELECT name FROM users WHERE id = ? AND deleted_at IS NULL').get(id) as { name: string } | null)?.name ?? null : null
    const me = this.principal(row.user_id)
    const reach = me && me.role !== 'guest' ? this.reachSql(me, 'g', false) : null
    // who shared it with me: the grant that still reaches me, else the share press (or folder add) that made this notice
    const g = reach ? this.db.query(`SELECT g.granted_by FROM file_share_grants g WHERE g.share_id = ? AND ${reach.sql} ORDER BY g.granted_at LIMIT 1`).get(s.id, ...reach.args) as { granted_by: string } | null : null
    const a = g ? null : this.db.query("SELECT actor_id FROM audit_log WHERE target = ? AND action IN ('file.share', 'folder_share.add') AND at <= ? ORDER BY id DESC LIMIT 1").get(this.auditTarget(s), row.created_at) as { actor_id: string | null } | null
    const by = name(g?.granted_by ?? a?.actor_id ?? null)
    const folder = s.kind === 'folder' ? { folder: 'shared' as const } : {}
    let why: 'stopped' | 'deleted' | 'moved' | null = null
    if (s.state === 'trashed') why = 'deleted'
    else if (s.state === 'live' && reach && !g) {
      if (this.db.query(`SELECT 1 FROM file_share_stops g WHERE g.share_id = ? AND ${reach.sql} AND g.stopped_at >= ? LIMIT 1`).get(s.id, ...reach.args, row.created_at)) why = 'stopped'
      else if (this.db.query(`SELECT 1 FROM audit_log WHERE target = ? AND at >= ? AND ((action = 'file.unshare' AND json_extract(detail, '$.reason') = 'moved_narrower')
          OR (action = 'folder_share.ended' AND json_extract(detail, '$.reason') IN ('moved_excluded', 'left_personal', 'project'))) LIMIT 1`).get(this.auditTarget(s), row.created_at)) why = 'moved'
    }
    return { ...out, by, ...folder, ...(why ? { why } : {}) }
  }

  /** An Activity row's details for its viewer (notifications/service.ts out). Names read now; nothing about the file
   * once it is gone or the viewer may no longer see it. */
  noticeOut(row: { id: string; user_id: string; event_type: string; source_id: string; created_at: string; read_at: string | null }): InboxNotification {
    const base = { id: row.id, eventType: row.event_type as InboxNotification['eventType'], sourceId: row.source_id, code: row.event_type as InboxNotification['code'], createdAt: row.created_at, readAt: row.read_at, chatId: null, outcome: null }
    const name = (id: string | null) => id ? (this.db.query('SELECT name FROM users WHERE id = ? AND deleted_at IS NULL').get(id) as { name: string } | null)?.name ?? null : null
    const gone = { ...base, link: null, fileShare: { by: null, name: null, linkId: null, gone: true as const } }
    if (row.event_type === 'file.access_answered') return { ...base, link: null, fileShare: { by: null, name: null, linkId: null, state: 'declined' } }
    if (row.event_type === 'file.shared' && row.source_id.startsWith('b:')) {
      // several files in one press: how many of them open for me now, and who pressed (one file left: that file's row)
      let b: ReturnType<FileShares['batchFiles']>
      try { b = this.batchFiles(row.user_id, row.source_id.slice(2)) } catch { return gone }
      // none opens now: who pressed, while their account is there (never a file's name)
      if (!b.files.length) return { ...gone, fileShare: { ...gone.fileShare, by: b.by } }
      if (b.files.length === 1) return { ...base, link: 'file', fileShare: { by: b.by, name: plainLabel(b.files[0]!.name, 120), linkId: b.files[0]!.share.id } }
      return { ...base, link: 'file', fileShare: { by: b.by, name: null, linkId: null, count: b.files.length, batchId: row.source_id.slice(2) } }
    }
    if (row.event_type === 'file.shared') {
      const s = this.row(row.source_id)
      const o = s ? this.open(row.user_id, s.id) : null
      if (s && o?.kind === 'folder') {
        const g = this.db.query(`SELECT g.granted_by FROM file_share_grants g WHERE g.share_id = ? AND ${REACHES('g')} ORDER BY g.granted_at LIMIT 1`).get(o.via, row.user_id, row.user_id, row.user_id) as { granted_by: string } | null
        return { ...base, link: 'file', fileShare: { by: name(g?.granted_by ?? null), name: plainLabel(o.name, 120), linkId: s.id, folder: 'shared' } }
      }
      if (!s || o?.kind !== 'open') return { ...gone, fileShare: this.goneShare(row, s) }
      // who gave THIS person access: their own grant, or the one of a group they are in (the earliest)
      const g = this.db.query(`SELECT g.granted_by FROM file_share_grants g WHERE g.share_id = ? AND ${REACHES('g')} ORDER BY g.granted_at LIMIT 1`).get(s.id, row.user_id, row.user_id, row.user_id) as { granted_by: string } | null
      return { ...base, link: 'file', fileShare: { by: name(g?.granted_by ?? null), name: plainLabel(o.name, 120), linkId: s.id } }
    }
    if (row.event_type === 'file.access_requested') {
      const a = this.askedOf(row.user_id, row.source_id)
      if (!a || (!a.may && a.share.owner_id !== row.user_id)) return gone
      const { share: s, request: q, requester, may } = a
      // asked for the person by someone else (requestFor): `by` is who asked, `for` who would get it
      const forName = q.asked_by ? name(requester ?? null) : null
      const answerable = may && q.state === 'pending'
      // (the card's line under Share: the person is not in the team project the file is in, so only this file opens)
      const outside = answerable && this.outsideProject(s.path, requester)
      return { ...base, link: 'file', fileShare: { by: name(q.asked_by ?? requester ?? null), name: plainLabel(baseName(s.path), 120), linkId: s.id, ...(forName ? { for: plainLabel(forName, 120) } : {}), ...(q.message ? { note: q.message } : {}), requestId: q.id, state: q.state, ...(answerable ? { canAnswer: true as const } : {}), ...(outside ? { outside: 'project' as const } : {}) } }
    }
    if (row.event_type === 'file.unshared_by_move') {
      const a = this.db.query('SELECT actor_id, action, target FROM audit_log WHERE id = ?').get(Number(row.source_id)) as { actor_id: string | null; action: string; target: string | null } | null
      const s = a?.target?.startsWith('file-share:') ? this.row(a.target.slice('file-share:'.length)) : null
      // the owner's own folder: sharing paused (the folder is not the one shared) or ended (their move); its name is theirs
      if (a && s && s.kind === 'folder' && (a.action === 'folder_share.paused' || a.action === 'folder_share.ended')) {
        if (s.owner_id !== row.user_id) return gone
        const paused = a.action === 'folder_share.paused'
        if (paused && (s.state !== 'live' || !s.paused_at)) return gone
        return { ...base, link: paused ? 'file' : null, fileShare: { by: null, name: plainLabel(baseName(s.path), 120), linkId: paused ? s.id : null, folder: paused ? 'paused' : 'ended' } }
      }
      const o = s ? this.open(row.user_id, s.id) : null
      if (!a || !s || o?.kind !== 'open') return { ...gone, fileShare: { ...gone.fileShare, by: name(a?.actor_id ?? null) } }
      return { ...base, link: 'file', fileShare: { by: name(a.actor_id), name: plainLabel(o.name, 120), linkId: s.id } }
    }
    return gone
  }
}
