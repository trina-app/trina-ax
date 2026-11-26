// Find work files, part 5, in the app (common/work-places.ts has the rules and the parsers; this runs the commands and
// reads the recent lists). A Mac with Full Disk Access: the cloud drives' folders (~/Library/CloudStorage), the home
// folder's work folders and messengers' downloads, and the files opened lately anywhere in the home folder (Spotlight,
// the shared file lists, Office's list). Windows: the same places, and the index's rows plus the Recent folder and
// Office's list anywhere (other drives, shares). Every command has a time limit; a failure gives nothing, never an error.
// Nothing here opens a document, and the only files of the apps' data read are APP_DATA_ALLOWED's (appDataAllowed is
// checked before each read).
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open, readdir, readFile, stat } from 'node:fs/promises'
import { join, posix, win32 } from 'node:path'
import { considered, neverListed } from '@mycel/shared/file-scan'
import type { FullDiskState } from '@mycel/shared/desktop-bridge'
import { mdlsArgs, mergeIndexed, parseMdfind, parseMdls, macPath, powershellArgs, RECENT_DAYS, type IndexedFile } from '../common/work-index'
import { appDataAllowed, cloudStorageRoot, uniqueLabels, homeExcluded, macCloudPlaces, macDataless, messengerPlaces, parseLnk, parseOfficeBookmarks, parseSharedFileList, parseStatFlags, parseSyncRoots, windowsCloudPlaces, workFolders, type Place } from '../common/work-places'

const run = (cmd: string, args: string[], ms: number) =>
  new Promise<string>((done, fail) => execFile(cmd, args, { timeout: ms, maxBuffer: 64 << 20, windowsHide: true }, (e, out) => {
    const text = String(out ?? '')
    if (e && ((e as { killed?: boolean }).killed || !text)) fail(e)
    else done(text)
  }))

/** Up to `n` at a time. */
async function pool<T, R>(items: readonly T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await f(items[i]!) }
  }))
  return out
}

// ---------------------------------------------------------------- Full Disk Access (a Mac)

/** Whether the app has Full Disk Access: it opens (and closes at once, reading nothing) the system's privacy database,
 * which only an app with Full Disk Access may open. macOS raises no question for it. */
export async function fullDiskState(home: string): Promise<FullDiskState> {
  if (process.platform !== 'darwin') return 'unknown'
  for (const p of [join(home, 'Library', 'Application Support', 'com.apple.TCC', 'TCC.db'), '/Library/Application Support/com.apple.TCC/TCC.db']) {
    try {
      const h = await open(p, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      await h.close().catch(() => {})
      return 'granted'
    } catch (e) {
      const code = (e as { code?: string } | null)?.code
      if (code === 'EPERM' || code === 'EACCES') return 'denied'
    }
  }
  return 'unknown'
}

/** System Settings › Privacy & Security › Full Disk Access. */
export const MAC_FULL_DISK_SETTINGS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'

// ---------------------------------------------------------------- the places

const isDir = async (p: string) => { try { return (await lstat(p)).isDirectory() } catch { return false } }
/** A folder's folder names (not links), at most 500. */
async function folderNames(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.isSymbolicLink()).map((d) => d.name).slice(0, 500)
  } catch { return [] }
}

/** The folders OneDrive syncs (its own and each SharePoint library), from the registry; [] when there are none or
 * PowerShell does not answer in 4 s. */
async function windowsSyncRoots(): Promise<string[]> {
  const out = await run('powershell.exe', powershellArgs("Get-ChildItem 'HKCU:\\Software\\SyncEngines\\Providers\\OneDrive' -ErrorAction SilentlyContinue | ForEach-Object { (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).MountPoint }"), 4000).catch(() => '')
  return parseSyncRoots(out)
}

/** The places beyond the three folders, those that are there: messengers' downloads first (inside Downloads or
 * Documents, so their files get the messenger's name), then the home folder's work folders, then the cloud drives. */
export async function widePlaces(home: string, companyWords: readonly string[]): Promise<Place[]> {
  const p = process.platform
  const syncRootsP = p === 'win32' ? windowsSyncRoots() : Promise.resolve([])
  const top = await folderNames(home)
  const cloud = p === 'darwin'
    ? macCloudPlaces(home, await folderNames(join(home, 'Library', 'CloudStorage')))
    : p === 'win32' ? windowsCloudPlaces(home, process.env, top, await syncRootsP) : []
  const messengers = (await Promise.all(messengerPlaces(home, p).map(async (m) => ((await isDir(m.path)) ? m : null)))).filter((m): m is Place => !!m)
  // one row per messenger folder that is there (KakaoTalk may have two)
  const all = [...messengers, ...workFolders(home, top, companyWords, p), ...cloud]
  const seen = new Set<string>()
  return uniqueLabels(all.filter((x) => { const k = x.path.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true }))
}

