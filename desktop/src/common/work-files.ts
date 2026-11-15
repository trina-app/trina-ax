// "Find work files on this computer" (docs/DECISIONS.md "Find work files on this computer"; the bridge:
// shared/src/desktop-bridge.ts workFiles). The team page asks once (scan); the app shows its own dialog, and only when
// the person agrees there does this look through Documents, Desktop and Downloads, in the main process, one folder after
// the other (macOS asks the person for each folder the first time the app reads it, so its questions come one by one).
// The look reads names, sizes and dates only (lstat: links and junctions are never followed, and a folder that is a link
// is not entered) and hands the page a list with an opaque id per file, never a path. Afterwards the page may read the
// bytes of a file of that list, by its id (read): only ids of this look, for a while (sessionMs), at most readFiles files
// and readBytes bytes in all. A read finds the file again under the folder it was found in (its real path must be the
// same: a folder on the way swapped for a link is refused), opens it without following a link, and checks that it is
// still the same file, the same size and date. Pure: the file system comes in as WorkFs, so it is unit-tested in
// tests/unit/e-desktop-work-files.test.ts; desktop/src/main/work-files.ts wires it to Electron and node:fs.
import { posix, win32 } from 'node:path'
import { considered, fileExt, neverListed, WORK_FILES_LIMITS } from '@mycel/shared/file-scan'
import type { WorkFileMeta, WorkFileRead, WorkFolderId, WorkRootId, WorkRootResult } from '@mycel/shared'
import { browserOwnerChange, type MeResult } from './browser-owner'
import { isRecent, MIN_BYTES, type IndexedFile } from './work-index'
import { placeOf, type Place } from './work-places'
import { folderKey, macBlocked } from './folder-access'

export type { Found }
export const WORK_ROOTS: readonly WorkFolderId[] = ['documents', 'desktop', 'downloads']

/** One entry of a folder as the file system lists it, links not followed. 'link': a symbolic link, a junction or (on
 * Windows, where the listing marks every reparse point) a file the list cannot tell yet: lstat decides. */
export interface WorkDirent {
  name: string
  kind: 'file' | 'dir' | 'link' | 'other'
}
/** lstat: the entry itself, never what a link points to. */
export interface WorkStat {
  kind: 'file' | 'dir' | 'link' | 'other'
  size: number
  mtimeMs: number
  dev: bigint
  ino: bigint
}
/** A file opened for reading, never through a link (O_NOFOLLOW where the system has it). */
export interface WorkHandle {
  /** fstat of the open file */
  stat(): Promise<WorkStat>
  read(size: number): Promise<Uint8Array>
  close(): Promise<void>
}
export interface WorkFs {
  /** at most `max` entries (a folder of millions is never read whole) */
  readdir(path: string, max: number): Promise<WorkDirent[]>
  lstat(path: string): Promise<WorkStat>
  realpath(path: string): Promise<string>
  /** open read only, never through a link at the last part */
  open(path: string): Promise<WorkHandle>
}

/** A folder to look through: its place (app.getPath) and, on Windows, whether OneDrive keeps it ("Documents (OneDrive)"). */
export interface WorkRoot {
  id: WorkRootId
  path: string
  oneDrive: boolean
  /** part 5: a place's name (work-places.ts Place.label), for a root other than the three folders */
  place?: string
}

/** Windows: Documents, Desktop or Downloads moved into OneDrive (Known Folder Move: C:\Users\alex\OneDrive - Acme\Documents). */
export function inOneDrive(path: string, platform: string): boolean {
  if (platform !== 'win32') return false
  return win32.normalize(path).split('\\').some((part) => /^onedrive( - .+)?$/i.test(part))
}

const sep = (platform: string) => (platform === 'win32' ? '\\' : '/')
const join = (platform: string, ...parts: string[]) => (platform === 'win32' ? win32.join(...parts) : posix.join(...parts))
/** the same path, as the file system compares names: Windows and macOS (APFS's default) without case */
const sameKey = (p: string, platform: string) => {
  const k = folderKey(p, platform)
  return platform === 'darwin' ? k.toLowerCase() : k
}
const insideKey = (path: string, folder: string, platform: string) => path === folder || path.startsWith(folder.endsWith(sep(platform)) ? folder : folder + sep(platform))

/** A file system call that does not answer in time (a network folder, an offline share): ETIMEDOUT. The call itself goes
 * on in the background; the look does not wait for it. */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('the file system did not answer in time'), { code: 'ETIMEDOUT' })), Math.max(0, ms))
  })
  return Promise.race([p, late]).finally(() => clearTimeout(timer))
}
/** A folder's first read may wait for macOS's question to the person: this long at most, then the folder is unreadable. */
export const FIRST_READ_MS = 120_000
/** A read of one file (at most 50 MB) gives up after this long: the next read waits behind it. */
export const READ_MS = 60_000
/** Every later call gets the time left for the folder, but at least this (a call answered in time is never cut short). */
const CALL_MIN_MS = 1000

