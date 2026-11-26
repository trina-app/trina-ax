// Find work files, part 5 (docs/DECISIONS.md "Find work files, part 5: wider places, Full Disk Access first"): the places
// beyond Documents, Desktop and Downloads, and the recent lists that point into them. Pure: the parsers take the bytes or
// the text a command printed, the place rules take names, so everything here is unit-tested in
// tests/unit/e-desktop-work-places.test.ts; desktop/src/main/work-places-run.ts runs the commands and reads the lists.
//
// What may be read (and only that): the folders of the places below (names, sizes and dates, never a file's content),
// and, as the only exceptions inside the apps' own data, the recent-document lists (APP_DATA_ALLOWED). Mail, Messages,
// Photos, Safari and any other app's data are never a place, and a recent list's entry that points there is dropped
// (homeExcluded). A file in the cloud (online only) is listed from its metadata and never opened by the look.
import { posix, win32 } from 'node:path'
import type { WorkCloudProvider } from '@mycel/shared/desktop-bridge'
import { neverListed } from '@mycel/shared/file-scan'

// ---------------------------------------------------------------- a place

/** A place's kind: a cloud drive's folder on this computer, a work folder in the home folder (named like the company or
 * like work), a messenger's downloads, a recently opened file anywhere in the home folder, another drive (Windows). */
export type PlaceKind = 'cloud' | 'folder' | 'messenger' | 'home' | 'drive'

export interface Place {
  kind: PlaceKind
  path: string
  /** how the list names it: "OneDrive – Acme", "Projects", "KakaoTalk", "D:" (never a whole path) */
  label: string
}

const fold = (s: string) => s.normalize('NFC').toLowerCase()

// ---------------------------------------------------------------- cloud drives

/** A cloud drive's folder name as macOS names it in ~/Library/CloudStorage (OneDrive-Acme, GoogleDrive-alex@acme.com,
 * Dropbox, Dropbox-Acme, Box-Box) or as Windows names it in the home folder (OneDrive - Acme, Dropbox (Acme), Box,
 * Google Drive) → its label, or null for anything else. A Google account's address shows its domain only. */
export function cloudLabel(name: string): string | null {
  const n = name.normalize('NFC').trim()
  let m = n.match(/^OneDrive(?:[- ]+(.+))?$/i)
  if (m) return m[1] && !/^personal$/i.test(m[1]) ? `OneDrive – ${m[1].trim()}` : 'OneDrive'
  m = n.match(/^Google ?Drive(?:[- ]+(.+))?$/i)
  if (m) {
    const domain = m[1]?.match(/@([^@\s]+)$/)?.[1]
    return domain && !/^(gmail|googlemail)\.com$/i.test(domain) ? `Google Drive – ${domain.toLowerCase()}` : 'Google Drive'
  }
  m = n.match(/^Dropbox(?:[- ]+\(?([^()]+?)\)?)?$/i)
  if (m) return m[1] && !/^(personal|dropbox)$/i.test(m[1]) ? `Dropbox – ${m[1].trim()}` : 'Dropbox'
  m = n.match(/^Box(?:[- ]+(.+))?$/i)
  if (m) return m[1] && !/^box$/i.test(m[1]) ? `Box – ${m[1].trim()}` : 'Box'
  return null
}

/** The cloud drives among ~/Library/CloudStorage's folders (a Mac). Only these providers: never iCloud's app data or
 * another provider's private store. */
export function macCloudPlaces(home: string, cloudStorageNames: readonly string[]): Place[] {
  return cloudStorageNames.flatMap((name) => {
    const label = /^(OneDrive|GoogleDrive|Dropbox|Box)(-|$)/i.test(name) ? cloudLabel(name) : null
    return label ? [{ kind: 'cloud' as const, path: posix.join(home, 'Library', 'CloudStorage', name), label }] : []
  })
}

/** Windows' cloud folders: OneDrive's own variables (OneDrive, OneDriveCommercial, OneDriveConsumer), SharePoint's synced
 * libraries (the folders the sync engine registered) and the home folder's Dropbox, Box and Google Drive folders. */
