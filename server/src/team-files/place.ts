// Low-level placement inside the team folder for the file screen and uploads (paths already authorize()d).
// Large files never pass through memory: uploads arrive as a file on disk and are renamed (same volume) or
// copied (another volume) into a temp name next to the target, re-checked, then renamed into place.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Database } from 'bun:sqlite'
import { PRODUCT } from '@mycel/shared'
import { DEFAULT_LOCALE, type Locale } from '@mycel/shared/api'
import { Denied, ToolError } from '../policy/errors'
import { verifyChain } from '../policy/resolve'
import { foldKey } from '../policy/names'
import { newId } from '../db'
import { insertVersion } from '../files/store'
import { copyOffLoop } from '../files/copy-off-loop'

export { copyOffLoop }

const C = fs.constants

/** lstat a team path; it must be a regular, singly linked file (or a folder when allowed). */
export function checkRegular(abs: string, allowDir = false): fs.Stats {
  let st: fs.Stats
  try { st = fs.lstatSync(abs) } catch (e: any) { if (e.code === 'ENOENT') throw new ToolError('not found', 'not_found'); throw e }
  if (st.isSymbolicLink()) throw new Denied('symbolic links are not followed')
  if (st.isDirectory()) { if (allowDir) return st; throw new ToolError('this is a folder', 'is_folder') }
  if (!st.isFile()) throw new Denied('not a regular file')
  if (st.nlink > 1) throw new Denied('hard-linked files are refused')
  return st
}

/** Where an open file really is, asked of the open file and not of its path: Linux /proc/self/fd; macOS /dev/fd (Bun
 * resolves it with F_GETPATH, with the real case of each name). null when the system does not tell. */
export function openedPath(fd: number): string | null {
  try {
    const p = process.platform === 'linux' ? fs.readlinkSync(`/proc/self/fd/${fd}`) : fs.realpathSync(`/dev/fd/${fd}`)
    return p.startsWith('/') && !p.startsWith('/dev/fd/') && !p.startsWith('/proc/') ? p : null
  } catch { return null }
}

/**
 * Open a file to read it, never through a link in its last name (O_NOFOLLOW); it must be a regular file with one link.
 * The caller closes the descriptor and reads from it: a second open by path could be another file.
 *
 * `seen`: the lstat that the permission check took of this path (policy/authorize.ts: `abs` is the team folder's real
 * path plus the names on disk). Pass it for every file in the team folder: a personal folder is also written by that
 * person's dev environment runs, so a file, or a folder on the way to it, can change after the check. The opened file
 * must then be the very file that was checked (same device and inode), and the system's own path of the open file
 * must be `abs`: a file reached through a folder that became a link has another path. A system that does not tell the
 * path: refused. Without `seen` (folders that only the server writes: uploads, thumbnails, installers) the file is
 * only checked to be regular.
 */
export function openChecked(abs: string, seen?: fs.Stats): { fd: number; st: fs.Stats } {
  if (!seen) return openRegular(abs)
  // after a check, every way the open can fail gives the same answer: whatever the name means now is not told
  try {
    const opened = openRegular(abs, seen)
    return opened
  } catch { throw new Denied(CHANGED) }
}
const CHANGED = 'path changed while opening'

function openRegular(abs: string, seen?: fs.Stats): { fd: number; st: fs.Stats } {
  let fd: number
  try { fd = fs.openSync(abs, C.O_RDONLY | C.O_NOFOLLOW | (C.O_NONBLOCK ?? 0)) } catch (e: any) {
    if (e.code === 'ELOOP' || e.code === 'EMLINK') throw new Denied('symbolic links are not followed')
    if (e.code === 'ENOENT') throw new ToolError('not found', 'not_found')
    throw new ToolError(`cannot open file (${e.code})`)
  }
  try {
    const st = fs.fstatSync(fd)
    if (st.isDirectory()) throw new ToolError('this is a folder', 'is_folder')
    if (!st.isFile() || st.nlink > 1) throw new Denied('not a regular file')
    if (seen && (st.ino !== seen.ino || st.dev !== seen.dev || openedPath(fd) !== abs)) throw new Denied('path changed while opening')
    return { fd, st }
  } catch (e) { fs.closeSync(fd); throw e }
}

