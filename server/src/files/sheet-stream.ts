// Text of a big .xlsx without loading it whole (docs/decisions/20261118-limits-office-read.md). SheetJS (office-parse.ts)
// builds every cell of every sheet in memory, which a 60 MB export (hundreds of MB of sheet XML) does not fit. Here each
// sheet's XML is inflated a piece at a time and its rows are scanned as they come, so memory holds one piece, the
// workbook's shared text and the rows kept for the answer. Runs in the office worker only (office-parse.ts), like the
// other parsers of untrusted input.
//
// What comes out:
// - the whole workbook as tab-separated text, in the same form as office-parse.ts sheetPart (`# sheet:` labels with the
//   A1 range, `# row N` where rows were left out), when it fits in FULL_TEXT_MAX;
// - else an overview: per sheet its range, how many rows hold data, its first OVERVIEW_HEAD and last OVERVIEW_TAIL
//   rows, and how to read the rest (read's `sheet` and `range`);
// - with a sheet and a range asked for: those rows (at most PART_ROWS_MAX), and the range to read on with.
// Values are the stored ones (no number formats), dates as ISO dates.
// The XML is untrusted: every scan is linear (indexOf from the current place), a row that never closes stops the read
// once the piece kept for it is over CARRY_MAX, a part may not inflate past its declared size, and the declared sizes
// were checked against zip-guard.ts limits for an entry (ratio) before any part is read.
import { Readable } from 'node:stream'
import zlib from 'node:zlib'
import { ToolError } from '../policy/errors'
import { entryData, readCentral, ZIP_ENTRIES_MAX, ZipProblem, type ZipEntry } from './zip-guard'
import { tooComplex } from './zip-guard'
import { attr, tags, unescapeXml } from './ooxml'

const MIB = 1024 * 1024
/** declared size of all parts together: only one piece of a sheet is in memory at a time, so this bounds the work (time),
 * not the memory; the worker's time limit stops a slower read first */
export const STREAM_TOTAL_MAX = 4096 * MIB
/** text of the whole workbook that is given as it is (the office worker's text cap) */
export const FULL_TEXT_MAX = 32 * MIB
/** declared sheet XML above this many times FULL_TEXT_MAX: the whole text is not tried (see bigSheetText) */
const FULL_TRY_XML_FACTOR = 8
/** rows of each sheet in the overview */
export const OVERVIEW_HEAD = 20
export const OVERVIEW_TAIL = 10
/** the overview's own size: later sheets are only named past it */
const OVERVIEW_MAX = 4 * MIB
/** rows with data one read of a range gives (read's own default is 2,000 lines), and its text */
export const PART_ROWS_MAX = 2000
const PART_TEXT_MAX = 8 * MIB
/** characters of the workbook's shared text kept (a cell past it says so) */
const SHARED_TEXT_MAX = 48 * 1024 * 1024
/** the unread end of a piece (an open row) may not grow past this */
const CARRY_MAX = 64 * MIB
/** small parts read whole (workbook, its relationships, styles) */
const SMALL_PART_MAX = 32 * MIB
/** inflated bytes between garbage collections: the scans make many short-lived strings, and the collector left alone
 * let a 60 MB workbook's reader grow past 700 MB (the converter cgroup has 512 MB on a small server) */
const GC_EVERY = 4 * MIB
let sinceGc = 0
const collect = () => { try { (globalThis as { Bun?: { gc(full: boolean): void } }).Bun?.gc(true) } catch {} }
/** a declared range larger than this is not used for the last column (office-parse.ts RANGE_CELLS_MAX) */
const RANGE_CELLS_MAX = 2_000_000
/** Excel's columns */
const COLS_MAX = 16384

/** A sheet and a range of it, as read's `sheet` / `range` give them. */
export interface SheetAsk { sheet?: string; range?: string }

// ---------------- the zip ----------------

type Index = Map<string, ZipEntry>

function index(bytes: Uint8Array): Index {
  let entries: ZipEntry[]
  try { entries = readCentral(bytes, { total: STREAM_TOTAL_MAX, entries: ZIP_ENTRIES_MAX }) } catch (e) {
    if (!(e instanceof ZipProblem)) throw e
    if (e.kind === 'encrypted') throw new ToolError('could not read this file (it is encrypted)')
    if (e.kind === 'complex') throw tooComplex(e.why)
    throw new ToolError(`could not read this file (damaged zip container: ${e.why})`)
  }
  const out: Index = new Map()
  for (const e of entries) out.set(new TextDecoder('utf-8').decode(e.nameBytes).replace(/^\/+/, ''), e)
  return out
}

