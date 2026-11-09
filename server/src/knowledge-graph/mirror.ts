// The copy of one team folder's code that CodeGraph indexes (<data>/knowledge-graph/roots/<id>/tree). CodeGraph never
// reads the team folder: it follows symbolic links (an in-folder link to /etc would be indexed) and writes its index
// next to the project. The copy takes only what the file tools would show and read:
// - names the team folder accepts (policy/names.ts), no server temp names, nothing under .system/
// - regular files with one link (no symbolic links, no hard links: the team folder refuses both), each opened without
//   following a link and checked to be the very file the listing saw (same device and inode)
// - not quarantined (safe operations 1A output is download-only)
// - code only (CodeGraph's languages and a few project files), at most 1 MB each, outside dependency and build folders
// Every folder of the copy is made by us and checked to be a plain folder on the way, so nothing written there goes
// through a link. A folder with more code than one index takes (LIMITS) is not copied at all ('too_big').
import fs from 'node:fs'
import path from 'node:path'
import { badSegment, hiddenEntry } from '../policy/names'

/** File types CodeGraph reads (its extraction/grammars.ts EXTENSION_MAP, 1.5) */
export const CODE_EXT = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx', '.py', '.pyw', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.cc',
  '.cxx', '.hpp', '.hxx', '.cs', '.cshtml', '.razor', '.php', '.rb', '.rake', '.swift', '.kt', '.kts', '.dart', '.svelte', '.vue',
  '.astro', '.r', '.scala', '.sc', '.lua', '.luau', '.m', '.mm', '.sol', '.yml', '.yaml',
])
/** what makes a folder "hold code" (YAML alone is configuration, not code) */
const REAL_CODE = new Set([...CODE_EXT].filter((e) => e !== '.yml' && e !== '.yaml'))
/** project files that tell CodeGraph how imports resolve */
const PROJECT_FILES = new Set(['package.json', 'tsconfig.json', 'jsconfig.json', 'go.mod', 'Cargo.toml', 'composer.json', 'pyproject.toml'])
/** dependency, build and tool folders (CodeGraph skips these too), and version control */
export const SKIP_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'bower_components', 'jspm_packages', 'web_modules', '.yarn', '.pnpm-store', '.next', '.nuxt',
  '.svelte-kit', '.turbo', '.vite', '.parcel-cache', '.angular', '.docusaurus', 'storybook-static', '.vercel', '.netlify', '.wrangler',
  'dist', 'build', 'out', '.output', 'coverage', '.nyc_output', '__pycache__', '__pypackages__', '.venv', 'venv', '.mypy_cache',
  '.pytest_cache', '.ruff_cache', '.tox', '.nox', '.eggs', 'target', '.gradle', 'obj', 'vendor', '.build', 'Pods', 'Carthage',
  'DerivedData', '.swiftpm', '.dart_tool', '.pub-cache', '.cache', '.attachments',
])

export interface MirrorLimits { maxFiles: number; maxBytes: number; maxFileBytes: number; maxEntries: number }
export const LIMITS: MirrorLimits = { maxFiles: 20_000, maxBytes: 200 * 1024 * 1024, maxFileBytes: 1024 * 1024, maxEntries: 200_000 }

export interface MirrorResult {
  /** the folder is not there (or not a plain folder) any more */
  missing: boolean
  /** more than the limits: nothing copied, the copy removed */
  tooBig: boolean
  /** at least one file of a programming language */
  hasCode: boolean
  files: number
  bytes: number
  copied: number
  removed: number
  /** the disk had no room for everything: the rest waits for the next run */
  partial: boolean
}

export interface MirrorOptions {
  teamRoot: string
  /** the folder's actual names under the team root */
  segs: readonly string[]
  /** the copy's folder (<root dir>/project/tree) */
  tree: string
  quarantined?: (abs: string) => boolean
  limits?: MirrorLimits
  /** room on the disk for this many bytes more (system/storage.ts); default: always */
  room?: (bytes: number) => boolean
}

