// The office worker's data mode (query_data, tools/query-data.ts; docs/decisions/20261118-data-tool.md): team data files
// (CSV, TSV, xlsx / xls / ods sheets, JSON, JSONL) copied into the worker's empty work folder are loaded into a SQLite
// database there (bun:sqlite), one table per file or sheet, and one read-only query runs over them. Small results go
// back as JSON; with `save`, the whole result is written into the work folder as CSV, TSV or xlsx (one file per value
// of `splitBy`), and the server places those files through make_file's save path.
// Runs only in the office worker (files/office-worker.ts), inside the converter isolation: no network, only the work
// folder readable and writable, a memory watchdog, a time limit and a disk cap (tools/query-data.ts). The database holds
// only the copies of the files the person may read, so a query can reach nothing else.
// - Columns: the header row (header_row, 1-based; 0 = no header: c1, c2, ...); empty or repeated names get a number.
//   A column whose every value is a number (no leading zero like "007", at most 15 digits, "1,234" allowed) is
//   INTEGER or REAL, anything else TEXT; empty cells are NULL. Dates stay text as written; dates of a sheet become
//   "YYYY-MM-DD" (or "YYYY-MM-DD HH:MM:SS").
// - CSV: UTF-8 (BOM or not), UTF-16 with a BOM, else CP949 (Korean Excel's "CSV"); the delimiter is the one of
//   , tab ; | that the first line has most of (a .tsv is tab). Parsed twice, streamed: once for the types, once to load.
// - SQL: one SELECT / WITH / VALUES statement, run with PRAGMA query_only (nothing can be changed or attached for
//   writing), as a subquery so repeated result column names stay apart ("x", "x:1").
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import * as XLSX from 'xlsx'
import { ToolError } from '../policy/errors'
import { boundRange, SHEET_ROWS_MAX } from './office-parse'
import { checkZip, isZip } from './zip-guard'

export const DATA_QUERY_MODE = 'data-query'
/** formats the data mode loads */
export const DATA_EXT = new Set(['csv', 'tsv', 'txt', 'xlsx', 'xls', 'ods', 'json', 'jsonl', 'ndjson'])
export const SHEET_EXT = new Set(['xlsx', 'xls', 'ods'])
/** columns of one table (SQLite's own limit is 2,000) */
export const DATA_COLUMNS_MAX = 1000
/** sheets of one workbook loaded as tables */
export const DATA_SHEETS_MAX = 50
/** sample rows of each table in the description */
export const SAMPLE_ROWS = 5
/** rows of an xlsx result (Excel's last row, less the header) */
export const XLSX_ROWS_MAX = 1_048_575
/** characters of one cell sent back inline (the saved files keep the whole cell) */
const CELL_CHARS_MAX = 300

export type ColumnType = 'integer' | 'real' | 'text'
export interface DataInput {
  /** the copy's file name in the work folder */
  file: string
  /** the team path, for messages */
  name: string
  ext: string
  /** the table name; a workbook's further sheets get "<table>_2", "<table>_3", ... */
  table: string
}
export interface DataQueryRequest {
  inputs: DataInput[]
  sql?: string
  /** load only this sheet of each workbook */
  sheet?: string
  /** 1-based header row; 0 = no header row */
  headerRow?: number
  /** result rows sent back inline */
  show: number
  save?: { format: 'csv' | 'tsv' | 'xlsx'; splitBy?: string; maxFiles: number }
}
export interface TableInfo {
  table: string
  source: string
  sheet?: string
  columns: { name: string; type: ColumnType }[]
  rows: number
  sample: unknown[][]
  /** what the load changed or noticed (encoding, delimiter, rows with more fields than the header) */
  notes: string[]
}
export interface DataQueryResponse {
  tables: TableInfo[]
  /** sheets left out because `sheet` named another one, per workbook */
  skippedSheets: { source: string; sheets: string[] }[]
  result?: { columns: string[]; rows: unknown[][]; total: number; cut: boolean }
  outputs?: { file: string; value: string | null; rows: number }[]
}

// ---------------------------------------------------------------- values and types

const NUM = /^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)?(?:\.\d+)?(?:[eE][+-]?\d+)?$/
const INT = /^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)$/

