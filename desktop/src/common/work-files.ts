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
import { considered, docRank, fileExt, neverListed, savedPage, softwareFolder, WORK_FILES_LIMITS } from '@mycel/shared/file-scan'
import type { WorkCloudProvider, WorkFileMeta, WorkFileRead, WorkFolderId, WorkRootId, WorkRootResult } from '@mycel/shared/desktop-bridge'
import { browserOwnerChange, type MeResult } from './browser-owner'
import { isRecent, type IndexedFile } from './work-index'
import { cloudProviderOf, placeOf, type Place } from './work-places'
import { folderKey, isUncPath, macBlocked, refusedShare } from './folder-access'

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
  /** the folder's identity with links followed (stat): what a network share's server shows as a plain folder may be a
   * junction it resolves itself (scanRoots compares it with guard before and after the folder is read). Absent: not
   * compared */
  identity?(path: string): Promise<{ dev: bigint; ino: bigint }>
  /** a Mac: whether the file's content is in the cloud only (SF_DATALESS), so a read downloads it first. Absent: not
   * known before the read (Windows, where the look's index said so: Found.late) */
  cloudOnly?(path: string): Promise<boolean>
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
/** A read of a file in a cloud's folder (cloudProviderOf) that the app could not tell was online only, still going after
 * this long: it is taken to be downloading, and the page says so. A guess: a large file there on a slow disk (or under a
 * virus scan) says so too, and one that stalls a minute there ends as cloudTimeout. */
export const CLOUD_HINT_MS = 1500
/** Every later call gets the time left for the folder, but at least this (a call answered in time is never cut short). */
const CALL_MIN_MS = 1000
/** A folder's lstat that only orders the walk (its date), or that only tells a Windows link from a real file, waits this
 * long at most: one that does not answer is skipped (the folder goes last), and never holds the rest of the walk until
 * the folder's time is up (one hung entry among forty answering ones once gave no files at all). */
const STAT_MS = 1500
/** A folder's listing in the walk (not the root's first one, which may wait for macOS's question) waits this long at
 * most: one that does not answer is skipped (cut) and the folders beside it are still walked, instead of the walk
 * waiting out the folder's whole time (Windows QA of 0.5.16: a listing that hung while its date answered held 10 s). */
const LIST_MS = 3000
/** Calls of one walk that did not answer in time and are still pending: each may hold one of the system's few file
 * threads until the drive answers, so the HUNG_MAX-th ends the walk (cut), and on a picked share no call follows (not even
 * the documents' lstat of that folder). Counted: listings, and on a picked share a Windows link's lstat and a folder's
 * date. A share's identity check or a document's lstat that does not answer ends the walk at once. */
const HUNG_MAX = 2

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
  limits?: Partial<Record<'walkDocs' | 'walkFiles' | 'depth' | 'rootMs' | 'totalMs' | 'fileBytes' | 'folderEntries' | 'folderDocs', number>>
  /** each file's id (crypto random in the app) */
  newId: () => string
  /** part 5: which of these entries (full paths) are online only (a Mac's SF_DATALESS): such a folder is never entered
   * (that would make the provider fetch it) and such a file is listed as in the cloud. Asked once per folder. */
  placeholders?: (paths: string[], root: WorkRoot) => Promise<Set<string>>
  /** the roots looked at before this call (their sameKey real paths): a folder of the walk that is one is skipped */
  earlier?: readonly string[]
  /** a network share or another volume the person picked: one file system call at a time (a share that hangs then holds
   * one of the system's few file threads, not sixteen). A listing or a Windows link's lstat that does not answer skips
   * that folder or entry (cut, a link is never entered or listed), and the walk ends at the HUNG_MAX-th call that did not
   * answer; a document's lstat that does not answer ends it at once (cut); a folder's date that does not answer stops the
   * ordering (the rest of the folders are walked as listed) and that folder is not asked again (cut) */
  serial?: boolean
  /** Windows: the identities a walk must not reach (common/folder-access.ts guardedIdentities: home and every folder
   * above it, the system's folders): a folder the listing marks as a reparse point that lstat calls a folder (lstat
   * follows what it cannot read as a link: a OneDrive folder, a volume mounted in a folder, a DFS link), and on a
   * network share every folder below its top. Only a match refuses: absent, rejected or an identity of 0 refuses
   * nothing. */
  guard?: () => Promise<readonly { dev: bigint; ino: bigint }[]>
  /** files listed before this call: by identity (dev:ino) and by path (sameKey); shared across calls */
  seen?: Set<string>
  seenPaths?: Set<string>
}

export interface ScanResult {
  /** the folders the walk did not enter because they are a program's or a code project's (sameKey real paths) */
  skipped?: string[]
  stopped: boolean
  roots: WorkRootResult[]
  files: WorkFileMeta[]
  found: Map<string, Found>
}

/** Look through the roots, one after the other (macOS asks for each folder the first time it is read), breadth first in
 * each (a level is done before the next one down, its newest folders first), within the limits. One folder gives at most
 * folderEntries entries and folderDocs documents (office types first), so a folder of thousands never uses up the look
 * before the folders beside it (MAN-057). Names, sizes and dates only; a link or junction is never entered or listed. */