/** One file of a look, as the session keeps it: where it was found and what it was then. */
interface Found {
  /** the root's real path (realpath at the look) */
  root: string
  /** the parts below the root, as listed */
  parts: string[]
  size: number
  mtimeMs: number
  dev: bigint
  ino: bigint
  /** part 5: not looked at by the look (an online-only file on Windows, which only the index described): what it is
   * (a file, not a link, its identity) is taken at the read, just before it is opened, and checked after */
  late?: boolean
}

export interface ScanProgress {
  root: WorkRootId
  /** part 5: the place's name, for a root other than the three folders */
  place?: string
  /** entries looked at in this folder so far */
  checked: number
  /** documents found in all folders so far */
  docs: number
}

export interface ScanOptions {
  platform: string
  now?: () => number
  /** the person pressed Stop: what was found so far is the list */
  stopped?: () => boolean
  onProgress?: (p: ScanProgress) => void
  /** may this root be looked at (common/folder-access.ts opensHome: never the home folder or one that holds it) */
  allowed?: (root: WorkRoot) => Promise<boolean>
  limits?: Partial<Record<'walkDocs' | 'walkFiles' | 'depth' | 'rootMs' | 'totalMs' | 'fileBytes', number>>
  /** each file's id (crypto random in the app) */
  newId: () => string
  /** part 5: which of these entries (full paths) are online only (a Mac's SF_DATALESS): such a folder is never entered
   * (that would make the provider fetch it) and such a file is listed as in the cloud. Asked once per folder. */
  placeholders?: (paths: string[], root: WorkRoot) => Promise<Set<string>>
  /** the roots looked at before this call (their sameKey real paths): a folder of the walk that is one is skipped */
  earlier?: readonly string[]
  /** files listed before this call: by identity (dev:ino) and by path (sameKey); shared across calls */
  seen?: Set<string>
  seenPaths?: Set<string>
}

export interface ScanResult {
  stopped: boolean
  roots: WorkRootResult[]
  files: WorkFileMeta[]
  found: Map<string, Found>
}

/** Look through the roots, one after the other (macOS asks for each folder the first time it is read), breadth first in
 * each, within the limits. Names, sizes and dates only; a link or junction is never entered or listed. */
