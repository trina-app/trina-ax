// "Find work files on this computer", the fast way (docs/DECISIONS.md "Find work files, part 4: ask the computer's index"):
// instead of walking Documents, Desktop and Downloads, ask the index the computer already keeps (Spotlight on a Mac,
// Windows Search on a PC) for the files used or changed lately, with what it knows of each (when it was last opened, how
// often, where it was downloaded from, who wrote it). No file is opened. The recent lists (Windows' Recent folder,
// Office's list of recent files) add to it. When the index is off, the folder walk (work-files.ts scanRoots) runs instead.
// Measured on a Mac (2026-11-15): Spotlight raises macOS's question for a protected folder exactly as a read does, so
// each folder is asked for first (one question per folder, one after the other) and queried after.
// Pure: the commands' output comes in as text, so the parsers are unit-tested in tests/unit/e-desktop-work-index.test.ts;
// desktop/src/main/work-files.ts runs the commands.
import { posix, win32 } from 'node:path'
import { winPlaceholder } from './work-places'
import { DOC_TYPES } from '@mycel/shared/file-scan'

/** How far back a file counts as recent (owner, 2026-11-15: "only files used recently", about six months). */
export const RECENT_DAYS = 180
/** Smaller files are no work document (an empty template, a stub); bigger ones are not offered (the file screen takes them). */
export const MIN_BYTES = 1024

/** What the index knows of one file. Dates in ms; null when the index has none. */
export interface IndexedFile {
  path: string
  /** last opened (Spotlight's kMDItemLastUsedDate, Windows' Recent list or Office's list) */
  used: number | null
  /** last changed */
  modified: number | null
  /** how often it was opened (Spotlight's kMDItemUseCount) */
  useCount: number | null
  size: number | null
  /** where it came from: the host names of the download's addresses (kMDItemWhereFroms, Zone.Identifier) */
  origins: string[]
  /** who wrote it, the organisation (kMDItemAuthors, kMDItemOrganizations; System.Author, System.Company) */
  authors: string[]
  org: string | null
  /** online only (part 5): its content is in the cloud (Windows' attributes, a Mac's SF_DATALESS); never opened by the look */
  cloud?: boolean
  /** in a recent-documents list (part 5: the Mac's shared file lists, Office's; Windows' Recent folder, Office's) */
  listed?: boolean
  /** found by an index query for recent files (part 5): recent by that query, even when nothing more is known of it */
  queried?: boolean
}

// ---------------------------------------------------------------- macOS: Spotlight

/** The mdfind query for one folder: files used or changed in the last `days` days. Types are filtered after (by name). */
export function mdfindArgs(root: string, days: number = RECENT_DAYS): string[] {
  return ['-onlyin', root, '-0', `(kMDItemLastUsedDate >= $time.today(-${days}) || kMDItemFSContentChangeDate >= $time.today(-${days})) && kMDItemContentTypeTree == "public.item"`]
}

/** mdfind -0's answer: the paths. */
export const parseMdfind = (out: string): string[] => out.split('\0').map((s) => s.trim()).filter(Boolean)

/** The attributes mdls is asked for, in the order it answers them (alphabetical). */
export const MDLS_NAMES = ['kMDItemAuthors', 'kMDItemFSContentChangeDate', 'kMDItemFSSize', 'kMDItemLastUsedDate', 'kMDItemOrganizations', 'kMDItemPath', 'kMDItemUseCount', 'kMDItemWhereFroms'] as const

export function mdlsArgs(paths: readonly string[]): string[] {
  return [...MDLS_NAMES.flatMap((n) => ['-name', n]), ...paths]
}

/** macOS names the user folders under the Data volume too: /System/Volumes/Data/Users/alex → /Users/alex. */
export const macPath = (p: string) => (p.startsWith('/System/Volumes/Data/') ? p.slice('/System/Volumes/Data'.length) : p)