export async function scanRoots(roots: readonly WorkRoot[], fs: WorkFs, o: ScanOptions): Promise<ScanResult> {
  const lim = { walkDocs: WORK_FILES_LIMITS.walkDocs, walkFiles: WORK_FILES_LIMITS.walkFiles, depth: WORK_FILES_LIMITS.depth, rootMs: WORK_FILES_LIMITS.rootMs, totalMs: WORK_FILES_LIMITS.totalMs, fileBytes: WORK_FILES_LIMITS.fileBytes, folderEntries: WORK_FILES_LIMITS.folderEntries, folderDocs: WORK_FILES_LIMITS.folderDocs, ...o.limits }
  const now = o.now ?? (() => Date.now())
  const p = o.platform
  const out: ScanResult = { stopped: false, roots: [], files: [], found: new Map(), skipped: [] }
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
      top = await within(fs.readdir(root.path, Math.min(lim.folderEntries, lim.walkFiles)), FIRST_READ_MS)
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
    const statInTime = <T,>(q: Promise<T>) => within(q, Math.min(STAT_MS, Math.max(CALL_MIN_MS, left())))
    const listInTime = <T,>(q: Promise<T>) => within(q, Math.min(LIST_MS, Math.max(CALL_MIN_MS, left())))
    /** the calls of this walk that did not answer in time and are still pending (HUNG_MAX): one that answers later,
     * however late, stops counting (a slow listing is no stuck thread) */
    let hung = 0
    /** a call that did not answer in time: counted while it is pending; true when it is the HUNG_MAX-th */
    const pending = (q: Promise<unknown>): boolean => {
      hung++
      q.then(() => { hung-- }, () => { hung-- })
      return hung >= HUNG_MAX
    }
    // a picked share whose folder date did not answer: the rest of the walk is not ordered (no more such calls)
    let unordered = false
    // a network share (\\nas\company, a mapped drive: its real path is the network one): every folder below its top is
    // compared by identity with guard, before and after its listing; a reparse point lstat calls a folder (a DFS link)
    // is walked under the same check (TC-4844)
    const share = isUncPath(real, p) || isUncPath(root.path, p)
    let guardIds: Promise<Set<string>> | null = null
    /** is this identity one of guard's (home, a folder above it, a system folder)? Only a match counts: an identity that
     * cannot be told (0) or a guard that cannot be had refuses nothing (a NAS without file numbers, a home whose
     * identity does not answer) */
    const guarded = async (id: { dev: bigint; ino: bigint }): Promise<boolean> => {
      if (!o.guard || id.dev === 0n || id.ino === 0n) return false
      guardIds ??= inTime(o.guard()).then((ids) => new Set(ids.map((x) => `${x.dev}:${x.ino}`)), () => new Set<string>())
      return (await guardIds).has(`${id.dev}:${id.ino}`)
    }
    /** may a folder the listing marked as a reparse point, and lstat then called a folder, be entered. On a share: yes (a
     * DFS link; its identity is checked when it is listed). Elsewhere only when it stays where its path says (its real
     * path is that path: a OneDrive folder; a mounted volume or a junction written as a volume or GLOBALROOT target is
     * not, and a read under it is refused anyway) and its identity is none of guard's */
    const reparseOk = async (st: WorkStat, path: string): Promise<boolean> => {
      if (share) return true
      if (await guarded(st)) return false
      return sameKey(await statInTime(fs.realpath(path)), p) === sameKey(path, p)
    }
    /** a share's folder's identity, links followed ('?' when it cannot be told), or null when it is one of guard's */
    const shareFolderId = async (path: string): Promise<string | null> => {
      if (!fs.identity) return '?'
      let id: { dev: bigint; ino: bigint }
      try { id = await statInTime(fs.identity(path)) } catch (x) {
        // one that does not answer in time is told to the walk (it may end it); any other error tells nothing
        if ((x as { code?: string } | null)?.code === 'ETIMEDOUT') throw x
        return '?'
      }
      return (await guarded(id)) ? null : `${id.dev}:${id.ino}`
    }
    // the folders whose date did not answer in time (their parts joined): likely stuck, so never waited on for long again
    const slow = new Set<string>()
    let docs = 0
    let reported = 0
    const report = (force = false) => {
      if (!o.onProgress || (!force && r.checked - reported < 200)) return
      reported = r.checked
      o.onProgress({ root: root.id, checked: r.checked, docs: out.files.length })
    }
    // breadth first, the newest folders of a level first (a folder's date moves when a file is added, renamed or removed
    // in it): a look cut by its limits keeps the shallow folders and, among them, the recent ones; the top folder first
    const queue = new FolderQueue()
    queue.push({ parts: [], entries: top, mtimeMs: Infinity })
    let end = false
    while (queue.size && !end) {
      const dir = queue.pop()!
      let entries = dir.entries
      if (!entries) {
        // a folder whose date did not answer: a picked share (one call at a time) is not asked again (cut); elsewhere its
        // listing gets STAT_MS too, and one that does not answer then is skipped (cut, HUNG_MAX), the rest of the walk goes on
        const stuck = slow.has(dir.parts.join('\0'))
        if (stuck && o.serial) { r.cut = true; continue }
        // a share's folder below its top: its identity, links followed, is none of guard's before it is read (a junction
        // the server resolves itself shows as a plain folder); one that cannot be told is walked, and one that does not
        // answer in time ends the walk on a share looked at one call at a time
        const at = join(p, real, ...dir.parts)
        let before: string | null = null
        if (share) {
          try { before = await shareFolderId(at) } catch {
            if (o.serial) { r.cut = true; end = true; break }
            before = '?'
          }
          if (!before) continue
        }
        let list: Promise<WorkDirent[]> | null = null
        try {
          list = fs.readdir(at, Math.max(1, Math.min(lim.folderEntries, lim.walkFiles - r.checked)))
          entries = await (stuck ? statInTime(list) : listInTime(list))
        } catch (e) {
          // a folder that does not answer in time (LIST_MS, after the root's first read) is skipped (cut) and the folders
          // beside it are walked, up to HUNG_MAX calls still pending; any other error skips that folder
          if ((e as { code?: string } | null)?.code === 'ETIMEDOUT' && list) { r.cut = true; if (pending(list)) { end = true; break } }
          continue
        }
        // asked again after the listing: a folder swapped for a junction meanwhile gives another identity (or a guarded
        // one), and its listing is dropped
        if (share) {
          let after: string | null = null
          try { after = await shareFolderId(at) } catch {
            if (o.serial) { r.cut = true; end = true; break }
            after = '?'
          }
          // a folder told before and after must be the same one; one told only once is kept unless that once was guarded
          if (!after || (after !== '?' && before !== '?' && after !== before)) continue
        }
        // a program's or a code project's folder (its .dll files, package.json, bin and lib): not entered further, and
        // the recent lists' files inside it are left out too (lookRoots)
        if (softwareFolder(entries)) { out.skipped?.push(sameKey(join(p, real, ...dir.parts), p)); continue }
      }
      // a folder of more entries than one folder gives: the rest of it is not seen (the folders beside it are)
      if (entries.length >= lim.folderEntries) r.cut = true
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
        let reparse: WorkStat | null = null
        // Windows lists every reparse point as a link, OneDrive's online-only files too: lstat tells a real link
        if (kind === 'link' && p === 'win32') {
          // one that does not answer is skipped, never entered or listed (what it is was not told); on a picked share (one
          // call at a time) the folder is cut and it counts towards HUNG_MAX
          const q = fs.lstat(join(p, real, ...dir.parts, e.name))
          try { reparse = await statInTime(q); kind = reparse.kind } catch (x) {
            if (o.serial && (x as { code?: string } | null)?.code === 'ETIMEDOUT') { r.cut = true; if (pending(q)) { end = true; break } }
            continue
          }
        }
        if (kind === 'dir') {
          // a reparse point lstat could not read as a link (it followed it; a link or junction it reads stays skipped):
          // on a share walked under the identity check (a DFS link), elsewhere only when its real path is its path and it
          // is not home, a folder above it or a system folder (guard)
          if (reparse && !(await reparseOk(reparse, join(p, real, ...dir.parts, e.name)).catch(() => false))) continue
          // a browser's "Save page as" folder (its page saved beside it): never entered
          if (savedPage(name, entries.map((x) => x.name))) continue
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
      }
      // one folder lists at most folderDocs documents, office types first (a folder of thousands of notes or pictures
      // keeps its spreadsheets; the look's document limit cuts the same way); the rest of it is cut
      files.sort((a, b) => docRank(a.name) - docRank(b.name))
      if (files.length > lim.folderDocs) {
        files.length = lim.folderDocs
        r.cut = true
      }
      if (docs + files.length > lim.walkDocs) { files.length = Math.max(0, lim.walkDocs - docs); r.cut = true; end = true }
      docs += files.length
      // online-only folders and files (a cloud drive's): one question for the folder's entries; a folder in the cloud is
      // never entered, a file in the cloud is listed as such
      let cloud = new Set<string>()
      // a cloud drive's folder: its folders and files; elsewhere only its folders (entering an online-only folder makes
      // the provider fetch it; an lstat of an online-only file fetches nothing), and no call without folders
      const ask = root.id === 'cloud' ? [...dirs, ...files.map((f) => f.parts)] : dirs
      if (o.placeholders && ask.length) {
        cloud = await inTime(o.placeholders(ask.map((x) => join(p, real, ...x)), root)).catch(() => {
          // no answer: nothing of this folder is entered or listed (it may all be in the cloud)
          dirs.length = 0
          files.length = 0
          return new Set<string>()
        })
      }
      const next = dirs.filter((d) => !cloud.has(join(p, real, ...d)))
      // each folder's date (its lstat, 16 at a time, each within STAT_MS) orders the walk; one that does not answer is
      // skipped and goes last, and the folders beside it are still walked (a hung lstat never ends the walk by itself; on
      // a picked share it counts towards HUNG_MAX)
      const step = o.serial ? 1 : 16
      const undated: string[][] = []
      let i = 0
      for (; i < next.length && !end && !unordered; i += step) {
        if (left() <= 0 || o.stopped?.()) break
        const b = next.slice(i, i + step)
        let stuck = false
        const st = await Promise.all(b.map((d) => { const q = fs.lstat(join(p, real, ...d)); return statInTime(q).catch((e: unknown) => {
          if ((e as { code?: string } | null)?.code === 'ETIMEDOUT') { stuck = true; slow.add(d.join('\0')); if (o.serial && pending(q)) { r.cut = true; end = true } }
          return null
        }) }))
        b.forEach((d, j) => { const m = st[j]?.mtimeMs; if (m === undefined) undated.push(d); else queue.push({ parts: d, mtimeMs: m }) })
        // a picked share (one call at a time) that did not answer one: no more dates are asked of it, the rest of its
        // folders are walked in the order listed
        if (stuck && o.serial) unordered = true
      }
      // the folders with no date (not asked: the share stopped answering or the time ran out; then the ones that did not
      // answer, last of all): still walked, after the dated ones of their level
      for (const d of [...next.slice(i), ...undated]) queue.push({ parts: d, mtimeMs: -Infinity })
      let halt = false
      // the documents found in this folder are all checked, even when a limit ended the folder's listing (end): only Stop,
      // the time and a drive that stops answering end the checks themselves
      for (let i = 0; i < files.length; i += step) {
        // Stop and the time count between batches too (a folder of thousands of documents on a slow drive)
        if (o.stopped?.()) { out.stopped = true; end = true; break }
        if (left() <= 0) { r.cut = true; end = true; break }
        // a picked share with HUNG_MAX calls still pending: no more calls (each holds one of the system's file threads)
        if (o.serial && hung >= HUNG_MAX) { r.cut = true; end = true; break }
        const batch = files.slice(i, i + step)
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

/** The walk's folders, breadth first: the shallower first, then the newer (a binary heap). */
interface QueuedFolder { parts: string[]; entries?: WorkDirent[]; mtimeMs: number; seq?: number }
class FolderQueue {
  private readonly h: QueuedFolder[] = []
  private seq = 0
  get size() { return this.h.length }
  /** shallower first (a level is walked before the next one down: one big or fresh deep tree never uses up the walk
   * before the folders beside it, MAN-057), then newer, then in the order found */
  private before(a: QueuedFolder, b: QueuedFolder) {
    if (a.parts.length !== b.parts.length) return a.parts.length < b.parts.length
    if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs > b.mtimeMs
    return a.seq! < b.seq!
  }
  push(x: QueuedFolder) {
    const h = this.h
    h.push({ ...x, seq: this.seq++ })
    for (let i = h.length - 1; i > 0;) {
      const up = (i - 1) >> 1
      if (!this.before(h[i]!, h[up]!)) break
      ;[h[i], h[up]] = [h[up]!, h[i]!]
      i = up
    }
  }
  pop(): QueuedFolder | undefined {
    const h = this.h
    const top = h[0]
    const last = h.pop()
    if (!h.length || !last) return top
    h[0] = last
    for (let i = 0; ;) {
      const l = 2 * i + 1, r = l + 1
      let m = i
      if (l < h.length && this.before(h[l]!, h[m]!)) m = l
      if (r < h.length && this.before(h[r]!, h[m]!)) m = r
      if (m === i) break
      ;[h[i], h[m]] = [h[m]!, h[i]!]
      i = m
    }
    return top
  }
}

// ---------------------------------------------------------------- from the computer's index

/** The index's files under one folder (work-index.ts) → the look's files, as a walk would give them: only paths inside
 * the folder's real path whose folder's real path is that same folder (no link on the way, a network or other volume
 * never), no never-listed part on the way, a document type, recent, not empty and at most fileBytes; each lstat'ed (a
 * file, not a link) for the read's later checks. At most `max`, the most recently touched first.
 * Part 5: the file itself is never opened (its folder's real path and its lstat say what a realpath of it would, without
 * making a cloud provider fetch it); an online-only file on Windows (the index's attributes) gets no call at all here
 * (Found.late: the read checks it). `serial` (a network share): one call at a time, and the first that does not answer
 * ends them, so a share that hangs holds at most one of the system's file threads. */
export async function filesFromIndex(root: WorkRoot, real: string, indexed: readonly IndexedFile[], fs: WorkFs, o: { platform: string; newId: () => string; now?: () => number; fileBytes?: number; max?: number; seen?: Set<string>; seenPaths?: Set<string>; stopped?: () => boolean; callMs?: number; serial?: boolean; deadline?: number }): Promise<{ files: WorkFileMeta[]; found: Map<string, Found>; tooBig: number; checked: number; timedOut?: boolean }> {
  const p = o.platform
  const now = o.now?.() ?? Date.now()
  const fileBytes = o.fileBytes ?? WORK_FILES_LIMITS.fileBytes
  const rootKey = sameKey(real, p)
  const out = { files: [] as WorkFileMeta[], found: new Map<string, Found>(), tooBig: 0, checked: indexed.length, timedOut: false }
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
      // (its date must be known: the read compares it)
      if (f.cloud && p === 'win32') return f.size !== null && f.size >= 0 && f.modified ? { f, parts, st: { kind: 'file' as const, size: f.size, mtimeMs: f.modified ?? 0, dev: 0n, ino: 0n }, late: true } : null
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
      // an empty file is nothing; a small one (an empty template, a note of a few lines) is listed so that search by name
      // finds it, and the page keeps it out of the picks (web/src/lib/workFiles.ts notWork: tooSmall)
      if (c.st.size === 0) continue
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
        ...(c.f.org ? { org: c.f.org.slice(0, 120) } : {}), ...(c.f.cloud ? { cloud: true } : {}), ...(c.f.listed ? { listed: true } : {}),
      })
    }
    if (late) out.timedOut = true
    if (late && o.serial) break
  }
  return out
}