export function windowsCloudPlaces(home: string, env: Readonly<Record<string, string | undefined>>, homeNames: readonly string[], syncRoots: readonly string[] = []): Place[] {
  const out: Place[] = []
  const seen = new Set<string>()
  const add = (path: string, label: string | null) => {
    const k = win32.normalize(path).toLowerCase()
    if (!label || seen.has(k)) return
    seen.add(k)
    out.push({ kind: 'cloud', path: win32.normalize(path), label })
  }
  for (const v of ['OneDriveCommercial', 'OneDriveConsumer', 'OneDrive']) {
    const p = env[v]
    if (p && win32.isAbsolute(p)) add(p, cloudLabel(win32.basename(p)) ?? 'OneDrive')
  }
  // SharePoint libraries synced by OneDrive: C:\Users\alex\Acme\Acme - Documents ("Acme – Documents"); a folder
  // inside a place already listed (a shared folder added as a shortcut in OneDrive) is that place's
  const within = (p: string) => { const k = win32.normalize(p).toLowerCase(); return [...seen].some((x) => k.startsWith(x.replace(/\\$/, '') + '\\')) }
  for (const p of syncRoots) if (win32.isAbsolute(p) && !within(p)) add(p, cloudLabel(win32.basename(p)) ?? win32.basename(p).replace(/ - /, ' – '))
  for (const name of homeNames) {
    const label = cloudLabel(name)
    if (label && !/^OneDrive/i.test(label)) add(win32.join(home, name), label)
  }
  return out
}

/** The folders OneDrive syncs for this person (HKCU\Software\SyncEngines\Providers\OneDrive\*\MountPoint, one path a
 * line as PowerShell prints them): the personal or work OneDrive and each synced SharePoint library. Only absolute local
 * paths, at most 20. */
export function parseSyncRoots(out: string): string[] {
  const res: string[] = []
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim()
    const p = /^[A-Za-z]:\\$/.test(t) ? t : t.replace(/\\+$/, '')
    if (/^[A-Za-z]:\\/.test(p) && !res.some((x) => x.toLowerCase() === p.toLowerCase())) res.push(p)
  }
  return res.slice(0, 20)
}

/** Each place's name once: a second "Google Drive" becomes "Google Drive (2)", and none takes a name the list keeps for
 * the three folders or the home folder (their files land in folders of that name under From this computer). */
export function uniqueLabels(places: readonly Place[]): Place[] {
  const used = new Set(['documents', 'desktop', 'downloads', 'home', ''])
  return places.map((x) => {
    let label = x.label
    for (let n = 2; used.has(fold(label)); n++) label = `${x.label} (${n})`
    used.add(fold(label))
    return label === x.label ? x : { ...x, label }
  })
}

// ---------------------------------------------------------------- work folders in the home folder

/** Words people name a work folder with, in the app's six languages (folder names only, whole words). */
export const WORK_FOLDER_WORDS: readonly string[] = [
  // en
  'work', 'projects', 'project', 'clients', 'client', 'customers', 'company', 'office', 'business', 'jobs',
  // ko
  '회사', '업무', '프로젝트', '고객', '거래처', '고객사', '사업',
  // ja
  '仕事', '業務', 'プロジェクト', '会社', '顧客', '取引先',
  // zh
  '工作', '项目', '公司', '客户', '业务',
  // es
  'trabajo', 'proyectos', 'proyecto', 'clientes', 'empresa', 'oficina',
  // id
  'kerja', 'pekerjaan', 'proyek', 'kantor', 'klien', 'perusahaan',
]

const cjk = (s: string) => /[\u3040-\u9fff\uac00-\ud7a3]/.test(s)
const words = (s: string) => fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean)
/** `name` holds `word`: Latin words as whole words (several as consecutive words), Korean, Japanese, Chinese inside. */
function holds(name: string, word: string): boolean {
  const w = fold(word).trim()
  if (!w) return false
  if (cjk(w)) return fold(name).includes(w)
  const ws = words(w)
  const ns = words(name)
  return ws.length > 0 && ns.some((_, i) => ws.every((x, j) => ns[i + j] === x))
}

