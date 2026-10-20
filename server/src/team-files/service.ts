// The file screen (design tab 4 "파일", tab 2 "동시 수정"): tree, text content, save, folders, move / rename,
// trash, version history. Every path goes through authorize() (policy/authorize.ts) with the caller's own rules;
// what the caller may not read looks exactly like what does not exist.
import fs from 'node:fs'
import path from 'node:path'
import type { FileChange, FileContent, FileEntry, FileVersion, Page, SaveResult, TrashItem, TreeResponse, UserRef } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { newId } from '../db'
import { ext, isOffice } from '../files/extract'
import { atomicWrite, conflictCopyName, fileEvent, readRegular, saveVersion, sha256 } from '../files/store'
import { HttpError } from '../http/errors'
import { atLeast, RuleSet, type Principal } from '../policy/access'
import { authorize, type Authorized } from '../policy/authorize'
import { Denied, ToolError } from '../policy/errors'
import { badSegment, hiddenEntry } from '../policy/names'
import { verifyChain } from '../policy/resolve'
import { PRODUCT } from '@mycel/shared'
import { publishChanges } from './changes'
import { fileError } from './errors'
import { checkRegular, freeName, hashFile, installFile, moveIntoTrash, restoredName, snapshotVersion, splitExt, treeSize } from './place'

/** Files the file screen treats as binary (rendered by the client from /download, never edited as text). */
const BINARY_EXT = new Set(['docx', 'doc', 'pptx', 'ppt', 'xlsx', 'xls', 'odt', 'ods', 'odp', 'pdf', 'hwp', 'hwpx', 'zip', 'gz', 'tgz', '7z', 'rar',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tiff', 'ico', 'mp3', 'm4a', 'wav', 'ogg', 'flac', 'aac', 'webm', 'mp4', 'mov', 'avi', 'mkv',
  'woff', 'woff2', 'ttf', 'otf', 'exe', 'dmg', 'pkg', 'bin', 'sqlite', 'db', 'key', 'numbers', 'pages'])
export const DEFAULT_CONTENT_BYTES = 2 * 1024 * 1024
const DAY = 86_400_000

export const mimeOf = (name: string): string | null => {
  const t = Bun.file(name).type
  return t && t !== 'application/octet-stream' ? t : (ext(name) ? 'application/octet-stream' : null)
}
const segsOf = (rel: string) => (rel === '' ? [] : rel.split('/'))
const isUnder = (anc: string, p: string) => anc === '' ? p !== '' : p.startsWith(anc + '/')
const iso = (ms: number) => new Date(ms).toISOString()