/** One attribute's value as mdls prints it: (null), a number, a quoted string, a date, or a list in ( … ). */
function mdValue(raw: string): string | number | string[] | null {
  const v = raw.trim()
  if (v === '(null)') return null
  if (v.startsWith('(')) {
    // one item per line ("a",\n "b"\n): an address can hold commas, a line cannot hold two items
    return v.replace(/^\(|\)$/g, '').split('\n').map((s) => s.trim().replace(/,$/, '').trim().replace(/^"|"$/g, '').replace(/\\"/g, '"')).filter(Boolean)
  }
  if (v.startsWith('"')) return v.replace(/^"|"$/g, '').replace(/\\"/g, '"')
  const n = Number(v)
  return Number.isFinite(n) && /^-?\d+(\.\d+)?$/.test(v) ? n : v
}
const mdDate = (v: unknown) => {
  if (typeof v !== 'string') return null
  const t = Date.parse(v.replace(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-]\d{4})$/, '$1T$2$3'))
  return Number.isFinite(t) ? t : null
}

/** mdls's answer for several files (each file: MDLS_NAMES in order, a list over several lines) → what the index knows. */
export function parseMdls(out: string): IndexedFile[] {
  // the attributes, one entry each (a list goes on until its closing parenthesis)
  const attrs: { name: string; value: string }[] = []
  let cur: { name: string; value: string } | null = null
  for (const line of out.split('\n')) {
    const m = line.match(/^(kMDItem\w+)\s*=\s*(.*)$/)
    if (m) {
      cur = { name: m[1]!, value: m[2]! }
      attrs.push(cur)
    } else if (cur && cur.value.trim().startsWith('(') && !cur.value.trim().endsWith(')')) cur.value += '\n' + line
  }
  const files: IndexedFile[] = []
  let rec: Record<string, unknown> = {}
  const flush = () => {
    const path = typeof rec.kMDItemPath === 'string' ? macPath(rec.kMDItemPath) : null
    if (path) {
      const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : [])
      files.push({
        path,
        used: mdDate(rec.kMDItemLastUsedDate),
        modified: mdDate(rec.kMDItemFSContentChangeDate),
        useCount: typeof rec.kMDItemUseCount === 'number' ? rec.kMDItemUseCount : null,
        size: typeof rec.kMDItemFSSize === 'number' ? rec.kMDItemFSSize : null,
        origins: hostsOf(list(rec.kMDItemWhereFroms)),
        authors: list(rec.kMDItemAuthors).slice(0, 5),
        org: list(rec.kMDItemOrganizations)[0] ?? null,
      })
    }
    rec = {}
  }
  for (const a of attrs) {
    // a new file starts where its first attribute comes again
    if (a.name === MDLS_NAMES[0] && Object.keys(rec).length) flush()
    rec[a.name] = mdValue(a.value)
  }
  if (Object.keys(rec).length) flush()
  return files
}

// ---------------------------------------------------------------- where a file came from

/** The host names of download addresses (only the host: never the whole address, which can hold a token). */
export function hostsOf(urls: readonly string[]): string[] {
  const out = new Set<string>()
  for (const u of urls) {
    try {
      const h = new URL(u).hostname.toLowerCase()
      if (h) out.add(h)
    } catch {
      // not an address (WhereFroms also holds a page title sometimes)
    }
  }
  return [...out].slice(0, 4)
}

/** Windows' Zone.Identifier stream of a downloaded file ([ZoneTransfer] ZoneId=3, HostUrl=…, ReferrerUrl=…) → hosts. */
export function parseZoneIdentifier(text: string): string[] {
  const urls = [...text.matchAll(/^(?:HostUrl|ReferrerUrl)=(.+)$/gim)].map((m) => m[1]!.trim())
  return hostsOf(urls)
}

// ---------------------------------------------------------------- Windows: Windows Search, Recent, Office

/** A PowerShell single-quoted string's quotes doubled: ASCII ' and the curly ones PowerShell also reads as quotes
 * (U+2018–U+201B). The script also goes as -EncodedCommand (powershellArgs), never through a command line's quoting. */