/** The folders at the top of the home folder that look like work: named with a work word, or with the company's or a
 * client's name (`companyNames`, at least 3 letters). Never a system folder, a hidden one, an app's data or a cloud drive
 * (that is its own place). At most `max`, in the order given. */
export function workFolders(home: string, topNames: readonly string[], companyNames: readonly string[], platform: string, max = 8): Place[] {
  const lib = platform === 'win32' ? win32 : posix
  const company = companyNames.map((n) => n.normalize('NFC').trim()).filter((n) => n.length >= 3 || (cjk(n) && n.length >= 2))
  const out: Place[] = []
  for (const name of topNames) {
    if (out.length >= max) break
    if (homeExcluded([name], platform) || HOME_TOP_FOLDERS.has(fold(name)) || cloudLabel(name)) continue
    if (WORK_FOLDER_WORDS.some((w) => holds(name, w)) || company.some((c) => holds(name, c))) out.push({ kind: 'folder', path: lib.join(home, name), label: name.normalize('NFC') })
  }
  return out
}

/** The home folder's own folders that are places already (the three) or never are (media). */
const HOME_TOP_FOLDERS = new Set(['documents', 'desktop', 'downloads', 'pictures', 'music', 'movies', 'videos', 'public', 'sites', 'applications', 'library', 'appdata', 'saved games', 'searches', 'contacts', 'favorites', 'links', '3d objects'])

// ---------------------------------------------------------------- messengers' downloads

/** Where messengers put the files people receive, by default, inside the home folder (only folders a person sees in
 * Finder or Explorer; never an app's own data). Data, not code: add a row for a new messenger. */
export const MESSENGER_FOLDERS: readonly { label: string; platform: 'darwin' | 'win32' | 'any'; path: readonly string[] }[] = [
  { label: 'KakaoTalk', platform: 'win32', path: ['Documents', '카카오톡 받은 파일'] },
  { label: 'KakaoTalk', platform: 'win32', path: ['Documents', 'KakaoTalk Downloads'] },
  { label: 'KakaoTalk', platform: 'darwin', path: ['Downloads', 'KakaoTalk'] },
  { label: 'KakaoTalk', platform: 'darwin', path: ['Documents', '카카오톡 받은 파일'] },
  { label: 'Telegram', platform: 'any', path: ['Downloads', 'Telegram Desktop'] },
  { label: 'WhatsApp', platform: 'any', path: ['Downloads', 'WhatsApp'] },
  { label: 'LINE', platform: 'win32', path: ['Documents', 'LINE'] },
  { label: 'Microsoft Teams', platform: 'any', path: ['Downloads', 'Microsoft Teams'] },
  { label: 'Slack', platform: 'any', path: ['Downloads', 'Slack'] },
  { label: 'Zalo', platform: 'win32', path: ['Documents', 'Zalo Received Files'] },
]

/** The messenger folders to try on this system (the caller keeps the ones that are there). */
export function messengerPlaces(home: string, platform: string): Place[] {
  const lib = platform === 'win32' ? win32 : posix
  return MESSENGER_FOLDERS.filter((m) => m.platform === 'any' || m.platform === platform).map((m) => ({ kind: 'messenger' as const, path: lib.join(home, ...m.path), label: m.label }))
}

// ---------------------------------------------------------------- what is never looked at

/** The apps' own data a look may read, and nothing else in it: the recent-document lists (a Mac: the shared file lists,
 * Office's recent files; Windows: the Recent folder's shortcuts). Relative to the home folder, '*' one name. */