export async function scanRoots(roots: readonly WorkRoot[], fs: WorkFs, o: ScanOptions): Promise<ScanResult> {
  const lim = { walkDocs: WORK_FILES_LIMITS.walkDocs, walkFiles: WORK_FILES_LIMITS.walkFiles, depth: WORK_FILES_LIMITS.depth, rootMs: WORK_FILES_LIMITS.rootMs, totalMs: WORK_FILES_LIMITS.totalMs, fileBytes: WORK_FILES_LIMITS.fileBytes, ...o.limits }
  const now = o.now ?? (() => Date.now())
  const p = o.platform
  const out: ScanResult = { stopped: false, roots: [], files: [], found: new Map() }
  /** walking time of all roots so far (macOS's question for a folder is not counted) */
  let spent = 0
  const seenRoots: string[] = [...(o.earlier ?? [])]
  const seenFiles = o.seen ?? new Set<string>()
  for (const root of roots) {
    const r: WorkRootResult = { id: root.id, ...(root.place !== undefined ? { place: root.place } : {}), oneDrive: root.oneDrive, state: 'ok', cut: false, tooBig: 0, checked: 0 }
    out.roots.push(r)
    if (out.stopped || spent >= lim.totalMs) { r.state = 'skipped'; r.cut = !out.stopped; continue }
    if (o.allowed && !(await o.allowed(root).catch(() => false))) { r.state = 'home'; continue }
    // the first read: macOS may ask the person now (and waits for the answer)
    let top: WorkDirent[]
    let real: string
    try {
      top = await within(fs.readdir(root.path, lim.walkFiles), FIRST_READ_MS)
      real = await within(fs.realpath(root.path), FIRST_READ_MS)
    } catch (e) {
      r.state = macBlocked(e, p) ? 'blocked' : (e as { code?: string } | null)?.code === 'ENOENT' ? 'missing' : 'unreadable'
      continue
    }
    // the same folder twice (Desktop inside Documents, or a root that is a link to another): looked at once; a root that
    // holds one looked at before skips that folder in its walk (below)
    const key = sameKey(real, p)
    if (seenRoots.some((k) => insideKey(key, k, p))) { r.state = 'same'; continue }
    const earlier = [...seenRoots]
    seenRoots.push(key)
    const start = now()
    const left = () => Math.min(lim.rootMs, lim.totalMs - spent) - (now() - start)
    const inTime = <T,>(q: Promise<T>) => within(q, Math.max(CALL_MIN_MS, left()))
    let docs = 0
    let reported = 0
    const report = (force = false) => {
      if (!o.onProgress || (!force && r.checked - reported < 200)) return
      reported = r.checked
      o.onProgress({ root: root.id, checked: r.checked, docs: out.files.length })
    }
    const queue: { parts: string[]; entries?: WorkDirent[] }[] = [{ parts: [], entries: top }]
    let end = false
    while (queue.length && !end) {
      const dir = queue.shift()!
      let entries = dir.entries
      if (!entries) {
        try {
          entries = await inTime(fs.readdir(join(p, real, ...dir.parts), Math.max(1, lim.walkFiles - r.checked)))
        } catch (e) {
          // a folder that does not answer in time ends this root's look (cut); any other error skips that folder
          if ((e as { code?: string } | null)?.code === 'ETIMEDOUT') { r.cut = true; end = true; break }
          continue
        }
      }
      // documents of this folder, their lstat a few at a time
      const files: { name: string; parts: string[] }[] = []
      const dirs: string[][] = []
      for (const e of entries) {
        if (o.stopped?.()) { out.stopped = true; end = true; break }
        if (docs >= lim.walkDocs || r.checked >= lim.walkFiles || left() <= 0) { r.cut = true; end = true; break }
        r.checked++
        report()
        const name = e.name.normalize('NFC')
        if (!name || neverListed(name)) continue
        let kind = e.kind
        // Windows lists every reparse point as a link, OneDrive's online-only files too: lstat tells a real link
        if (kind === 'link' && p === 'win32') {
          try { kind = (await inTime(fs.lstat(join(p, real, ...dir.parts, e.name)))).kind } catch { continue }
        }
        if (kind === 'dir') {
          if (dir.parts.length + 1 > lim.depth) { r.cut = true; continue }
          // a root looked at before, inside this one (Documents kept inside Desktop): not twice
          const sub = sameKey(join(p, real, ...dir.parts, e.name), p)
          if (earlier.includes(sub)) continue
          dirs.push([...dir.parts, e.name])
          continue
        }
        if (kind !== 'file') continue
        if (!considered(name, dir.parts.map((x) => x.normalize('NFC')))) continue
        files.push({ name, parts: [...dir.parts, e.name] })
        docs++
      }
      // online-only folders and files (a cloud drive's): one question for the folder's entries; a folder in the cloud is
      // never entered, a file in the cloud is listed as such
      let cloud = new Set<string>()
      if (o.placeholders && (dirs.length || files.length)) {
        cloud = await inTime(o.placeholders([...dirs, ...files.map((f) => f.parts)].map((x) => join(p, real, ...x)), root)).catch(() => {
          // no answer: nothing of this folder is entered or listed (it may all be in the cloud)
          dirs.length = 0
          files.length = 0
          return new Set<string>()
        })
      }
      for (const d of dirs) if (!cloud.has(join(p, real, ...d))) queue.push({ parts: d })
      let halt = false
      // the documents found in this folder are all checked, even when a limit ended the folder's listing (end): only Stop,
      // the time and a drive that stops answering end the checks themselves
      for (let i = 0; i < files.length; i += 16) {
        // Stop and the time count between batches too (a folder of thousands of documents on a slow drive)
        if (o.stopped?.()) { out.stopped = true; end = true; break }
        if (left() <= 0) { r.cut = true; end = true; break }
        const batch = files.slice(i, i + 16)
        let late = false
        const stats = await Promise.all(batch.map((f) => inTime(fs.lstat(join(p, real, ...f.parts))).catch((e: unknown) => {
          if ((e as { code?: string } | null)?.code === 'ETIMEDOUT') late = true
          return null
        })))
        // a drive that stops answering ends this folder's look (cut), as a folder that does not answer does
        if (late) { r.cut = true; end = true; halt = true }
        batch.forEach((f, j) => {
          const st = stats[j]
          if (!st || st.kind !== 'file') return
          if (st.size > lim.fileBytes) { r.tooBig++; return }
          // a file found twice (two roots reach it, a hard link): listed once
          const same = `${st.dev}:${st.ino}`
          if (st.ino !== 0n && seenFiles.has(same)) return
          const pk = sameKey(join(p, real, ...f.parts), p)
          if (o.seenPaths?.has(pk)) return
          seenFiles.add(same)
          const id = o.newId()
          out.found.set(id, { root: real, parts: f.parts, size: st.size, mtimeMs: st.mtimeMs, dev: st.dev, ino: st.ino })
          out.files.push({ id, root: root.id, ...(root.place !== undefined ? { place: root.place } : {}), folder: dir.parts.map((x) => x.normalize('NFC')).join('/'), name: f.name, ext: fileExt(f.name), size: st.size, modified: Math.round(st.mtimeMs), ...(cloud.has(join(p, real, ...f.parts)) ? { cloud: true } : {}) })
        })
        if (halt) break
      }
    }
    spent += now() - start
    report(true)
  }
  return out
}

// ---------------------------------------------------------------- from the computer's index

/** The index's files under one folder (work-index.ts) → the look's files, as a walk would give them: only paths inside
 * the folder's real path whose folder's real path is that same folder (no link on the way, a network or other volume
 * never), no never-listed part on the way, a document type, recent, between MIN_BYTES and fileBytes; each lstat'ed (a
 * file, not a link) for the read's later checks. At most `max`, the most recently touched first.
 * Part 5: the file itself is never opened (its folder's real path and its lstat say what a realpath of it would, without
 * making a cloud provider fetch it); an online-only file on Windows (the index's attributes) gets no call at all here
 * (Found.late: the read checks it). `serial` (a network share): one call at a time, and the first that does not answer
 * ends them, so a share that hangs holds at most one of the system's file threads. */