export const psQuote = (s: string) => s.replace(/['\u2018-\u201B]/g, (c) => c + c)

/** A Windows Search SQL string's quotes doubled: only ASCII ' (the SQL reads a curly quote as a letter). The SQL then goes
 * into a PowerShell string through psQuote, so a folder named "Alex’s" stays "Alex’s" (review of the 0x80040E14 fix). */
export const sqlQuote = (s: string) => s.replace(/'/g, "''")

/** Windows PowerShell writes to a pipe in the console's code page (437, 949 …), and execFile reads UTF-8: a Korean or
 * accented path came back as "?" and its file was never found (measured on a Windows 11 PC, 2026-11-15). Every script
 * starts with this, so its output is UTF-8. */
export const PS_UTF8 = '[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding $false'

/** powershell.exe's arguments for a script: UTF-16LE base64 (-EncodedCommand), so nothing in it is read by a shell;
 * its output UTF-8 (PS_UTF8). */
export const powershellArgs = (script: string) => ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`${PS_UTF8};${script}`, 'utf16le').toString('base64')]

/** One PowerShell run: Windows Search's SystemIndex for documents changed in the last `days` days under the
 * roots, as one JSON array. ADO through the Search.CollatorDSO provider; nothing is opened. `drives` (part 5): the other
 * fixed drives' indexed places too (D:\, E:\; the script finds them, never a network or removable drive). Each row has
 * the file's attributes, so an online-only file is told apart without touching it. The last-access date is not asked for:
 * Windows sets it when anything reads the file (unzipping, a virus scan, the indexer), so on Windows "opened" comes from
 * the Recent folder and Office's list only, and "recent" from the last change (measured on a Windows 11 PC, 2026-11-15:
 * 238 of 290 rows had a last access after their last change). */
/** The index is asked for documents only (and pictures, for brand folders): code trees, caches and media on a busy
 * drive never push the documents out of its first 2,000 rows (review of part 5). */
/** Windows Search's SQL has no IN: `System.FileExtension IN (…)` fails the whole query (0x80040E14, measured on a
 * Windows 11 PC, 2026-11-15), so each type is its own comparison. */
const EXT_FILTER = `(${[...DOC_TYPES, 'png', 'jpg', 'jpeg'].map((x) => `System.FileExtension = '.${x}'`).join(' OR ')})`

export function windowsSearchScript(roots: readonly string[], days: number = RECENT_DAYS, now = Date.now(), o: { drives?: boolean } = {}): string {
  const since = new Date(now - days * 86_400_000).toISOString().slice(0, 19).replace('T', ' ')
  const scope = roots.map((r) => `SCOPE='file:${sqlQuote(r.replace(/\\/g, '/'))}'`).join(' OR ')
  const sql = (sc: string) => `SELECT TOP 2000 System.ItemPathDisplay, System.DateModified, System.Size, System.Author, System.Company, System.FileAttributes FROM SystemIndex WHERE (${sc}) AND ${EXT_FILTER} AND System.FileAttributes <> 0 AND System.DateModified >= '${since}' ORDER BY System.DateModified DESC`
  return [
    "$ErrorActionPreference='Stop'",
    "$c=New-Object -ComObject ADODB.Connection",
    "$c.Open(\"Provider=Search.CollatorDSO;Extended Properties='Application=Windows';\")",
    `$q='${psQuote(sql(scope))}'`,
    // the other fixed drives (not the system drive: its user folders are the roots above), each its own scope
    ...(o.drives ? [
      "$sys=$env:SystemDrive.TrimEnd('\\')",
      "$ds=[System.IO.DriveInfo]::GetDrives()|Where-Object{$_.DriveType -eq 'Fixed' -and $_.IsReady -and $_.Name.TrimEnd('\\') -ne $sys}|ForEach-Object{\"SCOPE='file:\"+$_.Name.Replace('\\','/')+\"'\"}",
      `if($ds){$q='${psQuote(sql('__SCOPES__'))}'.Replace('__SCOPES__',((@('${psQuote(scope)}')+$ds) -join ' OR '))}`,
    ] : []),
    '$r=$c.Execute($q)',
    // the index's dates are UTC with no kind; ConvertTo-Json would take them as local time (9 h early in Seoul), so
    // they go as milliseconds since 1970, read as UTC
    "function T($v){if($v -is [datetime]){[DateTimeOffset]::new([DateTime]::SpecifyKind($v,[DateTimeKind]::Utc)).ToUnixTimeMilliseconds()}else{$null}}",
    '$o=@()',
    'while(-not $r.EOF){$o+=[pscustomobject]@{p=$r.Fields.Item(0).Value;m=(T $r.Fields.Item(1).Value);s=$r.Fields.Item(2).Value;au=$r.Fields.Item(3).Value;co=$r.Fields.Item(4).Value;fa=$r.Fields.Item(5).Value};$r.MoveNext()}',
    '$o|ConvertTo-Json -Compress -Depth 3',
  ].join(';')
}

/** A date of the script's JSON: milliseconds since 1970 (UTC), or as older scripts wrote it (/Date()/, text). */
const winDate = (v: unknown) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') {
    const m = v.match(/\/Date\((\d+)\)\//)
    const t = m ? Number(m[1]) : Date.parse(v)
    return Number.isFinite(t) ? t : null
  }
  return null
}