/** sha256 of a file, streamed (never loaded whole). */
export async function hashFile(abs: string, from?: { hash: crypto.Hash; offset: number }): Promise<string> {
  const { fd } = openChecked(abs)
  try { return await hashOpen(fd, from) } finally { fs.closeSync(fd) }
}

/** sha256 of an open file (the caller's checked descriptor; it stays open), streamed. */
export async function hashOpen(fd: number, from?: { hash: crypto.Hash; offset: number }): Promise<string> {
  const h = from?.hash ?? crypto.createHash('sha256')
  const buf = Buffer.allocUnsafe(4 * 1024 * 1024)
  let pos = from?.offset ?? 0
  for (;;) {
    const n = await new Promise<number>((res, rej) => fs.read(fd, buf, 0, buf.length, pos, (err, n) => (err ? rej(err) : res(n))))
    if (!n) break
    h.update(buf.subarray(0, n))
    pos += n
  }
  return h.digest('hex')
}

const tmpName = (dir: string) => path.join(dir, PRODUCT.tmpPrefix + crypto.randomBytes(8).toString('hex'))

/** Create missing parent folders (names already checked by authorize) and re-check the chain. */
export function ensureParents(root: string, segs: string[]) {
  let cur = root
  for (let i = 0; i < segs.length - 1; i++) {
    cur = path.join(cur, segs[i]!)
    try { fs.mkdirSync(cur, { mode: 0o700 }) } catch (e: any) { if (e.code !== 'EEXIST') throw e }
  }
  verifyChain(root, segs, true)
}

/**
 * New content waiting next to its place under a temp name (nobody lists, reads or authorizes a temp name: policy
 * access.ts). Everything slow (a copy across volumes, a copy that keeps its source, a copy of a team file) is done
 * while staging, off the event loop; putting it in place (commitStaged) is one rename and runs in the caller's
 * synchronous step, so a check right before it still holds when the file appears whole. abortStaged() undoes it.
 */
export interface Staged {
  root: string
  /** the folder it waits in (team path) */
  dir: string[]
  tmp: string
  src: string
  /** the source itself was renamed into `tmp`: the temp name may hold the only copy of the bytes */
  renamed: boolean
  /** copied to another volume: `src` goes once the copy is in place */
  copied: boolean
  /** what was staged (lstat of `tmp`) */
  st: fs.Stats
  done: boolean
}

/**
 * Stage the server-owned file at `src` (outside the team folder or in .system) for team folder `dir`. Same volume: a
 * rename. Another volume (EXDEV), or `keepSource`: a copy off the event loop. On a failure only the copy goes, so `src`
 * keeps the bytes.
 */
export async function stageInstall(root: string, dir: string[], src: string, o: { keepSource?: boolean } = {}): Promise<Staged> {
  ensureParents(root, [...dir, PRODUCT.tmpPrefix])
  const tmp = tmpName(path.join(root, ...dir))
  let renamed = false, copied = false
  if (o.keepSource) await copyOffLoop(src, tmp)
  else {
    try { fs.renameSync(src, tmp); renamed = true } catch (e: any) {
      if (e.code !== 'EXDEV') throw e
      await copyOffLoop(src, tmp)
      copied = true
    }
  }
  const s: Staged = { root, dir, tmp, src, renamed, copied, st: null as unknown as fs.Stats, done: false }
  try { fs.chmodSync(tmp, 0o600); s.st = fs.lstatSync(tmp) } catch (e) { abortStaged(s); throw e }
  return s
}

/**
 * Put staged content at team path `segs` (in the folder it was staged in), replacing a regular file there: the chain
 * is checked again, then one rename. Synchronous, and cheap. Throws (nothing in place, `s` still staged) when the
 * place is not a plain file any more.
 */
