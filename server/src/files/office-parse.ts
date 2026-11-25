// Text of spreadsheets (SheetJS: xlsx / xls / ods) and Hangul documents (hwp.ts: hwp / hwpx), make_file's new
// Hangul documents (hwpx-write.ts: pandoc's tree and an untrusted template in, a .hwpx out) and edit_hwp's changed
// ones (hwpx-edit.ts and hwp-edit.ts: an untrusted .hwpx or .hwp and the changes in, the changed file out). These are pure
// TypeScript and expand untrusted input in memory, so they run only in the office worker
// (files/office-worker.ts, a bounded child process started by extract.ts), never in the server process.
// Defence in depth inside the worker: zip containers are checked before a parser expands them (zip-guard.ts), a
// sheet's declared range is cut to its real cells, and the text is capped.
import * as XLSX from 'xlsx'
import { ToolError } from '../policy/errors'
import { hwpText, hwpxText } from './hwp'
import { checkZip, isZip, readCentral, tooComplex, ZipProblem } from './zip-guard'
import { bigSheetPart, bigSheetText, parseRange, pickSheet, PART_ROWS_MAX, repeatsSheetParts, type SheetAsk } from './sheet-stream'
import { docxExtraText, pptxExtraText, quoteLines, SECTION_MARK, xlsxChartsText, XLSX_CHARTS_TIME_MS } from './ooxml'
import { DOCX_COMMENT_MODE, docxCommentRequest } from './docx-comment'
import { DOCX_REVIEW_MODE, docxReviewRequest } from './docx-review'
import { CHART_DATA_MODE, chartDataRequest } from './chart-data'
import { hwpxWriteRequest } from './hwpx-write'
import { hwpxEditRequest, hwpxVerifyRequest } from './hwpx-edit'
import { hwpEditRequest, hwpVerifyRequest } from './hwp-edit'
import { HWP_EDIT_MODE, HWP_VERIFY_MODE, HWPX_EDIT_MODE, HWPX_VERIFY_MODE, HWPX_WRITE_MODE } from './hwpx-check'
import { PDF_STAMP_MODE, stampPdfRequest } from './pdf-stamp'
import { PDF_PAGES_MODE, pdfPagesRequest } from './pdf-pages'
import { PPTX_HTML_MODE, PPTX_SLIDES_MODE, pptxHtmlRequest } from './pptx-html'
import { OFFICE_EDIT_MODE, OFFICE_VERIFY_MODE, officeEditRequest, officeVerifyRequest } from './office-edit'
// the three editors register themselves with office-edit.ts
import './docx-edit'
import './xlsx-edit'
import './pptx-edit'
import { DOCX_TEMPLATE_CHECK_MODE, docxTemplateCheckRequest, PPTX_TEMPLATE_CHECK_MODE, pptxTemplateCheckRequest } from './office-template'
import { XLSX_VALUES_MODE, xlsxValuesRequest } from './xlsx-values'
import { DOCX_LINK_CHECK_MODE, linkCheckRequest, OFFICE_EXIT_MODE, officeExitRequest, PPTX_LINK_CHECK_MODE, XLSX_LINK_CHECK_MODE } from './office-links-check'

export const WORKER_EXT = new Set(['xlsx', 'xls', 'ods', 'hwp', 'hwpx'])
/** worker modes that give only the parts of a .docx / .pptx that pandoc drops (ooxml.ts); pandoc still gives the body */
export const EXTRA_MODES = new Set(['docx-extra', 'pptx-extra'])
/** worker modes that make a file: stdin is the request, stdout the file's bytes (make_file's .hwpx, hwpx-write.ts; edit_hwp's
 * changed .hwpx or .hwp with its report and the checks run again on it, hwpx-edit.ts and hwp-edit.ts; make_file's PDF of a
 * .pptx: the deck drawn as a page per slide, pptx-html.ts) */