/** A part found by name, without regard to case (some writers spell `xl/sharedStrings.xml` otherwise). */
function find(ix: Index, name: string): ZipEntry | undefined {
  const e = ix.get(name)
  if (e) return e
  const low = name.toLowerCase()
  for (const [k, v] of ix) if (k.toLowerCase() === low) return v
  return undefined
}

function damaged(why: string): ToolError { return new ToolError(`could not read this file (damaged zip container: ${why})`) }

/** A small part as text (the whole of it, at most SMALL_PART_MAX). */
function small(bytes: Uint8Array, e: ZipEntry | undefined): string {
  if (!e) return ''
  if (e.usize > SMALL_PART_MAX) throw tooComplex(`a part is over ${SMALL_PART_MAX / MIB} MB`)
  let data: Uint8Array
  try { data = entryData(bytes, e) } catch (err) { if (err instanceof ZipProblem) throw damaged(err.why); throw err }
  if (e.method === 0) return new TextDecoder('utf-8').decode(data)
  try { return new TextDecoder('utf-8').decode(zlib.inflateRawSync(data, { maxOutputLength: Math.max(e.usize, 1) })) } catch {
    throw damaged('bad compressed data')
  }
}

/** A part's text a piece at a time; it may not inflate past its declared size. Breaking the loop stops the inflate. */
async function* pieces(bytes: Uint8Array, e: ZipEntry): AsyncGenerator<string> {
  let data: Uint8Array
  try { data = entryData(bytes, e) } catch (err) { if (err instanceof ZipProblem) throw damaged(err.why); throw err }
  const dec = new TextDecoder('utf-8')
  if (e.method === 0) {
    for (let p = 0; p < data.length; p += 4 * MIB) yield dec.decode(data.subarray(p, p + 4 * MIB), { stream: true })
    const end = dec.decode()
    if (end) yield end
    return
  }
  const inflate = zlib.createInflateRaw({ chunkSize: 1 * MIB })
  const src = Readable.from([Buffer.from(data.buffer, data.byteOffset, data.byteLength)])
  src.pipe(inflate)
  let real = 0
  try {
    for await (const chunk of inflate as AsyncIterable<Buffer>) {
      real += chunk.length
      if (real > e.usize) throw tooComplex('a part is larger than its header says')
      yield dec.decode(chunk, { stream: true })
      sinceGc += chunk.length
      if (sinceGc >= GC_EVERY) { sinceGc = 0; collect() }
    }
  } catch (err) {
    if (err instanceof ToolError) throw err
    throw damaged('bad compressed data')
  } finally {
    src.unpipe(inflate)
    inflate.destroy()
    src.destroy()
  }
  const end = dec.decode()
  if (end) yield end
}

// ---------------- the workbook ----------------

interface SheetRef { name: string; part: string; hidden: boolean }
interface Book { sheets: SheetRef[]; date1904: boolean; styles: Map<number, StyleKind>; shared: SharedTable; sharedCut: boolean }
/** how a cell style shows a number: a date, or a percentage with this many decimals (others: the stored value) */
type StyleKind = 'date' | number

/**
 * The shared text, packed: every SHARED_BLOCK items are joined into one flat string with their offsets, so a million
 * short cell texts cost their characters, not a million string objects (that took ~300 MB for a 31 MB part).
 */
const SHARED_BLOCK = 4096
export class SharedTable {
  private blocks: { text: string; ends: Uint32Array }[] = []
  private cur: string[] = []
  /** items past SHARED_TEXT_MAX: known to exist, text not kept */
  private unread = 0
  get length() { return this.blocks.length * SHARED_BLOCK + this.cur.length + this.unread }
  push(t: string | undefined) {
    if (t === undefined || this.unread) { this.unread++; return }
    this.cur.push(t)
    if (this.cur.length === SHARED_BLOCK) this.seal()
  }
  seal() {
    if (!this.cur.length) return
    const ends = new Uint32Array(this.cur.length)
    let at = 0
    this.cur.forEach((t, i) => { at += t.length; ends[i] = at })
    this.blocks.push({ text: this.cur.join(''), ends })
    this.cur = []
  }
  /** the item's text; undefined past SHARED_TEXT_MAX */
  get(i: number): string | undefined {
    const b = this.blocks[Math.floor(i / SHARED_BLOCK)]
    if (b) { const j = i % SHARED_BLOCK; return b.text.slice(j ? b.ends[j - 1]! : 0, b.ends[j]!) }
    const k = i - this.blocks.length * SHARED_BLOCK
    return k < this.cur.length ? this.cur[k] : undefined
  }
}