export function commitStaged(s: Staged, segs: string[]): void {
  if (s.done) throw new Error('staged content was already placed or dropped')
  if (segs.length !== s.dir.length + 1 || segs.slice(0, -1).some((x, i) => x !== s.dir[i])) throw new Error('staged in another folder')
  verifyChain(s.root, segs, true)
  const target = path.join(s.root, ...segs)
  try {
    const st = fs.lstatSync(target)
    if (!st.isFile() || st.nlink > 1) throw new Denied('target is not a regular file')
  } catch (e: any) { if (e instanceof Denied) throw e }
  fs.renameSync(s.tmp, target)
  s.done = true
  // the target holds the bytes now; a source that cannot be removed is a leftover copy, not a failed install
  if (s.copied) try { fs.rmSync(s.src, { force: true }) } catch { /* left */ }
}

/** Undo a stage that was not placed: a copy goes; a renamed source goes back to `src` (the temp name may be the only
 * copy of the bytes: rooms/file-moves.ts), or, when even that fails, stays at its temp name (the mover finds it by its
 * inode) rather than being deleted. A no-op once placed. */
export function abortStaged(s: Staged): void {
  if (s.done) return
  s.done = true
  if (!s.renamed) { try { fs.rmSync(s.tmp, { force: true }) } catch { /* a temp name */ } }
  else try { fs.renameSync(s.tmp, s.src) } catch { /* left at its temp name: never the only copy deleted */ }
}

/**
 * Move a file that is already on the team folder's volume (.system/trash) to team path `segs`: a rename only, in the
 * caller's synchronous step. EXDEV is an error here, never a copy on the event loop.
 */
export function installRenamed(root: string, segs: string[], src: string): void {
  ensureParents(root, segs)
  const tmp = tmpName(path.join(root, ...segs.slice(0, -1)))
  fs.renameSync(src, tmp)
  const s: Staged = { root, dir: segs.slice(0, -1), tmp, src, renamed: true, copied: false, st: null as unknown as fs.Stats, done: false }
  try { fs.chmodSync(tmp, 0o600); commitStaged(s, segs) } catch (e) { abortStaged(s); throw e }
}

/**
 * The server-owned file `src` on the team folder's volume, so that installRenamed() places it with a rename: `src`
 * itself when it is there already, else a copy (off the event loop) under a temp name in the team's .system folder.
 * `src` stays until finish(true) (placed: the source goes) or finish(false) (not placed: the copy goes, `src` keeps the
 * bytes), so a failed placement leaves the caller's file where it was.
 */
export async function onTeamVolume(root: string, src: string): Promise<{ file: string; finish: (placed: boolean) => void }> {
  const sys = path.join(root, PRODUCT.systemDir)
  fs.mkdirSync(sys, { recursive: true, mode: 0o700 })
  if (fs.lstatSync(src).dev === fs.lstatSync(sys).dev) return { file: src, finish: () => {} }
  const tmp = tmpName(sys)
  await copyOffLoop(src, tmp)
  return {
    file: tmp,
    finish: (placed) => { try { fs.rmSync(placed ? src : tmp, { force: true }) } catch { /* a leftover copy */ } },
  }
}

/**
 * Stage a copy of a regular team file (already authorize()d for read) for team folder `dir` without passing through
 * memory or holding the event loop: clonefile on APFS, a copy on the file threads elsewhere. The source is checked
 * before and after the copy (same inode, size, still a regular singly linked file), so a file swapped for a link in
 * between is never copied. Put in place with commitStaged.
 */
export async function stageTeamCopy(root: string, srcAbs: string, dir: string[]): Promise<Staged> {
  const before = checkRegular(srcAbs)
  ensureParents(root, [...dir, PRODUCT.tmpPrefix])
  const tmp = tmpName(path.join(root, ...dir))
  await copyOffLoop(srcAbs, tmp)
  const s: Staged = { root, dir, tmp, src: srcAbs, renamed: false, copied: false, st: null as unknown as fs.Stats, done: false }
  try {
    const after = checkRegular(srcAbs)
    const out = fs.lstatSync(tmp)
    if (after.ino !== before.ino || after.dev !== before.dev || out.size !== after.size || out.size !== before.size) throw new Denied('path changed while copying')
    fs.chmodSync(tmp, 0o600)
    s.st = out
    return s
  } catch (e) { abortStaged(s); throw e }
}

