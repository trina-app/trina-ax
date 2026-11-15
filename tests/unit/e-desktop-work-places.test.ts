// Find work files, part 5 (docs/DECISIONS.md "Find work files, part 5: wider places, Full Disk Access first"): the recent
// lists' formats (a Mac's bookmarks and shared file lists, Office for Mac's list, Windows shortcuts), online-only files
// (SF_DATALESS, Windows' recall attributes), the places (cloud drives, work folders, messengers' downloads), what is never
// looked at (Mail, Messages, Photos, Safari, other apps' data; only the recent lists may be read), and the wide look.
// Made-up bytes, text and file systems only: nothing of this computer is read.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  APP_DATA_ALLOWED, appDataAllowed, cloudLabel, homeExcluded, macCloudPlaces, macDataless, messengerPlaces, parseBookmark, parseLnk, parseOfficeBookmarks,
  parseSharedFileList, parseStatFlags, placeOf, windowsCloudPlaces, winPlaceholder, workFolders, WORK_FOLDER_WORDS,
} from '../../desktop/src/common/work-places'
import { parseWindowsSearch, windowsSearchScript, type IndexedFile } from '../../desktop/src/common/work-index'
import { filesFromIndex, lookWide, scanAsk, scanRoots, WorkFileSessions, type WorkFs, type WorkRoot, type WorkStat } from '../../desktop/src/common/work-files'

const NOW = Date.UTC(2026, 10, 15, 12)
const DAY = 86_400_000
const HOME = '/Users/alex'

// ---------------------------------------------------------------- made-up formats

/** A macOS bookmark as Apple lays it out (64-byte header, items, a TOC whose 0x1004 entry lists the path's parts). */
function bookmark(parts: string[]): Uint8Array {
  const items: number[] = []
  const body: number[] = [0, 0, 0, 0] // the first TOC's offset, filled in below
  const u32 = (a: number[], v: number) => a.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff)
  const offs: number[] = []
  for (const p of parts) {
    offs.push(body.length)
    const b = [...new TextEncoder().encode(p)]
    u32(body, b.length); u32(body, 0x0101); body.push(...b)
    while (body.length % 4) body.push(0)
  }
  const arr = body.length
  u32(body, offs.length * 4); u32(body, 0x0601); for (const o of offs) u32(body, o)
  const toc = body.length
  u32(body, 0); u32(body, 0xfffffffe); u32(body, 1); u32(body, 0); u32(body, 1)
  u32(body, 0x1004); u32(body, arr); u32(body, 0)
  body[0] = toc & 0xff; body[1] = (toc >> 8) & 0xff
  const head: number[] = [0x62, 0x6f, 0x6f, 0x6b]
  u32(head, 64 + body.length); u32(head, 0x10050000); u32(head, 64)
  while (head.length < 64) head.push(0)
  void items
  return new Uint8Array([...head, ...body])
}

/** A Windows shortcut (MS-SHLLINK) with a LinkInfo: a local path (ANSI, or Unicode too), or a share. */
function lnk(o: { local?: string; unicode?: boolean; share?: string; suffix?: string; idList?: boolean }): Uint8Array {
  const out: number[] = []
  const u16 = (v: number) => out.push(v & 0xff, (v >> 8) & 0xff)
  const u32 = (a: number[], v: number) => a.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff)
  const head = new Array(0x4c).fill(0)
  head[0] = 0x4c
  const flags = 0x2 | (o.idList ? 0x1 : 0)
  head[0x14] = flags
  out.push(...head)
  if (o.idList) { u16(6); out.push(4, 0, 0xaa, 0xbb, 0, 0) }
  const hs = o.unicode ? 0x24 : 0x1c
  const strs: number[] = []
  const at = (b: number[]) => { const off = hs + strs.length; strs.push(...b); return off }
  const ansi = (s: string) => [...new TextEncoder().encode(s), 0]
  const wide = (s: string) => [...Buffer.from(s, 'utf16le'), 0, 0]
  const volume = o.local ? at([16, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 16, 0, 0, 0, 0]) : 0
  const localA = o.local ? at(ansi(o.unicode ? '?' : o.local)) : 0
  let net = 0
  if (o.share) {
    const n: number[] = []
    u32(n, 20 + o.share.length + 1); u32(n, 0); u32(n, 20); u32(n, 0); u32(n, 0); n.push(...ansi(o.share))
    net = at(n)
  }
  const suffixA = at(ansi(o.suffix ?? ''))
  const localW = o.local && o.unicode ? at(wide(o.local)) : 0
  const suffixW = o.unicode ? at(wide(o.suffix ?? '')) : 0
  const info: number[] = []
  u32(info, hs + strs.length); u32(info, hs); u32(info, (o.local ? 1 : 0) | (o.share ? 2 : 0)); u32(info, volume); u32(info, localA); u32(info, net); u32(info, suffixA)
  if (o.unicode) { u32(info, localW); u32(info, suffixW) }
  out.push(...info, ...strs)
  return new Uint8Array(out)
}