/** A recent list's entry, or a recent-files query's hit, that the index knows no date of: its file's date decides. */
const undated = (f: IndexedFile) => (!!f.listed || !!f.queried) && f.used === null && f.modified === null

// ---------------------------------------------------------------- the look: the index first, the walk when it is off

/** The walk's limits when the index is off (docs/DECISIONS.md part 4): shorter than before. Entries are cheap (a name
 * each); the time and one folder's share (folderEntries, folderDocs) are what bound it. Six folders down: an office's
 * "Documents › Clients › Acme › 2026 › Quotes" is five (MAN-057). */
export const FALLBACK_LIMITS = { depth: 6, walkFiles: 50_000, rootMs: 10_000, totalMs: 20_000 } as const

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
  /** part 5: a root that is never walked (a cloud drive's folder on Windows, whose online-only entries a walk would
   * touch): its first entry is not read either; without the index's rows it is left out ('skipped') */
  noWalk?: (root: WorkRoot) => boolean
  /** part 5: the whole look ends here: roots not reached are 'skipped' (cut), a walk gets at most what is left */
  deadline?: number
  /** the files a recent list or the index says were opened lately under a walked folder's real path (a Mac: Spotlight's
   * last-opened, the shared file lists, Office's list): asked for when the folder's walk starts, added after it when the
   * walk did not list them (a walk cut by its limits keeps the files the person really opened) */
  recentIn?: (real: string, root: WorkRoot) => Promise<IndexedFile[]>
  /** a root that is walked even when the index knows files in it (Windows' three folders, MAN-057: Windows Search's 2,000
   * newest rows of the whole home folder can hold only a few of a big Documents, or none it has not indexed yet). The
   * index is not waited for: its rows join after the walk as the recent lists' do (recentIn), for up to recentWaitMs */
  walkToo?: (root: WorkRoot) => boolean
  /** how long a walked root waits for its recent rows after its walk (default 1.5 s; at most a third of its share) */
  recentWaitMs?: number
  /** time kept back from the walks before the deadline (the wide look's recent files after them) */
  reserveMs?: number
  /** part 5: a root's own walk limits (a place beyond the three folders gets a shorter walk) */
  rootLimits?: (root: WorkRoot) => Partial<Record<'walkDocs' | 'walkFiles' | 'depth' | 'rootMs' | 'totalMs', number>>
}