/** What a text cell is as a number: an integer, a real, or not a number (a code like "007", a 16-digit card number) */
export function numberKind(s: string): 'integer' | 'real' | null {
  const t = s.trim()
  if (!t || !/\d/.test(t) || !NUM.test(t)) return null
  const digits = t.replace(/[^\d]/g, '')
  // a leading zero before another digit is a code ("007", "0101"), not a number; "0", "0.5" are numbers
  if (/^[+-]?0\d/.test(t.replace(/,/g, ''))) return null
  if (digits.length > 15) return null
  return INT.test(t) ? 'integer' : 'real'
}

/** per-column what has been seen */
class ColumnStats {
  seen = 0
  int = true
  num = true
  add(v: unknown) {
    if (v === null || v === undefined || v === '') return
    this.seen++
    if (typeof v === 'number') { if (!Number.isInteger(v)) this.int = false; return }
    if (typeof v === 'boolean') return
    if (typeof v === 'string') {
      const k = numberKind(v)
      if (!k) { this.num = false; this.int = false } else if (k === 'real') this.int = false
      return
    }
    this.num = false
    this.int = false
  }
  type(): ColumnType { return this.seen === 0 || !this.num ? 'text' : this.int ? 'integer' : 'real' }
}

const pad = (n: number) => String(n).padStart(2, '0')
/** a sheet's date as text: "YYYY-MM-DD" at midnight, else "YYYY-MM-DD HH:MM:SS" (the worker runs with TZ=UTC) */
function dateText(d: Date): string {
  if (Number.isNaN(d.getTime())) return ''
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  const s = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds()
  return s === 0 ? day : `${day} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

/** A cell as it goes into its column. */
export function cellFor(v: unknown, type: ColumnType): string | number | null {
  if (v === null || v === undefined || v === '') return null
  if (v instanceof Date) return dateText(v) || null
  if (typeof v === 'boolean') return type === 'text' ? (v ? 'TRUE' : 'FALSE') : v ? 1 : 0
  if (typeof v === 'number') return Number.isFinite(v) ? (type === 'text' ? String(v) : v) : null
  if (typeof v === 'object') return JSON.stringify(v)
  const s = String(v)
  if (type === 'text') return s
  const n = Number(s.trim().replace(/,/g, ''))
  return Number.isFinite(n) ? n : s
}

/** Column names from a header row: trimmed, one line; empty ones "c<N>", repeated ones get " 2", " 3" ... */
export function columnNames(header: unknown[], width: number): string[] {
  const used = new Set<string>()
  const out: string[] = []
  for (let i = 0; i < width; i++) {
    const raw = header[i] instanceof Date ? dateText(header[i] as Date) : header[i] == null ? '' : String(header[i])
    let name = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 120) || `c${i + 1}`
    const base = name
    for (let k = 2; used.has(name.toLowerCase()); k++) name = `${base} ${k}`
    used.add(name.toLowerCase())
    out.push(name)
  }
  return out
}

export const quoteId = (s: string) => '"' + s.replace(/"/g, '""') + '"'
/** a name as SQL needs it: bare when it is a plain word, else in double quotes */
export const sqlName = (s: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s) && !SQL_WORDS.has(s.toLowerCase()) ? s : quoteId(s))
const SQL_WORDS = new Set(['select', 'from', 'where', 'group', 'order', 'by', 'limit', 'table', 'index', 'values', 'join', 'on', 'as', 'and', 'or', 'not', 'null', 'case', 'when', 'then', 'else', 'end', 'having', 'union', 'all', 'distinct', 'in', 'is', 'like', 'between', 'exists', 'into', 'key', 'default', 'check', 'primary', 'references', 'transaction', 'to', 'with', 'offset', 'desc', 'asc', 'cast', 'over', 'window', 'partition', 'collate', 'escape', 'natural', 'left', 'right', 'inner', 'outer', 'cross', 'full', 'using', 'except', 'intersect', 'glob', 'match', 'regexp', 'if', 'set', 'update', 'delete', 'insert', 'create', 'drop', 'alter', 'add', 'column', 'constraint', 'unique', 'foreign', 'autoincrement', 'replace', 'abort', 'action', 'after', 'before', 'begin', 'commit', 'rollback', 'view', 'trigger', 'temp', 'temporary', 'virtual', 'group'])

// ---------------------------------------------------------------- CSV

/** RFC 4180 records, fed in pieces: quoted fields may hold the delimiter, doubled quotes and line breaks; \r\n, \n and
 * a lone \r end a record. Whole records are cut out of the text with slices (no character-by-character building), and
 * a record that runs past the end of a piece waits for the next one. */
export class CsvParser {
  private buf = ''
  private stopped = false
  private readonly d: number
  constructor(delim: string, private onRow: (r: string[]) => boolean | void) { this.d = delim.charCodeAt(0) }
  feed(s: string): boolean {
    if (this.stopped) return false
    this.buf = this.buf ? this.buf + s : s
    const at = this.parse(false)
    this.buf = at >= this.buf.length ? '' : this.buf.slice(at)
    return !this.stopped
  }
  end() { if (!this.stopped && this.buf) this.parse(true); this.buf = '' }
  /** parses whole records from the buffer; returns where the first one that is not whole yet starts */
  private parse(final: boolean): number {
    const b = this.buf, n = b.length, d = this.d
    let i = 0
    while (i < n && !this.stopped) {
      const rs = i
      const row: string[] = []
      let done = false
      for (;;) {
        let field: string
        if (b.charCodeAt(i) === 34) {
          // quoted: up to the quote that is not doubled
          let j = i + 1
          let parts: string[] | null = null
          let from = j
          for (;;) {
            const k = b.indexOf('"', j)
            if (k < 0) { if (!final) return rs; j = n; break }
            if (b.charCodeAt(k + 1) === 34) { (parts ??= []).push(b.slice(from, k + 1)); j = k + 2; from = j; continue }
            if (k + 1 >= n && !final) return rs
            j = k
            break
          }
          field = parts ? parts.join('') + b.slice(from, j) : b.slice(from, j)
          i = Math.min(n, j + 1)
          // anything after the closing quote up to the delimiter belongs to the field ("a"b -> ab)
          let k = i
          while (k < n) { const c = b.charCodeAt(k); if (c === d || c === 10 || c === 13) break; k++ }
          if (k > i) field += b.slice(i, k)
          i = k
        } else {
          let k = i
          while (k < n) { const c = b.charCodeAt(k); if (c === d || c === 10 || c === 13) break; k++ }
          field = b.slice(i, k)
          i = k
        }
        row.push(field)
        if (i >= n) { if (!final) return rs; done = true; break }
        const c = b.charCodeAt(i)
        if (c === d) { i++; if (i >= n && !final) return rs; if (i >= n) { row.push(''); done = true; break } continue }
        if (c === 13) { if (i + 1 >= n && !final) return rs; i += b.charCodeAt(i + 1) === 10 ? 2 : 1; break }
        i++ // \n
        break
      }
      if (this.onRow(row) === false) { this.stopped = true; return n }
      if (done) return n
    }
    return i
  }
}

type Encoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'euc-kr'

const CHUNK = 1 << 20

/** the file's text in pieces, decoded as `enc` (fatal for UTF-8: a wrong guess throws) */
function* textChunks(path: string, enc: Encoding): Generator<string> {
  const fd = fs.openSync(path, 'r')
  try {
    const dec = new TextDecoder(enc, { fatal: enc === 'utf-8', ignoreBOM: false })
    const buf = Buffer.alloc(CHUNK)
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK, null)
      if (n <= 0) break
      yield dec.decode(buf.subarray(0, n), { stream: true })
    }
    const tail = dec.decode()
    if (tail) yield tail
  } finally { fs.closeSync(fd) }
}

/** UTF-8 (with or without a BOM), UTF-16 by its BOM, else CP949 when the bytes are not valid UTF-8 */
function sniffEncoding(path: string): Encoding {
  const fd = fs.openSync(path, 'r')
  const head = Buffer.alloc(4)
  try { fs.readSync(fd, head, 0, 4, 0) } finally { fs.closeSync(fd) }
  if (head[0] === 0xff && head[1] === 0xfe) return 'utf-16le'
  if (head[0] === 0xfe && head[1] === 0xff) return 'utf-16be'
  try { for (const _ of textChunks(path, 'utf-8')) { /* validate */ } return 'utf-8' } catch { return 'euc-kr' }
}

/** the delimiter the first record uses most (outside quotes): , tab ; or | */
export function sniffDelimiter(firstText: string): string {
  const counts = new Map<string, number>([[',', 0], ['\t', 0], [';', 0], ['|', 0]])
  let q = false
  for (const ch of firstText) {
    if (ch === '"') q = !q
    else if (!q && (ch === '\n' || ch === '\r')) break
    else if (!q && counts.has(ch)) counts.set(ch, counts.get(ch)! + 1)
  }
  let best = ',', n = 0
  for (const [d, c] of counts) if (c > n) { best = d; n = c }
  return best
}

// ---------------------------------------------------------------- loading

/** rows that can be walked twice (the types, then the insert); `firstRow`: the 1-based row of the first one (a sheet's
 * cells can start below row 1); `keyed`: the first row is the names of the fields (JSON records), whatever header_row says */
interface Sheetish { name?: string; rows: () => Iterable<unknown[]>; notes: string[]; firstRow?: number; keyed?: boolean }

const blank = (r: unknown[]) => r.every((v) => v === null || v === undefined || v === '')

function createTable(db: Database, table: string, cols: string[], types: ColumnType[]) {
  db.run(`CREATE TABLE ${quoteId(table)} (${cols.map((c, i) => `${quoteId(c)} ${types[i] === 'integer' ? 'INTEGER' : types[i] === 'real' ? 'REAL' : 'TEXT'}`).join(', ')})`)
}

/** Loads one table: a first walk finds the header, the width (the widest row: no field is ever dropped) and each
 * column's type, a second inserts the rows. Blank rows are left out. */
function loadRows(db: Database, table: string, source: string, s: Sheetish, headerRowAsked: number): TableInfo {
  const headerRow = s.keyed ? 1 : headerRowAsked
  const skip = s.keyed ? 0 : Math.max(0, headerRow - (s.firstRow ?? 1))
  const where = `'${source}'${s.name !== undefined ? ` (sheet '${s.name}')` : ''}`
  let header: unknown[] = []
  let width = 0
  const stats: ColumnStats[] = []
  {
    let i = 0, headerTaken = headerRow === 0
    for (const r of s.rows()) {
      if (i++ < skip) continue
      if (!headerTaken) { header = r; headerTaken = true; width = r.length; continue }
      if (blank(r)) continue
      if (r.length > width) width = r.length
      if (width > DATA_COLUMNS_MAX) break
      for (let c = 0; c < r.length; c++) (stats[c] ??= new ColumnStats()).add(r[c])
    }
  }
  // a header with empty cells at its end: those columns only when a row has something there
  while (width > 0 && (header[width - 1] === null || header[width - 1] === undefined || header[width - 1] === '') && !stats[width - 1]?.seen) width--
  if (width > DATA_COLUMNS_MAX) throw new ToolError(`${where} has more than ${DATA_COLUMNS_MAX} columns, more than can be loaded`)
  if (width === 0) width = 1
  const cols = columnNames(header, width)
  const types = cols.map((_, c) => stats[c]?.type() ?? 'text')
  createTable(db, table, cols, types)
  const ins = db.prepare(`INSERT INTO ${quoteId(table)} VALUES (${cols.map(() => '?').join(', ')})`)
  const sample: unknown[][] = []
  let rows = 0
  let wider = 0
  const named = header.length
  db.transaction(() => {
    let i = 0, headerTaken = headerRow === 0
    const vals = new Array(cols.length)
    for (const r of s.rows()) {
      if (i++ < skip) continue
      if (!headerTaken) { headerTaken = true; continue }
      if (blank(r)) continue
      if (headerRow > 0 && r.length > named && !blank(r.slice(named))) wider++
      for (let c = 0; c < cols.length; c++) vals[c] = cellFor(r[c], types[c]!)
      ins.run(...vals)
      if (sample.length < SAMPLE_ROWS) sample.push([...vals])
      rows++
    }
  })()
  ins.finalize()
  const notes = [...s.notes]
  if (wider) notes.push(`${wider} row${wider === 1 ? ' has' : 's have'} more fields than the header row; the extra fields are in the columns named c<N>`)
  return { table, source, ...(s.name !== undefined ? { sheet: s.name } : {}), columns: cols.map((name, c) => ({ name, type: types[c]! })), rows, sample, notes }
}

function csvSheet(path: string, ext: string): Sheetish {
  const enc = sniffEncoding(path)
  let firstText = ''
  for (const s of textChunks(path, enc)) { firstText = s.slice(0, 65536); break }
  const delim = ext === 'tsv' ? '\t' : sniffDelimiter(firstText.replace(/^\uFEFF/, ''))
  const notes: string[] = []
  if (enc === 'euc-kr') notes.push('read as Korean Windows text (CP949)')
  if (enc.startsWith('utf-16')) notes.push('read as UTF-16 text')
  if (delim !== ',' && ext !== 'tsv') notes.push(`fields separated by ${delim === '\t' ? 'tabs' : `"${delim}"`}`)
  return {
    notes,
    rows: () => ({
      // the records of one piece of the file at a time
      *[Symbol.iterator]() {
        const pending: string[][] = []
        const p = new CsvParser(delim, (r) => { pending.push(r) })
        let first = true
        for (let s of textChunks(path, enc)) {
          if (first) { first = false; if (s.charCodeAt(0) === 0xfeff) s = s.slice(1) }
          p.feed(s)
          for (const r of pending) yield r
          pending.length = 0
        }
        p.end()
        for (const r of pending) yield r
      },
    }),
  }
}

function sheetsOf(path: string, name: string, only: string | undefined): { sheets: Sheetish[]; skipped: string[] } {
  const bytes = new Uint8Array(fs.readFileSync(path))
  if (isZip(bytes)) checkZip(bytes)
  let wb: XLSX.WorkBook
  try {
    wb = XLSX.read(bytes, { type: 'array', dense: true, cellDates: true, sheetRows: SHEET_ROWS_MAX, cellFormula: false, cellHTML: false, cellStyles: false, bookVBA: false, bookFiles: false })
  } catch (e) {
    if (e instanceof ToolError) throw e
    throw new ToolError(`could not read the spreadsheet '${name}' (${String((e as Error)?.message ?? e).slice(0, 200)})`)
  }
  let names = wb.SheetNames
  const skipped: string[] = []
  if (only !== undefined) {
    const want = only.normalize('NFC').trim().toLowerCase()
    const hit = names.find((n) => n.normalize('NFC').trim().toLowerCase() === want)
    if (!hit) throw new ToolError(`'${name}' has no sheet named '${only}'; its sheets: ${names.map((n) => `'${n}'`).join(', ')}`)
    skipped.push(...names.filter((n) => n !== hit))
    names = [hit]
  }
  if (names.length > DATA_SHEETS_MAX) { skipped.push(...names.slice(DATA_SHEETS_MAX)); names = names.slice(0, DATA_SHEETS_MAX) }
  const sheets: Sheetish[] = []
  for (const n of names) {
    const ws = wb.Sheets[n]!
    boundRange(ws)
    if (!ws['!ref']) continue
    const firstRow = XLSX.utils.decode_range(ws['!ref']).s.r + 1
    const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null, blankrows: true })
    sheets.push({ name: n, rows: () => grid, notes: [], firstRow })
  }
  return { sheets, skipped }
}

/** JSON: an array of records (or of arrays, the first one the header), or an object holding such an array; JSONL /
 * NDJSON: a record per line. A record's nested values are kept as JSON text (json_extract reads them). */
function jsonSheet(path: string, ext: string, name: string): Sheetish {
  const text = fs.readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
  let items: unknown[]
  if (ext === 'json') {
    let v: unknown
    try { v = JSON.parse(text) } catch (e) { throw new ToolError(`'${name}' is not valid JSON (${String((e as Error).message).slice(0, 200)})`) }
    if (!Array.isArray(v) && v && typeof v === 'object') {
      const arr = Object.values(v as Record<string, unknown>).find((x) => Array.isArray(x) && x.length > 0 && typeof x[0] === 'object' && x[0] !== null)
      v = arr ?? [v]
    }
    if (!Array.isArray(v)) throw new ToolError(`'${name}' holds no list of records to load as a table`)
    items = v
  } else {
    items = []
    let n = 0
    for (const line of text.split(/\r?\n/)) {
      n++
      if (!line.trim()) continue
      try { items.push(JSON.parse(line)) } catch { throw new ToolError(`'${name}' line ${n} is not valid JSON`) }
    }
  }
  if (items.length && Array.isArray(items[0])) return { notes: [], rows: () => items as unknown[][] }
  const keys: string[] = []
  const seen = new Set<string>()
  for (const it of items) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) continue
    for (const k of Object.keys(it)) if (!seen.has(k)) { seen.add(k); keys.push(k); if (keys.length > DATA_COLUMNS_MAX) throw new ToolError(`'${name}' has more than ${DATA_COLUMNS_MAX} different fields, more than can be loaded as columns`) }
  }
  if (!keys.length) keys.push('value')
  return {
    notes: [],
    keyed: true,
    rows: () => ({
      *[Symbol.iterator]() {
        yield keys
        for (const it of items) {
          if (it && typeof it === 'object' && !Array.isArray(it)) yield keys.map((k) => (it as Record<string, unknown>)[k] ?? null)
          else yield [it]
        }
      },
    }),
  }
}

// ---------------------------------------------------------------- the query

/** The query as it runs: comments and trailing semicolons taken off the end, exactly one statement, and a read. */
export function checkedSql(sql: string): string {
  let s = sql.trim()
  // one statement: a ";" outside quotes and comments may only be followed by more ";" and space
  let i = 0, q: string | null = null
  let end = -1
  while (i < s.length) {
    const ch = s[i]!
    if (q) {
      if (ch === q) { if (s[i + 1] === q) i++; else q = null }
      i++
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { q = ch; i++; continue }
    if (ch === '[') { const j = s.indexOf(']', i); i = j < 0 ? s.length : j + 1; continue }
    if (ch === '-' && s[i + 1] === '-') { const j = s.indexOf('\n', i); i = j < 0 ? s.length : j + 1; continue }
    if (ch === '/' && s[i + 1] === '*') { const j = s.indexOf('*/', i + 2); i = j < 0 ? s.length : j + 2; continue }
    if (ch === ';') { end = i; const rest = s.slice(i).replace(/^[;\s]+/, ''); if (rest && !/^(--[^\n]*\n?|\/\*[\s\S]*?\*\/|\s)*$/.test(rest)) throw new ToolError('give one SQL statement at a time (a SELECT); nothing was run'); break }
    i++
  }
  if (q) throw new ToolError('the SQL has an unclosed quote; nothing was run')
  if (end >= 0) s = s.slice(0, end)
  const head = s.replace(/^(\s|--[^\n]*\n?|\/\*[\s\S]*?\*\/)+/, '')
  if (!/^(select|with|values)\b/i.test(head)) throw new ToolError('only a query that reads can run here (SELECT, WITH or VALUES); the files are never changed by it. Nothing was run')
  return s
}

/** a result cell for the AI: long text cut (the saved file keeps all of it) */
const shown = (v: unknown) => (typeof v === 'string' && v.length > CELL_CHARS_MAX ? v.slice(0, CELL_CHARS_MAX) + '…' : v instanceof Uint8Array ? `(${v.byteLength} bytes)` : v)

function csvField(v: unknown, delim: string): string {
  if (v === null || v === undefined) return ''
  const s = v instanceof Uint8Array ? Buffer.from(v).toString('base64') : String(v)
  return s.includes(delim) || s.includes('"') || s.includes('\n') || s.includes('\r') ? '"' + s.replace(/"/g, '""') + '"' : s
}

/** a file name part for a split value: what the team folder takes in a name */
export function splitName(v: unknown): string {
  const s = v === null || v === undefined || v === '' ? 'blank' : String(v)
  return s.normalize('NFC').replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').replace(/[. ]+$/, '').slice(0, 80) || 'blank'
}

interface Out { file: string; value: string | null; rows: number; fd?: number; buf?: string[]; grid?: unknown[][] }

/** One result file being written: CSV / TSV streamed (UTF-8 with a BOM, so Excel shows Korean right), xlsx kept until the end. */
class OutputSet {
  private outs = new Map<string, Out>()
  private n = 0
  constructor(private dir: string, private format: 'csv' | 'tsv' | 'xlsx', private columns: string[], private maxFiles: number, private splitBy: number | null, private splitCol: string | null) {}
  private open(key: string, value: string | null): Out {
    let o = this.outs.get(key)
    if (o) return o
    if (this.outs.size >= this.maxFiles) throw new ToolError(this.splitCol !== null ? `the column '${this.splitCol}' has more than ${this.maxFiles} different values, too many files to save in one go; nothing was saved. Split by a column with fewer values, or save one file` : 'too many files; nothing was saved')
    const file = `out-${++this.n}.${this.format}`
    o = { file, value, rows: 0 }
    if (this.format === 'xlsx') o.grid = [this.columns]
    else {
      o.fd = fs.openSync(path.join(this.dir, file), 'wx')
      o.buf = []
      const d = this.format === 'tsv' ? '\t' : ','
      fs.writeSync(o.fd, '﻿' + this.columns.map((c) => csvField(c, d)).join(d) + '\r\n')
    }
    this.outs.set(key, o)
    return o
  }
  add(row: unknown[]) {
    let key = '', value: string | null = null
    if (this.splitBy !== null) { const v = row[this.splitBy]; value = splitName(v); key = value.toLowerCase() }
    const o = this.open(key, value)
    o.rows++
    if (o.grid) {
      if (o.rows > XLSX_ROWS_MAX) throw new ToolError(`the result has more than ${XLSX_ROWS_MAX.toLocaleString('en-US')} rows, more than an Excel sheet holds; nothing was saved. Save it as .csv instead`)
      o.grid.push(row.map((v) => (v instanceof Uint8Array ? `(${v.byteLength} bytes)` : v)))
      return
    }
    const d = this.format === 'tsv' ? '\t' : ','
    o.buf!.push(row.map((v) => csvField(v, d)).join(d))
    if (o.buf!.length >= 2000) { fs.writeSync(o.fd!, o.buf!.join('\r\n') + '\r\n'); o.buf = [] }
  }
  finish(): { file: string; value: string | null; rows: number }[] {
    // no rows at all: one file with the header, so "save it" never leaves nothing behind
    if (!this.outs.size) this.open('', null)
    const list = [...this.outs.values()]
    for (const o of list) {
      if (o.grid) {
        const ws = XLSX.utils.aoa_to_sheet(o.grid)
        const widths = this.columns.map((c, i) => Math.min(60, Math.max(8, ...o.grid!.slice(0, 1000).map((r) => String(r[i] ?? '').length + 2), c.length + 2)))
        ws['!cols'] = widths.map((wch) => ({ wch }))
        if (o.grid.length > 1 && this.columns.length) ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: o.grid.length - 1, c: this.columns.length - 1 } }) }
        const wb = XLSX.utils.book_new()
        const sheet = (o.value ?? 'Result').replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || 'Result'
        XLSX.utils.book_append_sheet(wb, ws, sheet)
        fs.writeFileSync(path.join(this.dir, o.file), XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true }), { flag: 'wx' })
        o.grid = undefined
      } else {
        if (o.buf!.length) fs.writeSync(o.fd!, o.buf!.join('\r\n') + '\r\n')
        fs.closeSync(o.fd!)
      }
    }
    return list.map((o) => ({ file: o.file, value: o.value, rows: o.rows }))
  }
}

/** The data mode: the request's files loaded, its query run, its result back (and saved into the work folder). */
export function runDataQuery(req: DataQueryRequest, dir = process.cwd()): DataQueryResponse {
  const at = (f: string) => path.join(dir, f)
  const db = new Database(at('data.db'), { create: true })
  try {
    // a scratch database: no journal, no syncs; SQLite's sorting files go to TMPDIR, the work folder
    db.run('PRAGMA journal_mode = OFF')
    db.run('PRAGMA synchronous = OFF')
    db.run('PRAGMA cache_size = -131072')
    db.run('PRAGMA temp_store = FILE')
    const tables: TableInfo[] = []
    const skippedSheets: DataQueryResponse['skippedSheets'] = []
    const headerRow = req.headerRow ?? 1
    for (const inp of req.inputs) {
      if (SHEET_EXT.has(inp.ext)) {
        const { sheets, skipped } = sheetsOf(at(inp.file), inp.name, req.sheet)
        if (skipped.length) skippedSheets.push({ source: inp.name, sheets: skipped })
        if (!sheets.length) { tables.push({ table: inp.table, source: inp.name, columns: [], rows: 0, sample: [], notes: ['the workbook has no cells'] }); createTable(db, inp.table, ['c1'], ['text']); continue }
        sheets.forEach((s, k) => tables.push(loadRows(db, k === 0 ? inp.table : `${inp.table}_${k + 1}`, inp.name, s, headerRow)))
      } else if (inp.ext === 'json' || inp.ext === 'jsonl' || inp.ext === 'ndjson') {
        tables.push(loadRows(db, inp.table, inp.name, jsonSheet(at(inp.file), inp.ext, inp.name), headerRow))
      } else {
        tables.push(loadRows(db, inp.table, inp.name, csvSheet(at(inp.file), inp.ext), headerRow))
      }
      // the copy is in the database now: its disk goes back to the work folder's cap
      try { fs.rmSync(at(inp.file), { force: true }) } catch {}
    }
    const res: DataQueryResponse = { tables, skippedSheets }
    if (req.sql === undefined) return res
    const sql = checkedSql(req.sql)
    db.run('PRAGMA query_only = ON')
    let stmt
    try { stmt = db.query(`SELECT * FROM (\n${sql}\n)`) } catch (e) { throw new ToolError(`the SQL did not run: ${sqlError(e)}. ${tablesHint(tables)}`) }
    const columns = stmt.columnNames
    let split: number | null = null
    if (req.save?.splitBy !== undefined) {
      const want = req.save.splitBy.toLowerCase()
      split = columns.findIndex((c) => c.toLowerCase() === want)
      if (split < 0) throw new ToolError(`split_by names the column '${req.save.splitBy}', which the result does not have (its columns: ${columns.map((c) => `'${c}'`).join(', ')}); nothing was saved`)
    }
    const out = req.save ? new OutputSet(dir, req.save.format, columns, req.save.splitBy !== undefined ? req.save.maxFiles : 1, split, req.save.splitBy ?? null) : null
    const rows: unknown[][] = []
    let total = 0
    try {
      for (const o of stmt.iterate() as Iterable<Record<string, unknown>>) {
        const row = columns.map((c) => tidy(o[c]))
        total++
        if (rows.length < req.show) rows.push(row.map(shown))
        out?.add(row)
      }
    } catch (e) {
      if (e instanceof ToolError) throw e
      throw new ToolError(`the SQL did not run: ${sqlError(e)}. ${tablesHint(tables)}`)
    }
    res.result = { columns, rows, total, cut: total > rows.length }
    if (out) res.outputs = out.finish()
    return res
  } finally { db.close() }
}

/** a result value: NULL as null, a computed decimal without float noise (0.1 + 0.2 is 0.3, not 0.30000000000000004) */
const tidy = (v: unknown) => (v === undefined ? null : typeof v === 'number' && !Number.isInteger(v) && Number.isFinite(v) ? Number(v.toPrecision(15)) : typeof v === 'bigint' ? Number(v) : v)
const sqlError = (e: unknown) => String((e as Error)?.message ?? e).replace(/^SQLiteError:\s*/, '').slice(0, 400)
/** the tables and columns, for a query that did not run */
export function tablesHint(tables: TableInfo[]): string {
  return 'Tables: ' + tables.map((t) => `${sqlName(t.table)} (${t.columns.map((c) => `${sqlName(c.name)} ${c.type}`).join(', ')})`).join('; ')
}

/** The worker's entry for the data mode: the request on stdin, the response as JSON on stdout. */
export function dataQueryRequest(input: Uint8Array): Uint8Array {
  let req: DataQueryRequest
  try { req = JSON.parse(Buffer.from(input).toString('utf8')) } catch { throw new ToolError('bad data request') }
  for (const inp of req.inputs ?? []) if (!/^in-\d+\.[a-z]+$/.test(inp.file)) throw new ToolError('bad data request')
  return new TextEncoder().encode(JSON.stringify(runDataQuery(req)))
}
