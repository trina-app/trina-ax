// Low-level file operations inside the team folder. Callers must have authorize()d the path first.
// Writes: temp file (O_CREAT|O_EXCL|O_NOFOLLOW) in the same folder -> fsync -> re-check -> rename.
// The whole read-compare-write sequence is synchronous so concurrent tool calls in this process can't interleave.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Database } from 'bun:sqlite'
import { PRODUCT } from '@mycel/shared'
import { DEFAULT_LOCALE, type Locale } from '@mycel/shared/api'
import { Denied, ToolError } from '../policy/errors'
import { verifyChain } from '../policy/resolve'
import { newId } from '../db'
import { zonedParts } from '../system/time-zone'
import { contentOrigin } from './timeline'
import { openChecked } from '../team-files/place'

const C = fs.constants
export const sha256 = (b: Uint8Array | string) => crypto.createHash('sha256').update(b).digest('hex')

/** What the lstat of a path (or the fstat of its open file) says about reading it: a folder, a link, anything but a
 * regular file with one link is refused. */
function refuseNotRegular(st: fs.Stats) {
  if (st.isSymbolicLink()) throw new Denied('symbolic links are not followed')
  if (st.isDirectory()) throw new ToolError('this is a folder; use list', 'is_folder')
  if (!st.isFile()) throw new Denied('not a regular file')
  if (st.nlink > 1) throw new Denied('hard-linked files are refused')
}

/**
 * Open a file to read it: never through a link in its last name (O_NOFOLLOW), a regular file with one link. The caller
 * reads from the descriptor and closes it.
 *
 * `seen`: the lstat the permission check took of this path (policy/authorize.ts `st`, with `abs` its `abs`). Pass it
 * for every file of the team folder: a personal folder is also written by that person's dev environment runs, so a
 * file, or a folder on the way to it, can change after the check. What the check saw answers as before; after it, the
 * open file must be the very file that was checked (team-files/place.ts openChecked: same device and inode, and the
 * system's own path of the open file is `abs`), and every way that can fail is the one refusal "path changed while
 * opening". Without `seen` (server-owned folders: uploads, caches, work folders) the file is only checked to be
 * regular.
 */
export function openToRead(abs: string, seen?: fs.Stats): { fd: number; st: fs.Stats } {
  if (seen) { refuseNotRegular(seen); return openChecked(abs, seen) }
  let fd: number
  try { fd = fs.openSync(abs, C.O_RDONLY | C.O_NOFOLLOW | (C.O_NONBLOCK ?? 0)) } catch (e: any) {
    if (e.code === 'ELOOP' || e.code === 'EMLINK') throw new Denied('symbolic links are not followed')
    if (e.code === 'ENOENT') throw new ToolError('not found', 'not_found')
    throw new ToolError(`cannot open file (${e.code})`)
  }
  try {
    const st = fs.fstatSync(fd)
    refuseNotRegular(st)
    return { fd, st }
  } catch (e) { fs.closeSync(fd); throw e }
}

/** The bytes of a regular, singly-linked file (no link followed in its last name; `seen`: see openToRead), read from
 * the one descriptor that was opened. */
export function readRegular(abs: string, maxBytes = 200 * 1024 * 1024, seen?: fs.Stats): { bytes: Buffer; st: fs.Stats } {
  const { fd, st } = openToRead(abs, seen)
  try {
    if (st.size > maxBytes) throw new ToolError('file is too large')
    const bytes = Buffer.alloc(st.size)
    let off = 0
    while (off < st.size) { const n = fs.readSync(fd, bytes, off, st.size - off, off); if (n <= 0) break; off += n }
    return { bytes: bytes.subarray(0, off), st }
  } finally { fs.closeSync(fd) }
}

/** readRegular without holding the server: the same refusals and `seen`, the bytes read in awaited pieces of at most
 * 4 MiB (the page check's pictures and scripts, up to 40 MB a page: review of batch 3, #379). */