export const APP_DATA_ALLOWED: readonly (readonly string[])[] = [
  ['Library', 'Application Support', 'com.apple.sharedfilelist', '*.sfl4'],
  ['Library', 'Application Support', 'com.apple.sharedfilelist', '*.sfl3'],
  ['Library', 'Application Support', 'com.apple.sharedfilelist', '*.sfl2'],
  ['Library', 'Application Support', 'com.apple.sharedfilelist', 'com.apple.LSSharedFileList.ApplicationRecentDocuments', '*.sfl4'],
  ['Library', 'Application Support', 'com.apple.sharedfilelist', 'com.apple.LSSharedFileList.ApplicationRecentDocuments', '*.sfl3'],
  ['Library', 'Application Support', 'com.apple.sharedfilelist', 'com.apple.LSSharedFileList.ApplicationRecentDocuments', '*.sfl2'],
  ['Library', 'Containers', 'com.microsoft.Word', 'Data', 'Library', 'Preferences', 'com.microsoft.Word.securebookmarks.plist'],
  ['Library', 'Containers', 'com.microsoft.Excel', 'Data', 'Library', 'Preferences', 'com.microsoft.Excel.securebookmarks.plist'],
  ['Library', 'Containers', 'com.microsoft.Powerpoint', 'Data', 'Library', 'Preferences', 'com.microsoft.Powerpoint.securebookmarks.plist'],
  ['AppData', 'Roaming', 'Microsoft', 'Windows', 'Recent', '*.lnk'],
]

/** May the look read this file of the apps' data (a recent list)? Exactly APP_DATA_ALLOWED: no folder above it, no
 * other name, no '..'. */
export function appDataAllowed(home: string, path: string, platform: string): boolean {
  const lib = platform === 'win32' ? win32 : posix
  const rel = lib.relative(lib.normalize(home), lib.normalize(path))
  if (!rel || rel.startsWith('..') || lib.isAbsolute(rel)) return false
  const parts = rel.split(lib.sep)
  const same = (a: string, b: string) => (platform === 'linux' ? a === b : fold(a) === fold(b))
  return APP_DATA_ALLOWED.some((rule) => rule.length === parts.length && rule.every((r, i) => {
    const p = parts[i]!
    if (r.startsWith('*.')) return p.length > r.length - 1 && fold(p).endsWith(fold(r.slice(1))) && !p.includes('/') && !p.includes('\\')
    return same(r, p)
  }))
}

/** Top folders of the home folder whose files are never listed: the apps' data (Library, AppData: Mail, Messages, Photos,
 * Safari, every other app's store), the trash, programs and media. Only a cloud drive's folder under
 * Library/CloudStorage is a place (cloudStorageRoot). */
const NEVER_TOP = new Set(['library', 'appdata', 'applications', '.trash', 'pictures', 'music', 'movies', 'videos', 'public', 'application data', 'local settings', 'ntuser.dat', 'saved games', 'onedrivetemp', '$recycle.bin'])

/** A path inside the home folder (its parts below home) that is never listed: an app's data (except a cloud drive's
 * folder in Library/CloudStorage, which is its own place), a hidden or system name, a package (Photos' library, an
 * app), the trash, media folders. A recent list's entry there is dropped. */
/** Windows: a part that is a short (8.3) name or ends in a dot or a space names another folder than it looks like
 * (APPDAT~1 is AppData, "AppData." is AppData): never trusted. */
const winOdd = (x: string) => /~\d/.test(x) || /[. ]$/.test(x)

export function homeExcluded(parts: readonly string[], platform: string): boolean {
  if (!parts.length) return true
  if (platform === 'win32' && parts.some(winOdd)) return true
  const top = fold(parts[0]!)
  if (top === 'library' && platform === 'darwin' && parts.length >= 3 && fold(parts[1]!) === 'cloudstorage' && cloudStorageRoot(parts[2]!)) {
    return parts.slice(3).some((x) => !x || neverListed(x.normalize('NFC')))
  }
  if (NEVER_TOP.has(top)) return true
  return parts.some((x) => !x || x === '..' || neverListed(x.normalize('NFC')))
}

/** A ~/Library/CloudStorage folder that is a cloud drive's (macCloudPlaces). */
export const cloudStorageRoot = (name: string) => /^(OneDrive|GoogleDrive|Dropbox|Box)(-|$)/i.test(name) && !!cloudLabel(name)

// ---------------------------------------------------------------- online-only files (placeholders)

