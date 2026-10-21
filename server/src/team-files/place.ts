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

/** Open with O_NOFOLLOW and check the fd is the same regular file as `st` (no swap in between). Caller closes. */
export function openChecked(abs: string): { fd: number; st: fs.Stats } {
  let fd: number
  try { fd = fs.openSync(abs, C.O_RDONLY | C.O_NOFOLLOW | (C.O_NONBLOCK ?? 0)) } catch (e: any) {
    if (e.code === 'ELOOP' || e.code === 'EMLINK') throw new Denied('symbolic links are not followed')
    if (e.code === 'ENOENT') throw new ToolError('not found', 'not_found')
    throw new ToolError(`cannot open file (${e.code})`)
  }
  const st = fs.fstatSync(fd)
  if (st.isDirectory()) { fs.closeSync(fd); throw new ToolError('this is a folder', 'is_folder') }
  if (!st.isFile() || st.nlink > 1) { fs.closeSync(fd); throw new Denied('not a regular file') }
  return { fd, st }
}

/** sha256 of a file, streamed (never loaded whole). */
export async function hashFile(abs: string, from?: { hash: crypto.Hash; offset: number }): Promise<string> {
  const h = from?.hash ?? crypto.createHash('sha256')
  const { fd } = openChecked(abs)
  try {
    const buf = Buffer.allocUnsafe(4 * 1024 * 1024)
    let pos = from?.offset ?? 0
    for (;;) {
      const n = await new Promise<number>((res, rej) => fs.read(fd, buf, 0, buf.length, pos, (err, n) => (err ? rej(err) : res(n))))
      if (!n) break
      h.update(buf.subarray(0, n))
      pos += n
    }
  } finally { fs.closeSync(fd) }
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
 * Move the file at `src` (server-owned, outside the team folder or in .system) to team path `segs`, replacing a
 * regular file there. Same volume: rename. Other volume: copy into a temp name next to the target first.
 */
export function installFile(root: string, segs: string[], src: string, o: { keepSource?: boolean } = {}) {
  ensureParents(root, segs)
  const dir = path.join(root, ...segs.slice(0, -1))
  const target = path.join(dir, segs[segs.length - 1]!)
  const tmp = tmpName(dir)
  if (o.keepSource) fs.copyFileSync(src, tmp, C.COPYFILE_EXCL | C.COPYFILE_FICLONE)
  else {
    try { fs.renameSync(src, tmp) } catch (e: any) {
      if (e.code !== 'EXDEV') throw e
      fs.copyFileSync(src, tmp, C.COPYFILE_EXCL)
      fs.rmSync(src, { force: true })
    }
  }
  try {
    fs.chmodSync(tmp, 0o600)
    verifyChain(root, segs, true)
    try {
      const st = fs.lstatSync(target)
      if (!st.isFile() || st.nlink > 1) throw new Denied('target is not a regular file')
    } catch (e: any) { if (e instanceof Denied) throw e }
    fs.renameSync(tmp, target)
  } catch (e) { fs.rmSync(tmp, { force: true }); throw e }
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

/** Keep the current content of `rel` (a file in the team folder) as a version, by copy (clone on APFS). */
export function snapshotVersion(db: Database, root: string, rel: string, by: { userId: string; turnId: string | null }, kind: 'edit' | 'restore', sha256: string): string {
  const abs = path.join(root, ...rel.split('/'))
  const st = checkRegular(abs)
  const blob = blobPath(root, 'history')
  fs.mkdirSync(path.join(root, ...blob.slice(0, -1)), { recursive: true, mode: 0o700 })
  fs.copyFileSync(abs, path.join(root, ...blob), C.COPYFILE_EXCL | C.COPYFILE_FICLONE)
  const id = newId()
  const v = (db.query('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM file_versions WHERE path = ?').get(rel) as { v: number }).v
  db.query('INSERT INTO file_versions (id, path, version, sha256, size, author_id, turn_id, kind, storage_path) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, rel, v, sha256, st.size, by.userId, by.turnId, kind, blob.join('/'))
  return id
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
export function freeName(dirAbs: string, name: string, folder = false): string {
  const existing = new Set(fs.readdirSync(dirAbs).map(foldKey))
  if (!existing.has(foldKey(name))) return name
  const [base, ext] = splitExt(name, folder)
  for (let i = 2; i < 10_000; i++) {
    const cand = `${base} (${i})${ext}`
    if (!existing.has(foldKey(cand))) return cand
  }
  throw new ToolError('no free name', 'conflict')
}

const RESTORED: Record<Locale, string> = { ko: '복원됨', en: 'restored', id: 'dipulihkan' }

/** "report (restored).md", then "report (restored 2).md" ... in the team's default language ("보고서 (복원됨).md"). */
export function restoredName(dirAbs: string, name: string, folder = false, locale: Locale = DEFAULT_LOCALE): string {
  const existing = new Set(fs.readdirSync(dirAbs).map(foldKey))
  if (!existing.has(foldKey(name))) return name
  const [base, ext] = splitExt(name, folder)
  for (let i = 1; i < 10_000; i++) {
    const cand = `${base} (${RESTORED[locale] ?? RESTORED.en}${i > 1 ? ' ' + i : ''})${ext}`
    if (!existing.has(foldKey(cand))) return cand
  }
  throw new ToolError('no free name', 'conflict')
}