// ---------------------------------------------------------------- a Mac: Spotlight for a place, the recent lists

const DOC_QUERY = (days: number) => `(kMDItemLastUsedDate >= $time.today(-${days}) || kMDItemFSContentChangeDate >= $time.today(-${days})) && kMDItemContentTypeTree == "public.item"`

/** What Spotlight knows of these paths (mdls, 200 a call, four at a time), within the deadline. */
async function mdlsOf(paths: readonly string[], deadline: number): Promise<IndexedFile[]> {
  const batches: string[][] = []
  for (let i = 0; i < paths.length; i += 200) batches.push(paths.slice(i, i + 200))
  const out: IndexedFile[] = []
  await pool(batches, 4, async (b) => {
    const left = deadline - Date.now()
    if (left < 200) return
    out.push(...(await run('/usr/bin/mdls', mdlsArgs(b), Math.min(8000, left)).then(parseMdls, () => [])))
  })
  return out
}

/** Online-only among these paths (stat's flags; SF_DATALESS), 200 a call. Fails when stat does not answer; a path stat
 * did not answer for (gone, or a name it printed differently) counts as online only (never entered, never touched). */
export async function macDatalessSet(paths: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>()
  for (let i = 0; i < paths.length; i += 200) {
    const batch = paths.slice(i, i + 200)
    const flags = parseStatFlags(await run('/usr/bin/stat', ['-f', '%Xf%t%N', '--', ...batch], 5000))
    for (const path of batch) { const f = flags.get(path); if (f === undefined || macDataless(f)) out.add(path) }
  }
  return out
}

/** Whether one file's content is in the cloud only (SF_DATALESS), so reading it downloads it first. false when stat does
 * not answer: the read goes on as for any file. */
export async function macCloudOnly(path: string): Promise<boolean> {
  const flags = parseStatFlags(await run('/usr/bin/stat', ['-f', '%Xf%t%N', '--', path], 3000)).get(path)
  return flags !== undefined && macDataless(flags)
}

/** Spotlight's recent documents in one place (a cloud drive's folder, a work folder): the paths, what it knows of the
 * newest 400, and for a cloud drive which are online only. null: Spotlight did not answer. */
export async function macPlaceIndex(place: { path: string; id: string }, deadline: number): Promise<IndexedFile[] | null> {
  let paths: string[]
  try {
    paths = parseMdfind(await run('/usr/bin/mdfind', ['-onlyin', place.path, '-0', DOC_QUERY(RECENT_DAYS)], Math.max(500, Math.min(5000, deadline - Date.now())))).map(macPath)
  } catch { return null }
  const root = place.path.endsWith('/') ? place.path : place.path + '/'
  paths = paths.filter((x) => x.startsWith(root) && considered(posix.basename(x).normalize('NFC'), []) && !x.slice(root.length).split('/').some((s) => !s || neverListed(s.normalize('NFC')))).slice(0, 2000)
  const known = await mdlsOf(paths.slice(0, 400), deadline)
  const byPath = new Map(known.map((k) => [k.path, k]))
  const files: IndexedFile[] = paths.map((x) => byPath.get(x) ?? { path: x, used: null, modified: null, useCount: null, size: null, origins: [], authors: [], org: null, queried: true })
  if (place.id === 'cloud' && files.length) {
    // a file Spotlight knows nothing of (no date) is not recent enough to tell: left out
    const dataless = await macDatalessSet(files.map((f) => f.path)).catch(() => null)
    // stat did not answer: none of it is listed (each may be in the cloud)
    if (!dataless) return []
    for (const f of files) if (dataless.has(f.path)) f.cloud = true
  }
  return files
}