describe('the recent lists', () => {
  test('a bookmark gives the file\'s path; a broken one gives nothing', () => {
    expect(parseBookmark(bookmark(['Users', 'alex', 'Clients', 'Acme 견적 Q3.docx']))).toBe('/Users/alex/Clients/Acme 견적 Q3.docx')
    expect(parseBookmark(new Uint8Array(10))).toBeNull()
    const bad = bookmark(['Users', 'alex', 'x.pdf'])
    bad[64] = 0xff; bad[65] = 0xff // the TOC's offset out of range
    expect(parseBookmark(bad)).toBeNull()
    // a part that would climb out ('..') or hold a slash is no path
    expect(parseBookmark(bookmark(['Users', '..', 'x.pdf']))).toBeNull()
    expect(parseBookmark(bookmark(['Users', 'a/b', 'x.pdf']))).toBeNull()
  })

  test('a shared file list (sfl4 as XML): its bookmarks in order, other blobs skipped, at most `max`', () => {
    const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64')
    const xml = `<plist><dict><key>$objects</key><array><string>$null</string>
      <data>${b64(new Uint8Array([0xfa, 0xde, 0x0c, 0x00, 1, 2, 3, 4]))}</data>
      <data>\n${b64(bookmark(['Users', 'alex', 'Projects', 'Plan.pptx'])).replace(/(.{40})/g, '$1\n\t')}\n</data>
      <data>${b64(bookmark(['Users', 'alex', 'Downloads', 'Quote.pdf']))}</data>
      <data>${b64(bookmark(['Users', 'alex', 'Projects', 'Plan.pptx']))}</data></array></dict></plist>`
    expect(parseSharedFileList(xml)).toEqual(['/Users/alex/Projects/Plan.pptx', '/Users/alex/Downloads/Quote.pdf'])
    expect(parseSharedFileList(xml, 1)).toEqual(['/Users/alex/Projects/Plan.pptx'])
  })

  test('Office for Mac\'s recent files (securebookmarks.plist as XML): the path and when it was last opened', () => {
    const xml = `<plist><dict>
      <key>file:///Users/alex/Documents/Acme%20Budget%202026.xlsx</key><dict><key>kBookmarkDataKey</key><data>AAAA</data><key>kLastUsedDateKey</key><date>2026-11-12T08:30:00Z</date><key>kUUIDKey</key><string>X</string></dict>
      <key>file:///Users/alex/Library/CloudStorage/OneDrive-Acme/Plan.docx</key><dict><key>kBookmarkDataKey</key><data>AAAA</data></dict>
      <key>https://acme.sharepoint.com/x.docx</key><dict><key>kLastUsedDateKey</key><date>2026-11-12T08:30:00Z</date></dict>
      <key>file://server/share/x.docx</key><dict></dict>
    </dict></plist>`
    expect(parseOfficeBookmarks(xml)).toEqual([
      { path: '/Users/alex/Documents/Acme Budget 2026.xlsx', used: Date.UTC(2026, 10, 12, 8, 30) },
      { path: '/Users/alex/Library/CloudStorage/OneDrive-Acme/Plan.docx', used: null },
    ])
  })

  test('a Windows shortcut gives its target: a local path (ANSI or Unicode), a share; an ID list before it is skipped', () => {
    expect(parseLnk(lnk({ local: 'C:\\Users\\alex\\Documents\\Plan.docx' }))).toBe('C:\\Users\\alex\\Documents\\Plan.docx')
    expect(parseLnk(lnk({ local: 'D:\\고객\\견적.xlsx', unicode: true, idList: true }))).toBe('D:\\고객\\견적.xlsx')
    expect(parseLnk(lnk({ share: '\\\\nas\\team', suffix: 'Plans\\Q3.xlsx' }))).toBe('\\\\nas\\team\\Plans\\Q3.xlsx')
    expect(parseLnk(new Uint8Array(20))).toBeNull()
    const noInfo = lnk({ local: 'C:\\a.pdf' })
    noInfo[0x14] = 0 // no LinkInfo
    expect(parseLnk(noInfo)).toBeNull()
  })

  test('Office\'s registry list and Windows Search keep their format; the index row\'s attributes mark an online-only file', () => {
    const rows = parseWindowsSearch(JSON.stringify([
      { p: 'C:\\Users\\alex\\OneDrive - Acme\\Plan.docx', m: '/Date(1762992000000)/', s: 4000, fa: 0x00400000 | 0x20 },
      { p: 'C:\\Users\\alex\\OneDrive - Acme\\Here.docx', m: '/Date(1762992000000)/', s: 4000, fa: 0x20 },
    ]))
    expect(rows.map((r) => !!r.cloud)).toEqual([true, false])
    // part 5: the attributes are asked for, and the other fixed drives join the scope (never a network one)
    const s = windowsSearchScript(['C:\\Users\\alex'], 180, NOW, { drives: true })
    expect(s).toContain('System.FileAttributes FROM SystemIndex')
    expect(s).toContain("$_.DriveType -eq 'Fixed'")
    expect(s).not.toContain('Network')
  })
})

