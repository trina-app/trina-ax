// The file screen (design tab 4 "파일", tab 2 "동시 수정"): tree, text content, save, folders, move / rename,
// trash, version history. Every path goes through authorize() (policy/authorize.ts) with the caller's own rules;
// what the caller may not read looks exactly like what does not exist.
import fs from 'node:fs'
import path from 'node:path'
import type { FileChange, FileContent, FileEntry, FileVersion, Page, SaveResult, TrashItem, TreeResponse, UserRef } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { teamDefaultLocale } from '../admin/settings'
import { newId } from '../db'
import { ext, isOffice } from '../files/extract'
import { atomicWrite, conflictCopyName, fileEvent, readRegular, recordConflictCopy, saveVersion, sha256 } from '../files/store'
import { HttpError } from '../http/errors'
import { atLeast, RuleSet, type Principal } from '../policy/access'
import { authorize, siblingVisible, type Authorized } from '../policy/authorize'
import { Denied, ToolError } from '../policy/errors'
import { badSegment, hiddenEntry } from '../policy/names'
import { verifyChain } from '../policy/resolve'
import { getTeamSettings } from '../admin/settings'
import { PRODUCT } from '@mycel/shared'
import { publishChanges } from './changes'
import { fileError } from './errors'
import { checkRegular, copyTeamFile, freeName, hashFile, installFile, moveIntoTrash, restoredName, snapshotVersion, splitExt, treeSize } from './place'
import crypto from 'node:crypto'

/** Files the file screen treats as binary (rendered by the client from /download, never edited as text). */
const BINARY_EXT = new Set(['docx', 'doc', 'pptx', 'ppt', 'xlsx', 'xls', 'odt', 'ods', 'odp', 'pdf', 'hwp', 'hwpx', 'zip', 'gz', 'tgz', '7z', 'rar',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tiff', 'ico', 'mp3', 'm4a', 'wav', 'ogg', 'flac', 'aac', 'webm', 'mp4', 'mov', 'avi', 'mkv',
  'woff', 'woff2', 'ttf', 'otf', 'exe', 'dmg', 'pkg', 'bin', 'sqlite', 'db', 'key', 'numbers', 'pages'])
export const DEFAULT_CONTENT_BYTES = 2 * 1024 * 1024
/** design tab 4: copy takes files up to 2 GB; sharing a project folder copies at most 1,000 files / 500 MB */
export const COPY_MAX_BYTES = 2 * 1024 ** 3
export const SHARE_MAX_FILES = 1000
export const SHARE_MAX_BYTES = 500 * 1024 ** 2
const DAY = 86_400_000

export const mimeOf = (name: string): string | null => {
  const t = Bun.file(name).type
  return t && t !== 'application/octet-stream' ? t : (ext(name) ? 'application/octet-stream' : null)
}
const segsOf = (rel: string) => (rel === '' ? [] : rel.split('/'))
const isUnder = (anc: string, p: string) => anc === '' ? p !== '' : p.startsWith(anc + '/')
const iso = (ms: number) => new Date(ms).toISOString()

interface VersionRow { id: string; path: string; version: number; sha256: string; size: number; author_id: string | null; turn_id: string | null; kind: FileVersion['kind']; conflict_path: string | null; storage_path: string | null; created_at: string; folder_id: string | null; path_at_save: string | null }
interface TrashRow { id: string; original_path: string; storage_path: string; size: number; deleted_by: string; turn_id: string | null; deleted_at: string; purge_at: string; kind: 'file' | 'folder'; folder_id: string | null }

export interface Actor { userId: string; turnId?: string | null }

export class TeamFiles {
  /** sha256 by (path, inode, size, mtime) so repeated previews of big files don't re-hash */
  private shaCache = new Map<string, string>()
  constructor(readonly ctx: AppContext) {}

  get root() { return this.ctx.files.fx.root }
  get fx() { return this.ctx.files.fx }
  rules() { return RuleSet.load(this.ctx.db) }
  principal(userId: string): Principal { return this.ctx.files.principal(userId) }

  // ---------------- entries ----------------
  entry(user: Principal, rules: RuleSet, segs: string[], st?: fs.Stats): FileEntry {
    const abs = path.join(this.root, ...segs)
    const s = st ?? fs.lstatSync(abs)
    const folder = s.isDirectory()
    return {
      name: segs[segs.length - 1] ?? '',
      path: segs.join('/'),
      type: folder ? 'folder' : 'file',
      size: folder ? null : s.size,
      mtime: s.mtime.toISOString(),
      mime: folder ? null : mimeOf(segs[segs.length - 1] ?? ''),
      access: rules.access(user, segs),
    }
  }
  private userRefs(ids: (string | null)[]): Map<string, UserRef> {
    const want = [...new Set(ids.filter((x): x is string => !!x))]
    const m = new Map<string, UserRef>()
    if (!want.length) return m
    const rows = this.ctx.db.query(`SELECT id, name FROM users WHERE id IN (${want.map(() => '?').join(',')})`).all(...want) as UserRef[]
    for (const r of rows) m.set(r.id, { id: r.id, name: r.name })
    return m
  }
  /** `before`: the rules loaded before a change that moved folders rows (see changes.ts) */
  private publish(changes: FileChange[], before?: RuleSet) { publishChanges(this.ctx, changes, before) }
  private by(userId: string): UserRef { const u = this.userRefs([userId]).get(userId); return u ?? { id: userId, name: userId } }

  // ---------------- tree ----------------
  tree(userId: string, rel: string, cursor: string | undefined, limit = 200): TreeResponse {
    const user = this.principal(userId)
    const rules = this.rules()
    const r = authorize(this.fx, rules, user, rel, 'list')
    if (!r.st!.isDirectory()) throw new ToolError(`'${r.rel}' is a file`, 'not_folder')
    const out: FileEntry[] = []
    for (const e of fs.readdirSync(r.abs, { withFileTypes: true })) {
      if (hiddenEntry(e.name, r.segs.length) || badSegment(e.name) || e.isSymbolicLink()) continue
      const c = [...r.segs, e.name]
      let st: fs.Stats
      try { st = fs.lstatSync(path.join(r.abs, e.name)) } catch { continue }
      if (st.isDirectory()) { if (rules.canList(user, c)) out.push(this.entry(user, rules, c, st)) }
      else if (st.isFile() && st.nlink === 1 && atLeast(rules.access(user, c), 'read')) out.push(this.entry(user, rules, c, st))
    }
    const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
    out.sort((a, b) => (a.type === b.type ? coll.compare(a.name, b.name) : a.type === 'folder' ? -1 : 1))
    const start = decodeCursor(cursor)
    const items = out.slice(start, start + limit)
    return { path: r.rel, access: rules.access(user, r.segs), entries: items, nextCursor: start + limit < out.length ? encodeCursor(start + limit) : null }
  }

