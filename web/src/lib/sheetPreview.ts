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
