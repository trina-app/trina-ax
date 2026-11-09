// The file screen (design tab 4 "파일", tab 2 "동시 수정"): tree, text content, save, folders, move / rename,
// trash, version history. Every path goes through authorize() (policy/authorize.ts) with the caller's own rules;
// what the caller may not read looks exactly like what does not exist.
import fs from 'node:fs'
import path from 'node:path'
import type { FileChange, FileContent, FileEntry, FileHistoryEvent, FileVersion, Page, SaveResult, TrashItem, TreeResponse, UserRef } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { teamDefaultLocale, teamTimeZone } from '../admin/settings'
import { resetEngineSessions } from '../chat/runtime'
import { newId } from '../db'
import { ext, isOffice } from '../files/extract'
import { atomicWrite, conflictCopyName, fileEvent, readRegular, recordConflictCopy, saveVersion, sha256 } from '../files/store'
import { CONTENT_KINDS, fileTimeline, placeNow } from '../files/timeline'
import { HttpError } from '../http/errors'
import { atLeast, RuleSet, type Principal } from '../policy/access'
import { authorize, siblingVisible, type Authorized } from '../policy/authorize'
import { Denied, ToolError } from '../policy/errors'
import { inSkills, SKILL_FILES_REFUSAL } from '../skills/guard'
import { audit } from '../admin/audit'
import { badSegment, foldKey, hiddenEntry, volumeKey } from '../policy/names'
import { skillsUnder } from '../skills/switch-on'
import { currentPlan } from '../system/limits'
import { assertStorageRoom, assertStorageRoomForAI } from '../system/storage'
import { parseInput, verifyChain } from '../policy/resolve'
import { getTeamSettings } from '../admin/settings'
import { PRODUCT } from '@mycel/shared'
import { publishChanges } from './changes'
import { FileError, fileError } from './errors'
import { checkRegular, copyTeamFile, freeName, hashFile, installFile, moveIntoTrash, restoredName, snapshotVersion, splitExt, treeSize } from './place'
import { AI_TRASH_MAX_ENTRIES, AiTrashChanged, TrashStranded, aiSkillPath, holdsSkillRoot, instructionFile, sameStamps, stampTree, type Stamp } from './ai-trash'
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

/** GET /api/files/history `current` */
interface HistoryCurrent { version: number; sha256: string; size: number; author: UserRef | null; turnId: string | null; at: string | null }
interface VersionRow { id: string; path: string; version: number; sha256: string; size: number; author_id: string | null; turn_id: string | null; saved_by?: string | null; saved_turn_id?: string | null; kind: FileVersion['kind']; conflict_path: string | null; storage_path: string | null; created_at: string; folder_id: string | null; path_at_save: string | null }
interface TrashRow { id: string; original_path: string; storage_path: string; size: number; deleted_by: string; turn_id: string | null; deleted_at: string; purge_at: string; kind: 'file' | 'folder'; folder_id: string | null }

export interface Actor { userId: string; turnId?: string | null }

/** Who changes files: a person on the Files screen (default), or the AI in a chat turn (tools/file-moves.ts). */
type By = { turnId?: string | null; tool?: string }

/** One item the AI's delete_files card showed (chat/delete-files.ts): what the person's yes is bound to. */
export interface AiTrashItem {
  /** the path as the file layer resolved it for the person (the actual letter case and Unicode form) */
  rel: string
  kind: 'file' | 'folder'
  /** files and folders inside it (a folder; 0 for a file) */
  files: number
  folders: number
  /** every entry on disk, the item first (team-files/ai-trash.ts) */
  entries: Stamp[]
  /** who of the other active people can read it, who can write it, and their roles now (a hash) */
  audience: string
}
/** What one delete_files call would put in the trash, as its card says it (TeamFiles.planAiTrash). */
export interface AiTrashPlan {
  items: AiTrashItem[]
  /** entries in all, the items and everything inside them (at most AI_TRASH_MAX_ENTRIES) */
  entries: number
  /** the team's trash setting when the card was made; purged that many days after it goes */
  retentionDays: number
  /** other active people who can read at least one item now: they no longer can */
  lost: number
  /** of those, the people who cannot write it: they cannot see it in the trash, so cannot restore it */
  noRestore: number
  /** other people who made or changed these files, as the file history shows them to this person */
  others: UserRef[]
}
/** delete_files' refusal for a skill root (also TeamFiles.remove's for every AI turn). */
export const AI_SKILL_TRASH_REFUSAL = 'a skill folder (skills/, a group\'s, a project\'s or a person\'s own skills: what people\'s AI follows), something in one, or a folder that holds one: skills are not deleted from a chat. The user deletes it on the Files screen or the Skills page'

export class TeamFiles {
  /** sha256 by (path, inode, size, mtime) so repeated previews of big files don't re-hash */
  private shaCache = new Map<string, string>()
  constructor(readonly ctx: AppContext) {}

  get root() { return this.ctx.files.fx.root }
  get fx() { return this.ctx.files.fx }
  rules() { return RuleSet.load(this.ctx.db) }
  principal(userId: string): Principal { return this.ctx.files.principal(userId) }