const resolve = (dir: string, target: string) => {
  const segs = (target.startsWith('/') ? target.slice(1) : dir + target).split('/')
  const out: string[] = []
  for (const s of segs) { if (s === '..') out.pop(); else if (s && s !== '.') out.push(s) }
  return out.join('/')
}

/** A tag name without its namespace prefix (`x:row` is `row`). */
const local = (name: string) => name.slice(name.indexOf(':') + 1)

function sheetsOf(bytes: Uint8Array, ix: Index): { sheets: SheetRef[]; date1904: boolean } {
  const wb = small(bytes, find(ix, 'xl/workbook.xml'))
  if (!wb) throw new ToolError('could not read this spreadsheet (no workbook part)')
  const relsXml = small(bytes, find(ix, 'xl/_rels/workbook.xml.rels'))
  const targets = new Map<string, string>()
  for (const t of tags(relsXml)) {
    if (local(t.name) !== 'Relationship' || t.close) continue
    const id = attr(t.head, 'Id'), target = attr(t.head, 'Target')
    if (id && target && attr(t.head, 'TargetMode') !== 'External') targets.set(id, resolve('xl/', target))
  }
  const sheets: SheetRef[] = []
  let date1904 = false
  for (const t of tags(wb)) {
    if (t.close) continue
    const n = local(t.name)
    if (n === 'workbookPr') { const d = attr(t.head, 'date1904'); date1904 = d === '1' || d === 'true' }
    if (n !== 'sheet') continue
    const name = attr(t.head, 'name') ?? `Sheet${sheets.length + 1}`
    const rid = /\sr:id="([^"]*)"/.exec(t.head)?.[1] ?? /\s\w+:id="([^"]*)"/.exec(t.head)?.[1]
    const part = rid ? targets.get(rid) : undefined
    const state = attr(t.head, 'state')
    if (part) sheets.push({ name, part, hidden: state === 'hidden' || state === 'veryHidden' })
  }
  if (!sheets.length) throw new ToolError('could not read this spreadsheet (no sheets found)')
  return { sheets, date1904 }
}

/** Built-in number formats that are dates or times (ECMA-376 18.8.30, and the East Asian ones Excel adds). */
const DATE_FMT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58])
/** A format code that shows a date or time: y, m, d, h or s outside quoted text, escapes and [colour] blocks. */
export function isDateFormat(code: string): boolean {
  const bare = code.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[(?!h\]|hh\]|m\]|mm\]|s\]|ss\])[^\]]*\]/gi, '')
  if (/^general$/i.test(bare.trim())) return false
  return /[ymdhs]/i.test(bare)
}

/** Built-in percentage formats: 9 is "0%", 10 is "0.00%". */
const PERCENT_FMT_IDS = new Map([[9, 0], [10, 2]])
/** A percentage format code ("0.0%"): its decimals, else null. */
export function percentDecimals(code: string): number | null {
  const bare = code.replace(/"[^"]*"/g, '').replace(/\\./g, '').split(';')[0]!
  if (!bare.includes('%')) return null
  return /\.(0+)/.exec(bare)?.[1]?.length ?? 0
}

/** The cell styles (`s` of a cell) whose number format is a date or a percentage. */
function cellStyles(bytes: Uint8Array, ix: Index): Map<number, StyleKind> {
  const xml = small(bytes, find(ix, 'xl/styles.xml'))
  const custom = new Map<number, string>()
  const out = new Map<number, StyleKind>()
  let inXfs = false, xf = 0
  for (const t of tags(xml)) {
    const n = local(t.name)
    if (n === 'numFmt' && !t.close) { const id = Number(attr(t.head, 'numFmtId')); const code = attr(t.head, 'formatCode'); if (Number.isInteger(id) && code !== undefined) custom.set(id, code) }
    else if (n === 'cellXfs') { inXfs = !t.close && !t.selfClose; xf = 0 }
    else if (n === 'xf' && inXfs && !t.close) {
      const id = Number(attr(t.head, 'numFmtId') ?? 0)
      const code = custom.get(id)
      if (code !== undefined ? isDateFormat(code) : DATE_FMT_IDS.has(id)) out.set(xf, 'date')
      else { const pct = code !== undefined ? percentDecimals(code) : PERCENT_FMT_IDS.get(id) ?? null; if (pct !== null) out.set(xf, pct) }
      xf++
    }
  }
  return out
}

/** `_x000D_`-style escapes of OOXML text (a character Excel could not write as XML). */
const unescapeOoxml = (s: string) => s.indexOf('_x') < 0 ? s : s.replace(/_x([0-9A-Fa-f]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))