/** macOS: a file or folder whose content is in the cloud only (st_flags SF_DATALESS). The look never reads it nor
 * enters such a folder (that would make the provider fetch it). */
export const SF_DATALESS = 0x40000000
export const macDataless = (flags: number) => (flags & SF_DATALESS) !== 0

/** Windows: a cloud file's attributes (FILE_ATTRIBUTE_*): its content comes from the cloud when read or opened, or it
 * is offline. The look never opens it. */
export const WIN_RECALL_ON_DATA_ACCESS = 0x00400000
export const WIN_RECALL_ON_OPEN = 0x00040000
export const WIN_OFFLINE = 0x00001000
export const winPlaceholder = (attrs: number) => (attrs & (WIN_RECALL_ON_DATA_ACCESS | WIN_RECALL_ON_OPEN | WIN_OFFLINE)) !== 0

/** Which cloud a file's content comes from, by where it is (null: no cloud's folder): iCloud Drive's folder on a Mac
 * (~/Library/Mobile Documents), a cloud drive's folder (a Mac's ~/Library/CloudStorage/OneDrive-Acme, Windows' OneDrive -
 * Acme, Google Drive, Dropbox, Box in the path). A Mac's Desktop and Documents kept in iCloud are not told by the path: an
 * online-only file there is iCloud's (the read says so). */
export function cloudProviderOf(path: string, platform: string): WorkCloudProvider | null {
  const parts = (platform === 'win32' ? win32.normalize(path).split('\\') : posix.normalize(path).split('/')).map((x) => x.normalize('NFC'))
  if (platform === 'darwin') {
    const lib = parts.findIndex((x, i) => x === 'Library' && i > 0)
    if (lib >= 0 && parts[lib + 1] === 'Mobile Documents') return 'icloud'
    const cs = lib >= 0 && parts[lib + 1] === 'CloudStorage' ? parts[lib + 2] : undefined
    return cs && cloudStorageRoot(cs) ? providerOfLabel(cloudLabel(cs)) : null
  }
  if (platform === 'win32') {
    for (const x of parts) {
      if (/^iCloud ?Drive$/i.test(x)) return 'icloud'
      const p = providerOfLabel(cloudLabel(x))
      if (p) return p
    }
    // Google Drive for desktop: a drive of its own, "My Drive" / "Shared drives" at its top
    if (parts.length > 2 && /^[a-z]:$/i.test(parts[0]!) && /^(my drive|shared drives)$/i.test(parts[1]!)) return 'googleDrive'
  }
  return null
}

const providerOfLabel = (label: string | null): WorkCloudProvider | null =>
  !label ? null : /^OneDrive/.test(label) ? 'onedrive' : /^Google Drive/.test(label) ? 'googleDrive' : /^Dropbox/.test(label) ? 'dropbox' : /^Box/.test(label) ? 'box' : null

/** `/usr/bin/stat -f '%Xf%t%N' <paths>`'s lines (the flags in hex, a tab, the path) → path → flags. */
export function parseStatFlags(out: string): Map<string, number> {
  const res = new Map<string, number>()
  for (const line of out.split('\n')) {
    const m = line.match(/^([0-9A-Fa-f]+)\t(.+)$/)
    if (m) res.set(m[2]!, parseInt(m[1]!, 16))
  }
  return res
}

// ---------------------------------------------------------------- the recent lists' formats

/** A macOS bookmark ("book" … as an alias file and the recent lists keep it) → the file's path, or null. The path's
 * parts are the TOC's 0x1004 entry (an array of UTF-8 strings), from the root of the volume it is on. */
