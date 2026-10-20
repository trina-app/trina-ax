// Low-level file operations inside the team folder. Callers must have authorize()d the path first.
// Writes: temp file (O_CREAT|O_EXCL|O_NOFOLLOW) in the same folder -> fsync -> re-check -> rename.
// The whole read-compare-write sequence is synchronous so concurrent tool calls in this process can't interleave.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Database } from 'bun:sqlite'
import { PRODUCT } from '@mycel/shared'
import { Denied, ToolError } from '../policy/errors'
import { verifyChain } from '../policy/resolve'
import { newId } from '../db'

const C = fs.constants
export const sha256 = (b: Uint8Array | string) => crypto.createHash('sha256').update(b).digest('hex')

/** Open a regular, singly-linked file without following a final symlink; returns its bytes. */
export function readRegular(abs: string, maxBytes = 200 * 1024 * 1024): { bytes: Buffer; st: fs.Stats } {
  let fd: number
  try { fd = fs.openSync(abs, C.O_RDONLY | C.O_NOFOLLOW | (C.O_NONBLOCK ?? 0)) } catch (e: any) {
    if (e.code === 'ELOOP' || e.code === 'EMLINK') throw new Denied('symbolic links are not followed')
    if (e.code === 'ENOENT') throw new ToolError('not found', 'not_found')
    throw new ToolError(`cannot open file (${e.code})`)
  }
  try {
    const st = fs.fstatSync(fd)
    if (st.isDirectory()) throw new ToolError('this is a folder; use list', 'is_folder')
    if (!st.isFile()) throw new Denied('not a regular file')
    if (st.nlink > 1) throw new Denied('hard-linked files are refused')
    if (st.size > maxBytes) throw new ToolError('file is too large')
    const bytes = Buffer.alloc(st.size)
    let off = 0
    while (off < st.size) { const n = fs.readSync(fd, bytes, off, st.size - off, off); if (n <= 0) break; off += n }
    return { bytes: bytes.subarray(0, off), st }
  } finally { fs.closeSync(fd) }
}

/** Current sha256 of an existing regular file, or null if missing. */
export function currentHash(abs: string): string | null {
  try { return sha256(readRegular(abs).bytes) } catch (e) { if (e instanceof ToolError && e.code === 'not_found') return null; throw e }
}

export function atomicWrite(root: string, segs: string[], data: Uint8Array, opts: { createDirs?: boolean; existing?: number } = {}) {
  // create missing parent folders one by one (names were checked by authorize)
  let cur = root
  for (let i = 0; i < segs.length - 1; i++) {
    cur = path.join(cur, segs[i])
    try { fs.mkdirSync(cur, { mode: 0o700 }) } catch (e: any) { if (e.code !== 'EEXIST') throw e }
  }
  verifyChain(root, segs, true)
  const dir = path.join(root, ...segs.slice(0, -1))
  const target = path.join(dir, segs[segs.length - 1])
  const tmp = path.join(dir, PRODUCT.tmpPrefix + crypto.randomBytes(8).toString('hex'))
  const fd = fs.openSync(tmp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600)
  try {
    let off = 0
    while (off < data.length) off += fs.writeSync(fd, data, off, data.length - off)
    fs.fsyncSync(fd)
  } finally { fs.closeSync(fd) }
  try {
    verifyChain(root, segs, true)
    try {
      const st = fs.lstatSync(target)
      if (!st.isFile() || st.nlink > 1) throw new Denied('target is not a regular file')
    } catch (e: any) { if (e instanceof Denied) throw e }
    fs.renameSync(tmp, target)
  } catch (e) { fs.rmSync(tmp, { force: true }); throw e }
}

function storeBlob(root: string, kind: 'history' | 'trash', bytes: Uint8Array): string {
  const now = new Date()
  const rel = [PRODUCT.systemDir, kind, `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`, crypto.randomUUID()]
  fs.mkdirSync(path.join(root, ...rel.slice(0, -1)), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(root, ...rel), bytes, { mode: 0o600, flag: 'wx' })
  return rel.join('/')
}

/** Keep the pre-write version in .system/history and record it in file_versions. */
export function saveVersion(db: Database, root: string, rel: string, bytes: Uint8Array, by: { userId: string; turnId: string | null }, kind: 'edit' | 'restore' = 'edit') {
  const storage = storeBlob(root, 'history', bytes)
  const v = (db.query('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM file_versions WHERE path = ?').get(rel) as any).v
  db.query('INSERT INTO file_versions (id, path, version, sha256, size, author_id, turn_id, kind, storage_path) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(newId('fv_'), rel, v, sha256(bytes), bytes.length, by.userId, by.turnId, kind, storage)
}

export function fileEvent(db: Database, e: { turnId: string | null; userId: string; path: string; action: string; size?: number; sha256?: string; detail?: unknown }) {
  db.query('INSERT INTO file_events (turn_id, user_id, path, action, size, sha256, detail) VALUES (?,?,?,?,?,?,?)')
    .run(e.turnId, e.userId, e.path, e.action, e.size ?? null, e.sha256 ?? null, e.detail === undefined ? null : JSON.stringify(e.detail))
}

/** "name (충돌 사본 - 사람 날짜 시각).ext" next to the original (design tab 2 "동시 수정"). */
export function conflictCopyName(original: string, person: string, d = new Date()): string {
  const m = /^(.*?)(\.[^.]+)?$/.exec(original)!
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`
  const safePerson = person.replace(/[<>:"|?*\\/\u0000-\u001f]/g, '').trim() || 'unknown'
  return `${m[1]} (충돌 사본 - ${safePerson} ${stamp})${m[2] ?? ''}`
}

/** Move a file to .system/trash (30 days) and record it. */
export function moveToTrash(db: Database, root: string, segs: string[], by: { userId: string; turnId: string | null }) {
  const abs = path.join(root, ...segs)
  const { bytes } = readRegular(abs)
  verifyChain(root, segs)
  const storage = storeBlob(root, 'trash', bytes)
  fs.unlinkSync(abs)
  const id = newId('tr_')
  const purge = new Date(Date.now() + 30 * 86400_000).toISOString()
  db.query('INSERT INTO trash_items (id, original_path, storage_path, size, deleted_by, turn_id, purge_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, segs.join('/'), storage, bytes.length, by.userId, by.turnId, purge)
  fileEvent(db, { turnId: by.turnId, userId: by.userId, path: segs.join('/'), action: 'delete', size: bytes.length, sha256: sha256(bytes) })
  return id
}
