// Text of spreadsheets (SheetJS: xlsx / xls / ods) and Hangul documents (hwp.ts: hwp / hwpx), and make_file's new
// Hangul documents (hwpx-write.ts: pandoc's tree and an untrusted template in, a .hwpx out). These are pure
// TypeScript and expand untrusted input in memory, so they run only in the office worker
// (files/office-worker.ts, a bounded child process started by extract.ts), never in the server process.
// Defence in depth inside the worker: zip containers are checked before a parser expands them (zip-guard.ts), a
// sheet's declared range is cut to its real cells, and the text is capped.
import * as XLSX from 'xlsx'
import { ToolError } from '../policy/errors'
import { hwpText, hwpxText } from './hwp'
import { checkZip, isZip, tooComplex } from './zip-guard'
import { docxExtraText, pptxExtraText } from './ooxml'
import { hwpxWriteRequest } from './hwpx-write'
import { HWPX_WRITE_MODE } from './hwpx-check'

export const WORKER_EXT = new Set(['xlsx', 'xls', 'ods', 'hwp', 'hwpx'])
/** worker modes that give only the parts of a .docx / .pptx that pandoc drops (ooxml.ts); pandoc still gives the body */
export const EXTRA_MODES = new Set(['docx-extra', 'pptx-extra'])
/** worker modes that make a file: stdin is the request, stdout the file's bytes (make_file's .hwpx, hwpx-write.ts) */
export const WRITE_MODES = new Set([HWPX_WRITE_MODE])
/** the worker's exit code when stderr holds a ToolError message (office-worker.ts) */
export const TOOL_ERROR_EXIT = 3
/** UTF-8 bytes of text out of one file (the worker's stdout cap in extract.ts is a little larger; hwp.ts keeps its
 * own smaller cap of 8M characters, at most 24 MiB) */
export const OFFICE_TEXT_MAX = 32 * 1024 * 1024
/** a declared sheet range larger than this is cut to the cells the sheet really has */
const RANGE_CELLS_MAX = 2_000_000
/** Excel's last row: SheetJS stops expanding rows there (an .ods row repeated a billion times) */
const SHEET_ROWS_MAX = 1_048_576

/** The cells of a dense sheet (`dense: true`): the real last row and column. */
function usedEnd(ws: XLSX.WorkSheet): { r: number; c: number } {
  const rows = (ws as { '!data'?: (XLSX.CellObject | undefined)[][] })['!data'] ?? []
  let r = -1, c = -1
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (!row) continue
    for (let j = row.length - 1; j >= 0; j--) if (row[j]) { r = i; if (j > c) c = j; break }
  }
  return { r, c }
}

/**
 * A sheet's range as sheet_to_csv walks it. Rows past the last real cell are blank and left out anyway, so the
 * range always ends there. Columns past the last real cell only add empty fields; they are cut only when the
 * declared range is absurd (a crafted A1:XFD1048576 would otherwise mean billions of empty fields).
 */
function boundRange(ws: XLSX.WorkSheet): void {
  if (!ws['!ref']) return
  const range = XLSX.utils.decode_range(ws['!ref'])
  const end = usedEnd(ws)
  if (end.r < 0) { delete ws['!ref']; return }
  range.e.r = Math.max(range.s.r, Math.min(range.e.r, end.r))
  if ((range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1) > RANGE_CELLS_MAX) range.e.c = Math.max(range.s.c, Math.min(range.e.c, end.c))
  ws['!ref'] = XLSX.utils.encode_range(range)
}

/**
 * A formula cell without a stored result (make_file writes these: the spreadsheet app calculates on open) is a
 * stub cell. It shows as its formula ("=SUM(B2:E2)"), not as a blank. Other stubs (empty styled cells) are dropped,
 * as they were before stubs were read.
 */
export function formulaStubsAsText(ws: XLSX.WorkSheet): void {
  const rows = (ws as { '!data'?: (XLSX.CellObject | undefined)[][] })['!data'] ?? []
  for (const row of rows) {
    if (!row) continue
    for (let j = 0; j < row.length; j++) {
      const c = row[j]
      if (c?.t !== 'z') continue
      row[j] = c.f ? { t: 's', v: `=${c.f}`, w: `=${c.f}` } : undefined
    }
  }
}

/** A sheet name on one line (the `# sheet:` label is parsed back by files/locations.ts). */
const labelName = (s: string) => s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim()

/** The rows of a bounded sheet that sheet_to_csv gives with `blankrows: false` (its own test: a cell with a value or a
 * formula without one), 0-based, in order. */
