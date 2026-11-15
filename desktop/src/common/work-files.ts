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
import type { WorkFileMeta, WorkFileRead, WorkRootId, WorkRootResult } from '@mycel/shared'
import { browserOwnerChange, type MeResult } from './browser-owner'
import { folderKey, macBlocked } from './folder-access'

export const WORK_ROOTS: readonly WorkRootId[] = ['documents', 'desktop', 'downloads']

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
}

export interface ScanProgress {
  root: WorkRootId
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
  const seenRoots: string[] = []
  const seenFiles = new Set<string>()
  for (const root of roots) {
    const r: WorkRootResult = { id: root.id, oneDrive: root.oneDrive, state: 'ok', cut: false, tooBig: 0, checked: 0 }
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
          queue.push({ parts: [...dir.parts, e.name] })
          continue
        }
        if (kind !== 'file') continue
        if (!considered(name, dir.parts.map((x) => x.normalize('NFC')))) continue
        files.push({ name, parts: [...dir.parts, e.name] })
        docs++
      }
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
          seenFiles.add(same)
          const id = o.newId()
          out.found.set(id, { root: real, parts: f.parts, size: st.size, mtimeMs: st.mtimeMs, dev: st.dev, ino: st.ino })
          out.files.push({ id, root: root.id, folder: dir.parts.map((x) => x.normalize('NFC')).join('/'), name: f.name, ext: fileExt(f.name), size: st.size, modified: Math.round(st.mtimeMs) })
        })
        if (halt) break
      }
    }
    spent += now() - start
    report(true)
  }
  return out
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
    try {
      const real = await this.fs.realpath(path)
      if (sameKey(real, p) !== sameKey(path, p) || !insideKey(sameKey(real, p), sameKey(f.root, p), p)) return { ok: false, reason: 'changed' }
      const st = await this.fs.lstat(path)
      if (!sameFile(st, f, p)) return { ok: false, reason: 'changed' }
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
      // the file that was opened: the same one, the same size and date
      if (!sameFile(await h.stat(), f, p)) return { ok: false, reason: 'changed' }
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
  if (st.kind !== 'file' || st.size !== f.size || Math.round(st.mtimeMs) !== Math.round(f.mtimeMs)) return false
  if (f.ino === 0n || st.ino === 0n) return platform !== 'win32'
  return st.dev === f.dev && st.ino === f.ino
}