export function parseBookmark(b: Uint8Array): string | null {
  if (b.byteLength < 64 || b[0] !== 0x62 || b[1] !== 0x6f || b[2] !== 0x6f || b[3] !== 0x6b) return null
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const u32 = (at: number) => (at >= 0 && at + 4 <= b.byteLength ? v.getUint32(at, true) : -1)
  const base = u32(12)
  if (base < 16 || base >= b.byteLength) return null
  const item = (off: number): { type: number; at: number; len: number } | null => {
    const at = base + off
    const len = u32(at)
    const type = u32(at + 4)
    if (len < 0 || type < 0 || at + 8 + len > b.byteLength) return null
    return { type, at: at + 8, len }
  }
  const text = new TextDecoder('utf-8', { fatal: false })
  let toc = u32(base)
  for (let guard = 0; toc > 0 && guard < 8; guard++) {
    const at = base + toc
    if (u32(at + 4) !== 0xfffffffe) return null
    const count = u32(at + 16)
    if (count < 0 || count > 512) return null
    for (let i = 0; i < count; i++) {
      const e = at + 20 + i * 12
      if (u32(e) !== 0x1004) continue
      const arr = item(u32(e + 4))
      if (!arr || arr.type !== 0x0601) return null
      const parts: string[] = []
      for (let j = 0; j < arr.len / 4; j++) {
        const s = item(u32(arr.at + j * 4))
        if (!s || s.type !== 0x0101) return null
        parts.push(text.decode(b.subarray(s.at, s.at + s.len)))
      }
      if (!parts.length || parts.some((p) => !p || p === '..' || p.includes('/') || p.includes('\0'))) return null
      return '/' + parts.join('/')
    }
    toc = u32(at + 12)
  }
  return null
}

/** The base64 blobs of a property list's XML (`plutil -convert xml1`). */
const dataBlobs = (xml: string) => [...xml.matchAll(/<data>([\s\S]*?)<\/data>/g)].map((m) => Buffer.from(m[1]!.replace(/\s+/g, ''), 'base64'))

/** A shared file list (.sfl2/.sfl3/.sfl4, NSKeyedArchiver; converted to XML by plutil) → its items' paths, as listed
 * (the most recent first), at most `max`. */
export function parseSharedFileList(xml: string, max = 100): string[] {
  const out: string[] = []
  for (const b of dataBlobs(xml)) {
    if (out.length >= max) break
    const p = parseBookmark(b)
    if (p && !out.includes(p)) out.push(p)
  }
  return out
}

/** Office for Mac's recent files (com.microsoft.<App>.securebookmarks.plist as XML: one entry per file, its key the
 * file's address, kLastUsedDateKey its last use) → paths and when they were last opened. */
export function parseOfficeBookmarks(xml: string): { path: string; used: number | null }[] {
  const out: { path: string; used: number | null }[] = []
  for (const m of xml.matchAll(/<key>(file:\/\/[^<]+)<\/key>\s*<dict>([\s\S]*?)<\/dict>/g)) {
    let path: string
    try {
      const u = new URL(m[1]!.replace(/&amp;/g, '&'))
      if (u.protocol !== 'file:' || (u.host && u.host !== 'localhost')) continue
      path = decodeURIComponent(u.pathname)
    } catch { continue }
    const d = m[2]!.match(/<key>kLastUsedDateKey<\/key>\s*<date>([^<]+)<\/date>/)
    const t = d ? Date.parse(d[1]!) : NaN
    out.push({ path: path.replace(/\/$/, ''), used: Number.isFinite(t) ? t : null })
  }
  return out
}

/** A Windows shortcut (.lnk, MS-SHLLINK) → its target's path, or null: LinkInfo's local base path (Unicode when there),
 * or a network share's name plus the common path suffix (\\nas\share\Plans\Q3.xlsx). */