export async function filesFromIndex(root: WorkRoot, real: string, indexed: readonly IndexedFile[], fs: WorkFs, o: { platform: string; newId: () => string; now?: () => number; fileBytes?: number; max?: number; seen?: Set<string>; seenPaths?: Set<string>; stopped?: () => boolean; callMs?: number; serial?: boolean; deadline?: number }): Promise<{ files: WorkFileMeta[]; found: Map<string, Found>; tooBig: number; checked: number }> {
  const p = o.platform
  const now = o.now?.() ?? Date.now()
  const fileBytes = o.fileBytes ?? WORK_FILES_LIMITS.fileBytes
  const rootKey = sameKey(real, p)
  const out = { files: [] as WorkFileMeta[], found: new Map<string, Found>(), tooBig: 0, checked: indexed.length }
  const lib = p === 'win32' ? win32 : posix
  const picked = indexed
    .map((f) => ({ f, key: sameKey(f.path, p) }))
    .filter(({ key }) => key !== rootKey && insideKey(key, rootKey, p) && !o.seenPaths?.has(key))
    .map(({ f }) => ({ f, parts: lib.relative(real, lib.normalize(f.path)).split(lib.sep) }))
    .filter(({ f, parts }) => parts.length && !parts.some((x) => !x || x === '..' || neverListed(x.normalize('NFC'))) && considered(parts.at(-1)!.normalize('NFC'), parts.slice(0, -1).map((x) => x.normalize('NFC'))) && (isRecent(f, now) || undated(f)))
    .sort((a, b) => Math.max(b.f.used ?? 0, b.f.modified ?? 0) - Math.max(a.f.used ?? 0, a.f.modified ?? 0))
    .slice(0, o.max ?? WORK_FILES_LIMITS.walkDocs)
  const step = o.serial ? 1 : 16
  // a recent list's entry with no date (no index here): its file's date decides, after its lstat
  const folderReal = new Map<string, Promise<string | null>>()
  for (let i = 0; i < picked.length; i += step) {
    // Stop, the time, and a drive that stops answering, end it here (each call has its time: review of part 4)
    if (o.stopped?.() || (o.deadline !== undefined && Date.now() >= o.deadline)) break
    const batch = picked.slice(i, i + step)
    let late = false
    const checks = await Promise.all(batch.map(async ({ f, parts }) => {
      const path = join(p, real, ...parts)
      // Windows' online-only file: described by the index only, never touched here
      if (f.cloud && p === 'win32') return f.size !== null && f.size >= 0 ? { f, parts, st: { kind: 'file' as const, size: f.size, mtimeMs: f.modified ?? 0, dev: 0n, ino: 0n }, late: true } : null
      try {
        // the folder's real path must still be where the index found it (no link on the way); the file itself a file
        const dir = parts.length > 1 ? join(p, real, ...parts.slice(0, -1)) : real
        let dr = folderReal.get(dir)
        if (!dr) { dr = within(fs.realpath(dir), o.callMs ?? CALL_MIN_MS).then((x) => x, (e: unknown) => { if ((e as { code?: string } | null)?.code === 'ETIMEDOUT') late = true; return null }); folderReal.set(dir, dr) }
        const dreal = await dr
        if (!dreal || sameKey(dreal, p) !== sameKey(dir, p)) return null
        const st = await within(fs.lstat(path), o.callMs ?? CALL_MIN_MS)
        return st.kind === 'file' ? { f, parts, st, late: false } : null
      } catch (e) {
        if ((e as { code?: string } | null)?.code === 'ETIMEDOUT') late = true
        return null
      }
    }))
    for (const c of checks) {
      if (!c) continue
      if (c.st.size > fileBytes) { out.tooBig++; continue }
      if (c.st.size < MIN_BYTES) continue
      if (undated(c.f) && !isRecent({ used: null, modified: c.st.mtimeMs }, now)) continue
      const same = `${c.st.dev}:${c.st.ino}`
      if (o.seen && c.st.ino !== 0n) { if (o.seen.has(same)) continue; o.seen.add(same) }
      const key = sameKey(join(p, real, ...c.parts), p)
      if (o.seenPaths) { if (o.seenPaths.has(key)) continue; o.seenPaths.add(key) }
      const id = o.newId()
      const name = c.parts.at(-1)!.normalize('NFC')
      out.found.set(id, { root: real, parts: c.parts, size: c.st.size, mtimeMs: c.st.mtimeMs, dev: c.st.dev, ino: c.st.ino, ...(c.late ? { late: true } : {}) })
      out.files.push({
        id, root: root.id, ...(root.place !== undefined ? { place: root.place } : {}), folder: c.parts.slice(0, -1).map((x) => x.normalize('NFC')).join('/'), name, ext: fileExt(name), size: c.st.size, modified: Math.round(c.st.mtimeMs),
        ...(c.f.used ? { used: Math.round(c.f.used) } : {}), ...(c.f.useCount ? { useCount: c.f.useCount } : {}),
        ...(c.f.origins.length ? { origins: c.f.origins.slice(0, 4) } : {}), ...(c.f.authors.length ? { authors: c.f.authors.slice(0, 5).map((a) => a.slice(0, 120)) } : {}),
        ...(c.f.org ? { org: c.f.org.slice(0, 120) } : {}), ...(c.f.cloud ? { cloud: true } : {}),
      })
    }
    if (late && o.serial) break
  }
  return out
}