  // ---------------- content ----------------
  async content(userId: string, rel: string, maxBytes = DEFAULT_CONTENT_BYTES): Promise<FileContent> {
    const user = this.principal(userId)
    const rules = this.rules()
    const r = authorize(this.fx, rules, user, rel, 'read')
    if (r.st!.isDirectory()) throw new ToolError('folder', 'is_folder')
    const st = checkRegular(r.abs)
    const sha = await this.sha(r.abs, st)
    const base = { path: r.rel, size: st.size, mtime: st.mtime.toISOString(), sha256: sha, mime: mimeOf(r.rel), access: rules.access(user, r.segs) }
    if (BINARY_EXT.has(ext(r.rel))) return { ...base, binary: true, content: null, truncated: false }
    const n = Math.min(st.size, maxBytes)
    const buf = Buffer.alloc(n)
    const fd = fs.openSync(r.abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try { let off = 0; while (off < n) { const k = fs.readSync(fd, buf, off, n - off, off); if (k <= 0) break; off += k } } finally { fs.closeSync(fd) }
    if (buf.subarray(0, 8000).includes(0)) return { ...base, binary: true, content: null, truncated: false }
    const truncated = st.size > maxBytes
    // a multi-byte character cut at the limit is dropped (on the bytes: a regex over the decoded text was quadratic
    // for files full of invalid UTF-8)
    const text = new TextDecoder('utf-8').decode(truncated ? buf.subarray(0, utf8Boundary(buf, n)) : buf)
    return { ...base, binary: false, content: text, truncated }
  }

  /** A readable regular file for the download endpoint. */
  fileForDownload(userId: string, rel: string): { abs: string; name: string } {
    const r = authorize(this.fx, this.rules(), this.principal(userId), rel, 'read')
    if (r.st!.isDirectory()) throw new ToolError('folder', 'is_folder')
    checkRegular(r.abs)
    return { abs: r.abs, name: r.segs[r.segs.length - 1]! }
  }

  private async sha(abs: string, st: fs.Stats): Promise<string> {
    const k = `${abs}\0${st.ino}\0${st.size}\0${st.mtimeMs}`
    const hit = this.shaCache.get(k)
    if (hit) return hit
    const h = await hashFile(abs)
    this.shaCache.set(k, h)
    if (this.shaCache.size > 1000) this.shaCache.delete(this.shaCache.keys().next().value!)
    return h
  }

  // ---------------- save (text) ----------------
  save(userId: string, rel: string, content: string, baseSha: string | null): SaveResult {
    const user = this.principal(userId)
    const rules = this.rules()
    const r = authorize(this.fx, rules, user, rel, 'write', { createDirs: true })
    if (BINARY_EXT.has(ext(r.rel)) || isOffice(r.rel)) fileError('validation', 'notText', { path: r.rel })
    const data = Buffer.from(content, 'utf8')
    const ndata = sha256(data)
    if (r.exists) {
      if (r.st!.isDirectory()) throw new ToolError('folder', 'is_folder')
      const cur = readRegular(r.abs).bytes
      const csha = sha256(cur)
      if (csha === ndata) return { path: r.rel, conflict: false, entry: this.entry(user, rules, r.segs) }
      if (baseSha === null || baseSha !== csha) return this.conflictCopy(user, rules, r, data)
      saveVersion(this.ctx.db, this.root, r.rel, cur, { userId, turnId: null })
      atomicWrite(this.root, r.segs, data)
      fileEvent(this.ctx.db, { turnId: null, userId, path: r.rel, action: 'update', size: data.length, sha256: ndata, detail: { tool: 'file-screen' } })
      this.publish([{ path: r.rel, action: 'update', by: this.by(userId), turnId: null }])
    } else {
      atomicWrite(this.root, r.segs, data, { createDirs: true })
      fileEvent(this.ctx.db, { turnId: null, userId, path: r.rel, action: 'create', size: data.length, sha256: ndata, detail: { tool: 'file-screen' } })
      this.publish([{ path: r.rel, action: 'create', by: this.by(userId), turnId: null }])
    }
    return { path: r.rel, conflict: false, entry: this.entry(user, rules, r.segs) }
  }

  /** Someone changed the file since the editor loaded it: keep the original, save "name (충돌 사본 - 사람 날짜 HH.mm).ext". */
  private conflictCopy(user: Principal, rules: RuleSet, r: Authorized, data: Buffer): SaveResult {
    const dir = r.segs.slice(0, -1)
    const dirAbs = path.join(this.root, ...dir)
    let name = conflictCopyName(r.segs[r.segs.length - 1]!, user.name, new Date(), teamDefaultLocale(this.ctx.db))
    if (badSegment(name)) name = `conflict-${Date.now()}-${r.segs[r.segs.length - 1]}`
    name = freeName(dirAbs, name)
    const copy = [...dir, name]
    atomicWrite(this.root, copy, data)
    const copyRel = copy.join('/')
    recordConflictCopy(this.ctx.db, this.ctx.files.events, { original: r.rel, copy: copyRel, userId: user.id, turnId: null, size: data.length, sha256: sha256(data), tool: 'file-screen' })
    fileEvent(this.ctx.db, { turnId: null, userId: user.id, path: copyRel, action: 'create', size: data.length, sha256: sha256(data), detail: { conflictCopyOf: r.rel } })
    this.publish([{ path: copyRel, action: 'create', by: this.by(user.id), turnId: null }])
    return { path: copyRel, conflict: true, entry: this.entry(user, rules, copy) }
  }

  // ---------------- folders ----------------
  mkdir(userId: string, rel: string): FileEntry {
    const user = this.principal(userId)
    const rules = this.rules()
    const r = authorize(this.fx, rules, user, rel, 'write', { mustExist: false })
    if (r.exists) fileError('conflict', 'exists', { path: r.rel })
    fs.mkdirSync(r.abs, { mode: 0o700 })
    verifyChain(this.root, r.segs)
    fileEvent(this.ctx.db, { turnId: null, userId, path: r.rel, action: 'create', detail: { folder: true, tool: 'file-screen' } })
    this.publish([{ path: r.rel, action: 'mkdir', by: this.by(userId), turnId: null }])
    return this.entry(user, rules, r.segs)
  }

  /** root, users/, users/<id>/ and .system/ never move or go to the trash */
  private assertMovable(segs: string[]) {
    if (segs.length === 0 || (segs[0] === 'users' && segs.length <= 2) || segs[0] === PRODUCT.systemDir) fileError('forbidden', 'protectedFolder')
  }
  /** A folder may move / go to the trash only if the caller can write every rule folder inside it: otherwise
   * moving it under users/<me>/ (where rules don't apply) or deleting it would reach what they cannot see. */
  private assertSubtreeWritable(user: Principal, rules: RuleSet, segs: string[]) {
    const base = segs.join('/')
    for (const f of rules.ruleFolders()) if (isUnder(base, f) && rules.access(user, segsOf(f)) !== 'write') fileError('forbidden', 'hiddenInside')
    const rows = this.ctx.db.query('SELECT path FROM folders').all() as { path: string }[]
    for (const f of rows) if (isUnder(base, f.path) && rules.access(user, segsOf(f.path)) !== 'write') fileError('forbidden', 'hiddenInside')
  }

  /**
   * true when `base` or something below it is a managed folder: a rule folder, a group's folder, shared/, skills/, or a
   * folder a project uses. Design tab 4 move/delete: those move, are renamed and go to the trash only by an admin or the
   * owner, and never move under users/ (rules there are not read, tab 2 rule 3). A rule-less folders row no project
   * uses any more (the project was deleted or moved elsewhere) does not count: it would lock an ordinary folder, its
   * author's included, for good (security review r2).
   */
  private managedInside(rules: RuleSet, base: string): boolean {
    if (rules.ruleFolders().some((f) => f === base || isUnder(base, f))) return true
    return this.managedRows(base, base)
  }
  /** Is one of the folders rows at or below `rowPrefix` managed? `livePrefix`: the path `rowPrefix` stands for
   * (differs for rows parked with a trashed folder, whose projects still name the path it had). */
  private managedRows(rowPrefix: string, livePrefix: string): boolean {
    const db = this.ctx.db
    const rows = db.query("SELECT id, path FROM folders WHERE path = ? OR substr(path, 1, length(?) + 1) = ? || '/'").all(rowPrefix, rowPrefix, rowPrefix) as { id: string; path: string }[]
    for (const f of rows) {
      const live = livePrefix + f.path.slice(rowPrefix.length)
      if (live === 'shared' || live === 'skills') return true
      if (db.query('SELECT 1 FROM folder_rules WHERE folder_id = ? LIMIT 1').get(f.id)) return true
      if (db.query('SELECT 1 FROM groups WHERE folder_id = ? LIMIT 1').get(f.id)) return true
    }
    // a project's folder (with or without a marker row: a project repointed by an admin has none); personal projects
    // live under users/<me>/, where nothing is managed
    if (livePrefix === 'users' || livePrefix.startsWith('users/')) return false
    return !!db.query(`SELECT 1 FROM projects WHERE substr(folder_path, 1, 6) <> 'users/' AND (${livePrefix === '' ? "folder_path <> ''" : "folder_path = ?1 OR substr(folder_path, 1, length(?1) + 1) = ?1 || '/'"}) LIMIT 1`)
      .get(...(livePrefix === '' ? [] : [livePrefix]))
  }
  private assertMayChangeManaged(user: Principal, rules: RuleSet, base: string): boolean {
    const managed = this.managedInside(rules, base)
    if (managed && user.role !== 'owner' && user.role !== 'admin') fileError('forbidden', 'ruleFolder')
    return managed
  }
  /** Active people other than `self` who can read `from` now but could not read `to` (counted, never named). */
  private lostViewers(rules: RuleSet, self: string, from: string[], to: string[]): number {
    let n = 0
    for (const p of activePeople(this.ctx.db)) {
      if (p.id === self) continue
      if (atLeast(rules.access(p, from), 'read') && !atLeast(rules.access(p, to), 'read')) n++
    }
    return n
  }

  // ---------------- move / rename ----------------
  move(userId: string, from: string, to: string, onExists: 'fail' | 'rename', o: { confirm?: boolean } = {}): { entry: FileEntry } {
    const user = this.principal(userId)
    const rules = this.rules()
    const fr = authorize(this.fx, rules, user, from, 'write', { mustExist: true })
    this.assertMovable(fr.segs)
    // a group / project / rule folder (or one holding such a folder): admins and the owner only, renames included
    const managed = this.assertMayChangeManaged(user, rules, fr.rel)
    const isDir = fr.st!.isDirectory()
    if (!isDir) checkRegular(fr.abs)
    let tr = authorize(this.fx, rules, user, to, 'write', { mustExist: false })
    const typed = segsOf(to.normalize('NFC'))
    let target: string[]
    if (tr.exists && tr.rel === fr.rel) {
      // same entry: case-only / Unicode-form rename on a case-insensitive volume
      target = [...fr.segs.slice(0, -1), typed[typed.length - 1]!]
      if (target.join('/') === fr.rel) return { entry: this.entry(user, rules, fr.segs) }
    } else {
      if (tr.exists) {
        if (onExists === 'fail') fileError('conflict', 'exists', { to: tr.rel })
        const parent = tr.segs.slice(0, -1)
        const free = freeName(path.join(this.root, ...parent), tr.segs[tr.segs.length - 1]!, isDir, (n) => siblingVisible(this.fx, rules, user, parent, n))
        tr = authorize(this.fx, rules, user, [...parent, free].join('/'), 'write', { mustExist: false })
      }
      target = tr.segs
    }
    if (isDir && (target.join('/') === fr.rel || isUnder(fr.rel, target.join('/')))) fileError('validation', 'intoItself', { to })
    this.assertMovable(target)
    if (isDir) this.assertSubtreeWritable(user, rules, fr.segs)
    // under users/ folder rules are not read: the folder would become private to one person and the rest of the team,
    // admins included, could not see it to move it back. Nobody may do that, owner included (design tab 2 rule 3).
    if (managed && target[0] === 'users') fileError('validation', 'ruleFolderToUsers', { to: 'invalid_path: a group, project or rule folder cannot move under users/' })
    // an ordinary item into the caller's own folder: whoever could read it and cannot any more must be confirmed
    let narrowed = 0
    if (target[0] === 'users' && !(fr.segs[0] === 'users' && fr.segs[1] === target[1])) {
      narrowed = this.lostViewers(rules, user.id, fr.segs, target)
      if (narrowed > 0 && !o.confirm) fileError('conflict', 'audienceNarrowed', undefined, { reason: 'audience_narrowed', lostViewers: narrowed })
    }
    const toRel = target.join('/')
    const db = this.ctx.db
    if (isDir && toRel.toLowerCase() !== fr.rel.toLowerCase()) {
      const clash = db.query('SELECT path FROM folders WHERE path = ? OR substr(path, 1, length(?) + 1) = ? || \'/\'').get(toRel, toRel, toRel) as { path: string } | null
      if (clash) fileError('conflict', 'exists', { to: toRel })
    }
    verifyChain(this.root, fr.segs)
    verifyChain(this.root, target, true)
    // DB first, the rename last inside the same transaction: if anything fails nothing has moved
    db.transaction(() => {
      const under = (col: string) => `(${col} = ? OR substr(${col}, 1, length(?) + 1) = ? || '/')`
      // history kept for a file that used to live at the new path: the moved history continues after it
      const moved = db.query(`SELECT DISTINCT path FROM file_versions WHERE ${under('path')}`).all(fr.rel, fr.rel, fr.rel) as { path: string }[]
      for (const m of moved) {
        const np = toRel + m.path.slice(fr.rel.length)
        const top = (db.query('SELECT MAX(version) AS v FROM file_versions WHERE path = ?').get(np) as { v: number | null }).v
        if (top) db.query('UPDATE file_versions SET version = version + ? WHERE path = ?').run(top, m.path)
      }
      const re = (table: string, col: string) => db.query(`UPDATE ${table} SET ${col} = ? || substr(${col}, length(?) + 1) WHERE ${under(col)}`).run(toRel, fr.rel, fr.rel, fr.rel, fr.rel)
      re('folders', 'path')
      re('projects', 'folder_path')
      re('file_versions', 'path')
      re('file_versions', 'conflict_path')
      re('attachments', 'path')
      // items trashed from inside the moved folder: their place to go back to moves with it. Otherwise the trash checks
      // write access on the old path (no rule there any more: the group stops seeing its own trash), and a restore
      // recreates the old name, or lands in whatever folder took that name since (another group's)
      db.query(`UPDATE trash_items SET original_path = ? || substr(original_path, length(?) + 1) WHERE restored_at IS NULL AND ${under('original_path')}`)
        .run(toRel, fr.rel, fr.rel, fr.rel, fr.rel)
      fileEvent(db, { turnId: null, userId, path: fr.rel, action: 'delete', detail: { movedTo: toRel, folder: isDir, tool: 'file-screen' } })
      fileEvent(db, { turnId: null, userId, path: toRel, action: 'create', detail: { movedFrom: fr.rel, folder: isDir, tool: 'file-screen', ...(narrowed ? { audienceNarrowed: narrowed } : {}) } })
      fs.renameSync(fr.abs, path.join(this.root, ...target))
    })()
    this.moveTextCache(fr.rel, toRel, isDir)
    // the folder's rules moved with it: who could see where it was is judged by the rules loaded before the move
    this.publish([{ path: toRel, from: fr.rel, action: 'move', by: this.by(userId), turnId: null }], rules)
    return { entry: this.entry(user, rules, target) }
  }

  // ---------------- copy: sharing a personal file / project (design tab 2 rule 3, tab 4 POST /api/files/copy) ----------------
  /** Active people other than `self` who could read `to` and cannot read `from` (counted, never named). */
  private viewersAdded(rules: RuleSet, self: string, from: string[], to: string[]): number {
    let n = 0
    for (const p of activePeople(this.ctx.db)) {
      if (p.id === self) continue
      if (atLeast(rules.access(p, to), 'read') && !atLeast(rules.access(p, from), 'read')) n++
    }
    return n
  }

  /**
   * Copy one file the caller can read to `to` (a new name in a folder the caller can write). Sibling-name and conflict
   * rules as for uploads: onExists rename (default) -> "name (2).ext"; replace -> the current file becomes a version, or,
   * when baseSha256 no longer matches it, the copy is saved as a conflict copy next to it; fail -> 409.
   * dryRun: nothing is copied; how many more people would see the copy than see the original.
   * A source the caller cannot read answers exactly like a missing one (not_found).
   */
  async copy(userId: string, from: string, to: string, o: { baseSha256?: string | null; dryRun?: boolean; onExists?: 'fail' | 'replace' | 'rename' } = {}): Promise<{ path: string; sha256: string } | { viewersAdded: number }> {
    const user = this.principal(userId)
    const rules = this.rules()
    const fr = authorize(this.fx, rules, user, from, 'read', { mustExist: true })
    if (fr.st!.isDirectory()) throw new ToolError('folder', 'is_folder')
    const st = checkRegular(fr.abs)
    if (st.size > COPY_MAX_BYTES) fileError('payload_too_large', 'tooLarge')
    const typed = segsOf(to.normalize('NFC'))
    const name = typed[typed.length - 1] ?? ''
    const bad = badSegment(name)
    if (!name || bad) fileError('validation', 'badName', { to: bad || 'empty name' })
    const pr = authorize(this.fx, rules, user, typed.slice(0, -1).join('/'), 'write', { mustExist: true })
    if (!pr.st!.isDirectory()) throw new ToolError('not a folder', 'not_folder')
    let r = authorize(this.fx, rules, user, [...pr.segs, name].join('/'), 'write', { mustExist: false })
    const added = this.viewersAdded(rules, user.id, fr.segs, r.segs)
    if (o.dryRun) return { viewersAdded: added }
    const onExists = o.onExists ?? 'rename'
    let replaced = false
    let conflictOf: string | null = null
    if (r.exists) {
      if (r.st!.isDirectory() || onExists === 'fail') fileError('conflict', 'exists', { to: r.rel })
      if (r.rel === fr.rel && onExists === 'replace') fileError('conflict', 'exists', { to: r.rel })
      if (onExists === 'rename') r = authorize(this.fx, rules, user, [...pr.segs, freeName(pr.abs, name, false, (n) => siblingVisible(this.fx, rules, user, pr.segs, n))].join('/'), 'write', { mustExist: false })
      else {
        const cur = await this.sha(r.abs, checkRegular(r.abs))
        if (o.baseSha256 && o.baseSha256 !== cur) {
          // changed since the caller looked at it: keep it, put the copy next to it (tab 2 "동시 수정")
          let cn = conflictCopyName(name, user.name, new Date(), teamDefaultLocale(this.ctx.db))
          if (badSegment(cn)) cn = `conflict-${Date.now()}-${name}`
          conflictOf = r.rel
          r = authorize(this.fx, rules, user, [...pr.segs, freeName(pr.abs, cn)].join('/'), 'write', { mustExist: false })
        } else {
          snapshotVersion(this.ctx.db, this.root, r.rel, { userId, turnId: null }, 'edit', cur)
          replaced = true
        }
      }
    }
    const out = copyTeamFile(this.root, fr.abs, r.segs)
    const sha = await this.sha(path.join(this.root, ...r.segs), fs.lstatSync(path.join(this.root, ...r.segs)))
    // a conflict copy is told to both people and listed in the original's history, like a conflicting save
    if (conflictOf) recordConflictCopy(this.ctx.db, this.ctx.files.events, { original: conflictOf, copy: r.rel, userId, turnId: null, size: out.size, sha256: sha, tool: 'file-screen' })
    fileEvent(this.ctx.db, { turnId: null, userId, path: r.rel, action: 'create', size: out.size, sha256: sha, detail: { sourcePaths: [fr.rel], widened: added > 0, replaced, tool: 'file-screen', ...(conflictOf ? { conflictCopyOf: conflictOf } : {}) } })
    this.extractText(r.rel)
    this.publish([{ path: r.rel, action: replaced ? 'update' : 'create', by: this.by(userId), turnId: null }])
    return { path: r.rel, sha256: sha }
  }

  /**
   * Copy a whole folder the caller can read into `toParent` (a folder the caller can write), under the same name
   * (" (2)" when taken). Only what the caller can read is copied (links, hard links, odd names and hidden entries are
   * left out); at most `limits` files / bytes (413 beyond). Built under a hidden temp name, then renamed into place.
   */
  copyFolderTree(userId: string, from: string, toParent: string, o: { dryRun?: boolean; maxFiles?: number; maxBytes?: number } = {}): { path: string; files: number; bytes: number } | { viewersAdded: number } {
    const user = this.principal(userId)
    const rules = this.rules()
    const fr = authorize(this.fx, rules, user, from, 'read', { mustExist: true })
    if (!fr.st!.isDirectory()) throw new ToolError('not a folder', 'not_folder')
    const pr = authorize(this.fx, rules, user, toParent, 'write', { mustExist: true })
    if (!pr.st!.isDirectory()) throw new ToolError('not a folder', 'not_folder')
    if (pr.rel === fr.rel || isUnder(fr.rel, pr.rel)) fileError('validation', 'intoItself', { toParent })
    // the name comes from the caller's own folder: step around only siblings they can see (a hidden one is refused
    // by authorize() like a missing name, so the " (2)" never tells them it exists)
    const name = freeName(pr.abs, fr.segs[fr.segs.length - 1]!, true, (n) => siblingVisible(this.fx, rules, user, pr.segs, n))
    const tr = authorize(this.fx, rules, user, [...pr.segs, name].join('/'), 'write', { mustExist: false })
    const added = this.viewersAdded(rules, user.id, fr.segs, tr.segs)
    if (o.dryRun) return { viewersAdded: added }
    const maxFiles = o.maxFiles ?? SHARE_MAX_FILES, maxBytes = o.maxBytes ?? SHARE_MAX_BYTES
    // what to copy: readable regular files and listable folders, walked without following anything
    const dirs: string[][] = [], files: { segs: string[]; size: number }[] = []
    let bytes = 0
    const walk = (segs: string[]) => {
      for (const e of fs.readdirSync(path.join(this.root, ...fr.segs, ...segs), { withFileTypes: true })) {
        if (hiddenEntry(e.name, fr.segs.length + segs.length) || badSegment(e.name) || e.isSymbolicLink()) continue
        const rel = [...segs, e.name]
        const abs = path.join(this.root, ...fr.segs, ...rel)
        let st: fs.Stats
        try { st = fs.lstatSync(abs) } catch { continue }
        if (st.isDirectory()) {
          if (!atLeast(rules.access(user, [...fr.segs, ...rel]), 'read')) continue
          dirs.push(rel)
          walk(rel)
        } else if (st.isFile() && st.nlink === 1 && atLeast(rules.access(user, [...fr.segs, ...rel]), 'read')) {
          files.push({ segs: rel, size: st.size })
          bytes += st.size
          if (files.length > maxFiles || bytes > maxBytes) fileError('payload_too_large', 'tooLarge')
        }
      }
    }
    walk([])
    const tmp = path.join(pr.abs, PRODUCT.tmpPrefix + crypto.randomUUID())
    fs.mkdirSync(tmp, { mode: 0o700 })
    try {
      for (const d of dirs) fs.mkdirSync(path.join(tmp, ...d), { mode: 0o700 })
      for (const f of files) {
        const src = path.join(this.root, ...fr.segs, ...f.segs)
        const before = checkRegular(src)
        const dst = path.join(tmp, ...f.segs)
        fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE)
        const after = checkRegular(src)
        if (after.ino !== before.ino || after.dev !== before.dev || fs.lstatSync(dst).size !== after.size) throw new Denied('path changed while copying')
        fs.chmodSync(dst, 0o600)
      }
      verifyChain(this.root, tr.segs, true)
      fs.renameSync(tmp, tr.abs)
    } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw e }
    fileEvent(this.ctx.db, { turnId: null, userId, path: tr.rel, action: 'create', size: bytes, detail: { folder: true, sourcePaths: [fr.rel], widened: added > 0, files: files.length, tool: 'file-screen' } })
    for (const f of files) this.extractText([...tr.segs, ...f.segs].join('/'))
    this.publish([{ path: tr.rel, action: 'mkdir', by: this.by(userId), turnId: null }])
    return { path: tr.rel, files: files.length, bytes }
  }

  private moveTextCache(from: string, to: string, isDir: boolean) {
    const office = this.ctx.files.office
    try {
      const src = isDir ? path.join(office.dir, ...from.split('/')) : office.cachePath(from)
      if (!fs.existsSync(src)) return
      const dst = isDir ? path.join(office.dir, ...to.split('/')) : office.cachePath(to)
      fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 })
      fs.rmSync(dst, { recursive: true, force: true })
      fs.renameSync(src, dst)
    } catch (e) { this.ctx.log.warn('text cache move failed', { err: e }) }
  }
  private dropTextCache(rel: string, isDir: boolean) {
    const office = this.ctx.files.office
    try { fs.rmSync(isDir ? path.join(office.dir, ...rel.split('/')) : office.cachePath(rel), { recursive: true, force: true }) } catch {}
  }
  /** Pre-extract office text into the grep sidecar cache (design tab 2 "업로드·변경 때 추출"). Fire and forget. */
  extractText(rel: string) {
    if (!isOffice(rel)) return
    this.ctx.files.office.update(rel).catch((e) => this.ctx.log.debug('office text extraction failed', { path: rel, err: String(e?.message ?? e) }))
  }

  // ---------------- delete -> trash ----------------
  remove(userId: string, rel: string, turnId: string | null = null): { trashId: string; purgeAt: string } {
    const user = this.principal(userId)
    const rules = this.rules()
    const r = authorize(this.fx, rules, user, rel, 'write', { mustExist: true })
    this.assertMovable(r.segs)
    // trashing a group / project / rule folder takes it from everyone who works there: admins and the owner only
    this.assertMayChangeManaged(user, rules, r.rel)
    const isDir = r.st!.isDirectory()
    let size: number
    if (isDir) { this.assertSubtreeWritable(user, rules, r.segs); size = treeSize(r.abs).bytes }
    else size = checkRegular(r.abs).size
    const id = newId()
    const purgeAt = iso(Date.now() + getTeamSettings(this.ctx.db).trashRetentionDays * DAY)
    const db = this.ctx.db
    db.transaction(() => {
      const storage = moveIntoTrash(this.root, r.segs)
      try {
        db.query('INSERT INTO trash_items (id, original_path, storage_path, size, deleted_by, turn_id, purge_at, kind) VALUES (?,?,?,?,?,?,?,?)')
          .run(id, r.rel, storage, size, userId, turnId, purgeAt, isDir ? 'folder' : 'file')
        // the folder's rules go with it (parked under its trash path): a new folder made at the same path does not
        // inherit them, and the deleted one gets them back wherever it is restored
        if (isDir) rebaseFolders(db, r.rel, storage)
        fileEvent(db, { turnId, userId, path: r.rel, action: 'delete', size, detail: { folder: isDir, trashId: id } })
      } catch (e) { fs.renameSync(path.join(this.root, ...storage.split('/')), r.abs); throw e }
    })()
    this.dropTextCache(r.rel, isDir)
    // a trashed folder's rules were parked with it: judge the deleted path by the rules as they were before
    this.publish([{ path: r.rel, action: 'delete', by: this.by(userId), turnId }], rules)
    return { trashId: id, purgeAt }
  }

  // ---------------- history ----------------
  private versionVisible(user: Principal, rules: RuleSet, row: Pick<VersionRow, 'path' | 'folder_id' | 'path_at_save'>): boolean {
    if (!atLeast(rules.access(user, segsOf(row.path)), 'read')) return false
    const f = row.folder_id ? this.folderLivePath(row.folder_id) : null
    if (f !== null) return atLeast(rules.access(user, segsOf(f)), 'read')
    return !row.path_at_save || atLeast(rules.access(user, segsOf(row.path_at_save)), 'read')
  }

  history(userId: string, rel: string): { path: string; items: FileVersion[] } {
    const user = this.principal(userId)
    const rules = this.rules()
    const r = authorize(this.fx, rules, user, rel, 'read', { mustExist: false })
    const rows = (this.ctx.db.query('SELECT id, path, version, sha256, size, author_id, turn_id, kind, conflict_path, storage_path, created_at, folder_id, path_at_save FROM file_versions WHERE path = ? ORDER BY version DESC LIMIT 500').all(r.rel) as VersionRow[])
      .filter((v) => this.versionVisible(user, rules, v))
    const refs = this.userRefs(rows.map((v) => v.author_id))
    return {
      path: r.rel,
      items: rows.map((v) => ({
        id: v.id, path: v.path, version: v.version, sha256: v.sha256, size: v.size, author: v.author_id ? refs.get(v.author_id) ?? { id: v.author_id, name: v.author_id } : null,
        turnId: v.turn_id, kind: v.kind, conflictPath: v.conflict_path, createdAt: normIso(v.created_at),
      })),
    }
  }

  private versionRow(user: Principal, rules: RuleSet, versionId: string): VersionRow {
    const v = this.ctx.db.query('SELECT id, path, version, sha256, size, author_id, turn_id, kind, conflict_path, storage_path, created_at, folder_id, path_at_save FROM file_versions WHERE id = ?').get(versionId) as VersionRow | null
    if (!v || !this.versionVisible(user, rules, v)) throw new HttpError('not_found')
    return v
  }

  /** For the download endpoint: the stored blob of an old version. */
  versionFile(userId: string, versionId: string): { abs: string; name: string; size: number } {
    const user = this.principal(userId)
    const v = this.versionRow(user, this.rules(), versionId)
    if (!v.storage_path) fileError('not_found', 'noBlob')
    const abs = path.join(this.root, ...v.storage_path.split('/'))
    const st = checkRegular(abs)
    const [base, x] = splitExt(v.path.split('/').pop()!)
    return { abs, name: `${base} (v${v.version})${x}`, size: st.size }
  }

  async restoreVersion(userId: string, rel: string, versionId: string): Promise<SaveResult> {
    const user = this.principal(userId)
    const rules = this.rules()
    const r = authorize(this.fx, rules, user, rel, 'write', { createDirs: true })
    const v = this.versionRow(user, rules, versionId)
    if (v.path !== r.rel) throw new HttpError('not_found')
    if (!v.storage_path) fileError('not_found', 'noBlob')
    const blob = path.join(this.root, ...v.storage_path.split('/'))
    checkRegular(blob)
    if (r.exists) {
      if (r.st!.isDirectory()) throw new ToolError('folder', 'is_folder')
      const st = checkRegular(r.abs)
      const cur = await this.sha(r.abs, st)
      if (cur === v.sha256) return { path: r.rel, conflict: false, entry: this.entry(user, rules, r.segs) }
      snapshotVersion(this.ctx.db, this.root, r.rel, { userId, turnId: null }, 'restore', cur)
    }
    installFile(this.root, r.segs, blob, { keepSource: true })
    fileEvent(this.ctx.db, { turnId: null, userId, path: r.rel, action: 'restore', size: v.size, sha256: v.sha256, detail: { versionId, version: v.version } })
    this.extractText(r.rel)
    this.publish([{ path: r.rel, action: 'restore', by: this.by(userId), turnId: null }])
    return { path: r.rel, conflict: false, entry: this.entry(user, rules, r.segs) }
  }

  // ---------------- trash ----------------
  /**
   * The path a folders row stands for: its path, or for a folder parked with a trashed folder
   * (.system/trash/<month>/<id>/...) the path it had before it was deleted. null: no such row.
   */
  private folderLivePath(folderId: string): string | null {
    const f = this.ctx.db.query('SELECT path FROM folders WHERE id = ?').get(folderId) as { path: string } | null
    if (!f) return null
    const segs = segsOf(f.path)
    if (segs[0] !== PRODUCT.systemDir) return f.path
    const storage = segs.slice(0, 4).join('/')
    const t = this.ctx.db.query('SELECT original_path FROM trash_items WHERE storage_path = ?').get(storage) as { original_path: string } | null
    return t ? t.original_path + f.path.slice(storage.length) : f.path
  }
  /**
   * Where a trash item goes back to now: its original path (move() keeps it up to date), held against the folder it
   * was trashed from (folder_id: the nearest folders row when it was trashed, migration 301). null when that folder is
   * itself in the trash (the item comes back with it: restoreTrash moves it along), was purged, or no longer holds that
   * path. The path alone would let whoever owns a folder that took the old name since (another group, a new rule
   * folder) see the item and restore it into their folder (security review r2).
   */
  private trashHome(t: TrashRow): string | null {
    if (!t.folder_id) return t.original_path
    const f = this.ctx.db.query('SELECT path FROM folders WHERE id = ?').get(t.folder_id) as { path: string } | null
    if (!f) return null
    if (t.kind === 'folder' && f.path === t.storage_path) return t.original_path // its own rules, parked with it
    if (segsOf(f.path)[0] === PRODUCT.systemDir) return null
    return f.path === '' || f.path === t.original_path || isUnder(f.path, t.original_path) ? t.original_path : null
  }
  private trashVisible(user: Principal, rules: RuleSet, t: TrashRow): boolean {
    const home = this.trashHome(t)
    if (home === null) return false
    // a trashed group / project / rule folder went there by an admin or the owner (assertMayChangeManaged) and comes
    // back only the same way: listing it to members, whose restore then failed (they cannot write groups/ or
    // projects/), offered what could not be done (design tab 4 move/delete; security review r2)
    if (t.kind === 'folder' && user.role !== 'owner' && user.role !== 'admin' && this.managedRows(t.storage_path, home)) return false
    // a trashed folder's own (parked) rules count as if it were still in place; rules of a folder that took its name
    // since belong to that other folder and do not
    const r = t.kind === 'folder' ? new RuleSet(this.ctx.db.query(`SELECT CASE WHEN f.path = ?1 OR substr(f.path, 1, length(?1) + 1) = ?1 || '/'
        THEN ?2 || substr(f.path, length(?1) + 1) ELSE f.path END AS path, r.subject_type, r.subject_id, r.access
      FROM folder_rules r JOIN folders f ON f.id = r.folder_id
      WHERE NOT (f.path = ?2 OR substr(f.path, 1, length(?2) + 1) = ?2 || '/')`).all(t.storage_path, home) as any) : rules
    const access = (p: string) => r.access(user, segsOf(p))
    if (access(home) !== 'write') return false
    if (t.folder_id) {
      const f = this.folderLivePath(t.folder_id)
      if (f !== null && !atLeast(access(f), 'read')) return false
    }
    return true
  }
  private trashRow(id: string): TrashRow | null {
    return this.ctx.db.query('SELECT id, original_path, storage_path, size, deleted_by, turn_id, deleted_at, purge_at, kind, folder_id FROM trash_items WHERE id = ? AND restored_at IS NULL').get(id) as TrashRow | null
  }

  trash(userId: string, o: { mine?: boolean; cursor?: string; limit?: number }): Page<TrashItem> {
    const user = this.principal(userId)
    const rules = this.rules()
    const limit = o.limit ?? 50
    const now = new Date().toISOString()
    const out: TrashRow[] = []
    let after = o.cursor && /^[0-9a-f-]{36}$/.test(o.cursor) ? o.cursor : null
    let more = true
    while (out.length < limit && more) {
      const rows = this.ctx.db.query(`SELECT id, original_path, storage_path, size, deleted_by, turn_id, deleted_at, purge_at, kind, folder_id FROM trash_items
        WHERE restored_at IS NULL AND purge_at > ? ${o.mine ? 'AND deleted_by = ?' : ''} ${after ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT 200`)
        .all(...[now, ...(o.mine ? [userId] : []), ...(after ? [after] : [])]) as TrashRow[]
      more = rows.length === 200
      for (const t of rows) {
        after = t.id
        if (this.trashVisible(user, rules, t)) { out.push(t); if (out.length === limit) break }
      }
    }
    const refs = this.userRefs(out.map((t) => t.deleted_by))
    return {
      items: out.map((t) => ({
        id: t.id, originalPath: t.original_path, size: t.size, deletedBy: refs.get(t.deleted_by) ?? { id: t.deleted_by, name: t.deleted_by },
        turnId: t.turn_id, deletedAt: normIso(t.deleted_at), purgeAt: normIso(t.purge_at), type: t.kind,
      })),
      nextCursor: out.length === limit && (more || out[out.length - 1]!.id !== after) ? out[out.length - 1]!.id : null,
    }
  }

  restoreTrash(userId: string, id: string): { entry: FileEntry } {
    const user = this.principal(userId)
    const rules = this.rules()
    const t = this.trashRow(id)
    if (!t || !this.trashVisible(user, rules, t)) throw new HttpError('not_found')
    const isDir = t.kind === 'folder'
    const want = segsOf(this.trashHome(t)!)
    // the original parent may be gone: it is created again (names were valid when the item was deleted).
    // A taken name (exactly or nearly) gets " (restored)" in the team's default language.
    const parentRel = want.slice(0, -1).join('/')
    const pw = authorize(this.fx, rules, user, parentRel, 'write', { mustExist: false, createDirs: true })
    const name = pw.exists && pw.st!.isDirectory() ? restoredName(pw.abs, want[want.length - 1]!, isDir, teamDefaultLocale(this.ctx.db), (n) => siblingVisible(this.fx, rules, user, pw.segs, n)) : want[want.length - 1]!
    // a folder's rules were parked with it (remove) and come back with it, also under a " (복원됨)" name
    const r = authorize(this.fx, rules, user, [...pw.segs, name].join('/'), 'write', { mustExist: false, createDirs: true })
    if (r.exists) fileError('conflict', 'restoreTaken')
    if (isDir) {
      const under = "path = ? OR substr(path, 1, length(?) + 1) = ? || '/'"
      const parked = this.ctx.db.query(`SELECT 1 FROM folders WHERE ${under} LIMIT 1`).get(t.storage_path, t.storage_path, t.storage_path)
      // rules already kept for the target path (a folder that is gone from disk): don't mix the two sets
      if (parked && this.ctx.db.query(`SELECT 1 FROM folders WHERE ${under} LIMIT 1`).get(r.rel, r.rel, r.rel)) fileError('conflict', 'restoreTaken')
    }
    const src = path.join(this.root, ...t.storage_path.split('/'))
    if (isDir) {
      const st = fs.lstatSync(src)
      if (!st.isDirectory()) throw new Denied('trash item changed')
      let cur = this.root
      for (const s of r.segs.slice(0, -1)) { cur = path.join(cur, s); try { fs.mkdirSync(cur, { mode: 0o700 }) } catch (e: any) { if (e.code !== 'EEXIST') throw e } }
      verifyChain(this.root, r.segs, true)
      this.ctx.db.transaction(() => {
        rebaseFolders(this.ctx.db, t.storage_path, r.rel)
        // items trashed from inside this folder before it went to the trash (hidden meanwhile, trashHome) come back
        // into the trash of the folder where it now is, " (restored)" name included
        this.ctx.db.query(`UPDATE trash_items SET original_path = ? || substr(original_path, length(?) + 1)
          WHERE restored_at IS NULL AND id <> ? AND (original_path = ? OR substr(original_path, 1, length(?) + 1) = ? || '/')
            AND folder_id IN (SELECT id FROM folders WHERE path = ? OR substr(path, 1, length(?) + 1) = ? || '/')`)
          .run(r.rel, t.original_path, t.id, t.original_path, t.original_path, t.original_path, r.rel, r.rel, r.rel)
        fs.renameSync(src, r.abs)
      })()
    } else {
      checkRegular(src)
      installFile(this.root, r.segs, src)
    }
    this.ctx.db.query('UPDATE trash_items SET restored_at = ? WHERE id = ?').run(new Date().toISOString(), id)
    fileEvent(this.ctx.db, { turnId: null, userId, path: r.rel, action: 'restore', size: t.size, detail: { trashId: id, folder: isDir, originalPath: t.original_path } })
    if (!isDir) this.extractText(r.rel)
    this.publish([{ path: r.rel, action: 'restore', by: this.by(userId), turnId: null }])
    return { entry: this.entry(user, rules, r.segs) }
  }
  /** Admin or owner (route auth), and like every trash action only for items the caller could restore: an admin has
   * no access to other people's users/<id>/, so their trashed files stay out of reach too. */
  purgeTrash(id: string, byUserId: string) {
    const t = this.trashRow(id)
    if (!t || !this.trashVisible(this.principal(byUserId), this.rules(), t)) throw new HttpError('not_found')
    this.purgeRow(t)
    this.ctx.db.query('INSERT INTO audit_log (actor_id, action, target, detail) VALUES (?,?,?,?)').run(byUserId, 'trash.purge', t.original_path, JSON.stringify({ trashId: id, size: t.size, kind: t.kind }))
  }
  private purgeRow(t: Pick<TrashRow, 'id' | 'storage_path' | 'kind'>) {
    const db = this.ctx.db
    const abs = path.join(this.root, ...t.storage_path.split('/'))
    if (t.storage_path.startsWith(`${PRODUCT.systemDir}/trash/`)) fs.rmSync(abs, { recursive: true, force: true })
    if (t.kind === 'folder') {
      // the folder's parked rules and the history kept under them go for good as well
      const ids = (db.query("SELECT id FROM folders WHERE path = ? OR substr(path, 1, length(?) + 1) = ? || '/'").all(t.storage_path, t.storage_path, t.storage_path) as { id: string }[]).map((x) => x.id)
      for (const fid of ids) {
        // what was trashed from inside it earlier goes for good with it (its place is gone; restoring it by its path
        // alone would put it into whatever folder takes the old name)
        for (const inner of db.query('SELECT id, storage_path, kind FROM trash_items WHERE folder_id = ? AND restored_at IS NULL AND id <> ?').all(fid, t.id) as Pick<TrashRow, 'id' | 'storage_path' | 'kind'>[]) this.purgeRow(inner)
        for (const v of db.query('SELECT id, storage_path FROM file_versions WHERE folder_id = ?').all(fid) as { id: string; storage_path: string | null }[]) {
          if (v.storage_path?.startsWith(`${PRODUCT.systemDir}/history/`)) fs.rmSync(path.join(this.root, ...v.storage_path.split('/')), { force: true })
          db.query('DELETE FROM file_versions WHERE id = ?').run(v.id)
        }
        db.query('DELETE FROM folders WHERE id = ?').run(fid)
      }
    }
    db.query('DELETE FROM trash_items WHERE id = ?').run(t.id)
  }

  // ---------------- uploads (small and chunked end here) ----------------
  /**
   * Put an uploaded file (already on disk at `src`, server-owned) into `folder/name`. onExists: fail -> conflict,
   * replace -> the current file becomes a version, rename -> "name (2).ext".
   */
  async placeUpload(userId: string, folder: string, name: string, src: string, onExists: 'fail' | 'replace' | 'rename', sha: string): Promise<FileEntry> {
    const user = this.principal(userId)
    const rules = this.rules()
    const bad = name.includes('/') ? 'names cannot contain "/"' : badSegment(name.normalize('NFC'))
    if (bad) fileError('validation', 'badName', { name: bad })
    const fr = authorize(this.fx, rules, user, folder, 'write', { mustExist: true })
    if (!fr.st!.isDirectory()) throw new ToolError('not a folder', 'not_folder')
    let finalName = name.normalize('NFC')
    if (onExists === 'rename') finalName = freeName(fr.abs, finalName, false, (n) => siblingVisible(this.fx, rules, user, fr.segs, n))
    const r = authorize(this.fx, rules, user, [...fr.segs, finalName].join('/'), 'write', { mustExist: false })
    let action: FileChange['action'] = 'create'
    if (r.exists) {
      if (r.st!.isDirectory() || onExists === 'fail') fileError('conflict', 'exists', { name: r.rel })
      const st = checkRegular(r.abs)
      snapshotVersion(this.ctx.db, this.root, r.rel, { userId, turnId: null }, 'edit', await this.sha(r.abs, st))
      action = 'update'
    }
    const size = fs.statSync(src).size
    installFile(this.root, r.segs, src)
    fileEvent(this.ctx.db, { turnId: null, userId, path: r.rel, action: 'upload', size, sha256: sha, detail: { replaced: action === 'update' } })
    this.extractText(r.rel)
    this.publish([{ path: r.rel, action, by: this.by(userId), turnId: null }])
    return this.entry(user, rules, r.segs)
  }

  // ---------------- retention ----------------
  /** Purge expired trash and old versions (settings trashRetentionDays via purge_at, fileHistoryRetentionDays). */
  sweep(now = Date.now()) {
    const db = this.ctx.db
    let trash = 0, versions = 0
    for (const t of db.query('SELECT id, storage_path, kind FROM trash_items WHERE restored_at IS NULL AND purge_at <= ?').all(iso(now)) as TrashRow[]) { this.purgeRow(t); trash++ }
    // the value the admin screen shows (stored setting or DEFAULT_SETTINGS): one source, so the two cannot drift
    const keepDays = getTeamSettings(db).fileHistoryRetentionDays
    const cutoff = iso(now - keepDays * DAY)
    for (const v of db.query('SELECT id, storage_path FROM file_versions WHERE created_at < ? LIMIT 5000').all(cutoff) as { id: string; storage_path: string | null }[]) {
      if (v.storage_path?.startsWith(`${PRODUCT.systemDir}/history/`)) fs.rmSync(path.join(this.root, ...v.storage_path.split('/')), { force: true })
      db.query('DELETE FROM file_versions WHERE id = ?').run(v.id)
      versions++
    }
    return { trash, versions }
  }
}