const ext = (name: string) => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i).toLowerCase() : '' }
export const wanted = (name: string) => CODE_EXT.has(ext(name)) || PROJECT_FILES.has(name)
const tick = () => new Promise<void>((r) => setImmediate(r))

export interface Seen { size: number; mtimeMs: number; dev: number; ino: number }

/** The folder's actual-name chain is plain folders all the way (no link anywhere on it). */
export function plainChain(root: string, segs: readonly string[]): boolean {
  let cur = root
  try {
    if (!fs.lstatSync(cur).isDirectory()) return false
    for (const s of segs) {
      cur = path.join(cur, s)
      const st = fs.lstatSync(cur)
      if (st.isSymbolicLink() || !st.isDirectory()) return false
    }
    return true
  } catch { return false }
}

export interface ListOptions {
  teamRoot: string
  segs: readonly string[]
  /** folder names not gone into */
  skipDirs: ReadonlySet<string>
  /** the files to keep (already a regular file with one link, a name the team folder accepts, not quarantined) */
  keep: (name: string, st: fs.Stats) => boolean
  quarantined?: (abs: string) => boolean
  maxEntries: number
  maxFiles: number
}

/**
 * The files of one team folder as the file tools would show them: accepted names, no server temp names or .system/, no
 * symbolic links (never followed), regular files with one link, not quarantined. Relative path → what the listing saw
 * (size, mtime, device and inode: readSeen reads only that file). null: more entries or files than the limits.
 */
export async function listFiles(o: ListOptions): Promise<Map<string, Seen> | null> {
  const base = path.join(o.teamRoot, ...o.segs)
  const out = new Map<string, Seen>()
  let entries = 0
  const stack: string[][] = [[]]
  while (stack.length) {
    const rel = stack.pop()!
    let names: string[]
    try { names = fs.readdirSync(path.join(base, ...rel)) } catch { continue }
    for (const name of names) {
      if (++entries > o.maxEntries) return null
      if (entries % 500 === 0) await tick()
      const depth = o.segs.length + rel.length
      if (hiddenEntry(name, depth) || badSegment(name) !== null) continue
      const abs = path.join(base, ...rel, name)
      let st: fs.Stats
      try { st = fs.lstatSync(abs) } catch { continue }
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) { if (!o.skipDirs.has(name)) stack.push([...rel, name]); continue }
      if (!st.isFile() || st.nlink !== 1 || !o.keep(name, st)) continue
      if (o.quarantined?.(abs)) continue
      out.set([...rel, name].join('/'), { size: st.size, mtimeMs: Math.floor(st.mtimeMs), dev: st.dev, ino: st.ino })
      if (out.size > o.maxFiles) return null
    }
  }
  return out
}

/** What the team folder holds for the copy. null: over the limits. */
async function listTeam(o: MirrorOptions, lim: MirrorLimits): Promise<{ want: Map<string, Seen>; hasCode: boolean; bytes: number } | null> {
  const want = await listFiles({ teamRoot: o.teamRoot, segs: o.segs, skipDirs: SKIP_DIRS, keep: (name, st) => wanted(name) && st.size <= lim.maxFileBytes, quarantined: o.quarantined, maxEntries: lim.maxEntries, maxFiles: lim.maxFiles })
  if (!want) return null
  let bytes = 0, hasCode = false
  for (const [rel, seen] of want) {
    bytes += seen.size
    if (REAL_CODE.has(ext(rel.slice(rel.lastIndexOf('/') + 1)))) hasCode = true
  }
  if (bytes > lim.maxBytes) return null
  return { want, hasCode, bytes }
}