function filledRows(ws: XLSX.WorkSheet, r: XLSX.Range): number[] {
  const data = (ws as { '!data'?: (XLSX.CellObject | undefined)[][] })['!data'] ?? []
  const out: number[] = []
  for (let R = r.s.r; R <= r.e.r; R++) {
    const row = data[R]
    if (!row) continue
    for (let C = r.s.c; C <= r.e.c; C++) {
      const c = row[C]
      if (c && (c.v != null || (c.f != null && !(c as { F?: string }).F))) { out.push(R); break }
    }
  }
  return out
}

/** CSV text split into records: a quoted field may hold line breaks (an even number of quotes ends a record). */
export function csvRecords(csv: string): string[] {
  if (!csv) return []
  const out: string[] = []
  let cur: string | null = null
  let quotes = 0
  for (const line of csv.split('\n')) {
    cur = cur === null ? line : cur + '\n' + line
    for (let i = line.indexOf('"'); i >= 0; i = line.indexOf('"', i + 1)) quotes++
    if (quotes % 2 === 0) { out.push(cur); cur = null; quotes = 0 }
  }
  if (cur !== null) out.push(cur)
  return out
}

/**
 * A sheet as tab-separated text under its label `# sheet: <name> · A1:F40 (tab-separated)` (the sheet's real range).
 * Blank rows are left out as before; where rows were left out, a `# row N` line gives the real row number of the next
 * one, so a part of the text maps back to its A1 range (files/locations.ts). A sheet without cells is labelled
 * without a range.
 */
function sheetPart(name: string, ws: XLSX.WorkSheet): string {
  const csv = XLSX.utils.sheet_to_csv(ws, { FS: '\t', blankrows: false })
  if (!ws['!ref']) return `# sheet: ${labelName(name)} (tab-separated)\n` + csv
  const r = XLSX.utils.decode_range(ws['!ref'])
  const rows = filledRows(ws, r)
  const records = csvRecords(csv)
  // the two must agree record for record; if they ever do not, the text stays as sheet_to_csv gave it (no row lines)
  if (rows.length !== records.length) return `# sheet: ${labelName(name)} (tab-separated)\n` + csv
  const range = `${XLSX.utils.encode_col(r.s.c)}${r.s.r + 1}:${XLSX.utils.encode_col(r.e.c)}${r.e.r + 1}`
  const out: string[] = [`# sheet: ${labelName(name)} · ${range} (tab-separated)`]
  let next = r.s.r
  rows.forEach((R, i) => {
    if (R !== next) out.push(`# row ${R + 1}`)
    out.push(records[i]!)
    next = R + 1
  })
  return out.join('\n')
}

export function sheetText(bytes: Uint8Array): string {
  if (isZip(bytes)) checkZip(bytes)
  let wb: XLSX.WorkBook
  try {
    wb = XLSX.read(bytes, { type: 'array', dense: true, sheetRows: SHEET_ROWS_MAX, sheetStubs: true, cellFormula: true, cellHTML: false, cellStyles: false, bookVBA: false, bookFiles: false })
  } catch (e) {
    if (e instanceof ToolError) throw e
    throw new ToolError(`could not read this spreadsheet (${String((e as Error)?.message ?? e).slice(0, 200)})`)
  }
  const out: string[] = []
  let size = 0
  for (const s of wb.SheetNames) {
    const ws = wb.Sheets[s]!
    formulaStubsAsText(ws)
    boundRange(ws)
    const part = sheetPart(s, ws)
    size += Buffer.byteLength(part, 'utf8') + 2
    if (size > OFFICE_TEXT_MAX) throw tooComplex(`more than ${OFFICE_TEXT_MAX / 1024 / 1024} MB of text`)
    out.push(part)
  }
  return out.join('\n\n')
}

/** Text of one file of a WORKER_EXT format (or an EXTRA_MODES mode); ToolError for a file it cannot or will not read. */
export function officeText(ext: string, bytes: Uint8Array): string {
  switch (ext) {
    case 'docx-extra': return docxExtraText(bytes)
    case 'pptx-extra': return pptxExtraText(bytes)
    case 'xlsx': case 'xls': case 'ods': return sheetText(bytes)
    case 'hwp': return hwpText(bytes)
    case 'hwpx': return hwpxText(bytes)
    default: throw new ToolError(`not a format of the office worker: ${ext}`)
  }
}

/** The bytes of the file a WRITE_MODES mode makes from its request; ToolError for a request it refuses. */
export function officeWrite(mode: string, input: Uint8Array): Uint8Array {
  if (mode === HWPX_WRITE_MODE) return hwpxWriteRequest(input)
  throw new ToolError(`not a mode of the office worker: ${mode}`)
}