/** Write bytes to a fresh server-side temp file (for small uploads arriving in memory). */
export async function writeTemp(dir: string, data: Blob | Uint8Array): Promise<string> {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const p = path.join(dir, 'up-' + crypto.randomBytes(12).toString('hex'))
  await Bun.write(p, data)
  fs.chmodSync(p, 0o600)
  return p
}

function blobPath(root: string, kind: 'history' | 'trash'): string[] {
  const now = new Date()
  return [PRODUCT.systemDir, kind, `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`, crypto.randomUUID()]
}

/** Same file, unchanged by what an lstat tells (the check replacing() and the hash cache use). */
export const sameFile = (a: fs.Stats, b: fs.Stats) => a.ino === b.ino && a.dev === b.dev && a.size === b.size && a.mtimeMs === b.mtimeMs

/**
 * A copy of a team file's current content, waiting under a temp name in .system/history/<month>/ (no file_versions row
 * yet: nobody can reach it) to become a version. Copied off the event loop (a clone on APFS); `st` is the file as it
 * was before the copy, and the file was the same (sameFile) after it, so the copy is that content.
 */
export interface KeptCopy { root: string; tmp: string; blob: string[]; st: fs.Stats; done: boolean }

/** Copy the current content of team file `abs` for a version (see KeptCopy). Throws Denied when the file changed
 * while it was copied (the caller looks again). */
export async function stageVersion(root: string, abs: string): Promise<KeptCopy> {
  const st = checkRegular(abs)
  const blob = blobPath(root, 'history')
  const dir = path.join(root, ...blob.slice(0, -1))
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const k: KeptCopy = { root, tmp: tmpName(dir), blob, st, done: false }
  await copyOffLoop(abs, k.tmp)
  try {
    const now = checkRegular(abs)
    if (!sameFile(st, now) || fs.lstatSync(k.tmp).size !== st.size) throw new Denied('path changed while copying')
    fs.chmodSync(k.tmp, 0o600)
  } catch (e) { dropVersion(k); throw e }
  return k
}

/** Make the staged copy a version of `rel` (its row; the copy renamed to its blob name). Synchronous; returns the id. */
export function commitVersion(db: Database, k: KeptCopy, rel: string, by: { userId: string; turnId: string | null }, kind: 'edit' | 'restore', sha256: string): string {
  if (k.done) throw new Error('kept copy was already used or dropped')
  fs.renameSync(k.tmp, path.join(k.root, ...k.blob))
  k.done = true
  const id = newId()
  try { insertVersion(db, { id, rel, sha256, size: k.st.size, by, kind, storage: k.blob.join('/') }) } catch (e) {
    try { fs.rmSync(path.join(k.root, ...k.blob), { force: true }) } catch { /* an orphan blob, never a row without one */ }
    throw e
  }
  return id
}

/** Take back a version made by commitVersion when the new content could not be put in place after all: the old file
 * is still where it was, so its row and blob go again (no version of a replace that did not happen). */
export function undoVersion(db: Database, k: KeptCopy, id: string): void {
  db.query('DELETE FROM file_versions WHERE id = ?').run(id)
  try { fs.rmSync(path.join(k.root, ...k.blob), { force: true }) } catch { /* an orphan blob */ }
}

/** Drop a staged copy that did not become a version. A no-op once used. */
export function dropVersion(k: KeptCopy): void {
  if (k.done) return
  k.done = true
  try { fs.rmSync(k.tmp, { force: true }) } catch { /* a temp name */ }
}

/**
 * Keep the current content of team file `abs` (team path `rel`, as hashed: `sha256`, the file then `st`) as a version
 * and put `incoming` at `segs` in its place. The slow part (the copy of the old content) runs first, off the event
 * loop; then, in one synchronous step, the file must still be the one that was hashed (sameFile with `st`): the version
 * row, the rename of the new content, `check` right before (a grant, a storage check). A failure of the rename takes
 * the version back. false: the file changed meanwhile (nothing changed, `incoming` still staged): the caller looks again.
 */