/** Text of the <t> runs of a string item (<si> or an inline <is>), without phonetic runs (<rPh>). */
function itemText(xml: string): string {
  let out = ''
  let pos = 0
  for (;;) {
    const s = xml.indexOf('<', pos)
    if (s < 0) break
    const gt = xml.indexOf('>', s)
    if (gt < 0) break
    const head = xml.slice(s + 1, gt)
    const name = local(head.split(/[\s/]/, 1)[0]!)
    if (name === 'rPh' && !head.endsWith('/')) {
      const e = xml.indexOf('rPh>', gt)
      pos = e < 0 ? xml.length : e + 4
      continue
    }
    if (name === 't' && !head.endsWith('/')) {
      const e = xml.indexOf('</', gt)
      if (e < 0) break
      out += xml.slice(gt + 1, e)
      pos = xml.indexOf('>', e) + 1 || xml.length
      continue
    }
    pos = gt + 1
  }
  return unescapeOoxml(unescapeXml(out))
}

/** The workbook's shared text (every <si>), at most SHARED_TEXT_MAX characters. */
async function sharedText(bytes: Uint8Array, ix: Index): Promise<{ shared: SharedTable; cut: boolean }> {
  const e = find(ix, 'xl/sharedStrings.xml')
  const shared = new SharedTable()
  if (!e) return { shared, cut: false }
  let carry = ''
  let size = 0
  let cut = false
  for await (const piece of pieces(bytes, e)) {
    let xml = carry + piece
    let pos = 0
    for (;;) {
      const s = findTag(xml, 'si', pos)
      if (s < 0) { pos = Math.max(pos, xml.lastIndexOf('<')); break }
      const gt = xml.indexOf('>', s)
      if (gt < 0) { pos = s; break }
      if (xml.charCodeAt(gt - 1) === 0x2f) { shared.push(''); pos = gt + 1; continue }
      const end = findEnd(xml, 'si', gt)
      if (end < 0) { pos = s; break }
      if (cut) shared.push(undefined)
      else {
        const t = itemText(xml.slice(gt + 1, end))
        size += t.length
        if (size > SHARED_TEXT_MAX) { cut = true; shared.push(undefined) } else shared.push(t)
      }
      pos = xml.indexOf('>', end) + 1
    }
    carry = pos < 0 ? '' : xml.slice(Math.max(0, pos))
    xml = ''
    if (carry.length > CARRY_MAX) throw tooComplex('a shared text item does not end')
  }
  shared.seal()
  return { shared, cut }
}

/** Where the next start tag of `name` (any prefix) is at or after `from`, or -1. */
function findTag(xml: string, name: string, from: number): number {
  for (let i = xml.indexOf('<', from); i >= 0; i = xml.indexOf('<', i + 1)) {
    let j = i + 1
    const c0 = xml.charCodeAt(j)
    if (c0 === 0x2f || c0 === 0x3f || c0 === 0x21) continue
    // the name, with or without a prefix
    let k = j
    while (k < xml.length && !ends(xml.charCodeAt(k))) k++
    if (k >= xml.length) return i
    const tag = xml.slice(j, k)
    if (tag === name || (tag.endsWith(':' + name))) return i
  }
  return -1
}
const ends = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x3e || c === 0x2f
/** Where the end tag of `name` (any prefix) after `from` starts, or -1. */
function findEnd(xml: string, name: string, from: number): number {
  for (let i = xml.indexOf('</', from); i >= 0; i = xml.indexOf('</', i + 2)) {
    const gt = xml.indexOf('>', i)
    if (gt < 0) return -1
    const tag = xml.slice(i + 2, gt).trim()
    if (tag === name || tag.endsWith(':' + name)) return i
  }
  return -1
}

// ---------------- cells and rows ----------------