/** The recent lists a Mac keeps (the shared file lists, Office's), as paths: only APP_DATA_ALLOWED's files. */
async function macRecentLists(home: string, deadline: number): Promise<IndexedFile[]> {
  const base = join(home, 'Library', 'Application Support', 'com.apple.sharedfilelist')
  const lists: string[] = []
  for (const dir of [base, join(base, 'com.apple.LSSharedFileList.ApplicationRecentDocuments')]) {
    try { for (const n of await readdir(dir)) if (/\.sfl[234]$/.test(n)) lists.push(join(dir, n)) } catch { /* none */ }
  }
  const office = ['Word', 'Excel', 'Powerpoint'].map((a) => join(home, 'Library', 'Containers', `com.microsoft.${a}`, 'Data', 'Library', 'Preferences', `com.microsoft.${a}.securebookmarks.plist`))
  const xml = (f: string) => {
    if (!appDataAllowed(home, f, 'darwin') || Date.now() > deadline) return Promise.resolve('')
    return run('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', '--', f], Math.max(200, Math.min(3000, deadline - Date.now()))).catch(() => '')
  }
  const out: IndexedFile[] = []
  const item = (path: string, used: number | null): IndexedFile => ({ path, used, modified: null, useCount: null, size: null, origins: [], authors: [], org: null, listed: true })
  await pool(lists.slice(0, 120), 8, async (f) => { for (const p of parseSharedFileList(await xml(f), 60)) out.push(item(p, null)) })
  await pool(office, 3, async (f) => { try { await stat(f) } catch { return } for (const r of parseOfficeBookmarks(await xml(f))) out.push(item(r.path, r.used)) })
  return out
}

/** The files opened lately anywhere in the home folder (a Mac): Spotlight's last-opened across home, the shared file
 * lists and Office's list; what Spotlight knows of them. Never one inside the apps' data (homeExcluded). */
export async function macRecent(home: string, deadline: number): Promise<IndexedFile[]> {
  const fromSpotlight = run('/usr/bin/mdfind', ['-onlyin', home, '-0', `kMDItemLastUsedDate >= $time.today(-${RECENT_DAYS})`], Math.max(500, Math.min(5000, deadline - Date.now())))
    .then((o) => parseMdfind(o).map(macPath), () => [] as string[])
  const [spot, lists] = await Promise.all([fromSpotlight, macRecentLists(home, deadline)])
  const homeSlash = home.endsWith('/') ? home : home + '/'
  const keep = (p: string) => {
    if (!p.startsWith(homeSlash)) return false
    const parts = p.slice(homeSlash.length).split('/')
    return !homeExcluded(parts, 'darwin') && considered(parts.at(-1)!.normalize('NFC'), [])
  }
  const all = mergeIndexed([spot.filter(keep).slice(0, 1500).map((path): IndexedFile => ({ path, used: null, modified: null, useCount: null, size: null, origins: [], authors: [], org: null, queried: true })), lists.filter((f) => keep(f.path))], 'darwin')
  const known = await mdlsOf(all.slice(0, 600).map((f) => f.path), deadline)
  // a file under a cloud drive's folder: online only or not (it is listed under its place, never opened)
  const inCloud = all.filter((f) => { const parts = f.path.slice(homeSlash.length).split('/'); return parts[0] === 'Library' && parts[1] === 'CloudStorage' && cloudStorageRoot(parts[2] ?? '') })
  if (inCloud.length) {
    const dl = await macDatalessSet(inCloud.map((f) => f.path)).catch(() => null)
    for (const f of inCloud) f.cloud = dl ? dl.has(f.path) : true
  }
  return mergeIndexed([all, known.map((k) => ({ ...k, listed: all.find((a) => a.path === k.path)?.listed }))], 'darwin')
}

// ---------------------------------------------------------------- Windows: the Recent folder's shortcuts

/** The Recent folder's shortcuts' targets (parsed here: MS-SHLLINK; Electron's reader as a second try), the shortcut's
 * time as last opened, the newest 300. Only APP_DATA_ALLOWED's files are read. */
export async function windowsRecentLinks(home: string, readShortcut?: (p: string) => string | null): Promise<IndexedFile[]> {
  const recent = join(process.env.APPDATA ?? win32.join(home, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Recent')
  const out: IndexedFile[] = []
  try {
    const names = (await readdir(recent)).filter((n) => n.toLowerCase().endsWith('.lnk'))
    const withTime = await Promise.all(names.map(async (n) => ({ n, t: await stat(join(recent, n)).then((s) => s.mtimeMs, () => 0) })))
    for (const { n, t } of withTime.sort((a, b) => b.t - a.t).slice(0, 300)) {
      const p = join(recent, n)
      if (!appDataAllowed(home, p, 'win32')) continue
      let target: string | null = null
      try {
        const b = await readFile(p)
        if (b.byteLength <= 64 * 1024) target = parseLnk(b)
      } catch { /* unreadable */ }
      if (!target && readShortcut) { try { target = readShortcut(p) } catch { target = null } }
      if (target && considered(win32.basename(target).normalize('NFC'), [])) out.push({ path: target, used: t || null, modified: null, useCount: null, size: null, origins: [], authors: [], org: null, listed: true })
    }
  } catch { /* no Recent folder */ }
  return out
}
