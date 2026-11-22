// Hash versions of a dev environment folder (hole 4 of the review: "record changes at the end of each answer" is not
// enough, the dev server, the build and npm write at any time). A snapshot is a manifest path -> size, times, sha256;
// the server takes one before and after every box command and at the start of every turn, and the difference is
// what changed (who: the person of the command, or "in the background" between commands).
//
// Skipped by name at any depth: node_modules, .git, .env* (files and folders: secrets), dist, build, .next, .venv,
// __pycache__, .cache, .turbo. A file is hashed again only when its size, mtime, ctime or inode changed: the box can
// set mtime back (touch -d) but not ctime. Content of small text-like files goes into a content store by hash, so a
// changed file's previous content can become a file version (track.ts).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { isRunPlaceholder } from './srt/placeholders'

export const SKIP_NAMES: ReadonlySet<string> = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv', '__pycache__', '.cache', '.turbo', '.svelte-kit', '.parcel-cache'])
export const skipName = (n: string) => SKIP_NAMES.has(n) || n === '.env' || n.startsWith('.env.') || n.startsWith('.env-')

export const SNAPSHOT_MAX_FILES = 20_000
/** larger files are not hashed (size and times only) */
export const HASH_MAX_BYTES = 32 << 20
/** files kept in the content store (for versions) */
export const CAS_FILE_MAX = 1 << 20
export const CAS_TOTAL_MAX = 256 << 20

export interface Entry { size: number; mtimeMs: number; ctimeMs: number; ino: number; sha256: string | null }
/** `unkept`: files whose content is not in the store (too large for it, over its total, or unreadable now);
 * `skipped`: folders skipped by name that hold something (node_modules, .git, .env*: no content of theirs is tracked).
 * Both only when the snapshot was taken with `report` (the own-folder window, track.ts). */
export interface Manifest { at: string; files: Record<string, Entry>; truncated: boolean; unkept?: string[]; skipped?: string[] }
export interface Change { path: string; action: 'create' | 'update' | 'delete'; before: string | null; after: string | null; size: number | null }

const sha = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex')

/**
 * The kernel's path of an open file, or null (throws for a bad fd; readInside catches it). Linux: /proc/self/fd. macOS: Bun's realpath of /dev/fd/N asks the kernel
 * for the path of that open file (F_GETPATH), with the real case of each name. The real path of the file's name now
 * would not do: between that check and the open (or a stat after it) the box can swap a folder for a link and back.
 * A runtime that does not resolve /dev/fd that way (Node returns /dev/fd/N) gets null, so nothing is read.
 */
export function openFilePath(fd: number): string | null {
  const real = process.platform === 'linux' ? fs.readlinkSync(`/proc/self/fd/${fd}`) : fs.realpathSync(`/dev/fd/${fd}`)
  return real.startsWith('/') && !real.startsWith('/dev/') && !real.startsWith('/proc/') ? real : null
}

/**
 * Read a file that the box can change at any time, without following a link the box swapped in after the listing:
 * O_NOFOLLOW for the last part, and the opened file's real path must be inside `within` for the folders above it.
 * The real path is the kernel's path of the open file, not of `abs` now (see openFilePath), so a link swapped in or
 * out between the open and the check changes nothing. null: not a regular file inside the folder (now). Without this
 * a link to a server file (the database, a secret) could become a "version" that every reader of the folder sees.
 * `within` must be a real path (fs.realpathSync), as the callers pass it.
 */
export function readInside(abs: string, within: string, maxBytes = HASH_MAX_BYTES): { bytes: Buffer; st: fs.Stats } | null {
  let fd: number
  try { fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0)) } catch { return null }
  try {
    const st = fs.fstatSync(fd)
    if (!st.isFile() || st.size > maxBytes) return null
    const real = openFilePath(fd)
    if (!real || !real.startsWith(within.replace(/\/+$/, '') + '/')) return null
    const bytes = Buffer.alloc(st.size)
    let off = 0
    while (off < st.size) { const n = fs.readSync(fd, bytes, off, st.size - off, off); if (n <= 0) break; off += n }
    return { bytes: off === st.size ? bytes : bytes.subarray(0, off), st }
  } catch { return null } finally { fs.closeSync(fd) }
}