/** The script's JSON (an array, one object, or nothing) → what the index knows. */
export function parseWindowsSearch(json: string): IndexedFile[] {
  let rows: unknown
  try { rows = JSON.parse(json.trim() || '[]') } catch { return [] }
  const list = Array.isArray(rows) ? rows : rows ? [rows] : []
  return list.flatMap((r): IndexedFile[] => {
    const o = r as Record<string, unknown>
    if (typeof o.p !== 'string' || !o.p) return []
    const authors = Array.isArray(o.au) ? o.au.map(String) : typeof o.au === 'string' ? [o.au] : []
    const fa = typeof o.fa === 'number' ? o.fa : 0
    // no last-access date (windowsSearchScript): an older script's `a` is ignored too
    return [{ path: o.p, used: null, modified: winDate(o.m), useCount: null, size: typeof o.s === 'number' ? o.s : null, origins: [], authors: authors.slice(0, 5), org: typeof o.co === 'string' && o.co ? o.co : null, ...(winPlaceholder(fa) ? { cloud: true } : {}) }]
  })
}

/** Office's recent files (reg query's lines, or the bare values PowerShell prints), newest first:
 * `Item 1    REG_SZ    [F00000000][T01DA1234ABCD5678][O00000000]*C:\Users\alex\Documents\Plan.docx`. The [T…] part is
 * a FILETIME (100 ns since 1601). */
export function parseOfficeMru(out: string): { path: string; used: number | null }[] {
  const res: { path: string; used: number | null }[] = []
  for (const m of out.matchAll(/^(?:.*REG_SZ\s+)?((?:\[[A-Z][0-9A-F]+\])+)\*(.+)$/gim)) {
    const t = m[1]!.match(/\[T([0-9A-F]{16})\]/i)
    const used = t ? Number((BigInt('0x' + t[1]) / 10_000n) - 11_644_473_600_000n) : null
    res.push({ path: m[2]!.trim(), used: used !== null && Number.isFinite(used) ? used : null })
  }
  return res
}

// ---------------------------------------------------------------- the candidates

/** Several sources about the same file (index, Recent, Office) → one, keeping the newest use and every hint. On Windows
 * and macOS paths are compared without case. */
export function mergeIndexed(lists: readonly (readonly IndexedFile[])[], platform: string): IndexedFile[] {
  const key = (p: string) => (platform === 'win32' ? win32.normalize(p).toLowerCase() : platform === 'darwin' ? posix.normalize(p).toLowerCase() : posix.normalize(p))
  const by = new Map<string, IndexedFile>()
  const max = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.max(a, b))
  for (const list of lists) for (const f of list) {
    const k = key(f.path)
    const was = by.get(k)
    if (!was) { by.set(k, { ...f, origins: [...f.origins], authors: [...f.authors] }); continue }
    was.used = max(was.used, f.used)
    was.modified = max(was.modified, f.modified)
    was.useCount = max(was.useCount, f.useCount)
    was.size ??= f.size
    was.org ??= f.org
    if (f.cloud) was.cloud = true
    if (f.listed) was.listed = true
    if (f.queried) was.queried = true
    for (const o of f.origins) if (!was.origins.includes(o)) was.origins.push(o)
    for (const a of f.authors) if (!was.authors.includes(a)) was.authors.push(a)
  }
  return [...by.values()]
}

/** What a Windows look gets from the index and the recent lists: `index`, the index's rows merged with the lists (null
 * when the index did not answer: the folders are walked then); `recent`, the files opened lately anywhere, which the
 * Recent folder and Office's list give even without the index. */
export interface WindowsLook { index: IndexedFile[] | null; recent: IndexedFile[] }
export function windowsLook(indexed: readonly IndexedFile[] | null, lists: readonly IndexedFile[]): WindowsLook {
  const index = indexed ? mergeIndexed([indexed, lists], 'win32') : null
  return { index, recent: index ?? mergeIndexed([lists], 'win32') }
}

/** The file's latest use or change. */
export const lastTouched = (f: Pick<IndexedFile, 'used' | 'modified'>) => Math.max(f.used ?? 0, f.modified ?? 0) || null

/** Recent: used or changed within `days`. */
export const isRecent = (f: Pick<IndexedFile, 'used' | 'modified'>, now = Date.now(), days: number = RECENT_DAYS) => {
  const t = lastTouched(f)
  return t !== null && now - t <= days * 86_400_000
}