describe('online-only files', () => {
  test('a Mac\'s SF_DATALESS and Windows\' recall attributes', () => {
    expect(macDataless(0x40000000)).toBe(true)
    expect(macDataless(0x40000020)).toBe(true)
    expect(macDataless(0x20)).toBe(false)
    expect(winPlaceholder(0x00400000)).toBe(true) // RECALL_ON_DATA_ACCESS
    expect(winPlaceholder(0x00040000)).toBe(true) // RECALL_ON_OPEN
    expect(winPlaceholder(0x00001000)).toBe(true) // OFFLINE
    expect(winPlaceholder(0x20 | 0x400)).toBe(false) // archive + reparse point (a pinned file)
    expect(parseStatFlags('40000000\t/Users/alex/Library/CloudStorage/OneDrive-Acme/a b.pdf\n0\t/x.pdf\nnoise\n')).toEqual(new Map([['/Users/alex/Library/CloudStorage/OneDrive-Acme/a b.pdf', 0x40000000], ['/x.pdf', 0]]))
  })
})

describe('the places', () => {
  test('cloud drives by their folder names; a Google account shows its domain only; no other provider', () => {
    expect(cloudLabel('OneDrive-Acme')).toBe('OneDrive – Acme')
    expect(cloudLabel('OneDrive - Acme Corp')).toBe('OneDrive – Acme Corp')
    expect(cloudLabel('OneDrive-Personal')).toBe('OneDrive')
    expect(cloudLabel('GoogleDrive-alex@acme.com')).toBe('Google Drive – acme.com')
    expect(cloudLabel('GoogleDrive-alex@gmail.com')).toBe('Google Drive')
    expect(cloudLabel('Dropbox (Acme)')).toBe('Dropbox – Acme')
    expect(cloudLabel('Box-Box')).toBe('Box')
    expect(cloudLabel('iCloud Drive')).toBeNull()
    expect(macCloudPlaces(HOME, ['OneDrive-Acme', 'GoogleDrive-alex@acme.com', 'Dropbox', 'Box-Box', 'iCloudDrive', 'com.apple.CloudDocs', 'SomeOther-Provider']).map((p) => [p.path, p.label])).toEqual([
      ['/Users/alex/Library/CloudStorage/OneDrive-Acme', 'OneDrive – Acme'],
      ['/Users/alex/Library/CloudStorage/GoogleDrive-alex@acme.com', 'Google Drive – acme.com'],
      ['/Users/alex/Library/CloudStorage/Dropbox', 'Dropbox'],
      ['/Users/alex/Library/CloudStorage/Box-Box', 'Box'],
    ])
    const win = windowsCloudPlaces('C:\\Users\\alex', { OneDriveCommercial: 'C:\\Users\\alex\\OneDrive - Acme', OneDrive: 'C:\\Users\\alex\\OneDrive - Acme' }, ['Dropbox', 'Google Drive', 'Documents', 'OneDrive - Acme'])
    expect(win.map((p) => p.label)).toEqual(['OneDrive – Acme', 'Dropbox', 'Google Drive'])
  })

  test('work folders at the top of home: work words in six languages and the company\'s names, never a system or cloud folder', () => {
    const top = ['Documents', 'Work', 'Projects 2026', 'Acme Corp', '회사 자료', '仕事', 'Trabajo', 'Pekerjaan', 'Photos', 'Library', '.secret', 'OneDrive - Acme', 'Workout plans', 'Music']
    expect(workFolders(HOME, top, ['Acme Corp', 'x'], 'darwin').map((p) => p.label)).toEqual(['Work', 'Projects 2026', 'Acme Corp', '회사 자료', '仕事', 'Trabajo', 'Pekerjaan'])
    // "Workout" is not "work": whole words only
    expect(workFolders(HOME, ['Workout plans'], [], 'darwin')).toEqual([])
    expect(workFolders(HOME, top, [], 'darwin', 2)).toHaveLength(2)
    for (const w of ['work', '회사', '仕事', '工作', 'trabajo', 'kerja']) expect(WORK_FOLDER_WORDS).toContain(w)
  })

  test('messengers\' downloads: data per system, inside the home folder\'s own folders only', () => {
    const mac = messengerPlaces(HOME, 'darwin').map((p) => `${p.label}:${p.path}`)
    expect(mac).toContain('KakaoTalk:/Users/alex/Downloads/KakaoTalk')
    expect(mac).toContain('Telegram:/Users/alex/Downloads/Telegram Desktop')
    const win = messengerPlaces('C:\\Users\\alex', 'win32').map((p) => `${p.label}:${p.path}`)
    expect(win).toContain('KakaoTalk:C:\\Users\\alex\\Documents\\카카오톡 받은 파일')
    // never an app's own data (Library, AppData, a container)
    for (const p of [...messengerPlaces(HOME, 'darwin'), ...messengerPlaces('C:\\Users\\alex', 'win32')]) expect(p.path).not.toMatch(/Library|AppData|Containers/i)
  })
})

