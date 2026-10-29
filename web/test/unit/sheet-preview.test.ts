// R2-FMT-06 / R2-FMT-07: the spreadsheet preview marks hidden sheets (it does not drop them) and knows when a sheet
// was cut at the preview row limit, so it can show a notice.
import { describe, expect, test } from 'bun:test'
import * as XLSX from 'xlsx'
import { SHEET_PREVIEW_ROWS, sheetMeta } from '../../src/lib/sheetPreview'

function book(rows: number) {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['region', 'q1'], ['Seoul', 1]]), 'Q1')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['marker'], ['QA-HIDDEN']]), 'Secret')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['no', 'amount'], ...Array.from({ length: rows - 1 }, (_, i) => [i + 1, i])]), 'Rows')
  XLSX.utils.book_set_sheet_visibility(wb, 'Secret', 1)
  const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  // same read options as SheetView
  return XLSX.read(bytes, { type: 'array', dense: true, sheetRows: SHEET_PREVIEW_ROWS })
}

describe('sheet preview meta', () => {
  test('a hidden sheet stays in the list and is marked hidden', () => {
    const meta = sheetMeta(book(10), XLSX.utils.decode_range)
    expect(meta.map((m) => [m.name, m.hidden])).toEqual([['Q1', false], ['Secret', true], ['Rows', false]])
  })

  test('a sheet with more rows than the limit is marked cut; smaller sheets are not', () => {
    const meta = sheetMeta(book(SHEET_PREVIEW_ROWS + 1), XLSX.utils.decode_range)
    expect(meta.map((m) => [m.name, m.cut])).toEqual([['Q1', false], ['Secret', false], ['Rows', true]])
  })

  test('a sheet with exactly the limit is not cut', () => {
    const meta = sheetMeta(book(SHEET_PREVIEW_ROWS), XLSX.utils.decode_range)
    expect(meta.find((m) => m.name === 'Rows')?.cut).toBe(false)
  })
})