  // ---------------- entries ----------------
  /** `mark`: look up FileEntry.downloadOnly (a listing that pages its entries marks only the page it returns) */
  entry(user: Principal, rules: RuleSet, segs: string[], st?: fs.Stats, mark = true): FileEntry {
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
      ...(mark && !folder && this.downloadOnly(abs) ? { downloadOnly: true as const } : {}),
    }
  }
  /** the same test the AI's read and the previews use (policy/authorize.ts: Quarantine.hasFile); a file that cannot be
   * checked now is listed without the mark (the read still refuses it) */
  private downloadOnly(abs: string): boolean {
    try { return this.ctx.files.quarantine.hasFile(abs) } catch { return false }
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
      else if (st.isFile() && st.nlink === 1 && atLeast(rules.access(user, c), 'read')) out.push(this.entry(user, rules, c, st, false))
    }
    const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
    out.sort((a, b) => (a.type === b.type ? coll.compare(a.name, b.name) : a.type === 'folder' ? -1 : 1))
    const start = decodeCursor(cursor)
    // download-only is looked up for the returned page only (a big folder is listed whole, then paged)
    const items = out.slice(start, start + limit).map((e) => (e.type === 'file' && this.downloadOnly(path.join(this.root, e.path)) ? { ...e, downloadOnly: true as const } : e))
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
  fileForDownload(userId: string, rel: string, download = true): { abs: string; name: string } {
    const r = authorize(this.fx, this.rules(), this.principal(userId), rel, 'read', {download})
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
    let name = conflictCopyName(r.segs[r.segs.length - 1]!, user.name, new Date(), teamDefaultLocale(this.ctx.db), teamTimeZone(this.ctx.db))
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

  /** root, users/, users/<id>/ and .system/ never move or go to the trash; nor does a folder holding a skill pack's
   * managed folder (server/src/plugins/manager.ts: turn the plugin off first) */
  private assertMovable(segs: string[]) {
    if (segs.length === 0 || (segs[0] === 'users' && segs.length <= 2) || segs[0] === PRODUCT.systemDir) fileError('forbidden', 'protectedFolder')
    if (this.fx.managed?.heldBelow(segs)) fileError('forbidden', 'pluginManaged', undefined, { reason: 'plugin_managed' })
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
  private managedRows(rowPrefix: string, livePrefix: string, trashId?: string): boolean {
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
    // a trashed folder (trashId): the projects that went to the trash with it are its own, so it is a project folder
    // there too, admin-only to see and restore (trashVisible); review round 3: members restored such a folder
    if (trashId && db.query('SELECT 1 FROM projects WHERE trashed_with = ? LIMIT 1').get(trashId)) return true
    // otherwise a project whose folder is in the trash does not use the folder now at its old path
    return !!db.query(`SELECT 1 FROM projects WHERE trashed_with IS NULL AND substr(folder_path, 1, 6) <> 'users/' AND (${livePrefix === '' ? "folder_path <> ''" : "folder_path = ?1 OR substr(folder_path, 1, length(?1) + 1) = ?1 || '/'"}) LIMIT 1`)
      .get(...(livePrefix === '' ? [] : [livePrefix]))
  }
  /** managedInside() for what is strictly below `base` (base itself left out). */
  private managedBelow(rules: RuleSet, base: string): boolean {
    if (rules.ruleFolders().some((f) => f !== base && isUnder(base, f))) return true
    const db = this.ctx.db
    const rows = db.query("SELECT path FROM folders WHERE substr(path, 1, length(?) + 1) = ? || '/'").all(base, base) as { path: string }[]
    for (const f of rows) if (this.managedRows(f.path, f.path)) return true
    return !!db.query("SELECT 1 FROM projects WHERE trashed_with IS NULL AND substr(folder_path, 1, length(?) + 1) = ? || '/' LIMIT 1").get(base, base)
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

  /** Active people who can read `segs` under `rules` (before a move or delete, to see who lost it after). */
  private readersOf(rules: RuleSet, segs: string[]): Principal[] {
    return activePeople(this.ctx.db).filter((p) => atLeast(rules.access(p, segs), 'read'))
  }
  /**
   * People who could read a file and no longer can after a move or delete: their chats start a fresh engine session
   * at the next turn, as after a rule change (H7). A stashed session may hold the file's content (an attachment or a
   * read by the AI) and a resumed session answered from it although the app showed the file as unavailable (security
   * round 4).
   */
  private dropSessionsOf(lost: Principal[], why: { path: string; to?: string }) {
    for (const p of lost) {
      const n = resetEngineSessions(this.ctx, p.id)
      if (n) this.ctx.log.info('engine sessions reset after a file left a person\'s reach', { user: p.id, chats: n, ...why })
    }
  }

  // ---------------- move / rename ----------------
  /** `skillMove`: skills/move.ts runMove, which checked write on both places and has the person's yes for exactly these
   * files (the AI's move_skill card or the Skills page): the AI's refusal for skill roots does not apply. */
  move(userId: string, from: string, to: string, onExists: 'fail' | 'rename', o: { confirm?: boolean; skillMove?: boolean; skillsOk?: boolean } & By = {}): { entry: FileEntry } {
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
    // the AI never moves anything into or out of a skill root (skills/, a group's groups/<g>/skills/, a project's
    // projects/<name>/skills/; skills/guard.ts): not a folder holding a skills/ folder into groups/<g>/ or projects/<name>
    // (it would make that group's or project's skills folder), nor groups/, projects/, a groups/<g>/ or a
    // projects/<name>/ that holds one anywhere (their skills would leave with it; docs/DECISIONS.md "Project skills"). What everyone's AI follows
    // changes only through write / edit and their card (docs/DECISIONS.md "Group skills"); people on the Files screen
    // (no turn) move as before
    if (o.turnId != null && !o.skillMove) {
      const fold = (n: string) => n.normalize('NFC').toLowerCase()
      const hasSkills = (abs: string) => { try { return fs.readdirSync(abs).some((n) => fold(n) === 'skills') } catch { return true } }
      const children = (abs: string) => { try { return fs.readdirSync(abs, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(abs, d.name)) } catch { return null } }
      // groups/<g>/skills and projects/<name>/skills are both skill roots by their path (skills/guard.ts)
      const holder = (n: string | undefined) => fold(n ?? '') === 'groups' || fold(n ?? '') === 'projects'
      const intoGroup = isDir && target.length === 2 && holder(target[0]) && hasSkills(fr.abs)
      const groupOut = isDir && holder(fr.segs[0]) && (
        fr.segs.length === 2 ? hasSkills(fr.abs) : fr.segs.length === 1 ? (children(fr.abs)?.some(hasSkills) ?? true) : false)
      if (inSkills(fr.rel) || inSkills(target.join('/')) || intoGroup || groupOut) throw new Denied(SKILL_FILES_REFUSAL)
    }
    // under users/ folder rules are not read: the folder would become private to one person and the rest of the team,
    // admins included, could not see it to move it back. Nobody may do that, owner included (design tab 2 rule 3).
    if (managed && target[0] === 'users') fileError('validation', 'ruleFolderToUsers', { to: 'invalid_path: a group, project or rule folder cannot move under users/' })
    // an ordinary item into the caller's own folder: whoever could read it and cannot any more must be confirmed
    let narrowed = 0
    if (target[0] === 'users' && !(fr.segs[0] === 'users' && fr.segs[1] === target[1])) {
      narrowed = this.lostViewers(rules, user.id, fr.segs, target)
      if (narrowed > 0 && !o.confirm) fileError('conflict', 'audienceNarrowed', undefined, { reason: 'audience_narrowed', lostViewers: narrowed })
    }
    // a project's folder moved to projects/<name> from elsewhere: the project follows it, and the skills in its skills/
    // folder start to count in its chats (docs/DECISIONS.md "Project skills"). Said first, with their names (409
    // project_skills_on unless skillsOk), and each recorded as a skill change once moved
    const switchOn = isDir ? this.skillsSwitchingOn(fr, target) : null
    if (switchOn?.names.length && !o.skillsOk) fileError('conflict', 'projectSkillsOn', undefined, { reason: 'project_skills_on', skills: switchOn.names.slice(0, 20).join('\n'), count: switchOn.names.length })
    const toRel = target.join('/')
    const readers = this.readersOf(rules, fr.segs)
    this.relocate(userId, fr, target, isDir, { ...o, narrowed })
    if (switchOn?.names.length) {
      for (const p of switchOn.paths) audit(this.ctx.db, { actor: userId, action: 'skills.change', target: `${toRel}/${p}`, detail: { change: 'move', from: `${fr.rel}/${p}`, byAi: o.turnId != null, turnId: o.turnId ?? null, kind: 'skill', tool: o.tool ?? null, project: switchOn.project } })
    }
    const after = this.rules()
    this.dropSessionsOf(readers.filter((p) => !atLeast(after.access(p, target), 'read')), { path: fr.rel, to: toRel })
    // the folder's rules moved with it: who could see where it was is judged by the rules loaded before the move
    this.publish([{ path: toRel, from: fr.rel, action: 'move', by: this.by(userId), turnId: o.turnId ?? null }], rules)
    return { entry: this.entry(user, rules, target) }
  }

  /**
   * The skills a move of folder `fr` to `target` turns on (docs/DECISIONS.md "Project skills"): `target` is
   * projects/<name>, `fr` is not one already, a live project's folder is `fr` (the project follows it), and its skills/
   * holds SKILL.md folders. Their names and their paths below the folder; null when the move turns nothing on.
   */
  private skillsSwitchingOn(fr: { rel: string; segs: string[]; abs: string }, target: string[]): { names: string[]; paths: string[]; project: { id: string; name: string } } | null {
    const fold = (n: string) => n.normalize('NFC').toLowerCase()
    if (target.length !== 2 || fold(target[0]!) !== 'projects') return null
    if (fr.segs.length === 2 && fold(fr.segs[0]!) === 'projects') return null
    // the live project on that folder, letter case and Unicode form folded (as the guard compares names)
    const k = foldKey(fr.rel)
    const project = (this.ctx.db.query('SELECT id, name, folder_path FROM projects WHERE trashed_with IS NULL ORDER BY created_at, id').all() as { id: string; name: string; folder_path: string }[])
      .find((p) => foldKey(p.folder_path) === k)
    if (!project) return null
    const found = skillsUnder(this.root, fr.rel)
    return found.names.length ? { ...found, project: { id: project.id, name: project.name } } : null
  }


  /**
   * A deleted member's personal folder `fromRel` (users/<id>) goes to `toRel` in the owner's personal folder (the
   * "transfer" of admin/users.ts deleteUser), with the same bookkeeping as a move on the Files screen: version history,
   * folders rows, projects and the text cache follow it, and the file events say where it went. Its chat attachments
   * (.attachments/, uploads/attachments.ts ATTACHMENTS_DIR) are removed first: they go with the chats. There is no
   * access check: nobody can open the folder of a deleted account, and deleting it was the decision. What the member
   * had deleted stays where it was (trash items do not cross the edge of a personal folder, as in move).
   * `actorId`: who deleted the member. The archive folder that holds `toRel` must exist.
   */
  archiveFolder(actorId: string, fromRel: string, toRel: string): void {
    const segs = segsOf(fromRel), target = segsOf(toRel)
    if (segs.length !== 2 || segs[0] !== 'users' || target.length < 3 || target[0] !== 'users' || target[1] === segs[1]) throw new Error(`not a personal folder to archive: ${fromRel} -> ${toRel}`)
    const abs = path.join(this.root, ...segs)
    const st = fs.lstatSync(abs)
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`not a folder: ${fromRel}`)
    if (fs.existsSync(path.join(this.root, ...target))) throw new Error(`already there: ${toRel}`)
    fs.rmSync(path.join(abs, '.attachments'), { recursive: true, force: true })
    this.dropTextCache(`${fromRel}/.attachments`, true)
    const before = this.rules()
    this.relocate(actorId, { rel: fromRel, segs, abs }, target, true, { tool: 'member-delete' })
    this.publish([{ path: toRel, from: fromRel, action: 'move', by: this.by(actorId), turnId: null }], before)
  }

  /**
   * The database and disk part of a move, after its checks: the history, folders rows, projects, attachments and
   * trash items of the moved path follow it, two file events record it, then the rename and the text cache. move()
   * checks the caller's access first; archiveFolder() is the server's own move of a deleted member's folder.
   */
  private relocate(userId: string, fr: { rel: string; segs: string[]; abs: string }, target: string[], isDir: boolean, o: By & { narrowed?: number }) {
    const toRel = target.join('/')
    const narrowed = o.narrowed ?? 0
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
      // one project per folder: a project inside the moved folder must not land on a folder another project in place
      // still names (one whose folder is gone from disk keeps its path). Two projects that already shared a folder
      // before the rule move together and stay as they are. Projects whose folder is in the trash hold no path.
      if (isDir) {
        const key = (p: string) => volumeKey(p, this.fx.caseInsensitive)
        const inside = db.query(`SELECT folder_path FROM projects WHERE trashed_with IS NULL AND ${under('folder_path')}`).all(fr.rel, fr.rel, fr.rel) as { folder_path: string }[]
        if (inside.length) {
          const others = new Set((db.query(`SELECT folder_path FROM projects WHERE trashed_with IS NULL AND NOT ${under('folder_path')}`).all(fr.rel, fr.rel, fr.rel) as { folder_path: string }[]).map((r) => key(r.folder_path)))
          for (const r of inside) {
            const next = toRel + r.folder_path.slice(fr.rel.length)
            if (key(next) !== key(r.folder_path) && others.has(key(next))) fileError('conflict', 'projectThere', { to: toRel }, { reason: 'project_folder_taken' })
          }
        }
      }
      const re = (table: string, col: string) => db.query(`UPDATE ${table} SET ${col} = ? || substr(${col}, length(?) + 1) WHERE ${under(col)}`).run(toRel, fr.rel, fr.rel, fr.rel, fr.rel)
      re('folders', 'path')
      // projects follow the folder: those in place, and those whose folder went to the trash from inside it while the
      // trash items follow it (below), so that they come back with it. A project whose folder was trashed from the
      // moved folder's own path (another folder) keeps its path.
      const trashFollows = isDir && personalSide(fr.segs) === personalSide(target)
      db.query(`UPDATE projects SET folder_path = ? || substr(folder_path, length(?) + 1) WHERE ${under('folder_path')} AND (trashed_with IS NULL${trashFollows ? " OR trashed_with IN (SELECT id FROM trash_items WHERE restored_at IS NULL AND substr(original_path, 1, length(?) + 1) = ? || '/')" : ''})`)
        .run(toRel, fr.rel, fr.rel, fr.rel, fr.rel, ...(trashFollows ? [fr.rel, fr.rel] : []))
      re('file_versions', 'path')
      re('file_versions', 'conflict_path')
      re('attachments', 'path')
      // items trashed from inside the moved folder: their place to go back to moves with it. Otherwise the trash checks
      // write access on the old path (no rule there any more: the group stops seeing its own trash), and a restore
      // recreates the old name, or lands in whatever folder took that name since (another group's).
      // Only while the folder stays on the same side of a personal folder's edge (team folders, or one person's own
      // users/<id>/): a file someone deleted in their personal folder stays theirs when they share the folder by
      // moving it into a team folder, and what the team deleted stays the team's when someone moves the folder into
      // their personal folder. Otherwise the whole team saw and restored a file the owner had deleted on purpose
      // before sharing the folder (security review r3).
      // Only what was inside the folder: a trashed file or folder that merely had the moved entry's own path was
      // another one and stays where it was deleted.
      if (isDir && personalSide(fr.segs) === personalSide(target)) {
        db.query("UPDATE trash_items SET original_path = ? || substr(original_path, length(?) + 1) WHERE restored_at IS NULL AND substr(original_path, 1, length(?) + 1) = ? || '/'")
          .run(toRel, fr.rel, fr.rel, fr.rel)
      }
      fileEvent(db, { turnId: o.turnId ?? null, userId, path: fr.rel, action: 'delete', detail: { movedTo: toRel, folder: isDir, tool: o.tool ?? 'file-screen' } })
      fileEvent(db, { turnId: o.turnId ?? null, userId, path: toRel, action: 'create', detail: { movedFrom: fr.rel, folder: isDir, tool: o.tool ?? 'file-screen', ...(narrowed ? { audienceNarrowed: narrowed } : {}) } })
      fs.renameSync(fr.abs, path.join(this.root, ...target))
    })()
    this.moveTextCache(fr.rel, toRel, isDir)
  }

  /**
   * For the AI's move_files / copy_files (tools/file-moves.ts), before anything changes: how many other active people
   * could read the items in `toFolder` and cannot read all of them now (added), and, for a move, how many can read one
   * of them now and could not in `toFolder` (lost). Counted once per person, never named. Every path is checked like
   * the move / copy itself (a path the caller may not use throws: the tool checks them one by one first).
   */
  audienceChange(userId: string, from: string[], toFolder: string, mode: 'move' | 'copy'): { added: number; lost: number; fingerprint: string } {
    const user = this.principal(userId)
    const rules = this.rules()
    const srcs = from.map((f) => authorize(this.fx, rules, user, f, mode === 'move' ? 'write' : 'read', { mustExist: true }).segs)
    const to = authorize(this.fx, rules, user, toFolder, 'write', { mustExist: true })
    if (!to.st!.isDirectory()) throw new ToolError('not a folder', 'not_folder')
    let added = 0, lost = 0
    const audience: string[] = []
    for (const p of activePeople(this.ctx.db)) {
      if (p.id === user.id) continue
      const sees = atLeast(rules.access(p, to.segs), 'read')
      audience.push(JSON.stringify([p.id, sees, srcs.map(s => atLeast(rules.access(p, s), 'read'))]))
      if (sees && srcs.some((s) => !atLeast(rules.access(p, s), 'read'))) added++
      if (mode === 'move' && !sees && srcs.some((s) => atLeast(rules.access(p, s), 'read'))) lost++
    }
    // Compare identities as well as counts without exposing reader names to the tool.
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(audience.sort())).digest('hex')
    return { added, lost, fingerprint }
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
  async copy(userId: string, from: string, to: string, o: { baseSha256?: string | null; dryRun?: boolean; onExists?: 'fail' | 'replace' | 'rename' } & By = {}): Promise<{ path: string; sha256: string } | { viewersAdded: number }> {
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
    // the AI never copies into a skill root (skills/, a group's skills; as move above): only write / edit and their card
    // put a file there. People on the Files screen (no turn) copy as before
    if (o.turnId != null && inSkills(r.rel)) throw new Denied(SKILL_FILES_REFUSAL)
    const added = this.viewersAdded(rules, user.id, fr.segs, r.segs)
    if (o.dryRun) return { viewersAdded: added }
    // with a plan, the team disk near full or over the plan's limit (system/storage.ts): a tool gets a tool error, the
    // Files screen a 507. A server with no plan has no check here, as before.
    if (currentPlan()) { if (o.tool) assertStorageRoomForAI(st.size); else assertStorageRoom(st.size) }
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
          let cn = conflictCopyName(name, user.name, new Date(), teamDefaultLocale(this.ctx.db), teamTimeZone(this.ctx.db))
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
    const turnId = o.turnId ?? null, tool = o.tool ?? 'file-screen'
    if (conflictOf) recordConflictCopy(this.ctx.db, this.ctx.files.events, { original: conflictOf, copy: r.rel, userId, turnId, size: out.size, sha256: sha, tool })
    fileEvent(this.ctx.db, { turnId, userId, path: r.rel, action: 'create', size: out.size, sha256: sha, detail: { sourcePaths: [fr.rel], widened: added > 0, replaced, tool, ...(conflictOf ? { conflictCopyOf: conflictOf } : {}) } })
    this.extractText(r.rel)
    this.publish([{ path: r.rel, action: replaced ? 'update' : 'create', by: this.by(userId), turnId }])
    return { path: r.rel, sha256: sha }
  }

  /**
   * A skill copied to another level (skills/move.ts runCopy, after the person's yes on its card or the Skills page):
   * `files` are the bytes the card was bound to (by their hashes), placed at `to`, a folder (`folder`: a SKILL.md folder,
   * each file at `segs` inside it) or a single file that is not there yet, where the caller may write. Built under a
   * server temp name beside it, then renamed into place. One event for it, with where it was copied from (`copiedFrom`:
   * skills/changes.ts lists it as the change's `from`; null for a person's own skill, never named to others).
   */
  writeSkillCopy(userId: string, from: string | null, to: string, files: { segs: string[]; bytes: Uint8Array }[], o: { folder: boolean; turnId?: string | null; tool?: string }): void {
    const user = this.principal(userId)
    const rules = this.rules()
    const tr = authorize(this.fx, rules, user, to, 'write', { mustExist: false })
    if (tr.exists) fileError('conflict', 'exists', { to: tr.rel })
    const size = files.reduce((n, f) => n + f.bytes.length, 0)
    if (currentPlan()) { if (o.turnId != null) assertStorageRoomForAI(size); else assertStorageRoom(size) }
    const dir = path.join(this.root, ...tr.segs.slice(0, -1))
    const tmp = path.join(dir, PRODUCT.tmpPrefix + crypto.randomUUID())
    try {
      if (o.folder) {
        fs.mkdirSync(tmp, { mode: 0o700 })
        for (const f of files) {
          if (!f.segs.length || f.segs.some((s) => !s || s === '.' || s === '..' || s.includes('/') || s.includes('\\'))) throw new Denied('bad path in a skill copy')
          fs.mkdirSync(path.join(tmp, ...f.segs.slice(0, -1)), { recursive: true, mode: 0o700 })
          fs.writeFileSync(path.join(tmp, ...f.segs), f.bytes, { mode: 0o600, flag: 'wx' })
        }
      } else fs.writeFileSync(tmp, files[0]?.bytes ?? new Uint8Array(), { mode: 0o600, flag: 'wx' })
      verifyChain(this.root, tr.segs, true)
      if (fs.existsSync(tr.abs)) fileError('conflict', 'exists', { to: tr.rel })
      fs.renameSync(tmp, tr.abs)
    } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw e }
    const turnId = o.turnId ?? null
    fileEvent(this.ctx.db, { turnId, userId, path: tr.rel, action: 'create', size, detail: { folder: o.folder, copiedFrom: from, ...(from ? { sourcePaths: [from] } : {}), ...(o.folder ? { files: files.length } : {}), tool: o.tool ?? 'skill_copy' } })
    for (const f of files) this.extractText(o.folder ? [...tr.segs, ...f.segs].join('/') : tr.rel)
    this.publish([{ path: tr.rel, action: o.folder ? 'mkdir' : 'create', by: this.by(userId), turnId }])
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
    // by authorize() like a missing name, so the " (2)" never tells them it exists). Also around every path a project
    // names: a project whose folder vanished from disk another way than the trash still takes a folder made at its
    // path, which would then carry its instructions and be admin-only to move (one project per folder,
    // docs/DECISIONS.md "Projects: a folder with instructions"). A project whose folder is in the trash holds no path,
    // but stepping around it too costs nothing. The caller learns only that some project names the path, never which.
    const projectKeys = new Set((this.ctx.db.query('SELECT folder_path FROM projects').all() as { folder_path: string }[]).map((r) => volumeKey(r.folder_path, this.fx.caseInsensitive)))
    const name = freeName(pr.abs, fr.segs[fr.segs.length - 1]!, true, (n) => siblingVisible(this.fx, rules, user, pr.segs, n), (n) => projectKeys.has(volumeKey([...pr.segs, n].join('/'), this.fx.caseInsensitive)))
    const tr = authorize(this.fx, rules, user, [...pr.segs, name].join('/'), 'write', { mustExist: false })
    const added = this.viewersAdded(rules, user.id, fr.segs, tr.segs)
    if (o.dryRun) return { viewersAdded: added }
    const { files, bytes } = this.copyTree(user, rules, fr, pr.abs, (tmp) => { verifyChain(this.root, tr.segs, true); fs.renameSync(tmp, tr.abs) }, o)
    fileEvent(this.ctx.db, { turnId: null, userId, path: tr.rel, action: 'create', size: bytes, detail: { folder: true, sourcePaths: [fr.rel], widened: added > 0, files: files.length, tool: 'file-screen' } })
    for (const f of files) this.extractText([...tr.segs, ...f.segs].join('/'))
    this.publish([{ path: tr.rel, action: 'mkdir', by: this.by(userId), turnId: null }])
    return { path: tr.rel, files: files.length, bytes }
  }

  /**
   * The readable files and listable folders of `fr`, copied into a temporary folder made in `intoAbs` (a server temp
   * name: nobody sees it), which `place` then puts where it goes. Walked without following anything; refused past
   * `maxFiles` / `maxBytes`; the temporary folder goes again when anything fails.
   */
  private copyTree(user: Principal, rules: RuleSet, fr: Authorized, intoAbs: string, place: (tmp: string) => void, o: { maxFiles?: number; maxBytes?: number }): { files: { segs: string[]; size: number }[]; bytes: number } {
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
    if (currentPlan()) assertStorageRoom(bytes)
    const tmp = path.join(intoAbs, PRODUCT.tmpPrefix + crypto.randomUUID())
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
      place(tmp)
    } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw e }
    return { files, bytes }
  }

  /**
   * Copy what is inside the caller's folder `from` into the empty folder `to` (a team project folder the server just
   * made for sharing a personal project, routes/chats.ts shareProject): read as the caller, written where the caller may
   * write (the new folder's rules let its creator write). Same limits as copyFolderTree. The caller takes `to` away
   * when this fails.
   */
  copyFolderInto(userId: string, from: string, to: string, o: { maxFiles?: number; maxBytes?: number } = {}): { files: number; bytes: number } {
    const user = this.principal(userId)
    const rules = this.rules()
    const fr = authorize(this.fx, rules, user, from, 'read', { mustExist: true })
    if (!fr.st!.isDirectory()) throw new ToolError('not a folder', 'not_folder')
    const tr = authorize(this.fx, rules, user, to, 'write', { mustExist: true })
    if (!tr.st!.isDirectory()) throw new ToolError('not a folder', 'not_folder')
    if (tr.rel === fr.rel || isUnder(fr.rel, tr.rel) || isUnder(tr.rel, fr.rel)) fileError('validation', 'intoItself', { to })
    if (fs.readdirSync(tr.abs).length) fileError('conflict', 'exists', { to })
    const { files, bytes } = this.copyTree(user, rules, fr, tr.abs, (tmp) => {
      for (const name of fs.readdirSync(tmp)) fs.renameSync(path.join(tmp, name), path.join(tr.abs, name))
      fs.rmdirSync(tmp)
    }, o)
    fileEvent(this.ctx.db, { turnId: null, userId, path: tr.rel, action: 'create', size: bytes, detail: { folder: true, sourcePaths: [fr.rel], files: files.length, tool: 'file-screen' } })
    for (const f of files) this.extractText([...tr.segs, ...f.segs].join('/'))
    this.publish([{ path: tr.rel, action: 'mkdir', by: this.by(userId), turnId: null }])
    return { files: files.length, bytes }
  }

  /**
   * Take back a folder that copyFolderTree() made in this request when the request's next step failed (sharing a
   * project refuses a folder another project names, routes/chats.ts): removed for good, not through the trash, so
   * nothing of it stays behind for an old project to take over. The copy holds only folders and files this request
   * made.
   */
  discardCopy(userId: string, rel: string) {
    const segs = segsOf(rel)
    verifyChain(this.root, segs)
    fs.rmSync(path.join(this.root, ...segs), { recursive: true, force: true })
    this.dropTextCache(rel, true)
    fileEvent(this.ctx.db, { turnId: null, userId, path: rel, action: 'delete', detail: { folder: true, discarded: true, tool: 'file-screen' } })
    this.publish([{ path: rel, action: 'delete', by: this.by(userId), turnId: null }])
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
  /**
   * `turnId`: an AI turn's delete (chat/delete-files.ts, the only one): it never takes a skill root, something in one
   * or a folder that holds one, whatever the role (fail closed here, not only in the tool), and nothing without `ai`,
   * the item its card showed. With `ai` the item must still be exactly that: the same entry, still one the AI may put
   * in the trash, the same people reading and writing it, the same entries on disk (checked right before the move and
   * again where it went, in the same synchronous block as moveIntoTrash), and the same trash setting. A folder that
   * changed between the two checks goes back where it was (`AiTrashChanged`); one that cannot go back (something took
   * its place meanwhile) stays in the trash with its row, nothing lost, and `changed` says so.
   */
  remove(userId: string, rel: string, turnId: string | null = null, o: { projectFolder?: boolean; ai?: { item: AiTrashItem; retentionDays: number } } = {}): { trashId: string; purgeAt: string; changed?: true } {
    const user = this.principal(userId)
    const rules = this.rules()
    const r = authorize(this.fx, rules, user, rel, 'write', { mustExist: true })
    this.assertMovable(r.segs)
    if (turnId !== null) {
      if (aiSkillPath(r.rel) || (r.st!.isDirectory() && holdsSkillRoot(r.segs))) throw new Denied(AI_SKILL_TRASH_REFUSAL)
      if (!o.ai) throw new Denied('an AI turn puts things in the trash only with delete_files, after the user\'s yes on its card')
    }
    // trashing a group / project / rule folder takes it from everyone who works there: admins and the owner only. Not
    // asked for the folder of a team project its editor deletes along with it (routes/chats.ts deleteProject: the
    // project's creator or an admin, a projects/<name> folder they write; a folder inside it they cannot write still
    // stops it, below)
    if (!o.projectFolder) this.assertMayChangeManaged(user, rules, r.rel)
    // the project's own folder is its editor's to trash; anything managed inside it (a rule folder, a group's folder,
    // another project's folder) stays admin-only, as for any other trash (review: another project went to the trash)
    else if (user.role !== 'owner' && user.role !== 'admin' && this.managedBelow(rules, r.rel)) fileError('forbidden', 'ruleFolder')
    const isDir = r.st!.isDirectory()
    let size: number
    if (isDir) { this.assertSubtreeWritable(user, rules, r.segs); size = treeSize(r.abs).bytes }
    else size = checkRegular(r.abs).size
    const ai = o.ai
    if (ai) this.aiItemStill(user, rules, ai.item, r)
    const days = getTeamSettings(this.ctx.db).trashRetentionDays
    if (ai && days !== ai.retentionDays) throw new AiTrashChanged(r.rel)
    const id = newId()
    const purgeAt = iso(Date.now() + days * DAY)
    const db = this.ctx.db
    const readers = this.readersOf(rules, r.segs)
    let changed = false
    /** the item's rows in the trash list, as one set of writes (inside the move's transaction, or again in a rescue) */
    const record = (storage: string, rescued: boolean) => {
      db.query('INSERT INTO trash_items (id, original_path, storage_path, size, deleted_by, turn_id, purge_at, kind) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, r.rel, storage, size, userId, turnId, purgeAt, isDir ? 'folder' : 'file')
      // the folder's rules go with it (parked under its trash path): a new folder made at the same path does not
      // inherit them, and the deleted one gets them back wherever it is restored
      if (isDir) rebaseFolders(db, r.rel, storage)
      // the team projects of this folder and below go with it: admins and the owner only until it comes back
      // (chat/projects.ts canSeeProject), and they follow it when it is restored. A project already marked keeps the
      // folder trashed first. Personal projects are their person's in the trash too.
      if (isDir && r.segs[0] !== 'users') db.query("UPDATE projects SET trashed_with = ? WHERE trashed_with IS NULL AND substr(folder_path, 1, 6) <> 'users/' AND (folder_path = ? OR substr(folder_path, 1, length(?) + 1) = ? || '/')").run(id, r.rel, r.rel, r.rel)
      fileEvent(db, { turnId, userId, path: r.rel, action: 'delete', size, detail: { folder: isDir, trashId: id, ...(ai ? { tool: 'delete_files' } : {}), ...(changed ? { changedWhileMoving: true } : {}), ...(rescued ? { rescued: true } : {}) } })
    }
    // an item that went to the trash storage, whose rows then failed and which could not go back (something took its place)
    const out: { stranded: { storage: string; cause: unknown } | null } = { stranded: null }
    try {
      db.transaction(() => {
        if (ai && !this.aiSameOnDisk(r.abs, ai.item)) throw new AiTrashChanged(r.rel)
        const storage = moveIntoTrash(this.root, r.segs)
        const storageAbs = path.join(this.root, ...storage.split('/'))
        // a folder can still change between that check and the move: a dev-environment job writes project folders from
        // outside this process (devenv/srt/access.ts). Checked again where it is now; put back when it differs
        if (ai && !this.aiSameOnDisk(storageAbs, ai.item)) {
          if (this.putBack(storageAbs, r.segs)) throw new AiTrashChanged(r.rel)
          changed = true
          this.ctx.log.warn('an item the AI put in the trash changed while it moved and could not go back; it stays in the trash', { path: r.rel, turn: turnId })
        }
        try { record(storage, false) } catch (e) {
          // back where it was, and never over what took that place meanwhile (a writer outside this process); when it
          // cannot go back it must not stay without a row (below)
          if (!this.putBack(storageAbs, r.segs)) out.stranded = { storage, cause: e }
          throw e
        }
      })()
    } catch (e) {
      const s = out.stranded
      if (!s) throw e
      // the rows were rolled back and the item could not go back: it sits in the trash storage. Logged at error level with
      // where it is, then its rows are written once more, and failing that the trash row alone, so it can be restored
      this.ctx.log.error('an item in the trash storage could not go back and its trash rows failed; writing them again', { path: r.rel, storage: s.storage, err: s.cause })
      let rescued = false
      try { db.transaction(() => record(s.storage, true))(); rescued = true } catch (again) {
        this.ctx.log.error('the trash rows failed again; writing the trash row alone', { path: r.rel, storage: s.storage, err: again })
        try {
          db.query('INSERT INTO trash_items (id, original_path, storage_path, size, deleted_by, turn_id, purge_at, kind) VALUES (?,?,?,?,?,?,?,?)')
            .run(id, r.rel, s.storage, size, userId, turnId, purgeAt, isDir ? 'folder' : 'file')
          rescued = true
        } catch (last) { this.ctx.log.error('no trash row could be written: the item is only in the trash storage', { path: r.rel, storage: s.storage, err: last }) }
      }
      if (!rescued) throw new TrashStranded(r.rel, s.storage)
    }
    const followUp = () => {
      this.dropTextCache(r.rel, isDir)
      // whoever could read it and cannot see it in the trash either (they could restore it from there) lost it
      const t = this.trashRow(id)
      const after = this.rules()
      this.dropSessionsOf(readers.filter((p) => !t || !this.trashVisible(p, after, t)), { path: r.rel })
      // a trashed folder's rules were parked with it: judge the deleted path by the rules as they were before
      this.publish([{ path: r.rel, action: 'delete', by: this.by(userId), turnId }], rules)
    }
    // the AI's delete: it is in the trash now, with its row, whatever a listener does next; the call says so (its trash
    // id goes into the audit row)
    if (ai) { try { followUp() } catch (e) { this.ctx.log.warn('after the AI put an item in the trash, a follow-up failed', { err: e, path: r.rel }) } }
    else followUp()
    return { trashId: id, purgeAt, ...(changed ? { changed: true as const } : {}) }
  }

  /** Put an item the AI was moving into the trash back at `segs` (it changed on the way). Only where nothing took its
   * place meanwhile and the folders above are still folders: a rename would replace a file or an empty folder made
   * there. false: it could not go back. */
  private putBack(fromAbs: string, segs: string[]): boolean {
    try {
      verifyChain(this.root, segs, true)
      const to = path.join(this.root, ...segs)
      try { fs.lstatSync(to); return false } catch (e: any) { if (e?.code !== 'ENOENT') return false }
      fs.renameSync(fromAbs, to)
      return true
    } catch { return false }
  }

  // ---------------- the AI's delete_files (chat/delete-files.ts) ----------------
  /**
   * Why the AI may not put `segs` in the trash, for every role (admins and the owner included), or null. Never the
   * team root, a top-level folder, .system, chat attachments, someone else's personal folder, a hidden item, a skill
   * root, something in one or a folder that holds one, an instruction file, a group / project / rule folder or a
   * folder that holds one (managedInside), a plugin's folder or one that holds it, or the target of an open upload
   * link. The Files screen keeps its own rules (assertMovable, assertMayChangeManaged): this is on top of them.
   */
  private aiTrashRefusal(user: Principal, rules: RuleSet, segs: string[], isDir: boolean): string | null {
    const rel = segs.join('/')
    const fold = (x: string) => x.normalize('NFC').toLowerCase()
    if (segs.length === 0 || fold(segs[0]!) === fold(PRODUCT.systemDir)) return 'the team root and the system folder never go to the trash'
    if (segs.some((x) => fold(x) === '.attachments')) return 'chat attachments (.attachments) go with their chats, not to the trash'
    if (fold(segs[0]!) === 'users' && segs.length >= 2 && segs[1] !== user.id) return 'another person\'s folder'
    if (isDir && segs.length === 1) return 'a top-level folder never goes to the trash from a chat; an admin deletes it on the Files screen'
    if (aiSkillPath(rel) || (isDir && holdsSkillRoot(segs))) return AI_SKILL_TRASH_REFUSAL
    if (segs.some((x) => x.startsWith('.'))) return 'a hidden item; the user deletes it on the Files screen'
    if (instructionFile(rel)) return 'an instruction file (CLAUDE.md, AGENTS.md, GEMINI.md, SKILL.md: what an AI follows); the user deletes it on the Files screen'
    if (this.managedInside(rules, rel)) return 'a group, project or rule folder, or a folder that holds one: an admin deletes it on the Files screen'
    // a personal project's folder too (managedInside leaves users/ out): the project would lose its folder
    if (isDir && this.projectAtOrBelow(rel)) return 'a project\'s folder, or a folder that holds one: the user deletes the project on the Projects screen'
    if (this.fx.managed?.managerOf(segs) || this.fx.managed?.heldBelow(segs)) return 'a plugin\'s folder, or one that holds it: an admin turns the plugin off in Admin > Plugins'
    if (this.linkTarget(rel, isDir)) return 'an open upload link points here; it can go to the trash once the link is used or expires'
    return null
  }

  /** A live project (not in the trash) uses `rel` or a folder below it, personal projects included. */
  private projectAtOrBelow(rel: string): boolean {
    const k = (p: string) => volumeKey(p, this.fx.caseInsensitive)
    const me = k(rel)
    const rows = this.ctx.db.query('SELECT folder_path FROM projects WHERE trashed_with IS NULL').all() as { folder_path: string }[]
    return rows.some((x) => { const p = k(x.folder_path); return p === me || p.startsWith(me + '/') })
  }

  /** An unused, unexpired upload link of the app connector (connectors/remote-mcp/upload-link.ts) points at `rel` (or,
   * for a folder, somewhere inside it). Fails closed: a link table that cannot be read counts as a link. */
  private linkTarget(rel: string, isDir: boolean): boolean {
    const k = (p: string) => volumeKey(p.split('/').filter((x) => x !== '' && x !== '.').join('/'), this.fx.caseInsensitive)
    const me = k(rel)
    let rows: { path: string }[]
    try { rows = this.ctx.db.query('SELECT path FROM remote_mcp_upload_links WHERE used_at IS NULL AND expires_at > ?').all(Date.now()) as { path: string }[] } catch { return true }
    return rows.some((x) => { const p = k(x.path); return p === me || (isDir && p.startsWith(me + '/')) })
  }

  /** The other active people who can read `segs` now and who can write it (they see it in the trash and may restore
   * it), with a hash of who they are, what they may do and their role. */
  private aiAudience(rules: RuleSet, self: string, segs: string[]): { fingerprint: string; readers: string[]; writers: string[] } {
    const rows: string[] = [], readers: string[] = [], writers: string[] = []
    for (const p of activePeople(this.ctx.db)) {
      if (p.id === self) continue
      const a = rules.access(p, segs)
      const read = atLeast(a, 'read'), write = a === 'write'
      rows.push(JSON.stringify([p.id, p.role, read, write]))
      if (read) readers.push(p.id)
      if (write) writers.push(p.id)
    }
    return { fingerprint: crypto.createHash('sha256').update(JSON.stringify(rows.sort())).digest('hex'), readers, writers }
  }

  /** The people (not `user`) who made or changed the file `rel`, as its history shows it to `user` (history(): only
   * where they may read the place it happened, judged where that place is now). */
  private historyPeople(user: Principal, rules: RuleSet, rel: string, into: Set<string>) {
    const db = this.ctx.db
    const readable = (p: string) => atLeast(rules.access(user, segsOf(p)), 'read')
    for (const e of fileTimeline(db, rel, { limit: 50 })) {
      if (!CONTENT_KINDS.has(e.kind) || !e.userId || e.userId === user.id || into.has(e.userId) || !readable(e.path)) continue
      const now = placeNow(db, e.path, e.id)
      if ('at' in now ? now.at === e.path || readable(now.at) : user.role === 'owner' || user.role === 'admin') into.add(e.userId)
    }
  }

  /**
   * Is `item` still exactly what the card showed: the same entry for this person (`r`, resolved again), still one the
   * AI may put in the trash, the same audience, the same entries on disk? Throws AiTrashChanged (or the access error).
   */
  private aiItemStill(user: Principal, rules: RuleSet, item: AiTrashItem, r?: Authorized) {
    const now = r ?? authorize(this.fx, rules, user, item.rel, 'write', { mustExist: true })
    if (now.rel !== item.rel) throw new AiTrashChanged(item.rel)
    const isDir = now.st!.isDirectory()
    if ((item.kind === 'folder') !== isDir) throw new AiTrashChanged(item.rel)
    const no = this.aiTrashRefusal(user, rules, now.segs, isDir)
    if (no) throw new Denied(no)
    if (this.aiAudience(rules, user.id, now.segs).fingerprint !== item.audience) throw new AiTrashChanged(item.rel)
    if (!this.aiSameOnDisk(now.abs, item)) throw new AiTrashChanged(item.rel)
  }
  /** The entries at `abs` (the item where it is, or where it went in the trash) are exactly the card's. */
  private aiSameOnDisk(abs: string, item: AiTrashItem): boolean {
    try { return sameStamps(stampTree(abs, item.entries.length), item.entries) } catch { return false }
  }

  /**
   * What one delete_files call would put in the trash, before its card: each path resolved for the person like the
   * Files screen's delete (write access, the same normalization as every file tool: no absolute paths, no '..', the
   * actual letter case and Unicode form), then the AI's own refusals (aiTrashRefusal). Any refused path refuses the
   * whole call (`refused`, each with its reason): the card shows only a call that runs as asked. Duplicates (another
   * spelling of the same entry) and items inside a listed folder go once. Every entry is walked and counted, inside
   * folders too, and the walk stops past AI_TRASH_MAX_ENTRIES (a ToolError). Nothing changes.
   */
  planAiTrash(userId: string, paths: readonly string[]): { plan: AiTrashPlan } | { refused: { path: string; error: string }[] } {
    const user = this.principal(userId)
    const rules = this.rules()
    const refused: { path: string; error: string }[] = []
    const found: { r: Authorized; isDir: boolean }[] = []
    for (const p of paths) {
      try {
        const r = authorize(this.fx, rules, user, p, 'write', { mustExist: true })
        const isDir = r.st!.isDirectory()
        if (!isDir) checkRegular(r.abs)
        const no = this.aiTrashRefusal(user, rules, r.segs, isDir)
        if (no) refused.push({ path: r.rel, error: no })
        else found.push({ r, isDir })
      } catch (e) { refused.push({ path: p, error: aiReason(e) }) }
    }
    if (refused.length) return { refused }
    const key = (p: string) => volumeKey(p, this.fx.caseInsensitive)
    const uniq = new Map<string, { r: Authorized; isDir: boolean }>()
    for (const f of found) if (!uniq.has(key(f.r.rel))) uniq.set(key(f.r.rel), f)
    const all = [...uniq.values()]
    const listed = all.filter((f) => !all.some((g) => g !== f && g.isDir && key(f.r.rel).startsWith(key(g.r.rel) + '/')))
    const tooMany = `more than ${AI_TRASH_MAX_ENTRIES} files and folders (everything inside a folder counts), so nothing was moved to the trash. Ask the user to delete fewer at once, or to delete it on the Files screen`
    let total = 0
    const items: AiTrashItem[] = []
    const lost = new Set<string>(), noRestore = new Set<string>(), others = new Set<string>()
    for (const f of listed) {
      let entries: Stamp[] | null
      try { entries = stampTree(f.r.abs, AI_TRASH_MAX_ENTRIES - total) } catch { return { refused: [{ path: f.r.rel, error: 'it could not be read through' }] } }
      if (!entries) throw new ToolError(tooMany, 'too_many')
      total += entries.length
      // inside a folder too: no skill root, no chat attachments, no instruction file, nothing a plugin manages
      for (const e of entries) {
        if (!e.rel) continue
        const full = `${f.r.rel}/${e.rel}`
        const segs = segsOf(full)
        const no = aiSkillPath(full) ? AI_SKILL_TRASH_REFUSAL : segs.at(-1)!.normalize('NFC').toLowerCase() === '.attachments' ? 'it holds chat attachments (.attachments)'
          : instructionFile(full) ? `it holds an instruction file (${full}); the user deletes it on the Files screen` : this.fx.managed?.managerOf(segs) ? 'it holds a plugin\'s folder' : null
        if (no) return { refused: [{ path: f.r.rel, error: no }] }
      }
      const aud = this.aiAudience(rules, user.id, f.r.segs)
      for (const id of aud.readers) { lost.add(id); if (!aud.writers.includes(id)) noRestore.add(id) }
      for (const e of entries) if (e.kind === 'file') this.historyPeople(user, rules, e.rel ? `${f.r.rel}/${e.rel}` : f.r.rel, others)
      items.push({
        rel: f.r.rel, kind: f.isDir ? 'folder' : 'file',
        files: f.isDir ? entries.filter((e) => e.kind !== 'dir').length : 0, folders: entries.filter((e) => e.rel && e.kind === 'dir').length,
        entries, audience: aud.fingerprint,
      })
    }
    const refs = this.userRefs([...others])
    const coll = new Intl.Collator(undefined, { sensitivity: 'base' })
    return {
      plan: {
        items, entries: total, retentionDays: getTeamSettings(this.ctx.db).trashRetentionDays, lost: lost.size, noRestore: noRestore.size,
        others: [...others].map((id) => refs.get(id) ?? { id, name: id }).sort((a, b) => coll.compare(a.name, b.name)),
      },
    }
  }

  /**
   * After the person's yes on delete_files' card: every item checked again first (aiItemStill, the trash setting), in
   * this one synchronous block, so no other call of this server (a move_files of the same turn, a save) runs between
   * the checks and the moves; any item that changed since the card stops the whole call before anything moves
   * (`changed`, nothing trashed). Then each item goes with remove(), which checks it once more around the move itself
   * (a writer outside this process, devenv/srt/access.ts). What went, what changed on the way (put back, or kept in
   * the trash when it could not go back) and what failed.
   */
  trashAiPlan(userId: string, plan: AiTrashPlan, turnId: string): { trashed: { path: string; trashId: string; purgeAt: string; changed?: true }[]; changed: string[]; failed: { path: string; error: string }[]; stranded: { path: string; storage: string }[] } {
    const user = this.principal(userId)
    const rules = this.rules()
    if (getTeamSettings(this.ctx.db).trashRetentionDays !== plan.retentionDays) return { trashed: [], changed: plan.items.map((i) => i.rel), failed: [], stranded: [] }
    for (const item of plan.items) {
      try { this.aiItemStill(user, rules, item) }
      catch (e) {
        if (e instanceof AiTrashChanged || (e instanceof ToolError && e.code === 'not_found') || e instanceof Denied) return { trashed: [], changed: [item.rel], failed: [], stranded: [] }
        throw e
      }
    }
    const out: ReturnType<TeamFiles['trashAiPlan']> = { trashed: [], changed: [], failed: [], stranded: [] }
    for (const item of plan.items) {
      try { out.trashed.push({ path: item.rel, ...this.remove(userId, item.rel, turnId, { ai: { item, retentionDays: plan.retentionDays } }) }) }
      catch (e) {
        if (e instanceof AiTrashChanged) out.changed.push(item.rel)
        // moved out of its place, but no trash row could be written: not "not moved" (remove(); the log says where)
        else if (e instanceof TrashStranded) out.stranded.push({ path: item.rel, storage: e.storage })
        else out.failed.push({ path: item.rel, error: aiReason(e) })
      }
    }
    return out
  }

  /** A path an AI turn put in the trash (still there), or one inside such a folder: never a "new" file for a room's
   * grant (chat/turn.ts roomGrantTarget). Rooms do not get delete_files; this keeps it so if that ever changes. */
  aiTrashed(rel: string): boolean {
    const k = (p: string) => volumeKey(p, this.fx.caseInsensitive)
    const me = k(rel)
    const rows = this.ctx.db.query('SELECT original_path FROM trash_items WHERE restored_at IS NULL AND turn_id IS NOT NULL').all() as { original_path: string }[]
    return rows.some((t) => { const p = k(t.original_path); return p === me || me.startsWith(p + '/') })
  }

  // ---------------- history ----------------
  private versionVisible(user: Principal, rules: RuleSet, row: Pick<VersionRow, 'path' | 'folder_id' | 'path_at_save'>): boolean {
    if (!atLeast(rules.access(user, segsOf(row.path)), 'read')) return false
    // the file's folder is in the trash (its rules parked under .system/trash): judge the version as if that folder,
    // and every folder that held it and went to the trash after it, were still in place. The live rules alone no
    // longer have them, so the path fell back to shared/ and every member read old versions of a restricted folder's
    // files (security round 3).
    const parked = row.folder_id ? this.parkedView(row.folder_id) : null
    if (parked === 'unknown') return user.role === 'owner' || user.role === 'admin'
    if (parked) return atLeast(parked.rules.access(user, segsOf(parked.path)), 'read') && atLeast(parked.rules.access(user, segsOf(row.path)), 'read')
    const f = row.folder_id ? this.folderLivePath(row.folder_id) : null
    if (f !== null) return atLeast(rules.access(user, segsOf(f)), 'read')
    return !row.path_at_save || atLeast(rules.access(user, segsOf(row.path_at_save)), 'read')
  }

  /**
   * Versions of one path. An existing entry the caller may read answers 200 with its rows (maybe none). Any other path
   * gets one answer whatever the reason (never existed, deleted, a missing folder above it, an entry hidden from the
   * caller under its exact name, a case variant or a look-alike): the version rows of that path the caller may read,
   * and the plain 404 of content/download when there are none. So the history of a deleted file the caller may read
   * still shows, and a hidden entry cannot be told from a missing one (security r2: 404 for a hidden entry or a
   * hidden look-alike vs 200 {items:[]} for a missing name was an existence oracle).
   * Also: the current file's hash (to tell which versions differ) and whether the caller may restore (write access to
   * the path, the rule restoreVersion checks; false for a path hidden from the caller).
   */
  async history(userId: string, rel: string): Promise<{ path: string; items: FileVersion[]; currentSha256: string | null; canRestore: boolean; current: HistoryCurrent | null; events: FileHistoryEvent[] }> {
    const user = this.principal(userId)
    const rules = this.rules()
    let at = parseInput(rel).join('/') // malformed input is refused the same way for everyone
    let exists = false
    let canRestore = false
    let currentSha256: string | null = null
    let currentSize = 0
    try {
      const r = authorize(this.fx, rules, user, rel, 'read', { mustExist: false })
      at = r.rel
      exists = r.exists
      // every listed version can be restored by whoever may write the file (restoreVersion checks the same);
      // the newest version is the content before the last change, not the current file
      // (a deleted file's versions too; a path hidden from the caller never gets here and stays false)
      canRestore = atLeast(rules.access(user, r.segs), 'write')
      if (r.exists && r.st!.isFile()) { try { const st = checkRegular(r.abs); currentSha256 = await this.sha(r.abs, st); currentSize = st.size } catch {} }
    } catch (e) {
      if (!(e instanceof Denied) && !(e instanceof ToolError && e.code === 'not_found')) throw e
    }
    const db = this.ctx.db
    const rows = (db.query('SELECT id, path, version, sha256, size, author_id, turn_id, saved_by, saved_turn_id, kind, conflict_path, storage_path, created_at, folder_id, path_at_save FROM file_versions WHERE path = ? ORDER BY version DESC LIMIT 500').all(at) as VersionRow[])
      .filter((v) => this.versionVisible(user, rules, v))
    if (!exists && rows.length === 0) throw new HttpError('not_found')
    // versions whose folder is in the trash cannot be restored until the folder is (restoreVersion refuses them)
    if (rows.length && rows.every((v) => this.versionInTrash(v))) canRestore = false
    // the changes of the file (moves followed back), each only where the caller may read the path it happened at:
    // a file moved out of a private folder does not show what happened in there, nor that folder's name
    const readable = (p: string) => atLeast(rules.access(user, segsOf(p)), 'read')
    // The live rules are keyed by the live folder paths: a folder above the old path that was renamed or trashed since
    // took its rules along, and the old path string fell back to the folder above (shared/: everyone). So the place is
    // judged where it is now too (placeNow), like versionVisible judges a version by its folder row. Still in the
    // trash (or purged): its rules are not in place, only owner / admin (review round 1).
    const seen = (p: string | null, id: number): boolean => {
      if (!p || !readable(p)) return false
      const now = placeNow(db, p, id)
      if ('at' in now) return now.at === p || readable(now.at)
      return user.role === 'owner' || user.role === 'admin'
    }
    const timeline = exists ? fileTimeline(db, at).filter((e) => seen(e.path, e.id)) : []
    // who made the content as it is now: the newest content change, when it made exactly this content
    const head = timeline.find((e) => CONTENT_KINDS.has(e.kind))
    const top = (db.query('SELECT MAX(version) AS v FROM file_versions WHERE path = ?').get(at) as { v: number | null }).v ?? 0
    const refs = this.userRefs([...rows.flatMap((v) => [v.author_id, v.saved_by ?? null]), ...timeline.map((e) => e.userId)])
    const ref = (id: string | null | undefined) => (id ? refs.get(id) ?? { id, name: id } : null)
    const headKnown = !!head && !!currentSha256 && head.sha256 === currentSha256
    return {
      path: at,
      currentSha256,
      canRestore,
      current: exists && currentSha256 ? {
        version: top + 1, sha256: currentSha256, size: currentSize,
        author: headKnown ? ref(head!.userId) : null, turnId: headKnown ? head!.turnId : null, at: headKnown ? normIso(head!.at) : null,
      } : null,
      events: timeline.map((e) => ({
        id: e.id, at: normIso(e.at), kind: e.kind, by: ref(e.userId), turnId: e.turnId, path: e.path,
        from: seen(e.from, e.id) ? e.from : null, size: e.size,
      })),
      items: rows.map((v) => ({
        id: v.id, path: v.path, version: v.version, sha256: v.sha256, size: v.size, author: ref(v.author_id),
        turnId: v.turn_id, kind: v.kind, conflictPath: v.conflict_path, createdAt: normIso(v.created_at),
        savedBy: ref(v.saved_by), savedTurnId: v.saved_by ? v.saved_turn_id ?? null : null,
      })),
    }
  }

  /** the folder the version was saved under is in the trash (or parked with a trash item that is gone) */
  private versionInTrash(v: Pick<VersionRow, 'folder_id'>): boolean {
    return !!v.folder_id && this.parkedView(v.folder_id) !== null
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
    // the version's folder is in the trash (its rules parked under .system/trash): the live rules no longer have them,
    // so write access fell back to the folder above (shared/: everyone write) and the restored file came back with no
    // rule at all, readable and writable by the whole team (security round 4). The folder comes back first, with its
    // rules; then the version.
    if (this.versionInTrash(v)) fileError('conflict', 'folderInTrash', { path: r.rel })
    if (!v.storage_path) fileError('not_found', 'noBlob')
    const blob = path.join(this.root, ...v.storage_path.split('/'))
    const size = checkRegular(blob).size
    let cur: string | null = null
    if (r.exists) {
      if (r.st!.isDirectory()) throw new ToolError('folder', 'is_folder')
      const st = checkRegular(r.abs)
      cur = await this.sha(r.abs, st)
      if (cur === v.sha256) return { path: r.rel, conflict: false, entry: this.entry(user, rules, r.segs) }
    }
    if (currentPlan()) assertStorageRoom(size)
    if (cur) snapshotVersion(this.ctx.db, this.root, r.rel, { userId, turnId: null }, 'restore', cur)
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
   * For a folders row parked with a trashed folder: the path it stands for and the rules as they would be if that
   * trashed folder were back in place, together with every folder that held it and was trashed after it (the first
   * one trashed after it at each step: the folder it was in then). Live rules at or below those paths belong to
   * folders that took the names since and do not count. null: the row is not parked (the live rules apply as they
   * are). 'unknown': parked, but the trash item holding it is gone; nobody below admin.
   */
  private parkedView(folderId: string): { path: string; rules: RuleSet } | 'unknown' | null {
    const db = this.ctx.db
    const f = db.query('SELECT path FROM folders WHERE id = ?').get(folderId) as { path: string } | null
    if (!f) return null
    const segs = segsOf(f.path)
    if (segs[0] !== PRODUCT.systemDir) return null
    const storage = segs.slice(0, 4).join('/')
    type Held = { id: string; original_path: string; storage_path: string }
    const own = db.query("SELECT id, original_path, storage_path FROM trash_items WHERE storage_path = ? AND kind = 'folder' AND restored_at IS NULL").get(storage) as Held | null
    if (!own) return 'unknown'
    const chain: Held[] = [own]
    for (let cur = own; chain.length < 64;) {
      const up = db.query(`SELECT id, original_path, storage_path FROM trash_items
        WHERE kind = 'folder' AND restored_at IS NULL AND id > ?1 AND (original_path = '' OR substr(?2, 1, length(original_path) + 1) = original_path || '/')
        ORDER BY id ASC LIMIT 1`).get(cur.id, cur.original_path) as Held | null
      if (!up) break
      chain.push(up)
      cur = up
    }
    const rows = db.query('SELECT f.path, r.subject_type, r.subject_id, r.access FROM folder_rules r JOIN folders f ON f.id = r.folder_id').all() as { path: string; subject_type: string; subject_id: string | null; access: string }[]
    const at = (p: string, base: string) => base === '' || p === base || p.startsWith(base + '/')
    const out: typeof rows = []
    for (const r of rows) {
      const held = chain.find((c) => at(r.path, c.storage_path))
      if (held) out.push({ ...r, path: held.original_path + r.path.slice(held.storage_path.length) })
      else if (!chain.some((c) => at(r.path, c.original_path))) out.push(r)
    }
    return { path: own.original_path + f.path.slice(storage.length), rules: new RuleSet(out as any) }
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
    // A live row is the very folder the item was trashed from (a folder that takes a trashed one's name gets a new
    // row). The item may sit outside it now: an ordinary folder it was in was moved out of it (move() carries the
    // item along). trashVisible then asks for read on that folder as well as write where the item goes back to, so
    // it shows only to people who could see it where it was deleted and can put it where it is now (security
    // review r3: it was nobody's, not even its group's, until it was purged).
    return t.original_path
  }
  /**
   * The path a trash item had when it was deleted, for an item stamped with no folders row (a personal folder, or a
   * team path no folders row covers): the delete's file_events row. Items moved with a folder before security
   * review r3 could have crossed out of a personal folder (move() no longer takes them across); null: not recorded.
   */
  private trashedFrom(t: TrashRow): string | null {
    const ev = this.ctx.db.query("SELECT path FROM file_events WHERE user_id = ? AND action = 'delete' AND json_extract(detail, '$.trashId') = ? LIMIT 1")
      .get(t.deleted_by, t.id) as { path: string } | null
    return ev?.path ?? null
  }
  private trashVisible(user: Principal, rules: RuleSet, t: TrashRow): boolean {
    const home = this.trashHome(t)
    if (home === null) return false
    // a trashed group / project / rule folder went there by an admin or the owner (assertMayChangeManaged) and comes
    // back only the same way: listing it to members, whose restore then failed (they cannot write groups/ or
    // projects/), offered what could not be done (design tab 4 move/delete; security review r2)
    if (t.kind === 'folder' && user.role !== 'owner' && user.role !== 'admin' && this.managedRows(t.storage_path, home, t.id)) return false
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
    } else if (segsOf(home)[0] !== 'users') {
      // no folder stamp: like a version's path_at_save, the place it was deleted from must be readable too (a file
      // deleted in users/<id>/ and moved into a team folder with its folder by an older build stays its owner's)
      const from = this.trashedFrom(t)
      if (from !== null && from !== home && !atLeast(access(from), 'read')) return false
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
        // into the trash of the folder where it now is, " (restored)" name included. So does a rule folder trashed from
        // inside it before (its folder_id is its own parked row): it was in this folder, the first one above it trashed
        // after it, and is judged under this folder's rules wherever it comes back (security round 3: left at the old
        // path, it fell under whatever took that name, and its versions under shared/)
        this.ctx.db.query(`UPDATE trash_items SET original_path = ?1 || substr(original_path, length(?2) + 1)
          WHERE restored_at IS NULL AND id <> ?3 AND (original_path = ?2 OR substr(original_path, 1, length(?2) + 1) = ?2 || '/')
            AND (folder_id IN (SELECT id FROM folders WHERE path = ?1 OR substr(path, 1, length(?1) + 1) = ?1 || '/')
              OR (kind = 'folder' AND id < ?3 AND folder_id IN (SELECT id FROM folders WHERE path = trash_items.storage_path)
                AND NOT EXISTS (SELECT 1 FROM trash_items p WHERE p.kind = 'folder' AND p.id > trash_items.id AND p.id < ?3
                  AND substr(trash_items.original_path, 1, length(p.original_path) + 1) = p.original_path || '/')))`)
          .run(r.rel, t.original_path, t.id)
        this.projectsBack(t, r.rel)
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
  /**
   * A folder came back from the trash at `to` (its old path, or a " (restored)" name): the projects that went to the
   * trash with it (`projects.trashed_with`) follow it there and are seen again by its readers, like a move. So do the
   * paths of projects whose folders were trashed from inside it earlier: their items come back into its trash (above),
   * and they follow when those come back. One project per folder: a restored project whose new path a project in place
   * already names stays detached, at its old path and admin-only, for an admin to point at a folder. A purge keeps the
   * mark (purgeRow): the project stays the admins' and the owner's, to delete or point elsewhere.
   */
  private projectsBack(t: TrashRow, to: string) {
    const db = this.ctx.db
    const from = t.original_path
    const under = (col: string, n: number) => `(${col} = ?${n} OR substr(${col}, 1, length(?${n}) + 1) = ?${n} || '/')`
    if (to !== from) {
      db.query(`UPDATE projects SET folder_path = ?1 || substr(folder_path, length(?2) + 1)
        WHERE ${under('folder_path', 2)} AND trashed_with IN (SELECT id FROM trash_items WHERE restored_at IS NULL AND id <> ?3 AND ${under('original_path', 1)})`)
        .run(to, from, t.id)
    }
    const key = (p: string) => volumeKey(p, this.fx.caseInsensitive)
    const inPlace = new Set((db.query('SELECT folder_path FROM projects WHERE trashed_with IS NULL').all() as { folder_path: string }[]).map((r) => key(r.folder_path)))
    for (const pr of db.query('SELECT id, folder_path FROM projects WHERE trashed_with = ? ORDER BY created_at, id').all(t.id) as { id: string; folder_path: string }[]) {
      if (pr.folder_path !== from && !pr.folder_path.startsWith(from + '/')) continue
      const next = to + pr.folder_path.slice(from.length)
      if (inPlace.has(key(next))) continue
      db.query('UPDATE projects SET folder_path = ?, trashed_with = NULL WHERE id = ?').run(next, pr.id)
      inPlace.add(key(next))
    }
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
   * replace -> the current file becomes a version, rename -> "name (2).ext". `event`: how the file event is recorded
   * when the server made the file for the person (the preview's "PDF로 저장": action create, where it came from).
   */
  async placeUpload(userId: string, folder: string, name: string, src: string, onExists: 'fail' | 'replace' | 'rename', sha: string, event?: { action: 'create'; detail: Record<string, unknown> }): Promise<FileEntry> {
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
    fileEvent(this.ctx.db, { turnId: null, userId, path: r.rel, action: event?.action ?? 'upload', size, sha256: sha, detail: { replaced: action === 'update', ...event?.detail } })
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

/** The reason a delete_files path failed, for the AI: the checks' own words; anything else is not shown. */
const aiReason = (e: unknown) => (e instanceof Denied || e instanceof ToolError || e instanceof HttpError || e instanceof FileError ? e.message : 'internal error')

/** Every active person with their groups (who could be affected by an audience change). */
export function activePeople(db: AppContext['db']): Principal[] {
  const users = db.query("SELECT id, name, role FROM users WHERE status = 'active' AND deleted_at IS NULL").all() as { id: string; name: string; role: Principal['role'] }[]
  const groups = new Map<string, string[]>()
  for (const m of db.query('SELECT group_id, user_id FROM group_members').all() as { group_id: string; user_id: string }[]) groups.set(m.user_id, [...(groups.get(m.user_id) ?? []), m.group_id])
  return users.map((u) => ({ ...u, groups: groups.get(u.id) ?? [] }))
}

/** Move the folders rows at `from` and below it to `to` (rules are kept by path). */
/** Whose side of the personal-folder edge a path is on: 'users/<id>' for a personal folder, '' for team folders. */
function personalSide(segs: readonly string[]): string {
  return segs[0] === 'users' ? `users/${segs[1] ?? ''}` : ''
}

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
