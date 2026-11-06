// Spreadsheet preview facts that the sheet tabs show: hidden sheets (R2-FMT-06) and the row limit (R2-FMT-07).
// The preview reads at most SHEET_PREVIEW_ROWS rows of each sheet (SheetJS sheetRows). The AI read path on the
// server reads all sheets and all rows; it does not use this file.
import type { WorkBook } from 'xlsx'

/** Rows of each sheet that the preview reads, header row included. */
export const SHEET_PREVIEW_ROWS = 5000

export type SheetMeta = { name: string; hidden: boolean; cut: boolean }

/** Decodes a sheet range such as "A1:C5001"; only the last row number is needed. */
type DecodeRange = (ref: string) => { e: { r: number } }

/**
 * One entry per sheet in file order. `hidden` is true for hidden and "very hidden" sheets (the preview shows them
 * with a badge, it does not drop them). `cut` is true when SheetJS stopped at sheetRows: it then keeps the full
 * range in `!fullref`, and that range has more rows than `!ref`.
 */
export function sheetMeta(wb: WorkBook, decodeRange: DecodeRange): SheetMeta[] {
  const props = wb.Workbook?.Sheets ?? []
  return wb.SheetNames.map((name, i) => {
    const ws = wb.Sheets[name]
    const full = ws?.['!fullref']
    const ref = ws?.['!ref']
    const cut = !!full && (!ref || decodeRange(full).e.r > decodeRange(ref).e.r)
    return { name, hidden: !!props[i]?.Hidden, cut }
  })
}

/**
 * Index of the sheet that the preview opens first: the first sheet that is not hidden, as a spreadsheet app does.
 * When all sheets are hidden (a damaged file), it is 0.
 */
export function firstVisibleSheet(meta: readonly Pick<SheetMeta, 'hidden'>[]): number {
  return Math.max(0, meta.findIndex((m) => !m.hidden))
}

/** The tab to open for an answer's source or a link (&sheet=…): that sheet when the file has it, else the first visible. */
export function startSheetIndex(meta: readonly Pick<SheetMeta, 'name' | 'hidden'>[], name?: string): number {
  const i = name === undefined ? -1 : meta.findIndex((m) => m.name === name)
  return i >= 0 ? i : firstVisibleSheet(meta)
}

/** The cells of an A1 range ("B12:D14", or one cell) as SheetJS's table cell ids ("sjs-B12"), at most `max`;
 * [] for anything that is not a range. */
export function rangeCellIds(range: string | undefined, max = 2000): string[] {
  const m = range ? /^([A-Z]{1,3})(\d{1,7})(?::([A-Z]{1,3})(\d{1,7}))?$/.exec(range) : null
  if (!m) return []
  const col = (s: string) => [...s].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1
  const name = (c: number) => { let s = ''; for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s }
  const c0 = col(m[1]!), r0 = Number(m[2]), c1 = m[3] ? col(m[3]) : c0, r1 = m[4] ? Number(m[4]) : r0
  const out: string[] = []
  for (let r = Math.min(r0, r1); r <= Math.max(r0, r1); r++) {
    for (let c = Math.min(c0, c1); c <= Math.max(c0, c1); c++) {
      if (out.length >= max) return out
      out.push(`sjs-${name(c)}${r}`)
    }
  }
  return out
}