describe('what is never looked at', () => {
  test('Mail, Messages, Photos, Safari and every other app\'s data are never listed; a cloud drive\'s folder is', () => {
    const never = [
      ['Library', 'Mail', 'V10', 'x.emlx'],
      ['Library', 'Messages', 'Attachments', 'a', 'Quote.pdf'],
      ['Library', 'Containers', 'com.apple.mail', 'Data', 'Library', 'Mail Downloads', 'Quote.pdf'],
      ['Library', 'Safari', 'Downloads.plist'],
      ['Pictures', 'Photos Library.photoslibrary', 'originals', 'scan.pdf'],
      ['Pictures', 'scan.pdf'],
      ['Library', 'Group Containers', 'group.com.apple.notes', 'x.pdf'],
      ['Library', 'Mobile Documents', 'com~apple~CloudDocs', 'x.pdf'],
      ['Library', 'CloudStorage', 'SomeOther-Provider', 'x.pdf'],
      ['Library', 'CloudStorage', 'OneDrive-Acme', '.hidden', 'x.pdf'],
      ['.Trash', 'x.pdf'],
      ['Applications', 'X.app', 'Contents', 'x.pdf'],
      ['AppData', 'Roaming', 'Slack', 'x.pdf'],
      ['Documents', '.git', 'x.md'],
    ]
    for (const parts of never) expect(homeExcluded(parts, parts[0] === 'AppData' ? 'win32' : 'darwin'), parts.join('/')).toBe(true)
    for (const parts of [['Documents', 'Plan.docx'], ['Clients', 'Acme', 'Quote.pdf'], ['Library', 'CloudStorage', 'OneDrive-Acme', 'Plans', 'Q3.xlsx']]) expect(homeExcluded(parts, 'darwin'), parts.join('/')).toBe(false)
  })

  test('of the apps\' data, only the recent lists may be read: exactly APP_DATA_ALLOWED', () => {
    const ok = [
      '/Users/alex/Library/Application Support/com.apple.sharedfilelist/com.apple.LSSharedFileList.ApplicationRecentDocuments/com.microsoft.word.sfl4',
      '/Users/alex/Library/Application Support/com.apple.sharedfilelist/com.apple.LSSharedFileList.RecentDocuments.sfl3',
      '/Users/alex/Library/Containers/com.microsoft.Word/Data/Library/Preferences/com.microsoft.Word.securebookmarks.plist',
    ]
    for (const p of ok) expect(appDataAllowed(HOME, p, 'darwin'), p).toBe(true)
    const no = [
      '/Users/alex/Library/Mail/V10/x.emlx',
      '/Users/alex/Library/Messages/chat.db',
      '/Users/alex/Library/Safari/History.db',
      '/Users/alex/Library/Application Support/com.apple.TCC/TCC.db',
      '/Users/alex/Library/Application Support/com.apple.sharedfilelist/../../Mail/x.sfl4',
      '/Users/alex/Library/Application Support/com.apple.sharedfilelist/sub/x.sfl4',
      '/Users/alex/Library/Containers/com.microsoft.Word/Data/Library/Preferences/com.microsoft.Word.plist',
      '/Users/alex/Library/Containers/com.apple.mail/Data/Library/Preferences/com.microsoft.Word.securebookmarks.plist',
      '/Users/bo/Library/Application Support/com.apple.sharedfilelist/x.sfl4',
    ]
    for (const p of no) expect(appDataAllowed(HOME, p, 'darwin'), p).toBe(false)
    expect(appDataAllowed('C:\\Users\\alex', 'C:\\Users\\alex\\AppData\\Roaming\\Microsoft\\Windows\\Recent\\Plan.docx.lnk', 'win32')).toBe(true)
    expect(appDataAllowed('C:\\Users\\alex', 'C:\\Users\\alex\\AppData\\Roaming\\Microsoft\\Windows\\Recent\\AutomaticDestinations\\x.automaticDestinations-ms', 'win32')).toBe(false)
    // the list pins every allowed kind: a new one needs a decision (docs/DECISIONS.md part 5)
    expect(APP_DATA_ALLOWED.map((r) => r.at(-1))).toEqual(['*.sfl4', '*.sfl3', '*.sfl2', '*.sfl4', '*.sfl3', '*.sfl2', 'com.microsoft.Word.securebookmarks.plist', 'com.microsoft.Excel.securebookmarks.plist', 'com.microsoft.Powerpoint.securebookmarks.plist', '*.lnk'])
  })

  test('the app reads the apps\' data only through appDataAllowed, and probes Full Disk Access without reading', () => {
    const src = readFileSync(join(import.meta.dir, '../../desktop/src/main/work-places-run.ts'), 'utf8')
    // the two readers of the apps' data check the rule first
    expect(src).toMatch(/const xml = \(f: string\) => \{\s*if \(!appDataAllowed\(home, f, 'darwin'\)/)
    expect(src).toMatch(/if \(!appDataAllowed\(home, p, 'win32'\)\) continue\s*let target/)
    // readFile only for the shortcuts; plutil only through xml()
    expect(src.match(/readFile\(/g)).toHaveLength(1)
    expect(src.match(/'\/usr\/bin\/plutil'/g)).toHaveLength(1)
    // the probe opens and closes: no read call on its handle
    const probe = src.slice(src.indexOf('export async function fullDiskState'), src.indexOf('export const MAC_FULL_DISK_SETTINGS'))
    expect(probe).toContain('await h.close()')
    expect(probe).not.toMatch(/\.read\(|readFile/)
  })

  test('a recent file\'s place: inside a place, else home (never the apps\' data), else (Windows) its drive or share', () => {
    const places = [{ kind: 'cloud' as const, path: '/Users/alex/Library/CloudStorage/OneDrive-Acme', label: 'OneDrive – Acme' }, { kind: 'folder' as const, path: '/Users/alex/Clients', label: 'Clients' }]
    expect(placeOf('/Users/alex/Library/CloudStorage/OneDrive-Acme/Plans/Q3.xlsx', places, HOME, 'darwin')).toMatchObject({ place: { label: 'OneDrive – Acme' }, parts: ['Plans', 'Q3.xlsx'] })
    expect(placeOf('/Users/alex/Notes/Plan.docx', places, HOME, 'darwin')).toMatchObject({ place: { kind: 'home' }, parts: ['Notes', 'Plan.docx'] })
    expect(placeOf('/Users/alex/Library/Mail/x.pdf', places, HOME, 'darwin')).toBeNull()
    expect(placeOf('/Volumes/NAS/x.pdf', places, HOME, 'darwin')).toBeNull()
    expect(placeOf('D:\\Clients\\Acme\\Q3.xlsx', [], 'C:\\Users\\alex', 'win32')).toMatchObject({ place: { kind: 'drive', label: 'D:' }, parts: ['Clients', 'Acme', 'Q3.xlsx'] })
    expect(placeOf('\\\\nas\\team\\Plans\\Q3.xlsx', [], 'C:\\Users\\alex', 'win32')).toMatchObject({ place: { kind: 'drive' }, parts: ['Plans', 'Q3.xlsx'] })
    expect(placeOf('C:\\Windows\\Temp\\x.pdf', [], 'C:\\Users\\alex', 'win32')).toBeNull()
    expect(placeOf('C:\\Users\\bo\\Documents\\x.pdf', [], 'C:\\Users\\alex', 'win32')).toBeNull()
    expect(placeOf('C:\\Users\\alex\\AppData\\Local\\Temp\\x.pdf', [], 'C:\\Users\\alex', 'win32')).toBeNull()
  })

  test('what a page may ask: a flag and short names, never a path', () => {
    expect(scanAsk({ wide: true, words: ['Acme', 'Globex Corp', '../etc', '/Users', 'a', 'x'.repeat(61), 42, '견적처', 'Acme'] })).toEqual({ wide: true, words: ['Acme', 'Globex Corp', '견적처'] })
    expect(scanAsk({ wide: 'yes' })).toEqual({ wide: false, words: [] })
    expect(scanAsk(null)).toEqual({ wide: false, words: [] })
    expect(scanAsk({ words: Array.from({ length: 40 }, (_, i) => `Client ${i}`) }).words).toHaveLength(20)
  })
})

// ---------------------------------------------------------------- a made-up file system

type Node = { dir: Record<string, Node> } | { size: number; mtimeMs: number; ino: bigint } | { link: string }
let ino = 5000n
const file = (size = 5000, mtimeMs = NOW - 5 * DAY): Node => ({ size, mtimeMs, ino: ino++ })
const dir = (c: Record<string, Node> = {}): Node => ({ dir: c })
function fakeFs(tree: Record<string, Node>, o: { win?: boolean; slow?: string[] } = {}) {
  const root: Node = dir(tree)
  const calls: string[] = []
  const split = (p: string) => p.split(o.win ? /[\\/]/ : /\//).filter(Boolean)
  const at = (p: string): Node | null => {
    let cur: Node = root
    for (const part of split(p)) {
      if (!('dir' in cur)) return null
      const next: Node | undefined = cur.dir[part]
      if (!next) return null
      cur = next
    }
    return cur
  }
  const err = (code: string) => Object.assign(new Error(code), { code })
  const hang = (p: string) => (o.slow ?? []).some((s) => p.startsWith(s))
  const never = <T,>() => new Promise<T>(() => {})
  const fs: WorkFs = {
    async readdir(p, max) {
      calls.push(`readdir ${p}`)
      const n = at(p)
      if (!n || !('dir' in n)) throw err('ENOENT')
      return Object.entries(n.dir).slice(0, max).map(([name, c]) => ({ name, kind: 'dir' in c ? 'dir' : 'link' in c ? 'link' : 'file' }))
    },
    async lstat(p) {
      calls.push(`lstat ${p}`)
      if (hang(p)) return never()
      const n = at(p)
      if (!n) throw err('ENOENT')
      const st: WorkStat = 'size' in n ? { kind: 'file', size: n.size, mtimeMs: n.mtimeMs, dev: 1n, ino: n.ino } : { kind: 'dir' in n ? 'dir' : 'link', size: 0, mtimeMs: 0, dev: 1n, ino: 1n }
      return st
    },
    async realpath(p) {
      calls.push(`realpath ${p}`)
      if (hang(p)) return never()
      if (!at(p)) throw err('ENOENT')
      return p
    },
    async open(p) {
      calls.push(`open ${p}`)
      const n = at(p)
      if (!n || !('size' in n)) throw err('ENOENT')
      return { stat: async () => ({ kind: 'file', size: n.size, mtimeMs: n.mtimeMs, dev: 1n, ino: n.ino }), read: async (size) => new Uint8Array(size), close: async () => {} }
    },
  }
  return { fs, calls }
}
let n = 0
const newId = () => `w${n++}`
const idx = (path: string, o: Partial<IndexedFile> = {}): IndexedFile => ({ path, used: NOW - 2 * DAY, modified: NOW - 9 * DAY, useCount: null, size: 5000, origins: [], authors: [], org: null, ...o })
const FOLDERS: WorkRoot[] = [{ id: 'documents', path: '/Users/alex/Documents', oneDrive: false }, { id: 'desktop', path: '/Users/alex/Desktop', oneDrive: false }, { id: 'downloads', path: '/Users/alex/Downloads', oneDrive: false }]

describe('the wide look', () => {
  const tree = () => ({ Users: dir({ alex: dir({
    Documents: dir({ 'Plan.docx': file() }),
    Desktop: dir(),
    Downloads: dir({ KakaoTalk: dir({ '견적서.pdf': file() }), 'Quote.pdf': file() }),
    Clients: dir({ Acme: dir({ 'Brief.pptx': file() }) }),
    Notes: dir({ 'Ideas.md': file() }),
    Library: dir({
      Mail: dir({ 'Quote.pdf': file() }),
      CloudStorage: dir({ 'OneDrive-Acme': dir({ Plans: dir({ 'Q3.xlsx': file() }), Online: dir({ 'Deep.docx': file() }), 'Cloud only.pdf': file() }) }),
    }),
  }) }) })
  const places: WorkRoot[] = [
    { id: 'messenger', path: '/Users/alex/Downloads/KakaoTalk', oneDrive: false, place: 'KakaoTalk' },
    { id: 'folder', path: '/Users/alex/Clients', oneDrive: false, place: 'Clients' },
    { id: 'cloud', path: '/Users/alex/Library/CloudStorage/OneDrive-Acme', oneDrive: false, place: 'OneDrive – Acme' },
  ]

  test('the places first (a messenger\'s folder in Downloads keeps its name), then the folders, then recent files elsewhere in home; never Mail', async () => {
    const { fs, calls } = fakeFs(tree())
    const r = await lookWide([...places, ...FOLDERS], fs, {
      platform: 'darwin', home: HOME, newId, now: () => NOW, index: async () => null,
      // a cloud drive: the folder "Online" and the file "Cloud only.pdf" are in the cloud only
      placeholders: async (paths, root) => new Set(root.id === 'cloud' ? paths.filter((p) => p.endsWith('/Online') || p.endsWith('Cloud only.pdf')) : []),
      recent: async () => [idx('/Users/alex/Notes/Ideas.md'), idx('/Users/alex/Library/Mail/Quote.pdf'), idx('/Users/alex/Documents/Plan.docx', { used: NOW - DAY })],
    })
    const where = r.files.map((f) => `${f.root}:${f.place ?? ''}:${f.folder ? f.folder + '/' : ''}${f.name}${f.cloud ? ' (cloud)' : ''}`)
    expect(where.sort()).toEqual([
      'cloud:OneDrive – Acme:Cloud only.pdf (cloud)',
      'cloud:OneDrive – Acme:Plans/Q3.xlsx',
      'documents::Plan.docx',
      'downloads::Quote.pdf',
      'folder:Clients:Acme/Brief.pptx',
      'home::Notes/Ideas.md',
      'messenger:KakaoTalk:견적서.pdf',
    ])
    // an online-only folder is never entered, no file of Mail is touched, nothing is opened
    expect(calls.some((c) => c.includes('/Online/') || c.endsWith('/Online'))).toBe(false)
    expect(calls.some((c) => c.includes('/Library/Mail'))).toBe(false)
    expect(calls.some((c) => c.startsWith('open'))).toBe(false)
    // the lists say when a listed file was opened
    expect(r.files.find((f) => f.name === 'Plan.docx')!.used).toBe(NOW - DAY)
    expect(JSON.stringify(r.files)).not.toContain('/Users/alex')
  })

  test('a place not looked at (blocked) lists none of its recent files', async () => {
    const { fs } = fakeFs(tree())
    const blocked: WorkFs = { ...fs, readdir: async (p, max) => { if (p.includes('OneDrive-Acme')) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); return fs.readdir(p, max) } }
    const r = await lookWide([...places, ...FOLDERS], blocked, { platform: 'darwin', home: HOME, newId, now: () => NOW, index: async () => null, recent: async () => [idx('/Users/alex/Library/CloudStorage/OneDrive-Acme/Plans/Q3.xlsx')] })
    expect(r.roots.find((x) => x.id === 'cloud')!.state).toBe('blocked')
    expect(r.files.some((f) => f.name === 'Q3.xlsx')).toBe(false)
  })

  test('Windows: an online-only file (the index\'s attributes) is listed from the index without one call; a hanging share stops at the first', async () => {
    const { fs, calls } = fakeFs({ 'C:': dir({ Users: dir({ alex: dir({ 'OneDrive - Acme': dir({ 'Cloud.docx': file(), 'Here.docx': file() }) }) }) }) }, { win: true, slow: ['\\\\nas'] })
    const root: WorkRoot = { id: 'cloud', path: 'C:\\Users\\alex\\OneDrive - Acme', oneDrive: false, place: 'OneDrive – Acme' }
    const r = await filesFromIndex(root, root.path, [idx('C:\\Users\\alex\\OneDrive - Acme\\Cloud.docx', { cloud: true, size: 9000 }), idx('C:\\Users\\alex\\OneDrive - Acme\\Here.docx')], fs, { platform: 'win32', newId, now: () => NOW })
    expect(r.files.map((f) => [f.name, !!f.cloud, f.size])).toEqual([['Cloud.docx', true, 9000], ['Here.docx', false, 5000]])
    expect(calls.filter((c) => c.includes('Cloud.docx'))).toEqual([])
    // a share that does not answer: one call at a time, the first that hangs ends them
    const share: WorkRoot = { id: 'drive', path: '\\\\nas\\team', oneDrive: false, place: '\\\\nas\\team' }
    const t0 = Date.now()
    const s = await filesFromIndex(share, share.path, [idx('\\\\nas\\team\\a.pdf'), idx('\\\\nas\\team\\b.pdf'), idx('\\\\nas\\team\\c.pdf')], fs, { platform: 'win32', newId, now: () => NOW, serial: true, callMs: 100 })
    expect(s.files).toEqual([])
    expect(calls.filter((c) => c.includes('nas'))).toHaveLength(1)
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  test('a read of an online-only file: the lstat just before the open says what it is, and the open must be that one', async () => {
    const { fs } = fakeFs({ 'C:': dir({ Users: dir({ alex: dir({ 'OneDrive - Acme': dir({ 'Cloud.docx': file(9000) }) }) }) }) }, { win: true })
    const root: WorkRoot = { id: 'cloud', path: 'C:\\Users\\alex\\OneDrive - Acme', oneDrive: false, place: 'OneDrive – Acme' }
    const node = (await fs.lstat('C:\\Users\\alex\\OneDrive - Acme\\Cloud.docx'))
    const r = await filesFromIndex(root, root.path, [idx('C:\\Users\\alex\\OneDrive - Acme\\Cloud.docx', { cloud: true, size: 9000, modified: node.mtimeMs })], fs, { platform: 'win32', newId, now: () => NOW })
    const sessions = new WorkFileSessions(fs, 'win32', () => NOW)
    sessions.begin('http://team', r.found)
    expect((await sessions.read('http://team', r.files[0]!.id)).ok).toBe(true)
    // swapped after the lstat: the open is another file
    const swapped: WorkFs = { ...fs, open: async (p) => { const h = await fs.open(p); return { ...h, stat: async () => ({ ...(await h.stat()), ino: 1n }) } } }
    const s2 = new WorkFileSessions(swapped, 'win32', () => NOW)
    s2.begin('http://team', r.found)
    expect(await s2.read('http://team', r.files[0]!.id)).toEqual({ ok: false, reason: 'changed' })
  })

  test('a cloud folder whose question gets no answer: nothing of it is entered or listed', async () => {
    const { fs, calls } = fakeFs(tree())
    const r = await scanRoots([places[2]!], fs, { platform: 'darwin', newId, placeholders: async () => { throw new Error('stat failed') } })
    expect(r.files).toEqual([])
    expect(calls.filter((c) => c.startsWith('readdir'))).toEqual(['readdir /Users/alex/Library/CloudStorage/OneDrive-Acme'])
  })
})

describe('dates', () => {
  test('a recent list\'s or a query\'s hit with no date from the index: its file\'s date decides (recent listed, old not)', async () => {
    const { fs } = fakeFs({ Users: dir({ alex: dir({ Notes: dir({ 'New.md': file(5000, NOW - 3 * DAY), 'Old.md': file(5000, NOW - 300 * DAY), 'Plain.md': file(5000, NOW - 3 * DAY) }) }) }) })
    const root: WorkRoot = { id: 'home', path: HOME, oneDrive: false, place: '' }
    const none = { used: null, modified: null }
    const r = await filesFromIndex(root, HOME, [idx('/Users/alex/Notes/New.md', { ...none, listed: true }), idx('/Users/alex/Notes/Old.md', { ...none, queried: true }), idx('/Users/alex/Notes/Plain.md', none)], fs, { platform: 'darwin', newId, now: () => NOW })
    expect(r.files.map((f) => f.name)).toEqual(['New.md'])
  })
})

describe('review of part 5', () => {
  test('Windows: a cloud drive\'s folder is never walked; without the index\'s rows it is left out, untouched', async () => {
    const { fs, calls } = fakeFs({ 'C:': dir({ Users: dir({ alex: dir({ 'OneDrive - Acme': dir({ Sub: dir({ 'x.docx': file() }) }), Documents: dir(), Desktop: dir(), Downloads: dir() }) }) }) }, { win: true })
    const cloud: WorkRoot = { id: 'cloud', path: 'C:\\Users\\alex\\OneDrive - Acme', oneDrive: false, place: 'OneDrive – Acme' }
    const r = await lookWide([cloud], fs, { platform: 'win32', home: 'C:\\Users\\alex', newId, now: () => NOW, index: async () => null, noWalk: (x) => x.id === 'cloud' })
    expect(r.roots[0]!.state).toBe('skipped')
    expect(calls.filter((c) => c.startsWith('readdir') || c.startsWith('lstat'))).toEqual([])
  })

  test('the whole look\'s deadline: roots not reached are skipped (cut)', async () => {
    const { fs } = fakeFs({ Users: dir({ alex: dir({ Documents: dir({ 'a.pdf': file() }), Desktop: dir(), Downloads: dir() }) }) })
    const r = await lookWide(FOLDERS, fs, { platform: 'darwin', home: HOME, newId, now: () => NOW, index: async () => null, deadline: Date.now() - 1 })
    expect(r.roots.map((x) => [x.state, x.cut])).toEqual([['skipped', true], ['skipped', true], ['skipped', true]])
  })

  test('network shares: after one does not answer, no other share is tried', async () => {
    const { fs, calls } = fakeFs({ 'C:': dir({ Users: dir({ alex: dir({ Documents: dir() }) }) }) }, { win: true, slow: ['\\\\nas1', '\\\\nas2'] })
    const t0 = Date.now()
    await lookWide([], fs, {
      platform: 'win32', home: 'C:\\Users\\alex', newId, now: () => NOW, index: async () => null, network: (p) => p.startsWith('\\\\'),
      recent: async () => [idx('\\\\nas1\\team\\a.pdf'), idx('\\\\nas2\\team\\b.pdf')],
    })
    expect(calls.filter((c) => c.includes('nas2'))).toEqual([])
    expect(Date.now() - t0).toBeLessThan(4000)
  })

  test('each place\'s name once, never one of the three folders\' or the home folder\'s', async () => {
    const { uniqueLabels } = await import('../../desktop/src/common/work-places')
    const p = (label: string) => ({ kind: 'cloud' as const, path: `/x/${label}`, label })
    expect(uniqueLabels([p('Google Drive'), p('Google Drive'), p('KakaoTalk'), p('kakaotalk'), p('Home'), p('Documents')]).map((x) => x.label)).toEqual(['Google Drive', 'Google Drive (2)', 'KakaoTalk', 'kakaotalk (2)', 'Home (2)', 'Documents (2)'])
  })

  test('Windows: short names and names ending in a dot or space are never trusted', () => {
    expect(homeExcluded(['APPDAT~1', 'Local', 'x.pdf'], 'win32')).toBe(true)
    expect(homeExcluded(['AppData.', 'Local', 'x.pdf'], 'win32')).toBe(true)
    expect(placeOf('C:\\Users\\alex\\APPDAT~1\\x.pdf', [], 'C:\\Users\\alex', 'win32')).toBeNull()
    expect(placeOf('C:\\Windows.old\\Users\\a\\x.pdf', [], 'C:\\Users\\alex', 'win32')).toBeNull()
    expect(placeOf('D:\\Clients\\Acme \\x.pdf', [], 'C:\\Users\\alex', 'win32')).toBeNull()
  })

  test('an online-only file the index gives no date for is not listed (its read could never match)', async () => {
    const { fs } = fakeFs({ 'C:': dir({ Users: dir({ alex: dir({ OD: dir({ 'x.docx': file() }) }) }) }) }, { win: true })
    const root: WorkRoot = { id: 'cloud', path: 'C:\\Users\\alex\\OD', oneDrive: false, place: 'OneDrive' }
    const r = await filesFromIndex(root, root.path, [idx('C:\\Users\\alex\\OD\\x.docx', { cloud: true, size: 9000, modified: null })], fs, { platform: 'win32', newId, now: () => NOW })
    expect(r.files).toEqual([])
  })

  test('Reopen only after Open Settings, while the app still has no access, never during a look; the index asks for documents only', () => {
    const ctl = readFileSync(join(import.meta.dir, '../../desktop/src/main/work-files.ts'), 'utf8')
    expect(ctl).toMatch(/async relaunch\(\) \{\s*if \(process\.platform !== 'darwin' \|\| this\.busy \|\| !this\.fullDiskSettingsAt \|\| Date\.now\(\) - this\.fullDiskSettingsAt > 15 \* 60_000\) return\s*if \(\(await this\.fullDisk\(\)\) === 'granted'\) return/)
    expect(windowsSearchScript(['C:\\Users\\a'])).toContain("System.FileExtension IN (''.pdf'',")
  })
})

describe('re-review of part 5', () => {
  test('outside a cloud drive only folders are asked about, and a folder without folders asks nothing', async () => {
    const { fs } = fakeFs({ Users: dir({ alex: dir({ Documents: dir({ 'a.pdf': file(), Plans: dir({ 'b.pdf': file() }), Online: dir({ 'c.pdf': file() }) }) }) }) })
    const asked: string[][] = []
    const r = await scanRoots([FOLDERS[0]!], fs, { platform: 'darwin', newId, placeholders: async (paths) => { asked.push(paths); return new Set(paths.filter((x) => x.endsWith('/Online'))) } })
    expect(asked).toEqual([['/Users/alex/Documents/Plans', '/Users/alex/Documents/Online']])
    expect(r.files.map((f) => f.name).sort()).toEqual(['a.pdf', 'b.pdf'])
  })

  test('Windows never walks OneDrive-moved folders; a Mac looks at its cloud drives before walking; enrich keeps the deadline', () => {
    const ctl = readFileSync(join(import.meta.dir, '../../desktop/src/main/work-files.ts'), 'utf8')
    expect(ctl).toContain("noWalk: (root) => root.id === 'cloud' || root.oneDrive,")
    expect(ctl).toContain("process.platform === 'win32' ? [...others, ...folders, ...cloud] : [...others, ...cloud, ...folders]")
    const common = readFileSync(join(import.meta.dir, '../../desktop/src/common/work-files.ts'), 'utf8')
    expect(common).toContain('deadline: Math.min(Date.now() + FALLBACK_LIMITS.rootMs, o.deadline ?? Infinity)')
  })
})