/** A root answered by the index only, reached after the look's end: how long its rows are waited for. */
const LATE_INDEX_MS = 2000

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
  const seenPaths = o.seenPaths ?? new Set<string>()
  const n = Math.max(1, roots.length)
  const tell = (root: WorkRoot, i: number, part: number, checked: number) => o.onProgress?.({ root: root.id, ...(root.place !== undefined ? { place: root.place } : {}), checked, docs: out.files.length, done: Math.min(1, (i + part) / n) })
  for (const [i, root] of roots.entries()) {
    const r: WorkRootResult = { id: root.id, ...(root.place !== undefined ? { place: root.place } : {}), oneDrive: root.oneDrive, state: 'ok', cut: false, tooBig: 0, checked: 0 }
    out.roots.push(r)
    tell(root, i, 0, 0)
    if (out.stopped || o.stopped?.()) { out.stopped = true; r.state = 'skipped'; continue }
    const noWalk = !!o.noWalk?.(root)
    // past the look's end: a root that is walked is skipped; one answered by the index only (a cloud drive's folder on
    // Windows, almost free once the index has answered) still gets its rows, for a moment (review of MAN-057)
    const late = o.deadline !== undefined && Date.now() >= o.deadline
    if (late && !noWalk) { r.state = 'skipped'; r.cut = true; continue }
    if (o.allowed && !(await o.allowed(root).catch(() => false))) { r.state = 'home'; continue }
    let real: string
    let top0 = 0
    try {
      if (!noWalk) top0 = (await within(fs.readdir(root.path, 1), FIRST_READ_MS)).length
      real = await within(fs.realpath(root.path), noWalk ? 5000 : FIRST_READ_MS)
    } catch (e) {
      r.state = macBlocked(e, p) ? 'blocked' : (e as { code?: string } | null)?.code === 'ENOENT' ? 'missing' : 'unreadable'
      continue
    }
    const key = sameKey(real, p)
    if (seenRoots.some((k) => insideKey(key, k, p))) { r.state = 'same'; continue }
    seenRoots.push(key)
    tell(root, i, 0.2, 0)
    const walkToo = !noWalk && !!o.walkToo?.(root)
    const indexP = o.index(real, root).catch(() => null)
    const mineOf = (rows: IndexedFile[] | null) => rows?.filter((f) => insideKey(sameKey(f.path, p), key, p)) ?? null
    // a root walked anyway: the index is not waited for here
    const indexed = walkToo ? null : late ? await within(indexP, LATE_INDEX_MS).catch(() => null) : await indexP
    // an index that knows nothing of a folder that has entries (Windows Search does not index a Documents moved to D:\
    // by default) is no answer: that folder is walked
    const mine = mineOf(indexed)
    if (noWalk && !mine?.length) {
      // never walked: without the index's rows nothing of it is listed
      r.state = 'skipped'
    } else if (mine && (mine.length > 0 || top0 === 0)) {
      r.how = 'index'
      const f = await filesFromIndex(root, real, mine!, fs, { platform: p, newId: o.newId, now: o.now, fileBytes: o.limits?.fileBytes, seen, seenPaths, stopped: () => !!o.stopped?.(), deadline: late ? Date.now() + LATE_INDEX_MS : o.deadline })
      r.checked = f.checked
      r.tooBig = f.tooBig
      for (const x of f.files) out.files.push(x)
      for (const [id, x] of f.found) out.found.set(id, x)
    } else {
      r.how = 'walk'
      const listsP = o.recentIn ? o.recentIn(real, root).catch(() => [] as IndexedFile[]) : null
      // the index's rows of a root walked anyway join as the recent lists' do
      const recentP = walkToo
        ? Promise.all([listsP ?? Promise.resolve([] as IndexedFile[]), indexP.then((x) => mineOf(x) ?? [])]).then(([a, b]) => [...a, ...b])
        : listsP
      const lim = { ...FALLBACK_LIMITS, ...o.limits, ...o.rootLimits?.(root) }
      // each walked root gets its share of the time left (the roots still to walk, and what the look keeps back for its
      // own last step), its wait for the index's rows included: the first big folder never leaves the others nothing
      // (review of MAN-057)
      let wait = o.recentWaitMs ?? 1500
      if (o.deadline !== undefined) {
        const walksLeft = roots.slice(i).filter((x) => !o.noWalk?.(x)).length || 1
        const share = (o.deadline - Date.now() - (o.reserveMs ?? 0)) / walksLeft
        wait = Math.max(500, Math.min(wait, share / 3))
        lim.rootMs = Math.max(500, Math.min(lim.rootMs, share - (walkToo ? wait : 0)))
      }
      const w = await scanRoots([root], fs, { ...o, earlier: seenRoots.slice(0, -1), seen, seenPaths, limits: lim, onProgress: (x) => tell(root, i, 0.2 + 0.7 * Math.min(1, x.checked / FALLBACK_LIMITS.walkFiles), x.checked) })
      const wr = w.roots[0]!
      Object.assign(r, { state: wr.state, cut: wr.cut, tooBig: wr.tooBig, checked: wr.checked })
      if (o.enrich && w.files.length) {
        const lib = p === 'win32' ? win32 : posix
        const newest = [...w.files].sort((a, b) => b.modified - a.modified).slice(0, ENRICH_MAX)
        const pathOf = new Map(newest.map((f) => [sameKey(lib.join(real, ...w.found.get(f.id)!.parts), p), f]))
        // within the folder's time, and Stop ends it (a Spotlight that does not answer holds nothing up)
        const known = await o.enrich([...newest.map((f) => lib.join(real, ...w.found.get(f.id)!.parts))], { deadline: Math.min(Date.now() + FALLBACK_LIMITS.rootMs, o.deadline ?? Infinity), stopped: () => !!o.stopped?.() }).catch(() => [] as IndexedFile[])
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
      // an empty file is nothing. A small one (an empty template, a text note of a few lines) stays listed: search by name
      // must find every file the look saw (MAN-057: three quotes of 27 to 53 bytes were dropped here, so "quote" found
      // nothing). The page keeps small files out of the picks and the AI (web/src/lib/workFiles.ts notWork: tooSmall).
      for (const x of w.files) if (x.size === 0) w.found.delete(x.id)
      w.files = w.files.filter((x) => w.found.has(x.id))
      for (const x of w.files) {
        const fx = w.found.get(x.id)!
        seenPaths.add(sameKey(join(p, fx.root, ...fx.parts), p))
        out.files.push(x)
      }
      for (const [id, x] of w.found) out.found.set(id, x)
      if (w.stopped) out.stopped = true
      // the files opened lately in this folder that the walk did not list (cut, too deep): added as the index's are
      if (recentP && !out.stopped && !o.stopped?.()) {
        const skipped = w.skipped ?? []
        const rec = (await within(recentP, Math.max(500, Math.min(wait, (o.deadline ?? Infinity) - Date.now()))).catch(() => [] as IndexedFile[]))
          .filter((x) => { const k = sameKey(x.path, p); return insideKey(k, key, p) && !skipped.some((s) => insideKey(k, s, p)) })
        // a walked file the lists know: when it was opened, and that it is in a recent list
        const walked = new Map(w.files.map((x) => { const fx = w.found.get(x.id)!; return [sameKey(join(p, fx.root, ...fx.parts), p), x] as const }))
        for (const k of rec) {
          const x = walked.get(sameKey(k.path, p))
          if (!x) continue
          if (k.used && (!x.used || k.used > x.used)) x.used = Math.round(k.used)
          if (k.listed) x.listed = true
          if (k.useCount && !x.useCount) x.useCount = k.useCount
          if (k.origins.length && !x.origins?.length) x.origins = k.origins.slice(0, 4)
          if (k.authors.length && !x.authors?.length) x.authors = k.authors.slice(0, 5).map((a) => a.slice(0, 120))
          if (k.org && !x.org) x.org = k.org.slice(0, 120)
        }
        if (rec.length) {
          const f = await filesFromIndex(root, real, rec, fs, { platform: p, newId: o.newId, now: o.now, fileBytes: o.limits?.fileBytes, seen, seenPaths, stopped: () => !!o.stopped?.(), deadline: Math.min(Date.now() + 2000, o.deadline ?? Infinity), max: 300 })
          r.tooBig += f.tooBig
          for (const x of f.files) out.files.push(x)
          for (const [id, x] of f.found) out.found.set(id, x)
        }
      }
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
  /** network groups: at most 3 are tried, and none after one that did not answer (a hung call holds one of the system's
   * few file threads until the share answers) */
  let networkTries = 0
  let networkDead = false
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
      if (f.listed) there.listed = true
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
    if (serial && (networkDead || ++networkTries > 3)) continue
    let real: string
    try {
      real = serial ? g.place.path : await within(fs.realpath(g.place.path), 2000)
    } catch { continue }
    const f = await filesFromIndex({ id, path: g.place.path, oneDrive: false, place: g.place.label }, real, g.files.map((x) => ({ ...x, path: lib.join(real, lib.relative(lib.normalize(g.place.path), lib.normalize(x.path))) })), fs, {
      platform: p, newId: o.newId, now: o.now, fileBytes: o.limits?.fileBytes, seenPaths, stopped: () => !!o.stopped?.(), serial, callMs: serial ? 1500 : undefined, deadline: Date.now() + Math.max(500, Math.min(left(), serial ? 3000 : 5000)), max: 300,
    })
    if (serial && f.timedOut) networkDead = true
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

/** A folder "Choose a folder…" never looks through: one inside the apps' data or a never-listed folder (AppData, Library,
 * a dot folder, node_modules, an app bundle), or the system's own (Windows, Program Files, ProgramData, another
 * person's Users folder; a Mac's /System, /private, /usr, /Applications …). A Mac's cloud drives (~/Library/CloudStorage/…,
 * iCloud Drive's ~/Library/Mobile Documents/…) count from their own folder on. A drive's letter is no folder name.
 * `home`: the person's home folder (another person's is refused). A network share (\\nas\company\…) counts from
 * below its share name, as a drive from below its letter (a share of a drive's top holds Windows and Users too); a
 * device path, an admin share (C$, ADMIN$) and WSL's are refused (common/folder-access.ts refusedShare). */
export function pickRefused(path: string, platform: string, home?: string): boolean {
  const lib = platform === 'win32' ? win32 : posix
  const parts = lib.normalize(path).split(lib.sep).filter(Boolean)
  const low = parts.map((x) => x.toLowerCase())
  let from = 0
  if (platform === 'win32') {
    if (refusedShare(path, platform)) return true
    // where the folders below a drive or a share start: after "C:", after "\\server\share"
    const unc = isUncPath(path, platform)
    const at = unc ? 2 : low[0] && /^[a-z]:$/.test(low[0]) ? 1 : 0
    const top = low[at]
    if (top && /^(windows|program files( \(x86\))?|programdata|\$recycle\.bin|system volume information|recovery|perflogs)$/.test(top)) return true
    // C:\Users\other: only the person's own
    if (low[at] === 'users' && low.length > at + 1 && home) {
      const own = lib.normalize(home).toLowerCase().split(lib.sep).filter(Boolean)
      const ownAt = own[0] && /^[a-z]:$/.test(own[0]) ? 1 : 0
      if (low[at + 1] !== own[ownAt + 1] && !(own[ownAt] === 'users' && low[at + 1] === 'public')) return true
    }
    // the server's name is no folder name
    if (unc) from = 1
  }
  if (platform === 'darwin') {
    if (low[0] && /^(system|private|usr|bin|sbin|etc|var|tmp|cores|opt|applications|library|dev)$/.test(low[0])) return true
    if (low[0] === 'users' && low.length > 1 && home) {
      const own = posix.normalize(home).toLowerCase().split('/').filter(Boolean)
      if (low[1] !== own[1] && low[1] !== 'shared') return true
    }
    const i = parts.findIndex((x, j) => x.toLowerCase() === 'library' && /^(cloudstorage|mobile documents)$/i.test(parts[j + 1] ?? ''))
    if (i >= 0) from = i + 3
    if (i >= 0 && parts.length < from) return true
  }
  return parts.slice(from).some((part) => !(platform === 'win32' && /^[a-z]:$/i.test(part)) && neverListed(part.normalize('NFC')))
}

/** Where "Choose a folder…"'s pick goes (real paths): inside one of the three folders (`root`, its index, with the path
 * below it in parts; case and separators as the file system compares them), or a folder of its own with a name the page
 * can show and that never takes the name of a root folder (a drive's top: its letter; "D:\Archive\Documents":
 * "Documents (Archive)"). Never a whole path. */
export function pickTarget(picked: string, roots: readonly (string | null)[], platform: string): { root: number; parts: string[]; label: string } {
  const lib = platform === 'win32' ? win32 : posix
  const norm = lib.normalize(picked).replace(/[\\/]+$/, '') || lib.normalize(picked)
  const own = lib.basename(norm).normalize('NFC')
  const drive = norm.match(/^([a-z]):\\?$/i)?.[1]
  let label = drive ? drive.toUpperCase() : own || 'Folder'
  for (const [i, r] of roots.entries()) {
    if (!r) continue
    const rk = sameKey(lib.normalize(r).replace(/[\\/]+$/, ''), platform)
    const pk = sameKey(norm, platform)
    if (pk === rk || pk.startsWith(rk + sep(platform))) {
      // the path below the root as the pick spells it (the keys only fold case, so the lengths match)
      const parts = pk === rk ? [] : norm.slice(rk.length + 1).split(lib.sep).filter(Boolean)
      return { root: i, parts, label }
    }
  }
  if (/^(documents|desktop|downloads|home)$/i.test(label)) {
    const parent = lib.basename(lib.dirname(norm)).replace(/:$/, '') || 'Folder'
    label = `${label} (${parent.normalize('NFC')})`
  }
  return { root: -1, parts: [], label }
}

// ---------------------------------------------------------------- what the page may read afterwards

/** The file (or a folder on its way) is not there any more: deleted or moved away. */
const gone = (e: unknown) => { const c = (e as { code?: string } | null)?.code; return c === 'ENOENT' || c === 'ENOTDIR' }

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
  /** the files the page named at the person's Add (WorkFilesController.add): only these are read */
  added: Set<string>
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
    private readonly limits: Partial<Record<'readFiles' | 'readBytes' | 'sessionMs' | 'readMs' | 'cloudHintMs', number>> = {},
  ) {}

  private get lim() {
    return { readFiles: WORK_FILES_LIMITS.readFiles, readBytes: WORK_FILES_LIMITS.readBytes, sessionMs: WORK_FILES_LIMITS.sessionMs, ...this.limits }
  }

  /** A new look for this origin: it replaces the one before (its ids read nothing any more). */
  begin(origin: string, found: Map<string, Found>) {
    this.sessions.set(origin, { origin, at: this.now(), found, read: new Set(), bytes: 0, reads: 0, added: new Set() })
  }

  /** The files these ids name in this origin's latest look, before they are added: null when the look is gone or
   * expired, an id is not of it, an id is named twice, or they are over the read limits (files, bytes) all together. */
  toAdd(origin: string, ids: readonly string[]): { name: string; size: number }[] | null {
    const s = this.sessions.get(origin)
    if (!s || this.now() - s.at > this.lim.sessionMs || !ids.length || new Set(ids).size !== ids.length) return null
    const files = ids.map((id) => s.found.get(id))
    if (files.some((f) => !f)) return null
    // with what was added before in this look: the same limits the reads keep
    const all = new Set([...s.added, ...ids])
    const bytes = [...all].reduce((n, id) => n + (s.found.get(id)?.size ?? 0), 0)
    if (all.size > this.lim.readFiles || bytes > this.lim.readBytes) return null
    return files.map((f) => ({ name: f!.parts.at(-1) ?? '', size: f!.size }))
  }

  /** An id of this origin's latest look that was added. */
  isAdded(origin: string, id: string): boolean {
    return !!this.sessions.get(origin)?.added.has(id)
  }

  /** The page named these files at the person's Add (WorkFilesController.add): they (and nothing else of the look) may be
   * read now. */
  allow(origin: string, ids: readonly string[]): boolean {
    const s = this.sessions.get(origin)
    if (!s || this.now() - s.at > this.lim.sessionMs || ids.some((id) => !s.found.has(id))) return false
    for (const id of ids) s.added.add(id)
    return true
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

  /** The bytes of one file of this origin's latest look, by its id. Reads run one after the other. `onCloud`: the file's
   * content is in the cloud only and is being downloaded first (said once, when its read starts). */
  read(origin: string, id: string, onCloud?: (cloud: WorkCloudProvider) => void): Promise<WorkFileRead> {
    const next = this.queue.then(() => this.readNow(origin, id, onCloud))
    this.queue = next.catch(() => {})
    return next
  }

  private async readNow(origin: string, id: string, onCloud?: (cloud: WorkCloudProvider) => void): Promise<WorkFileRead> {
    const s = this.sessions.get(origin)
    if (!s) return { ok: false, reason: 'unknown' }
    if (this.now() - s.at > this.lim.sessionMs) {
      this.sessions.delete(origin)
      return { ok: false, reason: 'expired' }
    }
    const f = s.found.get(id)
    // a file the person did not add in the app's own window is not read, whatever the page asks (TC-3300)
    if (!f || !s.added.has(id)) return { ok: false, reason: 'unknown' }
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
    // a file on a drive that stops answering gives up after READ_MS, so the reads behind it are not held forever; one
    // that was coming from the cloud says so (the person can open it once to download it, then add it again)
    let cloud: WorkCloudProvider | null = null
    let late: ReturnType<typeof setTimeout> | undefined
    // the answer is given (a read that gave up goes on in the background): nothing more is said of it
    let over = false
    const fetching = (c: WorkCloudProvider) => {
      clearTimeout(late)
      if (cloud || over) return
      cloud = c
      try { onCloud?.(c) } catch { /* the page's listener: nothing of it stops the read */ }
    }
    const maybe = (c: WorkCloudProvider) => { if (!over) late = setTimeout(() => fetching(c), this.limits.cloudHintMs ?? CLOUD_HINT_MS) }
    const r = await within(this.readFile(f, fetching, maybe), this.limits.readMs ?? READ_MS)
      .catch((): WorkFileRead => (cloud ? { ok: false, reason: 'cloudTimeout', cloud } : { ok: false, reason: 'unreadable' }))
      .finally(() => { over = true; clearTimeout(late) })
    // a session that changed while this read (a new look, a sign-out) gives nothing
    if (this.sessions.get(origin) !== s) return { ok: false, reason: 'unknown' }
    if (!r.ok && !again) {
      s.read.delete(id)
      s.bytes -= f.size
    }
    return r
  }

  /** The file found again where the look found it, the same one, its bytes. `fetching`: its content is in the cloud only
   * and the read downloads it (a Mac's flag, or Windows' index at the look); `maybe`: it is in a cloud's folder, and a read
   * still going after a moment is taken for a download. */
  private async readFile(f: Found, fetching: (c: WorkCloudProvider) => void, maybe: (c: WorkCloudProvider) => void): Promise<WorkFileRead> {
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
    } catch (e) {
      // deleted, or moved away, since the look (the page says "No longer on this computer")
      return { ok: false, reason: gone(e) ? 'missing' : 'unreadable' }
    }
    // online only: the open or the read makes the provider download it, which can take a while
    const provider = cloudProviderOf(path, p)
    const cloudOnly = p === 'win32' ? !!f.late : await this.fs.cloudOnly?.(path).catch(() => false)
    if (cloudOnly) fetching(provider ?? (p === 'darwin' ? 'icloud' : 'cloud'))
    else if (provider) maybe(provider)
    let h: WorkHandle
    try {
      h = await this.fs.open(path)
    } catch (e) {
      // O_NOFOLLOW on a link that took the file's place: ELOOP; deleted between the check and the open: ENOENT
      const code = (e as { code?: string } | null)?.code
      return { ok: false, reason: code === 'ELOOP' ? 'changed' : gone(e) ? 'missing' : 'unreadable' }
    }
    try {
      // the file that was opened: the same one, the same size and date (a late one: the one lstat'ed just before)
      const opened = await h.stat()
      if (!sameFile(opened, f, p) || (f.late && (before.ino === 0n || opened.dev !== before.dev || opened.ino !== before.ino))) return { ok: false, reason: 'changed' }
      // a late one: the way to it is still the same after the open (no folder swapped for a junction meanwhile)
      if (f.late && sameKey(await this.fs.realpath(path), p) !== sameKey(path, p)) return { ok: false, reason: 'changed' }
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