/** What the copy holds now: relative path → size and mtime (links and odd entries are removed on the way). */
function listCopy(tree: string): Map<string, { size: number; mtimeMs: number }> {
  const have = new Map<string, { size: number; mtimeMs: number }>()
  const stack: string[][] = [[]]
  while (stack.length) {
    const rel = stack.pop()!
    let names: string[]
    try { names = fs.readdirSync(path.join(tree, ...rel)) } catch { continue }
    for (const name of names) {
      const abs = path.join(tree, ...rel, name)
      let st: fs.Stats
      try { st = fs.lstatSync(abs) } catch { continue }
      if (st.isDirectory()) stack.push([...rel, name])
      else if (st.isFile()) have.set([...rel, name].join('/'), { size: st.size, mtimeMs: Math.floor(st.mtimeMs) })
      else fs.rmSync(abs, { force: true }) // a link or anything else: never ours
    }
  }
  return have
}

/** A path in the copy whose folders are all plain folders (made here when missing). */
function dest(tree: string, rel: string): string | null {
  const parts = rel.split('/')
  let cur = tree
  for (const p of parts.slice(0, -1)) {
    cur = path.join(cur, p)
    try {
      const st = fs.lstatSync(cur)
      if (st.isSymbolicLink() || !st.isDirectory()) { fs.rmSync(cur, { force: true }); fs.mkdirSync(cur) }
    } catch { try { fs.mkdirSync(cur) } catch { return null } }
  }
  return path.join(cur, parts[parts.length - 1]!)
}

/** Read a team file the listing saw, without following a link, only if it is still that file. */
export function readSeen(abs: string, seen: Seen): Buffer | null {
  let fd: number
  try { fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0)) } catch { return null }
  try {
    const st = fs.fstatSync(fd)
    if (!st.isFile() || st.nlink !== 1 || st.dev !== seen.dev || st.ino !== seen.ino || st.size > seen.size * 2 + 4096) return null
    const buf = Buffer.alloc(st.size)
    let off = 0
    while (off < st.size) { const n = fs.readSync(fd, buf, off, st.size - off, off); if (n <= 0) break; off += n }
    return buf.subarray(0, off)
  } catch { return null } finally { fs.closeSync(fd) }
}

/** Bring the copy of one folder up to date with the team folder. */
export async function mirrorFolder(o: MirrorOptions): Promise<MirrorResult> {
  const lim = o.limits ?? LIMITS
  const r: MirrorResult = { missing: false, tooBig: false, hasCode: false, files: 0, bytes: 0, copied: 0, removed: 0, partial: false }
  if (!plainChain(o.teamRoot, o.segs)) { r.missing = true; fs.rmSync(o.tree, { recursive: true, force: true }); return r }
  const listed = await listTeam(o, lim)
  if (!listed) { r.tooBig = true; fs.rmSync(o.tree, { recursive: true, force: true }); return r }
  r.hasCode = listed.hasCode
  fs.mkdirSync(o.tree, { recursive: true })
  const have = listCopy(o.tree)
  const base = path.join(o.teamRoot, ...o.segs)
  let n = 0
  for (const [rel, seen] of listed.want) {
    if (++n % 100 === 0) await tick()
    const h = have.get(rel)
    if (h && h.size === seen.size && h.mtimeMs === seen.mtimeMs) { r.files++; r.bytes += seen.size; continue }
    if (o.room && !o.room(seen.size)) { r.partial = true; continue }
    const bytes = readSeen(path.join(base, ...rel.split('/')), seen)
    if (!bytes) continue
    const to = dest(o.tree, rel)
    if (!to) continue
    const tmp = path.join(path.dirname(to), `.kg-${process.pid}-${n}.tmp`)
    try {
      fs.writeFileSync(tmp, bytes, { flag: 'wx', mode: 0o600 })
      const at = new Date(seen.mtimeMs)
      fs.utimesSync(tmp, at, at)
      fs.renameSync(tmp, to)
      r.copied++; r.files++; r.bytes += bytes.length
    } catch { fs.rmSync(tmp, { force: true }) }
  }
  for (const rel of have.keys()) {
    if (listed.want.has(rel)) continue
    fs.rmSync(path.join(o.tree, ...rel.split('/')), { force: true })
    r.removed++
  }
  return r
}
