// Text of spreadsheets (SheetJS: xlsx / xls / ods) and Hangul documents (hwp.ts: hwp / hwpx). These parsers are
// pure TypeScript and expand untrusted input in memory, so they run only in the office worker
// (files/office-worker.ts, a bounded child process started by extract.ts), never in the server process.
// Defence in depth inside the worker: zip containers are checked before a parser expands them (zip-guard.ts), a
// sheet's declared range is cut to its real cells, and the text is capped.
import * as XLSX from 'xlsx'
import { ToolError } from '../policy/errors'
import { hwpText, hwpxText } from './hwp'
import { checkZip, isZip, tooComplex } from './zip-guard'
import { docxExtraText, pptxExtraText } from './ooxml'

export const WORKER_EXT = new Set(['xlsx', 'xls', 'ods', 'hwp', 'hwpx'])
/** worker modes that give only the parts of a .docx / .pptx that pandoc drops (ooxml.ts); pandoc still gives the body */
export const EXTRA_MODES = new Set(['docx-extra', 'pptx-extra'])
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
    const part = `# sheet: ${s} (tab-separated)\n` + XLSX.utils.sheet_to_csv(ws, { FS: '\t', blankrows: false })
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