/** The caps of one store: a file up to `fileMax` is kept, at most `totalMax` in all. */
export interface StoreCaps { fileMax: number; totalMax: number }
export const PROJECT_CAPS: StoreCaps = { fileMax: CAS_FILE_MAX, totalMax: CAS_TOTAL_MAX }

export class SnapshotStore {
  constructor(readonly dir: string, readonly caps: StoreCaps = PROJECT_CAPS) {}
  private get manifestFile() { return path.join(this.dir, 'manifest.json') }
  private casPath(h: string) { return path.join(this.dir, 'cas', h.slice(0, 2), h) }

  load(): Manifest | null {
    try { return JSON.parse(fs.readFileSync(this.manifestFile, 'utf8')) as Manifest } catch { return null }
  }
  save(m: Manifest) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const tmp = this.manifestFile + '.' + process.pid + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(m), { mode: 0o600 })
    fs.renameSync(tmp, this.manifestFile)
  }
  /** content by hash (null when it was not kept) */
  blob(h: string): Buffer | null {
    try { return fs.readFileSync(this.casPath(h)) } catch { return null }
  }
  casBytes(): number {
    let n = 0
    const walk = (d: string) => { for (const e of safeList(d)) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else try { n += fs.statSync(p).size } catch {} } }
    walk(path.join(this.dir, 'cas'))
    return n
  }
  /** keep `bytes` by its hash; true when the store has them (now or before) */
  keep(h: string, bytes: Uint8Array, budget: { left: number }): boolean {
    const p = this.casPath(h)
    if (fs.existsSync(p)) return true
    if (bytes.length > this.caps.fileMax || bytes.length > budget.left) return false
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 })
    try { fs.writeFileSync(p, bytes, { mode: 0o600, flag: 'wx' }); budget.left -= bytes.length; return true } catch { return fs.existsSync(p) }
  }
  has(h: string): boolean { return fs.existsSync(this.casPath(h)) }
  /** remove every kept content that none of `keep` names (the own-folder store keeps only its newest manifest's) */
  prune(keep: ReadonlySet<string>) {
    const cas = path.join(this.dir, 'cas')
    for (const d of safeList(cas)) {
      if (!d.isDirectory()) continue
      for (const f of safeList(path.join(cas, d.name))) if (!keep.has(f.name)) try { fs.rmSync(path.join(cas, d.name, f.name), { force: true }) } catch {}
    }
  }
}

function safeList(d: string): fs.Dirent[] {
  try { return fs.readdirSync(d, { withFileTypes: true }) } catch { return [] }
}

/**
 * Snapshot of `root/folder` (folder relative to the team root; manifest paths are relative to the team root too, like
 * file_events). Links are not followed and not listed. `prev`: reuse hashes of unchanged files.
 */