export const colName = (c: number) => { let s = ''; for (c++; c > 0; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(65 + ((c - 1) % 26)) + s; return s }
export const colIndex = (s: string) => { let n = 0; for (const ch of s.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1 }

/** An Excel serial date as an ISO date (with the time when it has one). */
export function serialDate(v: number, date1904: boolean): string {
  if (!Number.isFinite(v) || v < 0 || v > 2958465) return String(v)
  const ms = Math.round((v + (date1904 ? 1462 : 0)) * 86400000) + Date.UTC(1899, 11, 30)
  const d = new Date(ms)
  const iso = d.toISOString()
  if (v < 1 && !date1904) return iso.slice(11, 19)
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ')
}

/** A field of a tab-separated row, quoted like SheetJS sheet_to_csv when it holds a tab, a line feed or a quote. */
const field = (t: string) => /[\t\n"]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t

type Row = { r: number; cells: string[] }

/** The cells of one <row>…</row> (its inner XML) as text by column; empty when no cell has a value or a formula. */
function rowCells(xml: string, book: Book): string[] {
  const cells: string[] = []
  let next = 0
  let pos = 0
  for (;;) {
    const s = findTag(xml, 'c', pos)
    if (s < 0) break
    const gt = xml.indexOf('>', s)
    if (gt < 0) break
    const head = xml.slice(s, gt)
    const selfClose = xml.charCodeAt(gt - 1) === 0x2f
    const ref = fa(head, 'r')
    const col = ref ? colIndex(/^[A-Za-z]+/.exec(ref)?.[0] ?? 'A') : next
    next = col + 1
    if (selfClose) { pos = gt + 1; continue }
    const end = findEnd(xml, 'c', gt)
    if (end < 0) break
    pos = end + 3
    if (col >= COLS_MAX) continue
    const inner = xml.slice(gt + 1, end)
    const t = fa(head, 't') ?? 'n'
    const v = elementText(inner, 'v')
    let text: string | undefined
    if (t === 'inlineStr') { const is = elementInner(inner, 'is'); text = is === undefined ? undefined : itemText(is) }
    else if (v !== undefined) {
      if (t === 's') { const i = Number(v); text = Number.isInteger(i) && i >= 0 && i < book.shared.length ? (book.shared.get(i) ?? '(text not read: the workbook holds too much text)') : '' }
      else if (t === 'b') text = v.trim() === '1' || v.trim() === 'true' ? 'TRUE' : 'FALSE'
      else if (t === 'str' || t === 'e' || t === 'd') text = unescapeOoxml(unescapeXml(v))
      else {
        const kind = book.styles.get(Number(fa(head, 's') ?? 0))
        const num = v.trim()
        text = kind === undefined || num === '' || !Number.isFinite(Number(num)) ? num
          : kind === 'date' ? serialDate(Number(num), book.date1904) : `${(Number(num) * 100).toFixed(kind)}%`
      }
    }
    if (text === undefined) {
      // a formula without a stored result shows as its formula (office-parse.ts formulaStubsAsText)
      const f = elementText(inner, 'f')
      if (f) text = '=' + unescapeXml(f)
    }
    if (text !== undefined) cells[col] = text
  }
  return cells
}

/** The text of the first <name>…</name> in `xml` (unescaped later), or undefined. */
function elementText(xml: string, name: string): string | undefined {
  const s = findTag(xml, name, 0)
  if (s < 0) return undefined
  const gt = xml.indexOf('>', s)
  if (gt < 0 || xml.charCodeAt(gt - 1) === 0x2f) return undefined
  const e = findEnd(xml, name, gt)
  return e < 0 ? undefined : xml.slice(gt + 1, e)
}
const elementInner = elementText

/** An attribute of a cell or row tag, found with indexOf (attr() builds a RegExp per call: too slow per cell). */
function fa(head: string, name: string): string | undefined {
  const pat = name + '="'
  for (let i = head.indexOf(pat); i >= 0; i = head.indexOf(pat, i + 1)) {
    const c = head.charCodeAt(i - 1)
    if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) continue
    const e = head.indexOf('"', i + pat.length)
    return e < 0 ? undefined : head.slice(i + pat.length, e)
  }
  return undefined
}

const filled = (cells: string[]) => cells.some((c) => c !== undefined && c !== '')

/** Every row with data of a sheet, in order. `onRow` returns false to stop reading the sheet. */
/** A sheet's declared range (<dimension ref="A1:H40"/>), 0-based, or null. */
type Dim = { s: { r: number; c: number }; e: { r: number; c: number } }
function dimOf(ref: string | undefined): Dim | null {
  const m = ref ? /^\$?([A-Za-z]{1,3})\$?(\d{1,7})(?::\$?([A-Za-z]{1,3})\$?(\d{1,7}))?$/.exec(ref.trim()) : null
  if (!m) return null
  const s = { r: Number(m[2]) - 1, c: colIndex(m[1]!) }
  const e = m[3] ? { r: Number(m[4]) - 1, c: colIndex(m[3]) } : { ...s }
  return s.r >= 0 && e.r >= s.r && e.c >= s.c && s.c < COLS_MAX ? { s, e: { r: e.r, c: Math.min(e.c, COLS_MAX - 1) } } : null
}

/** Every row with data of a sheet, in order. `onRow` returns false to stop reading the sheet. `onDim` gets the sheet's
 * declared range (or null) before the first row. */
async function scanSheet(bytes: Uint8Array, e: ZipEntry, book: Book, onRow: (row: Row) => boolean | void, onDim?: (d: Dim | null) => void): Promise<void> {
  let carry = ''
  let last = 0
  let dimSeen = !onDim
  for await (const piece of pieces(bytes, e)) {
    const xml = carry + piece
    let pos = 0
    if (!dimSeen) {
      // the dimension comes before the sheet's data (CT_Worksheet's order)
      const data = findTag(xml, 'sheetData', 0)
      if (data >= 0 || xml.length > CARRY_MAX) {
        const head = data >= 0 ? xml.slice(0, data) : ''
        const d = findTag(head, 'dimension', 0)
        const gt = d >= 0 ? head.indexOf('>', d) : -1
        onDim!(gt >= 0 ? dimOf(fa(head.slice(d, gt), 'ref')) : null)
        dimSeen = true
      } else { carry = xml; continue }
    }
    for (;;) {
      const s = findTag(xml, 'row', pos)
      if (s < 0) { const lt = xml.lastIndexOf('<'); pos = Math.max(pos, lt < 0 ? xml.length : lt); break }
      const gt = xml.indexOf('>', s)
      if (gt < 0) { pos = s; break }
      const head = xml.slice(s, gt)
      const rAttr = Number(fa(head, 'r'))
      const r = Number.isInteger(rAttr) && rAttr > 0 ? rAttr : last + 1
      if (xml.charCodeAt(gt - 1) === 0x2f) { last = r; pos = gt + 1; continue }
      const end = findEnd(xml, 'row', gt)
      if (end < 0) { pos = s; break }
      last = r
      const cells = rowCells(xml.slice(gt + 1, end), book)
      pos = end + 5
      if (filled(cells) && onRow({ r, cells }) === false) return
    }
    carry = xml.slice(pos)
    if (carry.length > CARRY_MAX) throw tooComplex('a sheet row does not end')
  }
}

/** A row's fields from column c0 to c1, without empty ones at the end. */
const rowFields = (cells: string[], c0 = 0, c1 = cells.length - 1) => {
  const out: string[] = []
  for (let c = c0; c <= Math.min(c1, cells.length - 1); c++) out.push(field(cells[c] ?? ''))
  while (out.length && out[out.length - 1] === '') out.pop()
  return out
}
const rowLine = (cells: string[], c0 = 0, c1 = cells.length - 1) => rowFields(cells, c0, c1).join('\t')
const labelName = (s: string) => s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim()
const n = (v: number) => v.toLocaleString('en-US')

/** Rows as text lines, with `# row N` where the next row is not the one after the last. */
function rowLines(rows: Row[], from: number, c0?: number, c1?: number): string[] {
  const out: string[] = []
  let next = from
  for (const row of rows) {
    if (row.r !== next) out.push(`# row ${row.r}`)
    out.push(rowLine(row.cells, c0, c1))
    next = row.r + 1
  }
  return out
}

async function book(bytes: Uint8Array): Promise<{ ix: Index; book: Book }> {
  const ix = index(bytes)
  const { sheets, date1904 } = sheetsOf(bytes, ix)
  const styles = cellStyles(bytes, ix)
  const { shared, cut } = await sharedText(bytes, ix)
  return { ix, book: { sheets, date1904, styles, shared, sharedCut: cut } }
}

// ---------------- the whole workbook, or its overview ----------------

interface SheetFacts { ref: SheetRef; rows: number; first: number; last: number; cols: number; head: Row[]; tail: Row[]; missing: boolean }

/** The workbook's text: whole when it fits in FULL_TEXT_MAX (`fullMax`, for tests), else its overview. */
export async function bigSheetText(bytes: Uint8Array, o: { fullMax?: number } = {}): Promise<string> {
  const fullMax = o.fullMax ?? FULL_TEXT_MAX
  const { ix, book: b } = await book(bytes)
  const facts: SheetFacts[] = []
  // sheet XML is about four times its tab-separated text (an export of numbers and short text, measured): far past
  // the whole-text size the whole text is not tried, which keeps up to FULL_TEXT_MAX of lines out of memory
  const declared = b.sheets.reduce((n, s) => n + (find(ix, s.part)?.usize ?? 0), 0)
  let full: string[] | null = declared > FULL_TRY_XML_FACTOR * fullMax ? null : []
  let fullSize = 0
  for (const ref of b.sheets) {
    const e = find(ix, ref.part)
    const f: SheetFacts = { ref, rows: 0, first: 0, last: 0, cols: 0, head: [], tail: [], missing: !e }
    facts.push(f)
    if (!e) continue
    // the whole sheet as office-parse.ts sheetPart gives it (SheetJS): from the declared range's first row and column,
    // every row padded with empty fields to its last column; `fields` is -1 for a `# row N` line
    const lines: string[] | null = full ? [] : null
    const fields: number[] = []
    let dim: Dim | null = null
    let next = 1, c0 = 0
    await scanSheet(bytes, e, b, (row) => {
      if (!f.rows) f.first = row.r
      f.rows++
      f.last = row.r
      if (row.cells.length > f.cols) f.cols = row.cells.length
      if (f.head.length < OVERVIEW_HEAD) f.head.push(row)
      else { f.tail.push(row); if (f.tail.length > OVERVIEW_TAIL) f.tail.shift() }
      if (full && lines) {
        if (row.r !== next) { lines.push(`# row ${row.r}`); fields.push(-1) }
        const fs = rowFields(row.cells, c0)
        const line = fs.join('\t')
        lines.push(line)
        fields.push(fs.length)
        fullSize += line.length + 12
        next = row.r + 1
        if (fullSize > fullMax) { full = null; lines.length = 0; fields.length = 0 }
      }
    }, (d) => { dim = d; if (d) { next = d.s.r + 1; c0 = d.s.c } })
    if (full && lines) {
      if (!f.rows) full.push(`# sheet: ${labelName(ref.name)} (tab-separated)\n`)
      else {
        const d = dim as Dim | null
        const r0 = d ? d.s.r + 1 : 1
        // SheetJS keeps the declared last column unless the declared range is absurd (office-parse.ts boundRange)
        const declared = d && (f.last - r0 + 1) * (d.e.c - c0 + 1) <= RANGE_CELLS_MAX ? d.e.c : -1
        const c1 = Math.max(declared, f.cols - 1, c0)
        const width = c1 - c0 + 1
        for (let i = 0; i < lines.length; i++) if (fields[i]! >= 0 && fields[i]! < width) lines[i] += '\t'.repeat(width - Math.max(fields[i]!, 1))
        full.push([`# sheet: ${labelName(ref.name)} · ${colName(c0)}${r0}:${colName(c1)}${f.last} (tab-separated)`, ...lines].join('\n'))
      }
    }
  }
  if (full) return full.join('\n\n')
  return overview(facts, b)
}

function overview(facts: SheetFacts[], b: Book): string {
  const out: string[] = [
    `# workbook: ${facts.length} sheet${facts.length === 1 ? '' : 's'}, too large to give whole. Each sheet shows its first ${OVERVIEW_HEAD} and last ${OVERVIEW_TAIL} rows with data. ` +
    `Read any other rows with read's sheet and range (for example sheet "${labelName(facts[0]!.ref.name)}", range "A${OVERVIEW_HEAD + 1}:${colName(Math.max(0, (facts[0]!.cols || 1) - 1))}${OVERVIEW_HEAD + PART_ROWS_MAX}"), at most ${n(PART_ROWS_MAX)} rows per read.` +
    (b.sharedCut ? ' Some cell text was not read (the workbook holds too much text).' : ''),
  ]
  let size = out[0]!.length
  for (const f of facts) {
    const name = labelName(f.ref.name)
    const hidden = f.ref.hidden ? ' (hidden sheet)' : ''
    if (f.missing) { out.push(`# sheet: ${name} (tab-separated)\n# this sheet's part is missing from the file${hidden}`); continue }
    if (!f.rows) { out.push(`# sheet: ${name} (tab-separated)\n# no rows with data${hidden}`); continue }
    const lastCol = colName(Math.max(0, f.cols - 1))
    const label = `# sheet: ${name} · A1:${lastCol}${f.last} (tab-separated)`
    const shown = f.head.length + f.tail.length
    const about = `# ${n(f.rows)} row${f.rows === 1 ? '' : 's'} with data, rows ${n(f.first)} to ${n(f.last)}, columns A to ${lastCol}${hidden}`
    if (size > OVERVIEW_MAX) { out.push(`${label}\n${about}; not shown here (read it with sheet "${name}" and a range)`); continue }
    const lines = [label, about, `# row ${f.first}`, ...rowLines(f.head, f.first)]
    if (f.tail.length) {
      const gapFrom = f.head[f.head.length - 1]!.r + 1, gapTo = f.tail[0]!.r - 1
      if (f.rows > shown && gapTo >= gapFrom) lines.push(`# ${n(f.rows - shown)} rows with data not shown here: read them with sheet "${name}", range "A${gapFrom}:${lastCol}${gapTo}"`)
      lines.push(`# row ${f.tail[0]!.r}`, ...rowLines(f.tail, f.tail[0]!.r))
    }
    const text = lines.join('\n')
    size += text.length
    out.push(text)
  }
  return out.join('\n\n')
}

// ---------------- one range ----------------

/** A range as read takes it: "A1:H2000", "B5", "100:300" (rows), "C:F" (columns, every row), or a row like "1200:". */
export function parseRange(s: string | undefined): { c0: number; r0: number; c1: number; r1: number } {
  if (!s || !s.trim()) return { c0: 0, r0: 1, c1: COLS_MAX - 1, r1: Infinity }
  const m = /^\s*\$?([A-Za-z]{1,3})?\$?(\d{1,7})?\s*(?::\s*\$?([A-Za-z]{1,3})?\$?(\d{1,7})?)?\s*$/.exec(s)
  if (!m || (!m[1] && !m[2])) throw new ToolError(`range "${s}" is not a range like "A1:H2000", "100:300" or "C:F"`, 'bad_range')
  const one = m[3] === undefined && m[4] === undefined && !s.includes(':')
  const c0 = m[1] ? colIndex(m[1]) : 0
  const r0 = m[2] ? Number(m[2]) : 1
  const c1 = m[3] ? colIndex(m[3]) : one && m[1] ? c0 : COLS_MAX - 1
  const r1 = m[4] ? Number(m[4]) : one && m[2] ? r0 : Infinity
  if (r0 < 1 || r1 < r0 || c1 < c0 || c0 >= COLS_MAX) throw new ToolError(`range "${s}" is empty (its end comes before its start)`, 'bad_range')
  return { c0, r0, c1: Math.min(c1, COLS_MAX - 1), r1 }
}

/** The sheet read asks for: by its name (exact, else ignoring case and spaces at the ends), else the first sheet. */
export function pickSheet<T extends { name: string }>(sheets: T[], name: string | undefined): T {
  if (name === undefined || name === '') return sheets[0]!
  const s = sheets.find((x) => x.name === name) ?? sheets.find((x) => x.name.trim().toLowerCase() === name.trim().toLowerCase())
  if (!s) throw new ToolError(`this workbook has no sheet "${name}"; its sheets: ${sheets.map((x) => `"${labelName(x.name)}"`).join(', ')}`, 'bad_sheet')
  return s
}

/** The rows of one range of one sheet (at most PART_ROWS_MAX rows with data), and where to read on. */
export async function bigSheetPart(bytes: Uint8Array, ask: SheetAsk): Promise<string> {
  const { ix, book: b } = await book(bytes)
  const ref = pickSheet(b.sheets, ask.sheet)
  const range = parseRange(ask.range)
  const e = find(ix, ref.part)
  const name = labelName(ref.name)
  if (!e) return `# sheet: ${name} (tab-separated)\n# this sheet's part is missing from the file`
  const rows: Row[] = []
  let size = 0
  let more: number | null = null
  let lastRow = 0
  let cols = 0
  await scanSheet(bytes, e, b, (row) => {
    lastRow = row.r
    if (row.r < range.r0) return
    if (row.r > range.r1) return false
    if (rows.length >= PART_ROWS_MAX || size > PART_TEXT_MAX) { more = row.r; return false }
    const cut = row.cells.slice(0, range.c1 + 1)
    if (!filled(cut.slice(range.c0))) return
    rows.push({ r: row.r, cells: cut })
    if (cut.length > cols) cols = cut.length
    size += rowLine(cut, range.c0, range.c1).length + 1
  })
  const c0 = colName(range.c0)
  if (!rows.length) {
    const end = more ?? lastRow
    return `# sheet: ${name} (tab-separated)\n# no rows with data in ${ask.range ?? 'this sheet'}${end ? `; the sheet's rows with data end at row ${n(lastRow)}` : ''}`
  }
  const c1 = colName(Math.min(range.c1, Math.max(range.c0, cols - 1)))
  const last = rows[rows.length - 1]!.r
  const out = [`# sheet: ${name} · ${c0}${rows[0]!.r}:${c1}${last} (tab-separated)`, ...rowLines(rows, rows[0]!.r, range.c0, range.c1)]
  if (more !== null) out.push(`# more rows with data follow (from row ${n(more)}): read on with sheet "${name}", range "${c0}${more}:${c1}${range.r1 === Infinity ? '' : range.r1}"`)
  return out.join('\n')
}