/** Every active person with their groups (who could be affected by an audience change). */
export function activePeople(db: AppContext['db']): Principal[] {
  const users = db.query("SELECT id, name, role FROM users WHERE status = 'active' AND deleted_at IS NULL").all() as { id: string; name: string; role: Principal['role'] }[]
  const groups = new Map<string, string[]>()
  for (const m of db.query('SELECT group_id, user_id FROM group_members').all() as { group_id: string; user_id: string }[]) groups.set(m.user_id, [...(groups.get(m.user_id) ?? []), m.group_id])
  return users.map((u) => ({ ...u, groups: groups.get(u.id) ?? [] }))
}

/** Move the folders rows at `from` and below it to `to` (rules are kept by path). */
function rebaseFolders(db: AppContext['db'], from: string, to: string) {
  db.query("UPDATE folders SET path = ? || substr(path, length(?) + 1) WHERE path = ? OR substr(path, 1, length(?) + 1) = ? || '/'").run(to, from, from, from, from)
}

/** The largest k <= n such that buf[0, k) does not end inside a UTF-8 sequence (looks at most 3 bytes back). */
export function utf8Boundary(buf: Uint8Array, n: number): number {
  let i = n
  let back = 0
  while (i > 0 && back < 3 && (buf[i - 1]! & 0xc0) === 0x80) { i--; back++ }
  if (i === 0) return n
  const lead = buf[i - 1]!
  const len = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
  // the sequence starting at i-1 needs `len` bytes; cut before it when they are not all there
  return len > 1 && i - 1 + len > n ? i - 1 : n
}

/** SQLite default timestamps ("2026-10-21T03:04:05.678Z") are already ISO; older rows may lack the Z. */
export const normIso = (s: string) => (/[zZ]|[+-]\d\d:\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z')
const encodeCursor = (n: number) => Buffer.from(String(n)).toString('base64url')
const decodeCursor = (c: string | undefined) => {
  if (!c) return 0
  const n = Number(Buffer.from(c, 'base64url').toString())
  return Number.isInteger(n) && n >= 0 ? n : 0
}