export const WRITE_MODES = new Set([HWPX_WRITE_MODE, HWPX_EDIT_MODE, HWPX_VERIFY_MODE, HWP_EDIT_MODE, HWP_VERIFY_MODE, PDF_STAMP_MODE, PDF_PAGES_MODE, PPTX_HTML_MODE, PPTX_SLIDES_MODE])
/** the worker's exit code when stderr holds a ToolError message (office-worker.ts) */
export const TOOL_ERROR_EXIT = 3
/** UTF-8 bytes of text out of one file (the worker's stdout cap in extract.ts is a little larger; hwp.ts keeps its
 * own smaller cap of 8M characters, at most 24 MiB) */
export const OFFICE_TEXT_MAX = 32 * 1024 * 1024
/** a declared sheet range larger than this is cut to the cells the sheet really has */
const RANGE_CELLS_MAX = 2_000_000
/** Excel's last row: SheetJS stops expanding rows there (an .ods row repeated a billion times) */
export const SHEET_ROWS_MAX = 1_048_576

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
export function boundRange(ws: XLSX.WorkSheet): void {
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

/** a formula longer than this is shown cut, with "…" (the value after it stays whole) */
export const FORMULA_SHOWN_MAX = 300

/** the formula text one workbook's read may add next to the values (a sheet past it shows its values only, with a
 * labelled line: a formula column of 200,000 rows would make the text several times larger) */
export const FORMULA_TEXT_MAX = 4 * 1024 * 1024

/**
 * A formula cell with a stored result shows both, `=SUM(B2:B9) → 1770`, so the AI sees how a person's sheet is built,
 * not only its numbers (QA TC-4918; Claude Code reads formulas with openpyxl). The value is the one the file stores,
 * as the spreadsheet app formats it. Run after formulaStubsAsText (a stub has no value: it shows as its formula).
 * `room`: the bytes of formula text still allowed; a sheet that needs more is left as it is (`shown: false`). The
 * returned `undo` puts the cells back (a sheet whose text then does not fit the read).
 */
export function formulasWithValues(ws: XLSX.WorkSheet, room = Infinity): { shown: boolean; bytes: number; cells: number; undo: () => void } {
  const rows = (ws as { '!data'?: (XLSX.CellObject | undefined)[][] })['!data'] ?? []
  const changes: { row: (XLSX.CellObject | undefined)[]; j: number; text: string; old: XLSX.CellObject }[] = []
  let bytes = 0
  for (const row of rows) {
    if (!row) continue
    for (let j = 0; j < row.length; j++) {
      const c = row[j]
      if (!c?.f || c.t === 'z' || c.v == null) continue
      const f = c.f.length > FORMULA_SHOWN_MAX ? c.f.slice(0, FORMULA_SHOWN_MAX).replace(/[\uD800-\uDBFF]$/, '') + '…' : c.f
      const v = c.w ?? String(c.v)
      const text = `=${f} → ${v}`
      bytes += Buffer.byteLength(text) - Buffer.byteLength(v)
      changes.push({ row, j, text, old: c })
    }
  }
  const undo = () => { for (const x of changes) x.row[x.j] = x.old }
  if (bytes > room) return { shown: false, bytes: 0, cells: changes.length, undo: () => {} }
  for (const x of changes) x.row[x.j] = { t: 's', v: x.text, w: x.text }
  return { shown: true, bytes, cells: changes.length, undo }
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

/**
 * An .xlsx larger than this, or one whose parts expand past the zip check's total, is read a sheet piece at a time
 * (sheet-stream.ts). SheetJS holds every cell in memory: about 120 times the file (1.3 GB for an 11 MB export, 2.3 GB
 * for 18 MB, measured 2026-11-18), where the streaming reader takes about 200 MB and a quarter of the time.
 */
export const SHEETJS_MAX = 2 * 1024 * 1024

/** Is this a workbook for the streaming reader (an .xlsx zip that SheetJS would hold whole)? */
export function streamsSheets(ext: string, bytes: Uint8Array): boolean {
  if (ext !== 'xlsx' || !isZip(bytes)) return false
  if (bytes.byteLength > SHEETJS_MAX) return true
  try { readCentral(bytes) } catch (e) { return e instanceof ZipProblem && e.kind === 'complex' && /expands to more than/.test(e.why) }
  // a sheet named more than once: SheetJS reads it again for each name (sheet-stream.ts repeatsSheetParts)
  return repeatsSheetParts(bytes)
}

/** A spreadsheet's text: the whole workbook (or, when it is too large, its overview), or one sheet's range. The whole
 * workbook and its overview end with the charts of an .xlsx (withCharts). A line of cell text that starts like a
 * section label (`=== `) gets a space in front (ooxml.ts quoteLines), so only the real labels start a line. */
export async function workbookText(ext: string, bytes: Uint8Array, ask?: SheetAsk): Promise<string> {
  const wanted = ask && (ask.sheet !== undefined || ask.range !== undefined)
  if (streamsSheets(ext, bytes)) return wanted ? quoteLines(await bigSheetPart(bytes, ask!)) : withCharts(ext, bytes, quoteLines(await bigSheetText(bytes)))
  if (wanted) return quoteLines(sheetRangeText(bytes, ask!))
  let text: string
  try { text = sheetText(bytes) } catch (e) {
    // more text than one read gives: an .xlsx gets its overview from the streaming reader instead
    if (ext === 'xlsx' && isZip(bytes) && e instanceof ToolError && e.message.includes('MB of text')) text = await bigSheetText(bytes)
    else throw e
  }
  return withCharts(ext, bytes, quoteLines(text))
}

/** time kept back for writing the answer when the charts are read near the worker's end (OFFICE_DEADLINE_MS) */
const CHARTS_TIME_RESERVE_MS = 3000

/**
 * The text of the sheets, then the workbook's charts (ooxml.ts xlsxChartsText) under their own label. Charts never
 * lose the sheets: when they cannot be read, or would pass the output cap or the worker's time (extract.ts gives the
 * worker its end as OFFICE_DEADLINE_MS), a labelled line says so instead.
 */
function withCharts(ext: string, bytes: Uint8Array, text: string): string {
  if (ext !== 'xlsx') return text
  const notRead = (why: string) => `${SECTION_MARK}The charts of this workbook were not read (${why}) ===`
  const end = Number(process.env.OFFICE_DEADLINE_MS)
  const left = Number.isFinite(end) && end > 0 ? end - Date.now() - CHARTS_TIME_RESERVE_MS : XLSX_CHARTS_TIME_MS
  let charts: string
  if (left < 500) charts = notRead('no time was left after the sheets')
  else {
    try { charts = xlsxChartsText(bytes, { timeMs: Math.min(XLSX_CHARTS_TIME_MS, left) }) } catch (e) {
      charts = notRead(e instanceof ToolError ? oneLineWhy(e.message) : 'the reader failed')
    }
  }
  if (!charts) return text
  // the sheets' text with the charts stays under the worker's output cap (extract.ts officeWorkerText)
  if (Buffer.byteLength(text, 'utf8') + Buffer.byteLength(charts, 'utf8') > OFFICE_TEXT_MAX) charts = notRead("the sheets' text is already at the size limit")
  return `${text.trimEnd()}\n\n${charts}`
}
const oneLineWhy = (s: string) => s.replace(/[\r\n\u0085\u2028\u2029]+/g, ' ').slice(0, 200)

function readBook(bytes: Uint8Array): XLSX.WorkBook {
  if (isZip(bytes)) checkZip(bytes)
  try {
    return XLSX.read(bytes, { type: 'array', dense: true, sheetRows: SHEET_ROWS_MAX, sheetStubs: true, cellFormula: true, cellHTML: false, cellStyles: false, bookVBA: false, bookFiles: false })
  } catch (e) {
    if (e instanceof ToolError) throw e
    throw new ToolError(`could not read this spreadsheet (${String((e as Error)?.message ?? e).slice(0, 200)})`)
  }
}

/** One sheet's range (read's `sheet` and `range`) of a workbook SheetJS reads, at most PART_ROWS_MAX rows. */
function sheetRangeText(bytes: Uint8Array, ask: SheetAsk): string {
  const wb = readBook(bytes)
  const name = pickSheet(wb.SheetNames.map((n) => ({ name: n })), ask.sheet).name
  const ws = wb.Sheets[name]!
  formulaStubsAsText(ws)
  boundRange(ws)
  const q = parseRange(ask.range)
  if (!ws['!ref']) return `# sheet: ${labelName(name)} (tab-separated)\n# no rows with data`
  const r = XLSX.utils.decode_range(ws['!ref'])
  const s = { r: Math.max(r.s.r, q.r0 - 1), c: Math.max(r.s.c, q.c0) }
  const e = { r: Math.min(r.e.r, q.r1 === Infinity ? r.e.r : q.r1 - 1), c: Math.min(r.e.c, q.c1) }
  if (s.r > e.r || s.c > e.c) return `# sheet: ${labelName(name)} (tab-separated)\n# no rows with data in ${ask.range ?? 'this sheet'}; the sheet's range is ${ws['!ref']}`
  let more: number | null = null
  if (e.r - s.r + 1 > PART_ROWS_MAX) { more = s.r + PART_ROWS_MAX + 1; e.r = s.r + PART_ROWS_MAX - 1 }
  ws['!ref'] = XLSX.utils.encode_range({ s, e })
  const text = sheetPart(name, ws)
  if (more === null) return text
  const c0 = XLSX.utils.encode_col(s.c), c1 = XLSX.utils.encode_col(Math.min(r.e.c, q.c1))
  return `${text}\n# more rows follow (from row ${more}): read on with sheet "${labelName(name)}", range "${c0}${more}:${c1}${q.r1 === Infinity ? r.e.r + 1 : q.r1}"`
}

/** `formulaMax`: the formula text the read may add (tests give less) */
export function sheetText(bytes: Uint8Array, formulaMax = FORMULA_TEXT_MAX): string {
  let wb: XLSX.WorkBook
  wb = readBook(bytes)
  const out: string[] = []
  let size = 0
  let formulaRoom = formulaMax
  /** sheets whose formulas are not shown (too many), with their formula cells */
  const valuesOnly: { name: string; cells: number }[] = []
  for (const s of wb.SheetNames) {
    const ws = wb.Sheets[s]!
    formulaStubsAsText(ws)
    const fx = formulasWithValues(ws, formulaRoom)
    formulaRoom -= fx.bytes
    boundRange(ws)
    let part = sheetPart(s, ws)
    // the formulas would take the read past its text limit: the values alone, as before formulas were shown
    if (fx.shown && fx.bytes && size + Buffer.byteLength(part, 'utf8') + 2 > OFFICE_TEXT_MAX) { fx.undo(); formulaRoom += fx.bytes; part = sheetPart(s, ws); valuesOnly.push({ name: s, cells: fx.cells }) }
    else if (!fx.shown) valuesOnly.push({ name: s, cells: fx.cells })
    size += Buffer.byteLength(part, 'utf8') + 2
    if (size > OFFICE_TEXT_MAX) throw tooComplex(`more than ${OFFICE_TEXT_MAX / 1024 / 1024} MB of text`)
    out.push(part)
  }
  // said once at the end, as a section label (files/locations.ts: never a sheet row the AI could take for data)
  for (const v of valuesOnly) out.push(`=== Sheet '${labelName(v.name)}' shows values only: its ${v.cells} formula cells are too many to show next to them ===`)
  return out.join('\n\n')
}

// comment_docx's mode: Word comments added to a .docx (docx-comment.ts), a write mode like the others above
WRITE_MODES.add(DOCX_COMMENT_MODE)
// edit_office's modes: an existing .docx / .xlsx / .pptx changed in place, and the fresh read-back (office-edit.ts)
WRITE_MODES.add(OFFICE_EDIT_MODE)
WRITE_MODES.add(OFFICE_VERIFY_MODE)
// make_file's .docx / .pptx template checked before pandoc copies its parts (office-template.ts)
WRITE_MODES.add(DOCX_TEMPLATE_CHECK_MODE)
WRITE_MODES.add(PPTX_TEMPLATE_CHECK_MODE)
// make_file's finished Word / PowerPoint / Excel file checked for links and references that leave it (office-links-check.ts)
WRITE_MODES.add(DOCX_LINK_CHECK_MODE)
WRITE_MODES.add(PPTX_LINK_CHECK_MODE)
WRITE_MODES.add(XLSX_LINK_CHECK_MODE)
WRITE_MODES.add(OFFICE_EXIT_MODE)
WRITE_MODES.add(XLSX_VALUES_MODE)
// a Word file leaving the work folder read back: its tracked changes and comments (docx-review.ts), JSON out
WRITE_MODES.add(DOCX_REVIEW_MODE)
// a deck or Word file leaving the work folder: whether each chart keeps its data sheet (chart-data.ts), JSON out
WRITE_MODES.add(CHART_DATA_MODE)

/** Text of one file of a WORKER_EXT format (or an EXTRA_MODES mode); ToolError for a file it cannot or will not read.
 * `ask`: one sheet and range of a spreadsheet (read's `sheet` / `range`). */
export function officeText(ext: string, bytes: Uint8Array, ask?: SheetAsk): string | Promise<string> {
  switch (ext) {
    case 'docx-extra': return docxExtraText(bytes)
    case 'pptx-extra': return pptxExtraText(bytes)
    case 'xlsx': case 'xls': case 'ods': return workbookText(ext, bytes, ask)
    case 'hwp': return hwpText(bytes)
    case 'hwpx': return hwpxText(bytes)
    default: throw new ToolError(`not a format of the office worker: ${ext}`)
  }
}

/** The bytes of the file a WRITE_MODES mode makes from its request; ToolError for a request it refuses. */
export function officeWrite(mode: string, input: Uint8Array): Uint8Array | Promise<Uint8Array> {
  // stamp_pdf (pdf-stamp.ts): an existing PDF and an image in, the stamped PDF and its report out
  if (mode === PDF_STAMP_MODE) return stampPdfRequest(input)
  // edit_pdf, merge_pdfs, split_pdf (pdf-pages.ts): page work on existing PDFs
  if (mode === PDF_PAGES_MODE) return pdfPagesRequest(input)
  if (mode === DOCX_COMMENT_MODE) return docxCommentRequest(input)
  if (mode === OFFICE_EDIT_MODE) return officeEditRequest(input)
  if (mode === OFFICE_VERIFY_MODE) return officeVerifyRequest(input)
  if (mode === DOCX_TEMPLATE_CHECK_MODE) return docxTemplateCheckRequest(input)
  if (mode === PPTX_TEMPLATE_CHECK_MODE) return pptxTemplateCheckRequest(input)
  if (mode === DOCX_LINK_CHECK_MODE) return linkCheckRequest('docx')(input)
  if (mode === PPTX_LINK_CHECK_MODE) return linkCheckRequest('pptx')(input)
  if (mode === XLSX_LINK_CHECK_MODE) return linkCheckRequest('xlsx')(input)
  if (mode === OFFICE_EXIT_MODE) return officeExitRequest(input)
  if (mode === XLSX_VALUES_MODE) return xlsxValuesRequest(input)
  if (mode === DOCX_REVIEW_MODE) return docxReviewRequest(input)
  if (mode === CHART_DATA_MODE) return chartDataRequest(input)
  if (mode === HWPX_WRITE_MODE) return hwpxWriteRequest(input)
  if (mode === HWPX_EDIT_MODE) return hwpxEditRequest(input)
  if (mode === HWPX_VERIFY_MODE) return hwpxVerifyRequest(input)
  if (mode === HWP_EDIT_MODE) return hwpEditRequest(input)
  if (mode === HWP_VERIFY_MODE) return hwpVerifyRequest(input)
  if (mode === PPTX_HTML_MODE) return pptxHtmlRequest(input)
  if (mode === PPTX_SLIDES_MODE) return pptxHtmlRequest(input, { withHidden: true })
  throw new ToolError(`not a mode of the office worker: ${mode}`)
}