export async function readRegularAsync(abs: string, maxBytes = 200 * 1024 * 1024, seen?: fs.Stats): Promise<{ bytes: Buffer; st: fs.Stats }> {
  const { fd, st } = openToRead(abs, seen)
  try {
    if (st.size > maxBytes) throw new ToolError('file is too large')
    const bytes = Buffer.allocUnsafe(st.size)
    let off = 0
    while (off < st.size) {
      const at = off
      const n = await new Promise<number>((res, rej) => fs.read(fd, bytes, at, Math.min(4 * 1024 * 1024, st.size - at), at, (e, got) => (e ? rej(e) : res(got))))
      if (n <= 0) break
      off += n
    }
    return { bytes: bytes.subarray(0, off), st }
  } finally { fs.closeSync(fd) }
}

/** The first `n` bytes of a regular, singly linked file (same refusals and `seen` as readRegular): a CSV's column names. */
export function readHead(abs: string, n: number, seen?: fs.Stats): Buffer {
  const { fd, st } = openToRead(abs, seen)
  try {
    const bytes = Buffer.alloc(Math.min(n, st.size))
    const got = bytes.length ? fs.readSync(fd, bytes, 0, bytes.length, 0) : 0
    return bytes.subarray(0, Math.max(0, got))
  } finally { fs.closeSync(fd) }
}

/** A regular, singly linked file in pieces of at most 4 MiB (same refusals and `seen` as readRegular), up to the size
 * its fstat gave, never the whole file in memory: `each` gets every piece in order and may wait (make_zip's deflate). */
export async function readRegularPieces(abs: string, seen: fs.Stats | undefined, each: (piece: Buffer) => Promise<void> | void, signal?: AbortSignal): Promise<fs.Stats> {
  const { fd, st } = openToRead(abs, seen)
  try {
    const buf = Buffer.allocUnsafe(Math.min(4 * 1024 * 1024, Math.max(1, st.size)))
    for (let pos = 0; pos < st.size;) {
      signal?.throwIfAborted()
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, st.size - pos), pos)
      if (n <= 0) break
      await each(Buffer.from(buf.subarray(0, n)))
      pos += n
    }
    return st
  } finally { fs.closeSync(fd) }
}

/**
 * sha256 of a regular, singly linked file (no final symlink followed), read in 4 MiB pieces: no size limit and never
 * the whole file in memory. Synchronous, for checks that run inside authorize(); same refusals as readRegular, and the
 * same `seen`.
 */
export function sha256Regular(abs: string, seen?: fs.Stats): string {
  const { fd, st } = openToRead(abs, seen)
  try {
    // the bytes up to the size fstat gave, like readRegular: a file that grows while it is hashed is judged by what it
    // was (its first st.size bytes), never let through because the appended bytes changed the hash
    const h = crypto.createHash('sha256')
    const buf = Buffer.allocUnsafe(Math.min(4 * 1024 * 1024, Math.max(1, st.size)))
    for (let pos = 0; pos < st.size;) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, st.size - pos), pos)
      if (n <= 0) break
      h.update(buf.subarray(0, n)); pos += n
    }
    return h.digest('hex')
  } finally { fs.closeSync(fd) }
}

/**
 * A copy of a regular, singly linked file (same refusals and `seen` as readRegular) into `dest`, a new file (0600):
 * read and written in 4 MiB pieces without blocking the server, never whole in memory, and hashed on the way, so the
 * hash is of the very bytes copied (a file that grows meanwhile is copied up to the size fstat gave). Refused over
 * `maxBytes`. The caller removes `dest` on failure (it is in a work folder).
 */