/** Team setting (A stores settings as key -> json; also accepts one 'team' object). */
export function settingNumber(db: AppContext['db'], key: string, def: number): number {
  try {
    const r = db.query('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | null
    if (r) { const v = JSON.parse(r.value); if (typeof v === 'number' && Number.isFinite(v)) return v }
    const t = db.query("SELECT value FROM settings WHERE key = 'team'").get() as { value: string } | null
    if (t) { const v = JSON.parse(t.value)?.[key]; if (typeof v === 'number' && Number.isFinite(v)) return v }
  } catch { /* bad json: default */ }
  return def
}

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
  private publish(changes: FileChange[]) { publishChanges(this.ctx, changes) }
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
    let text = new TextDecoder('utf-8').decode(buf)
    if (truncated) text = text.replace(/\uFFFD+$/, '') // a multi-byte character cut at the limit
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
    let name = conflictCopyName(r.segs[r.segs.length - 1]!, user.name)
    if (badSegment(name)) name = `conflict-${Date.now()}-${r.segs[r.segs.length - 1]}`
    name = freeName(dirAbs, name)
    const copy = [...dir, name]
    atomicWrite(this.root, copy, data)
    const copyRel = copy.join('/')
    const db = this.ctx.db
    const v = (db.query('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM file_versions WHERE path = ?').get(r.rel) as { v: number }).v
    db.query('INSERT INTO file_versions (id, path, version, sha256, size, author_id, turn_id, kind, conflict_path, storage_path) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(newId(), r.rel, v, sha256(data), data.length, user.id, null, 'conflict_copy', copyRel, null)
    const last = db.query("SELECT e.user_id FROM file_events e WHERE e.path = ? AND e.action IN ('update','create','upload','restore') ORDER BY e.id DESC LIMIT 1").get(r.rel) as { user_id: string } | null
    fileEvent(db, { turnId: null, userId: user.id, path: r.rel, action: 'conflict', size: data.length, sha256: sha256(data), detail: { copy: copyRel, changedBy: last?.user_id ?? null, tool: 'file-screen' } })
    fileEvent(db, { turnId: null, userId: user.id, path: copyRel, action: 'create', size: data.length, sha256: sha256(data), detail: { conflictCopyOf: r.rel } })
    this.ctx.files.events.emit('conflict', { path: r.rel, copy: copyRel, users: [user.id, last?.user_id].filter(Boolean) })
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
    const users = this.ctx.db.query('SELECT path FROM folders').all() as { path: string }[]
    for (const f of users) if (isUnder(base, f.path) && rules.access(user, segsOf(f.path)) !== 'write') fileError('forbidden', 'hiddenInside')
  }

  // ---------------- move / rename ----------------
  move(userId: string, from: string, to: string, onExists: 'fail' | 'rename'): { entry: FileEntry } {
    const user = this.principal(userId)
    const rules = this.rules()
    const fr = authorize(this.fx, rules, user, from, 'write', { mustExist: true })
    this.assertMovable(fr.segs)
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
        tr = authorize(this.fx, rules, user, [...parent, freeName(path.join(this.root, ...parent), tr.segs[tr.segs.length - 1]!, isDir)].join('/'), 'write', { mustExist: false })
      }
      target = tr.segs
    }
    if (isDir && (target.join('/') === fr.rel || isUnder(fr.rel, target.join('/')))) fileError('validation', 'intoItself', { to })
    this.assertMovable(target)
    if (isDir) this.assertSubtreeWritable(user, rules, fr.segs)
    const toRel = target.join('/')
    const db = this.ctx.db
    if (isDir && toRel.toLowerCase() !== fr.rel.toLowerCase()) {
      const clash = db.query('SELECT path FROM folders WHERE path = ? OR substr(path, 1, length(?) + 1) = ? || \'/\'').get(toRel, toRel, toRel) as { path: string } | null
      if (clash) fileError('conflict', 'exists', { to: toRel })
    }
    verifyChain(this.root, fr.segs)
    verifyChain(this.root, target, true)
    fs.renameSync(fr.abs, path.join(this.root, ...target))
    db.transaction(() => {
      const re = (table: string, col: string) => db.query(`UPDATE ${table} SET ${col} = ? || substr(${col}, length(?) + 1) WHERE ${col} = ? OR substr(${col}, 1, length(?) + 1) = ? || '/'`).run(toRel, fr.rel, fr.rel, fr.rel, fr.rel)
      re('folders', 'path')
      re('projects', 'folder_path')
      re('file_versions', 'path')
      re('attachments', 'path')
      fileEvent(db, { turnId: null, userId, path: fr.rel, action: 'delete', detail: { movedTo: toRel, folder: isDir, tool: 'file-screen' } })
      fileEvent(db, { turnId: null, userId, path: toRel, action: 'create', detail: { movedFrom: fr.rel, folder: isDir, tool: 'file-screen' } })
    })()
    this.moveTextCache(fr.rel, toRel, isDir)
    this.publish([{ path: toRel, from: fr.rel, action: 'move', by: this.by(userId), turnId: null }])
    return { entry: this.entry(user, rules, target) }
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
    const isDir = r.st!.isDirectory()
    let size: number
    if (isDir) { this.assertSubtreeWritable(user, rules, r.segs); size = treeSize(r.abs).bytes }
    else size = checkRegular(r.abs).size
    const storage = moveIntoTrash(this.root, r.segs)
    const id = newId()
    const purgeAt = iso(Date.now() + settingNumber(this.ctx.db, 'trashRetentionDays', 30) * DAY)
    this.ctx.db.query('INSERT INTO trash_items (id, original_path, storage_path, size, deleted_by, turn_id, purge_at, kind) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, r.rel, storage, size, userId, turnId, purgeAt, isDir ? 'folder' : 'file')
    fileEvent(this.ctx.db, { turnId, userId, path: r.rel, action: 'delete', size, detail: { folder: isDir, trashId: id } })
    this.dropTextCache(r.rel, isDir)
    this.publish([{ path: r.rel, action: 'delete', by: this.by(userId), turnId }])
    return { trashId: id, purgeAt }
  }

  // ---------------- history ----------------
  private versionVisible(user: Principal, rules: RuleSet, row: Pick<VersionRow, 'path' | 'folder_id' | 'path_at_save'>): boolean {
    if (!atLeast(rules.access(user, segsOf(row.path)), 'read')) return false
    if (row.folder_id) {
      const f = this.ctx.db.query('SELECT path FROM folders WHERE id = ?').get(row.folder_id) as { path: string } | null
      if (f && !atLeast(rules.access(user, segsOf(f.path)), 'read')) return false
    } else if (row.path_at_save && !atLeast(rules.access(user, segsOf(row.path_at_save)), 'read')) return false
    return true
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
  private trashVisible(user: Principal, rules: RuleSet, t: TrashRow): boolean {
    if (rules.access(user, segsOf(t.original_path)) !== 'write') return false
    if (t.folder_id) {
      const f = this.ctx.db.query('SELECT path FROM folders WHERE id = ?').get(t.folder_id) as { path: string } | null
      if (f && !atLeast(rules.access(user, segsOf(f.path)), 'read')) return false
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
    const want = segsOf(t.original_path)
    // the original parent may be gone: it is created again (names were valid when the item was deleted).
    // A taken name (exactly or nearly) gets " (복원됨)".
    const parentRel = want.slice(0, -1).join('/')
    const pw = authorize(this.fx, rules, user, parentRel, 'write', { mustExist: false, createDirs: true })
    const name = pw.exists && pw.st!.isDirectory() ? restoredName(pw.abs, want[want.length - 1]!, isDir) : want[want.length - 1]!
    const r = authorize(this.fx, rules, user, [...pw.segs, name].join('/'), 'write', { mustExist: false, createDirs: true })
    if (r.exists) fileError('conflict', 'restoreTaken')
    const src = path.join(this.root, ...t.storage_path.split('/'))
    if (isDir) {
      const st = fs.lstatSync(src)
      if (!st.isDirectory()) throw new Denied('trash item changed')
      let cur = this.root
      for (const s of r.segs.slice(0, -1)) { cur = path.join(cur, s); try { fs.mkdirSync(cur, { mode: 0o700 }) } catch (e: any) { if (e.code !== 'EEXIST') throw e } }
      verifyChain(this.root, r.segs, true)
      fs.renameSync(src, r.abs)
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
  purgeTrash(id: string, byUserId: string) {
    const t = this.trashRow(id)
    if (!t) throw new HttpError('not_found')
    this.purgeRow(t)
    this.ctx.db.query('INSERT INTO audit_log (actor_id, action, target, detail) VALUES (?,?,?,?)').run(byUserId, 'trash.purge', t.original_path, JSON.stringify({ trashId: id, size: t.size, kind: t.kind }))
  }
  private purgeRow(t: Pick<TrashRow, 'id' | 'storage_path'>) {
    const abs = path.join(this.root, ...t.storage_path.split('/'))
    if (t.storage_path.startsWith(`${PRODUCT.systemDir}/trash/`)) fs.rmSync(abs, { recursive: true, force: true })
    this.ctx.db.query('DELETE FROM trash_items WHERE id = ?').run(t.id)
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
    if (onExists === 'rename') finalName = freeName(fr.abs, finalName)
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
    for (const t of db.query('SELECT id, storage_path FROM trash_items WHERE restored_at IS NULL AND purge_at <= ?').all(iso(now)) as TrashRow[]) { this.purgeRow(t); trash++ }
    const keepDays = settingNumber(db, 'fileHistoryRetentionDays', 7)
    const cutoff = iso(now - keepDays * DAY)
    for (const v of db.query('SELECT id, storage_path FROM file_versions WHERE created_at < ? LIMIT 5000').all(cutoff) as { id: string; storage_path: string | null }[]) {
      if (v.storage_path?.startsWith(`${PRODUCT.systemDir}/history/`)) fs.rmSync(path.join(this.root, ...v.storage_path.split('/')), { force: true })
      db.query('DELETE FROM file_versions WHERE id = ?').run(v.id)
      versions++
    }
    return { trash, versions }
  }
}

/** SQLite default timestamps ("2026-10-21T03:04:05.678Z") are already ISO; older rows may lack the Z. */
export const normIso = (s: string) => (/[zZ]|[+-]\d\d:\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z')
const encodeCursor = (n: number) => Buffer.from(String(n)).toString('base64url')
const decodeCursor = (c: string | undefined) => {
  if (!c) return 0
  const n = Number(Buffer.from(c, 'base64url').toString())
  return Number.isInteger(n) && n >= 0 ? n : 0
}