/** A recent list's entry, or a recent-files query's hit, that the index knows no date of: its file's date decides. */
const undated = (f: IndexedFile) => (!!f.listed || !!f.queried) && f.used === null && f.modified === null

// ---------------------------------------------------------------- the look: the index first, the walk when it is off

/** The walk's limits when the index is off (docs/DECISIONS.md part 4): shallower and shorter than before. */
export const FALLBACK_LIMITS = { depth: 4, walkFiles: 20_000, rootMs: 10_000, totalMs: 20_000 } as const

export interface LookOptions extends Omit<ScanOptions, 'onProgress'> {
  /** the index's recent files under a folder's real path; null: no index here (off, failed, another system) */
  index: (real: string, root: WorkRoot) => Promise<IndexedFile[] | null>
  /** progress: the folder, entries checked, documents so far, and how far the look is (0–1) */
  onProgress?: (p: ScanProgress & { done: number }) => void
  /** what the index knows of walked files (a Mac: mdls on the newest ones, faster than listing through Spotlight,
   * measured 2026-11-15), by their path; files it does not know keep what the walk saw */
  enrich?: (paths: string[], until: { deadline: number; stopped: () => boolean }) => Promise<IndexedFile[]>
  /** part 5: the paths (sameKey) of the files listed so far, across roots (a place inside another is listed once) */
  seenPaths?: Set<string>
  /** part 5: a root's own walk limits (a place beyond the three folders gets a shorter walk) */
  rootLimits?: (root: WorkRoot) => Partial<Record<'walkDocs' | 'walkFiles' | 'depth' | 'rootMs' | 'totalMs', number>>
}

/** The walk's newest documents the index is asked about (the rest keep their date only). */
export const ENRICH_MAX = 1000

/**
 * Look through the roots one after the other. For each: ask first (its first entry is read: macOS asks the person about
 * that folder now, and Spotlight would ask the same, measured 2026-11-15), then the computer's index for its recent
 * files (filesFromIndex), or, when there is no index, the walk with FALLBACK_LIMITS. The folder's result says which.
 */