export async function copyRegular(abs: string, dest: string, maxBytes: number, seen?: fs.Stats, signal?: AbortSignal): Promise<{ size: number; sha256: string }> {
  const { fd, st } = openToRead(abs, seen)
  let out: number | null = null
  try {
    if (st.size > maxBytes) throw new ToolError('file is too large')
    out = fs.openSync(dest, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600)
    const h = crypto.createHash('sha256')
    const buf = Buffer.allocUnsafe(Math.min(4 * 1024 * 1024, Math.max(1, st.size)))
    const read = (pos: number, len: number) => new Promise<number>((ok, no) => fs.read(fd, buf, 0, len, pos, (e, n) => (e ? no(e) : ok(n))))
    const write = (at: number, from: number, len: number) => new Promise<number>((ok, no) => fs.write(out!, buf, from, len, at, (e, n) => (e ? no(e) : ok(n))))
    let pos = 0
    while (pos < st.size) {
      signal?.throwIfAborted()
      const n = await read(pos, Math.min(buf.length, st.size - pos))
      if (n <= 0) break
      h.update(buf.subarray(0, n))
      for (let w = 0; w < n;) w += await write(pos + w, w, n - w)
      pos += n
    }
    return { size: pos, sha256: h.digest('hex') }
  } finally {
    fs.closeSync(fd)
    if (out !== null) fs.closeSync(out)
  }
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

/** Keep the pre-write version in .system/history and record it in file_versions.
 * `by`: whose save replaces it (author_id / turn_id); saved_by / saved_turn_id: whose save produced it (timeline.ts). */
export function saveVersion(db: Database, root: string, rel: string, bytes: Uint8Array, by: { userId: string; turnId: string | null }, kind: 'edit' | 'restore' = 'edit') {
  const storage = storeBlob(root, 'history', bytes)
  insertVersion(db, { id: newId(), rel, sha256: sha256(bytes), size: bytes.length, by, kind, storage })
}

/** One file_versions row of stored content (saveVersion, place.ts snapshotVersion). */
export function insertVersion(db: Database, o: { id: string; rel: string; sha256: string; size: number; by: { userId: string; turnId: string | null }; kind: 'edit' | 'restore'; storage: string }) {
  const origin = contentOrigin(db, o.rel, o.sha256)
  const v = (db.query('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM file_versions WHERE path = ?').get(o.rel) as { v: number }).v
  db.query('INSERT INTO file_versions (id, path, version, sha256, size, author_id, turn_id, kind, storage_path, saved_by, saved_turn_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(o.id, o.rel, v, o.sha256, o.size, o.by.userId, o.by.turnId, o.kind, o.storage, origin?.userId ?? null, origin ? origin.turnId : null)
}

export interface FileEventInput { turnId: string | null; userId: string; path: string; action: string; size?: number; sha256?: string; detail?: unknown }
type FileEventHook = (e: FileEventInput) => void
const hooks = new WeakMap<Database, FileEventHook[]>()

/** Run `fn` after every file event recorded in `db` (team skills change tracking, skills/changes.ts). */
export function onFileEvent(db: Database, fn: FileEventHook): void {
  hooks.set(db, [...(hooks.get(db) ?? []), fn])
}

export function fileEvent(db: Database, e: FileEventInput) {
  db.query('INSERT INTO file_events (turn_id, user_id, path, action, size, sha256, detail) VALUES (?,?,?,?,?,?,?)')
    .run(e.turnId, e.userId, e.path, e.action, e.size ?? null, e.sha256 ?? null, e.detail === undefined ? null : JSON.stringify(e.detail))
  // every place that changes a team file records it here: the one point that sees all of them
  for (const fn of hooks.get(db) ?? []) fn(e)
}

/** Words of the conflict copy name per language (the web's file list recognises all five: web/src/lib/paths.ts). */
// plain words (QA TC-r2u-30: "conflict copy" is a developer's word); copies made before keep their names, and the web
// app still knows the old words (web/src/lib/paths.ts CONFLICT_RE)
export const CONFLICT_COPY: Record<Locale, string> = { ko: '동시에 고친 사본', en: 'edited at the same time', id: 'diubah bersamaan', ja: "同時に編集したコピー", es: "editado a la vez", zh: '同时修改的副本' }

/** "name (conflict copy - person date time).ext" next to the original (design tab 2 "동시 수정"), in the team's
 * default language (the file is shared, so not in one person's language). */
export function conflictCopyName(original: string, person: string, d = new Date(), locale: Locale = DEFAULT_LOCALE, tz?: string): string {
  const m = /^(.*?)(\.[^.]+)?$/.exec(original)!
  const pad = (n: number) => String(n).padStart(2, '0')
  // the team's time zone when given (admin/settings.ts teamTimeZone), else the process's
  const z = tz ? zonedParts(d, tz) : { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), min: d.getMinutes() }
  const stamp = `${z.y}-${pad(z.m)}-${pad(z.d)} ${pad(z.h)}.${pad(z.min)}`
  const safePerson = person.replace(/[<>:"|?*\\/\u0000-\u001f]/g, '').trim() || 'unknown'
  return `${m[1]} (${CONFLICT_COPY[locale] ?? CONFLICT_COPY.en} - ${safePerson} ${stamp})${m[2] ?? ''}`
}

/**
 * Record a conflict copy (design tab 2 "동시 수정", tab 4 PUT content "두 사람에게 알린다"): a file_versions row
 * kind 'conflict_copy' on the original pointing at the copy (so the copy is found from the original's history),
 * file_events 'conflict' on the original, and the 'conflict' event for the saver and the person who changed the file
 * last (component C sends files.conflict to each of them only after checking they can read both the file and the copy).
 * Every path that leaves a conflict copy calls this: the file screen save, the AI write / edit, make_file and
 * POST /api/files/copy. Call it before the copy's own 'create' event: the last changer is read from the original's.
 */
export function recordConflictCopy(db: Database, events: { emit(name: string, e: unknown): unknown }, o: { original: string; copy: string; userId: string; turnId: string | null; size: number; sha256: string; tool: string }): { changedBy: { id: string; name: string | null } | null } {
  const last = db.query(`SELECT e.user_id, u.name FROM file_events e LEFT JOIN users u ON u.id = e.user_id
    WHERE e.path = ? AND e.action IN ('update','create','upload','restore') ORDER BY e.id DESC LIMIT 1`).get(o.original) as { user_id: string; name: string | null } | null
  const v = (db.query('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM file_versions WHERE path = ?').get(o.original) as { v: number }).v
  db.query('INSERT INTO file_versions (id, path, version, sha256, size, author_id, turn_id, kind, conflict_path, storage_path, saved_by, saved_turn_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(newId(), o.original, v, o.sha256, o.size, o.userId, o.turnId, 'conflict_copy', o.copy, null, o.userId, o.turnId)
  fileEvent(db, { turnId: o.turnId, userId: o.userId, path: o.original, action: 'conflict', size: o.size, sha256: o.sha256, detail: { copy: o.copy, changedBy: last?.user_id ?? null, tool: o.tool } })
  events.emit('conflict', { path: o.original, copy: o.copy, by: o.userId, users: [o.userId, last?.user_id].filter(Boolean) })
  return { changedBy: last ? { id: last.user_id, name: last.name } : null }
}

/** Move a file to .system/trash (30 days) and record it. `seen`: the check's lstat of it (readRegular): the copy kept
 * is of the file that was checked. */
export function moveToTrash(db: Database, root: string, segs: string[], by: { userId: string; turnId: string | null }, seen?: fs.Stats) {
  const abs = path.join(root, ...segs)
  const { bytes } = readRegular(abs, undefined, seen)
  verifyChain(root, segs)
  const storage = storeBlob(root, 'trash', bytes)
  fs.unlinkSync(abs)
  const id = newId()
  const purge = new Date(Date.now() + 30 * 86400_000).toISOString()
  db.query('INSERT INTO trash_items (id, original_path, storage_path, size, deleted_by, turn_id, purge_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, segs.join('/'), storage, bytes.length, by.userId, by.turnId, purge)
  fileEvent(db, { turnId: by.turnId, userId: by.userId, path: segs.join('/'), action: 'delete', size: bytes.length, sha256: sha256(bytes) })
  return id
}

/** Put `bytes`, the last content of `rel` that is gone already (a dev environment command removed it, devenv/track.ts),
 * in the trash as a file item, restorable like any deleted file for `days` days. Returns the trash id. */
export function trashBytes(db: Database, root: string, rel: string, bytes: Uint8Array, by: { userId: string; turnId: string | null }, days: number): string {
  return trashRow(db, rel, storeBlob(root, 'trash', bytes), bytes.length, by, days)
}
/** The trash_items row of a file (or a folder) whose content is at `storage` (.system/trash/…) already. Returns the trash id. */
export function trashRow(db: Database, rel: string, storage: string, size: number, by: { userId: string; turnId: string | null }, days: number, kind: 'file' | 'folder' = 'file'): string {
  const id = newId()
  db.query('INSERT INTO trash_items (id, original_path, storage_path, size, deleted_by, turn_id, purge_at, kind) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, rel, storage, size, by.userId, by.turnId, new Date(Date.now() + days * 86400_000).toISOString(), kind)
  return id
}