export async function replaceKeeping(db: Database, abs: string, rel: string, segs: string[], st: fs.Stats, sha256: string, incoming: Staged, by: { userId: string; turnId: string | null }, kind: 'edit' | 'restore', check?: () => void): Promise<boolean> {
  let k: KeptCopy
  try { k = await stageVersion(incoming.root, abs) } catch (e) { if (e instanceof Denied && e.message === 'path changed while copying') return false; throw e }
  try {
    // from here on, nothing awaits: what was checked is what is replaced
    let now: fs.Stats
    try { now = checkRegular(abs) } catch { return false }
    if (!sameFile(st, k.st) || !sameFile(st, now)) return false
    check?.()
    const id = commitVersion(db, k, rel, by, kind, sha256)
    try { commitStaged(incoming, segs) } catch (e) { undoVersion(db, k, id); throw e }
    return true
  } finally { dropVersion(k) }
}

/** Move a file or folder into .system/trash (rename: instant, nothing read). Returns the storage path. */
export function moveIntoTrash(root: string, segs: string[]): string {
  const blob = blobPath(root, 'trash')
  fs.mkdirSync(path.join(root, ...blob.slice(0, -1)), { recursive: true, mode: 0o700 })
  verifyChain(root, segs)
  fs.renameSync(path.join(root, ...segs), path.join(root, ...blob))
  return blob.join('/')
}

/** Sum of file sizes under a folder (bounded walk; symlinks are not followed). */
export function treeSize(abs: string, limit = 200_000): { bytes: number; files: number } {
  let bytes = 0, files = 0, seen = 0
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (++seen > limit) return
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) { try { bytes += fs.lstatSync(p).size; files++ } catch {} }
    }
  }
  walk(abs)
  return { bytes, files }
}

/** "name (2).ext", "name (3).ext" ... the first that is free (also free of near-duplicate siblings). */
export const splitExt = (name: string, folder = false): [string, string] => {
  if (folder) return [name, '']
  const m = /^(.+?)(\.[^.]+)?$/.exec(name)
  return m ? [m[1]!, m[2] ?? ''] : [name, '']
}
/** Fold keys of the entries in `dirAbs`; with `visible`, only those the caller can see (see siblingVisible). */
const takenKeys = (dirAbs: string, visible?: (name: string) => boolean) =>
  new Set(fs.readdirSync(dirAbs).filter((n) => !visible || visible(n)).map(foldKey))

/**
 * `visible`: for a name the caller typed (upload, move, restore), count only siblings they can see. A name held by a
 * hidden entry is then not stepped around (that "(2)" / "(3)" would tell them it exists): authorize() refuses it with
 * the same not-found answer as the exact hidden name. Server-made names (conflict copies, attachments) leave it out
 * so a save never fails because of something the saver cannot see.
 */
export function freeName(dirAbs: string, name: string, folder = false, visible?: (name: string) => boolean, alsoTaken?: (name: string) => boolean): string {
  const existing = takenKeys(dirAbs, visible)
  // `alsoTaken`: names that are not on disk but must not be taken either (a folder a project still names)
  const free = (n: string) => !existing.has(foldKey(n)) && !alsoTaken?.(n)
  if (free(name)) return name
  const [base, ext] = splitExt(name, folder)
  for (let i = 2; i < 10_000; i++) {
    const cand = `${base} (${i})${ext}`
    if (free(cand)) return cand
  }
  throw new ToolError('no free name', 'conflict')
}

export const RESTORED: Record<Locale, string> = { ko: '복원됨', en: 'restored', id: 'dipulihkan', ja: "復元済み", es: "restaurado", zh: "已恢复" }

/** "report (restored).md", then "report (restored 2).md" ... in the team's default language ("보고서 (복원됨).md"). */
export function restoredName(dirAbs: string, name: string, folder = false, locale: Locale = DEFAULT_LOCALE, visible?: (name: string) => boolean): string {
  const existing = takenKeys(dirAbs, visible)
  if (!existing.has(foldKey(name))) return name
  const [base, ext] = splitExt(name, folder)
  for (let i = 1; i < 10_000; i++) {
    const cand = `${base} (${RESTORED[locale] ?? RESTORED.en}${i > 1 ? ' ' + i : ''})${ext}`
    if (!existing.has(foldKey(cand))) return cand
  }
  throw new ToolError('no free name', 'conflict')
}