export function takeSnapshot(root: string, folder: string, prev: Manifest | null, store?: SnapshotStore, o: { report?: boolean } = {}): Manifest {
  const files: Record<string, Entry> = {}
  let count = 0, truncated = false
  const unkept: string[] = [], skipped: string[] = []
  const budget = { left: store ? Math.max(0, store.caps.totalMax - store.casBytes()) : 0 }
  let within = path.join(root, folder)
  try { within = fs.realpathSync(within) } catch { return { at: new Date().toISOString(), files, truncated: true } }
  const walk = (rel: string) => {
    for (const e of safeList(path.join(root, rel))) {
      if (truncated) return
      if (skipName(e.name)) {
        // a skipped name that holds something: none of it can come back (report: the caller says so)
        if (o.report) { const r0 = rel ? `${rel}/${e.name}` : e.name; if (e.isFile() || (e.isDirectory() && safeList(path.join(root, r0)).length)) skipped.push(r0) }
        continue
      }
      const r = rel ? `${rel}/${e.name}` : e.name
      // the empty names this server made for a run (srt's mount points) are no change of the folder (QA TC-5349)
      if (isRunPlaceholder(path.join(root, r))) continue
      if (e.isDirectory()) { walk(r); continue }
      if (!e.isFile()) continue
      if (++count > SNAPSHOT_MAX_FILES) { truncated = true; return }
      const abs = path.join(root, r)
      let st: fs.Stats
      try { st = fs.lstatSync(abs) } catch { continue }
      if (!st.isFile()) continue
      const old = prev?.files[r]
      const same = !!old && old.size === st.size && old.mtimeMs === st.mtimeMs && old.ctimeMs === st.ctimeMs && old.ino === st.ino
      // report: the same file as before is taken as it was only when its content is still in the store (a content the
      // store could not keep, or lost, is read again: it may fit now)
      if (same && (!o.report || (old!.sha256 && store?.has(old!.sha256)) || !store || st.size > store.caps.fileMax)) {
        files[r] = old!
        if (o.report && (!old!.sha256 || !store?.has(old!.sha256))) unkept.push(r)
        continue
      }
      let h: string | null = null
      let kept = false
      if (st.size <= HASH_MAX_BYTES && (!o.report || !store || st.size <= store.caps.fileMax)) {
        const got = readInside(abs, within)
        if (!got) { if (o.report) unkept.push(r); continue }
        h = sha(got.bytes)
        kept = !!store?.keep(h, got.bytes, budget)
      }
      if (o.report && !kept) unkept.push(r)
      files[r] = { size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, ino: st.ino, sha256: h }
    }
  }
  walk(folder)
  return { at: new Date().toISOString(), files, truncated, ...(o.report ? { unkept, skipped } : {}) }
}

/** What changed from `a` to `b` (content: by hash; a file too large to hash: by size and mtime). */
export function diffSnapshots(a: Manifest | null, b: Manifest): Change[] {
  const out: Change[] = []
  const before = a?.files ?? {}
  for (const [p, e] of Object.entries(b.files)) {
    const o = before[p]
    if (!o) out.push({ path: p, action: 'create', before: null, after: e.sha256, size: e.size })
    else if (e.sha256 !== null && o.sha256 !== null ? e.sha256 !== o.sha256 : (e.size !== o.size || e.mtimeMs !== o.mtimeMs)) out.push({ path: p, action: 'update', before: o.sha256, after: e.sha256, size: e.size })
  }
  // a truncated snapshot does not know about the files it did not reach: no deletes from it
  if (!b.truncated) for (const p of Object.keys(before)) if (!(p in b.files)) out.push({ path: p, action: 'delete', before: before[p]!.sha256, after: null, size: null })
  return out.sort((x, y) => x.path.localeCompare(y.path))
}

/**
 * Could a store with `caps` keep every file of `root/folder` (stat only: nothing is read, kept or saved)? What could
 * not: a file over caps.fileMax, the files past caps.totalMax in all, a name skipped by name that holds something, more
 * files than a snapshot lists (truncated). Links and other entries that are not files are not tracked at all. Paths
 * under `exclude` (team-relative prefixes: folders a run cannot write) are not looked at.
 */
export function keepable(root: string, folder: string, caps: StoreCaps, exclude: readonly string[] = []): { unkept: string[]; skipped: string[]; truncated: boolean } {
  const unkept: string[] = [], skipped: string[] = []
  let count = 0, total = 0, truncated = false
  const out = (r: string) => exclude.some((x) => r === x || r.startsWith(x + '/'))
  const walk = (rel: string) => {
    for (const e of safeList(path.join(root, rel))) {
      if (truncated) return
      const r = rel ? `${rel}/${e.name}` : e.name
      if (out(r) || isRunPlaceholder(path.join(root, r))) continue
      if (skipName(e.name)) { if (e.isFile() || (e.isDirectory() && safeList(path.join(root, r)).length)) skipped.push(r); continue }
      if (e.isDirectory()) { walk(r); continue }
      if (!e.isFile()) continue
      if (++count > SNAPSHOT_MAX_FILES) { truncated = true; return }
      let st: fs.Stats
      try { st = fs.lstatSync(path.join(root, r)) } catch { continue }
      if (!st.isFile()) continue
      total += st.size
      if (st.size > caps.fileMax || total > caps.totalMax) unkept.push(r)
    }
  }
  walk(folder)
  return { unkept, skipped, truncated }
}