export async function lookRoots(roots: readonly WorkRoot[], fs: WorkFs, o: LookOptions): Promise<ScanResult> {
  const p = o.platform
  const out: ScanResult = { stopped: false, roots: [], files: [], found: new Map() }
  const seenRoots: string[] = []
  const seen = new Set<string>()
  const n = Math.max(1, roots.length)
  const tell = (root: WorkRoot, i: number, part: number, checked: number) => o.onProgress?.({ root: root.id, ...(root.place !== undefined ? { place: root.place } : {}), checked, docs: out.files.length, done: Math.min(1, (i + part) / n) })
  for (const [i, root] of roots.entries()) {
    const r: WorkRootResult = { id: root.id, ...(root.place !== undefined ? { place: root.place } : {}), oneDrive: root.oneDrive, state: 'ok', cut: false, tooBig: 0, checked: 0 }
    out.roots.push(r)
    tell(root, i, 0, 0)
    if (out.stopped || o.stopped?.()) { out.stopped = true; r.state = 'skipped'; continue }
    if (o.allowed && !(await o.allowed(root).catch(() => false))) { r.state = 'home'; continue }
    let real: string
    let top0 = 0
    try {
      top0 = (await within(fs.readdir(root.path, 1), FIRST_READ_MS)).length
      real = await within(fs.realpath(root.path), FIRST_READ_MS)
    } catch (e) {
      r.state = macBlocked(e, p) ? 'blocked' : (e as { code?: string } | null)?.code === 'ENOENT' ? 'missing' : 'unreadable'
      continue
    }
    const key = sameKey(real, p)
    if (seenRoots.some((k) => insideKey(key, k, p))) { r.state = 'same'; continue }
    seenRoots.push(key)
    tell(root, i, 0.2, 0)
    const indexed = await o.index(real, root).catch(() => null)
    // an index that knows nothing of a folder that has entries (Windows Search does not index a Documents moved to D:\
    // by default) is no answer: that folder is walked
    const mine = indexed?.filter((f) => insideKey(sameKey(f.path, p), key, p)) ?? null
    if (mine && (mine.length > 0 || top0 === 0)) {
      r.how = 'index'
      const f = await filesFromIndex(root, real, mine, fs, { platform: p, newId: o.newId, now: o.now, fileBytes: o.limits?.fileBytes, seen, seenPaths: o.seenPaths, stopped: () => !!o.stopped?.() })
      r.checked = f.checked
      r.tooBig = f.tooBig
      for (const x of f.files) out.files.push(x)
      for (const [id, x] of f.found) out.found.set(id, x)
    } else {
      r.how = 'walk'
      const w = await scanRoots([root], fs, { ...o, earlier: seenRoots.slice(0, -1), seen, seenPaths: o.seenPaths, limits: { ...FALLBACK_LIMITS, ...o.limits, ...o.rootLimits?.(root) }, onProgress: (x) => tell(root, i, 0.2 + 0.7 * Math.min(1, x.checked / FALLBACK_LIMITS.walkFiles), x.checked) })
      const wr = w.roots[0]!
      Object.assign(r, { state: wr.state, cut: wr.cut, tooBig: wr.tooBig, checked: wr.checked })
      if (o.enrich && w.files.length) {
        const lib = p === 'win32' ? win32 : posix
        const newest = [...w.files].sort((a, b) => b.modified - a.modified).slice(0, ENRICH_MAX)
        const pathOf = new Map(newest.map((f) => [sameKey(lib.join(real, ...w.found.get(f.id)!.parts), p), f]))
        // within the folder's time, and Stop ends it (a Spotlight that does not answer holds nothing up)
        const known = await o.enrich([...newest.map((f) => lib.join(real, ...w.found.get(f.id)!.parts))], { deadline: Date.now() + FALLBACK_LIMITS.rootMs, stopped: () => !!o.stopped?.() }).catch(() => [] as IndexedFile[])
        for (const k of known) {
          const f = pathOf.get(sameKey(k.path, p))
          if (!f) continue
          if (k.used) f.used = Math.round(k.used)
          if (k.useCount) f.useCount = k.useCount
          if (k.origins.length) f.origins = k.origins.slice(0, 4)
          if (k.authors.length) f.authors = k.authors.slice(0, 5).map((a) => a.slice(0, 120))
          if (k.org) f.org = k.org.slice(0, 120)
        }
      }
      for (const x of w.files) {
        const fx = w.found.get(x.id)!
        if (o.seenPaths) o.seenPaths.add(sameKey(join(p, fx.root, ...fx.parts), p))
        out.files.push(x)
      }
      for (const [id, x] of w.found) out.found.set(id, x)
      if (w.stopped) out.stopped = true
    }
    tell(root, i, 1, r.checked)
  }
  return out
}

// ---------------------------------------------------------------- part 5: the wide look

export interface WideOptions extends LookOptions {
  home: string
  /** the files opened lately anywhere (a Mac: Spotlight across the home folder, the shared file lists, Office's list;
   * Windows: the index's rows outside the roots, the Recent folder, Office's list), started with the look */
  recent?: () => Promise<IndexedFile[]>
  /** a path on a network share (Windows \\nas\share, a mapped drive): its files are checked one at a time */
  network?: (path: string) => boolean
  /** the look ends here, whatever is left (the recent files get what remains) */
  deadline?: number
}

/** A wide look (part 5): the roots (the places first, then the three folders) as lookRoots, then the recent files: one
 * already listed gets what the lists know (when it was opened); one elsewhere in the home folder (or, on Windows, on
 * another drive or a share) is listed under its place, never one inside the apps' data (work-places.ts placeOf,
 * homeExcluded). A place that was not looked at (blocked, unreadable) lists none of its recent files either. */
