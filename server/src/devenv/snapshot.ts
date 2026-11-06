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

export const SKIP_NAMES: ReadonlySet<string> = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv', '__pycache__', '.cache', '.turbo', '.svelte-kit', '.parcel-cache'])
export const skipName = (n: string) => SKIP_NAMES.has(n) || n === '.env' || n.startsWith('.env.') || n.startsWith('.env-')

export const SNAPSHOT_MAX_FILES = 20_000
/** larger files are not hashed (size and times only) */
export const HASH_MAX_BYTES = 32 << 20
/** files kept in the content store (for versions) */
export const CAS_FILE_MAX = 1 << 20
export const CAS_TOTAL_MAX = 256 << 20

export interface Entry { size: number; mtimeMs: number; ctimeMs: number; ino: number; sha256: string | null }
export interface Manifest { at: string; files: Record<string, Entry>; truncated: boolean }
export interface Change { path: string; action: 'create' | 'update' | 'delete'; before: string | null; after: string | null; size: number | null }

const sha = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex')

/**
 * Read a file that the box can change at any time, without following a link the box swapped in after the listing:
 * O_NOFOLLOW for the last part, and the opened file's real path (Linux /proc/self/fd) must be inside `within` for the
 * folders above it. null: not a regular file inside the folder (now). Without this a link to a server file (the
 * database, a secret) could become a "version" that every reader of the folder sees.
 */
export function readInside(abs: string, within: string, maxBytes = HASH_MAX_BYTES): { bytes: Buffer; st: fs.Stats } | null {
  let fd: number
  try { fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0)) } catch { return null }
  try {
    const st = fs.fstatSync(fd)
    if (!st.isFile() || st.size > maxBytes) return null
    if (process.platform === 'linux') {
      const real = fs.readlinkSync(`/proc/self/fd/${fd}`)
      if (!real.startsWith(within.replace(/\/+$/, '') + '/')) return null
    }
    const bytes = Buffer.alloc(st.size)
    let off = 0
    while (off < st.size) { const n = fs.readSync(fd, bytes, off, st.size - off, off); if (n <= 0) break; off += n }
    return { bytes: off === st.size ? bytes : bytes.subarray(0, off), st }
  } catch { return null } finally { fs.closeSync(fd) }
}

export class SnapshotStore {
  constructor(readonly dir: string) {}
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
  keep(h: string, bytes: Uint8Array, budget: { left: number }) {
    if (bytes.length > CAS_FILE_MAX || bytes.length > budget.left) return
    const p = this.casPath(h)
    if (fs.existsSync(p)) return
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 })
    try { fs.writeFileSync(p, bytes, { mode: 0o600, flag: 'wx' }); budget.left -= bytes.length } catch {}
  }
}

function safeList(d: string): fs.Dirent[] {
  try { return fs.readdirSync(d, { withFileTypes: true }) } catch { return [] }
}

/**
 * Snapshot of `root/folder` (folder relative to the team root; manifest paths are relative to the team root too, like
 * file_events). Links are not followed and not listed. `prev`: reuse hashes of unchanged files.
 */
export function takeSnapshot(root: string, folder: string, prev: Manifest | null, store?: SnapshotStore): Manifest {
  const files: Record<string, Entry> = {}
  let count = 0, truncated = false
  const budget = { left: store ? Math.max(0, CAS_TOTAL_MAX - store.casBytes()) : 0 }
  let within = path.join(root, folder)
  try { within = fs.realpathSync(within) } catch { return { at: new Date().toISOString(), files, truncated: true } }
  const walk = (rel: string) => {
    for (const e of safeList(path.join(root, rel))) {
      if (truncated) return
      if (skipName(e.name)) continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) { walk(r); continue }
      if (!e.isFile()) continue
      if (++count > SNAPSHOT_MAX_FILES) { truncated = true; return }
      const abs = path.join(root, r)
      let st: fs.Stats
      try { st = fs.lstatSync(abs) } catch { continue }
      if (!st.isFile()) continue
      const old = prev?.files[r]
      if (old && old.size === st.size && old.mtimeMs === st.mtimeMs && old.ctimeMs === st.ctimeMs && old.ino === st.ino) { files[r] = old; continue }
      let h: string | null = null
      if (st.size <= HASH_MAX_BYTES) {
        const r = readInside(abs, within)
        if (!r) continue
        h = sha(r.bytes)
        store?.keep(h, r.bytes, budget)
      }
      files[r] = { size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, ino: st.ino, sha256: h }
    }
  }
  walk(folder)
  return { at: new Date().toISOString(), files, truncated }
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