export function parseLnk(b: Uint8Array): string | null {
  if (b.byteLength < 0x4c) return null
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  if (v.getUint32(0, true) !== 0x4c) return null
  const flags = v.getUint32(0x14, true)
  let at = 0x4c
  // HasLinkTargetIDList: an ID list first (its size, then the list)
  if (flags & 0x1) {
    if (at + 2 > b.byteLength) return null
    at += 2 + v.getUint16(at, true)
  }
  // HasLinkInfo
  if (!(flags & 0x2) || at + 28 > b.byteLength) return null
  const info = at
  const size = v.getUint32(info, true)
  const headerSize = v.getUint32(info + 4, true)
  const infoFlags = v.getUint32(info + 8, true)
  if (size < 28 || info + size > b.byteLength) return null
  const ansi = (off: number) => {
    if (!off || info + off >= info + size) return ''
    let end = info + off
    while (end < info + size && b[end] !== 0) end++
    return new TextDecoder('latin1').decode(b.subarray(info + off, end))
  }
  const wide = (off: number) => {
    if (!off || info + off >= info + size) return ''
    let end = info + off
    while (end + 1 < info + size && (b[end] !== 0 || b[end + 1] !== 0)) end += 2
    return new TextDecoder('utf-16le').decode(b.subarray(info + off, end))
  }
  const suffixU = headerSize >= 0x24 ? wide(v.getUint32(info + 0x20, true)) : ''
  const suffix = suffixU || ansi(v.getUint32(info + 0x18, true))
  // VolumeIDAndLocalBasePath
  if (infoFlags & 0x1) {
    const local = (headerSize >= 0x24 ? wide(v.getUint32(info + 0x1c, true)) : '') || ansi(v.getUint32(info + 0x10, true))
    if (local) return win32.join(local, suffix)
  }
  // CommonNetworkRelativeLinkAndPathSuffix
  if (infoFlags & 0x2) {
    const net = info + v.getUint32(info + 0x14, true)
    if (net + 20 > info + size) return null
    const nameOff = v.getUint32(net + 8, true)
    let end = net + nameOff
    while (end < info + size && b[end] !== 0) end++
    const share = new TextDecoder('latin1').decode(b.subarray(net + nameOff, end))
    if (share.startsWith('\\\\')) return suffix ? `${share.replace(/\\$/, '')}\\${suffix}` : share
  }
  return null
}

// ---------------------------------------------------------------- recent files → places

/** Where a recent file is: the first place that holds it (the longest path first), else the home folder (a Mac: only
 * inside home; Windows: a fixed drive or a share is its own 'drive' place), or null when it is never listed. */
export function placeOf(path: string, places: readonly Place[], home: string, platform: string): { place: Place; parts: string[] } | null {
  const lib = platform === 'win32' ? win32 : posix
  const key = (p: string) => (platform === 'linux' ? lib.normalize(p) : fold(lib.normalize(p)))
  const k = key(path)
  const inside = (root: string) => {
    const r = key(root)
    return k.startsWith(r.endsWith(lib.sep) ? r : r + lib.sep)
  }
  const sorted = [...places].sort((a, b) => b.path.length - a.path.length)
  for (const p of sorted) {
    if (!inside(p.path)) continue
    const parts = lib.relative(lib.normalize(p.path), lib.normalize(path)).split(lib.sep)
    if (parts.some((x) => !x || x === '..' || (platform === 'win32' && winOdd(x)) || neverListed(x.normalize('NFC')))) return null
    return { place: p, parts }
  }
  if (inside(home)) {
    const parts = lib.relative(lib.normalize(home), lib.normalize(path)).split(lib.sep)
    if (homeExcluded(parts, platform)) return null
    return { place: { kind: 'home', path: home, label: '' }, parts }
  }
  if (platform !== 'win32') return null
  // Windows: another drive (D:\Clients\…) or a share (\\nas\team\…): the drive or the share is the place
  const root = win32.parse(win32.normalize(path)).root
  if (!root) return null
  const parts = win32.relative(root, win32.normalize(path)).split('\\')
  if (parts.some((x) => !x || x === '..' || winOdd(x) || neverListed(x.normalize('NFC'))) || NEVER_TOP.has(fold(parts[0] ?? ''))) return null
  // the system's own folders at a drive's top (Windows, Windows.old, the programs, other people's folders, recovery)
  if (/^(windows|windows\.old|program files|program files \(x86\)|programdata|users|documents and settings|recovery|perflogs|msocache|\$windows\.~bt|\$windows\.~ws|intel|amd|nvidia)$/i.test(parts[0] ?? '')) return null
  return { place: { kind: 'drive', path: root, label: root.replace(/\\$/, '') }, parts }
}