export async function lookWide(roots: readonly WorkRoot[], fs: WorkFs, o: WideOptions): Promise<ScanResult> {
  const p = o.platform
  const lib = p === 'win32' ? win32 : posix
  const seenPaths = o.seenPaths ?? new Set<string>()
  const recentP = (o.recent?.() ?? Promise.resolve([] as IndexedFile[])).catch(() => [] as IndexedFile[])
  const r = await lookRoots(roots, fs, { ...o, seenPaths })
  if (r.stopped || o.stopped?.()) { r.stopped = true; return r }
  const left = () => (o.deadline ?? Date.now() + 10_000) - Date.now()
  const recent = await within(recentP, Math.max(500, left())).catch(() => [] as IndexedFile[])
  if (!recent.length) return r
  // the files listed so far, by path: the lists add when each was opened
  const byPath = new Map<string, WorkFileMeta>()
  for (const f of r.files) { const x = r.found.get(f.id); if (x) byPath.set(sameKey(join(p, x.root, ...x.parts), p), f) }
  // the places looked at, by their real path (a recent file inside a place not looked at stays out)
  const looked: Place[] = []
  const notLooked: string[] = []
  for (const [i, root] of roots.entries()) {
    const res = r.roots[i]
    if (res?.state === 'ok') looked.push({ kind: (root.id === 'cloud' || root.id === 'folder' || root.id === 'messenger') ? root.id : 'folder', path: root.path, label: root.place ?? '' })
    else notLooked.push(root.path)
  }
  const groups = new Map<string, { place: Place; files: IndexedFile[] }>()
  const homeKey = sameKey(o.home, p)
  for (const f of recent) {
    const k = sameKey(f.path, p)
    const there = byPath.get(k)
    if (there) {
      if (f.used && (!there.used || f.used > there.used)) there.used = Math.round(f.used)
      if (f.useCount && !there.useCount) there.useCount = f.useCount
      if (f.origins.length && !there.origins?.length) there.origins = f.origins.slice(0, 4)
      continue
    }
    if (notLooked.some((n) => insideKey(k, sameKey(n, p), p))) continue
    const at = placeOf(f.path, looked, o.home, p)
    // inside a place looked at but not listed (cut, too old, not a document): left as the look left it
    if (!at || (at.place.kind !== 'home' && at.place.kind !== 'drive')) continue
    if (at.place.kind === 'home' && !insideKey(k, homeKey, p)) continue
    const g = groups.get(at.place.path) ?? { place: at.place, files: [] }
    g.files.push(f)
    groups.set(at.place.path, g)
  }
  for (const g of groups.values()) {
    if (o.stopped?.() || left() <= 0) break
    const id: WorkRootId = g.place.kind === 'drive' ? 'drive' : 'home'
    const res: WorkRootResult = { id, place: g.place.label, oneDrive: false, state: 'ok', cut: false, tooBig: 0, checked: 0, how: 'index' }
    const serial = !!o.network?.(g.place.path)
    let real: string
    try {
      real = serial ? g.place.path : await within(fs.realpath(g.place.path), 2000)
    } catch { continue }
    const f = await filesFromIndex({ id, path: g.place.path, oneDrive: false, place: g.place.label }, real, g.files.map((x) => ({ ...x, path: lib.join(real, lib.relative(lib.normalize(g.place.path), lib.normalize(x.path))) })), fs, {
      platform: p, newId: o.newId, now: o.now, fileBytes: o.limits?.fileBytes, seenPaths, stopped: () => !!o.stopped?.(), serial, callMs: serial ? 1500 : undefined, deadline: Date.now() + Math.max(500, Math.min(left(), serial ? 3000 : 5000)), max: 300,
    })
    res.checked = f.checked
    res.tooBig = f.tooBig
    if (!f.files.length && !f.tooBig) continue
    r.roots.push(res)
    for (const x of f.files) r.files.push(x)
    for (const [fid, x] of f.found) r.found.set(fid, x)
  }
  return r
}

/** What a page may ask of a look (bridge:work-files-scan): the wide look or not, and at most 20 company or client names
 * of 2–60 characters (letters, digits, spaces and a few marks; no path separators). Anything else is dropped. */
export function scanAsk(raw: unknown): { wide: boolean; words: string[] } {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const words = Array.isArray(o.words) ? o.words : []
  const clean = [...new Set(words.filter((w): w is string => typeof w === 'string').map((w) => w.normalize('NFC').trim()).filter((w) => w.length >= 2 && w.length <= 60 && /^[\p{L}\p{N} &.,'()+-]+$/u.test(w) && !w.includes('..')))].slice(0, 20)
  return { wide: o.wide === true, words: clean }
}

// ---------------------------------------------------------------- what the page may read afterwards

interface Session {
  origin: string
  at: number
  found: Map<string, Found>
  /** the files counted against the limits: taken before a read starts (so reads sent at once cannot pass them) and
   * given back when that read fails */
  read: Set<string>
  bytes: number
  /** reads in all, a file read again included */
  reads: number
}

/** The latest look of each team origin, for the person signed in (a sign-out or another person forgets them all). */
export class WorkFileSessions {
  private readonly sessions = new Map<string, Session>()
  private owner: string | null = null
  /** reads run one at a time: at most one file (50 MB) is in memory on its way to the page */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly fs: WorkFs,
    private readonly platform: string,
    private readonly now: () => number = () => Date.now(),
    private readonly limits: Partial<Record<'readFiles' | 'readBytes' | 'sessionMs' | 'readMs', number>> = {},
  ) {}

  private get lim() {
    return { readFiles: WORK_FILES_LIMITS.readFiles, readBytes: WORK_FILES_LIMITS.readBytes, sessionMs: WORK_FILES_LIMITS.sessionMs, ...this.limits }
  }

  /** A new look for this origin: it replaces the one before (its ids read nothing any more). */
  begin(origin: string, found: Map<string, Found>) {
    this.sessions.set(origin, { origin, at: this.now(), found, read: new Set(), bytes: 0, reads: 0 })
  }

  /** This origin has a look to add to (not expired). */
  has(origin: string): boolean {
    const s = this.sessions.get(origin)
    return !!s && this.now() - s.at <= this.lim.sessionMs
  }

  /** A folder the person picked themselves after the look ("Choose it yourself"): its files join the latest look of this
   * origin (its limits and its hour stay); false when there is none. */
  extend(origin: string, found: Map<string, Found>): boolean {
    const s = this.sessions.get(origin)
    if (!s || this.now() - s.at > this.lim.sessionMs) return false
    for (const [id, f] of found) s.found.set(id, f)
    return true
  }

  /** The bytes of one file of this origin's latest look, by its id. Reads run one after the other. */
  read(origin: string, id: string): Promise<WorkFileRead> {
    const next = this.queue.then(() => this.readNow(origin, id))
    this.queue = next.catch(() => {})
    return next
  }

  private async readNow(origin: string, id: string): Promise<WorkFileRead> {
    const s = this.sessions.get(origin)
    if (!s) return { ok: false, reason: 'unknown' }
    if (this.now() - s.at > this.lim.sessionMs) {
      this.sessions.delete(origin)
      return { ok: false, reason: 'expired' }
    }
    const f = s.found.get(id)
    if (!f) return { ok: false, reason: 'unknown' }
    const again = s.read.has(id)
    // a file read again counts once, but reads in all are limited too (a page reading one file over and over)
    if (s.reads >= this.lim.readFiles * 3) return { ok: false, reason: 'limit' }
    if (!again && (s.read.size >= this.lim.readFiles || s.bytes + f.size > this.lim.readBytes)) return { ok: false, reason: 'limit' }
    // taken now, before any wait; given back if this read gives nothing
    s.reads++
    if (!again) {
      s.read.add(id)
      s.bytes += f.size
    }
    // a file on a drive that stops answering gives up after READ_MS, so the reads behind it are not held forever
    const r = await within(this.readFile(f), this.limits.readMs ?? READ_MS).catch((): WorkFileRead => ({ ok: false, reason: 'unreadable' }))
    // a session that changed while this read (a new look, a sign-out) gives nothing
    if (this.sessions.get(origin) !== s) return { ok: false, reason: 'unknown' }
    if (!r.ok && !again) {
      s.read.delete(id)
      s.bytes -= f.size
    }
    return r
  }

  /** The file found again where the look found it, the same one, its bytes. */
  private async readFile(f: Found): Promise<WorkFileRead> {
    const p = this.platform
    const path = join(p, f.root, ...f.parts)
    // found again where it was: no part of the way is a link now (the real path is the same path), still a file
    // (a file the look did not touch, Found.late: what it is now, which the open must match)
    let before: WorkStat
    try {
      const real = await this.fs.realpath(path)
      if (sameKey(real, p) !== sameKey(path, p) || !insideKey(sameKey(real, p), sameKey(f.root, p), p)) return { ok: false, reason: 'changed' }
      before = await this.fs.lstat(path)
      if (!sameFile(before, f, p)) return { ok: false, reason: 'changed' }
    } catch {
      return { ok: false, reason: 'unreadable' }
    }
    let h: WorkHandle
    try {
      h = await this.fs.open(path)
    } catch (e) {
      // O_NOFOLLOW on a link that took the file's place: ELOOP
      return { ok: false, reason: (e as { code?: string } | null)?.code === 'ELOOP' ? 'changed' : 'unreadable' }
    }
    try {
      // the file that was opened: the same one, the same size and date (a late one: the one lstat'ed just before)
      const opened = await h.stat()
      if (!sameFile(opened, f, p) || (f.late && (before.ino === 0n || opened.dev !== before.dev || opened.ino !== before.ino))) return { ok: false, reason: 'changed' }
      const bytes = await h.read(f.size)
      if (bytes.byteLength !== f.size) return { ok: false, reason: 'changed' }
      return { ok: true, bytes }
    } catch {
      return { ok: false, reason: 'unreadable' }
    } finally {
      await h.close().catch(() => {})
    }
  }

  /** Who is signed in to the team page now (GET /api/me): a sign-out or another person forgets every look (true). */
  person(me: MeResult): boolean {
    const change = browserOwnerChange(this.owner, me)
    if (change.clear) this.sessions.clear()
    this.owner = change.owner
    return change.clear
  }

  /** Another team opened, the window closed: nothing of the last look stays readable. */
  forget() {
    this.sessions.clear()
  }
}

/** The same file as at the look: a file, the same identity, size and date. A file system that gives no identity (0: some
 * network and FAT drives) is taken on size and date on macOS and Linux, where the open never follows a link
 * (O_NOFOLLOW); on Windows, which has no O_NOFOLLOW, the identity is what tells a link's target apart, so without one the
 * read is refused. */
function sameFile(st: WorkStat, f: Found, platform: string): boolean {
  // a late one (the index described it, the look never touched it): a file of that size, changed within 2 s of the
  // index's date (the index keeps seconds); its identity is checked against the lstat before the open
  if (f.late) return st.kind === 'file' && st.size === f.size && Math.abs(st.mtimeMs - f.mtimeMs) <= 2000
  if (st.kind !== 'file' || st.size !== f.size || Math.round(st.mtimeMs) !== Math.round(f.mtimeMs)) return false
  if (f.ino === 0n || st.ino === 0n) return platform !== 'win32'
  return st.dev === f.dev && st.ino === f.ino
}
