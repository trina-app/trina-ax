// S-112: an AI-made .xlsx stores formulas without results (openpyxl, make_file). The preview works out the common
// ones for display and leaves every other formula as its text: it never shows a number Excel would not show.
import { describe, expect, test } from 'bun:test'
import * as XLSX from 'xlsx'
import { SHEET_PREVIEW_ROWS, sheetMeta } from '../../src/lib/sheetPreview'
import { fillFormulaResults } from '../../src/lib/sheetFormulas'

type Cell = string | number | boolean | null
/** A workbook as openpyxl writes it: a string starting with "=" is a formula with no stored result. */
function aiBook(sheets: Record<string, Cell[][]>, formats: Record<string, string> = {}) {
  const wb = XLSX.utils.book_new()
  for (const [name, rows] of Object.entries(sheets)) {
    const ws: XLSX.WorkSheet = {}
    rows.forEach((row, r) =>
      row.forEach((v, c) => {
        if (v === null) return
        const addr = XLSX.utils.encode_cell({ r, c })
        ws[addr] = typeof v === 'string' && v.startsWith('=') ? { t: 'z', f: v.slice(1) } : { t: typeof v === 'number' ? 'n' : typeof v === 'boolean' ? 'b' : 's', v }
        if (formats[`${name}!${addr}`]) ws[addr].z = formats[`${name}!${addr}`]
      }),
    )
    ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length - 1, c: Math.max(...rows.map((r) => r.length)) - 1 } })
    XLSX.utils.book_append_sheet(wb, ws, name)
  }
  // read back as an openpyxl file is: type "z" with the formula and no result
  const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  return XLSX.read(bytes, { type: 'array', dense: true, sheetRows: SHEET_PREVIEW_ROWS, sheetStubs: true, cellNF: true })
}

/** Same steps as SheetView: the shown text of each cell, and the formula list. */
function preview(wb: XLSX.WorkBook) {
  const meta = sheetMeta(wb, XLSX.utils.decode_range)
  const formulas = fillFormulaResults(wb, {
    cut: new Set(meta.filter((m) => m.cut).map((m) => m.name)),
    decodeRange: XLSX.utils.decode_range,
    format: (z, v) => XLSX.SSF.format(z, v),
  })
  const shown = (sheet: string, addr: string) => {
    const { r, c } = XLSX.utils.decode_cell(addr)
    return ((wb.Sheets[sheet] as { '!data': (XLSX.CellObject | undefined)[][] })['!data'][r]?.[c])?.w
  }
  return { shown, formulas }
}

const sales: Cell[][] = [
  ['Item', 'Qty', 'Price', 'Total', 'Share'],
  ['Apple', 3, 1200, '=B2*C2', '=IF(D$5=0,0,D2/D$5)'],
  ['Pear', 0, 900, '=B3*C3', '=IF(D$5=0,0,D3/D$5)'],
  ['Kiwi', 5, 500, '=B4*C4', '=IF(D$5=0,0,D4/D$5)'],
  ['Sum', '=SUM(B2:B4)', '=AVERAGE(C2:C4)', '=SUM(D2:D4)', '=SUM(E2:E4)'],
]

describe('formula results in the sheet preview', () => {
  test('the file has no stored results (the S-112 case)', () => {
    const wb = aiBook({ Sales: sales })
    expect((wb.Sheets.Sales as { '!data': XLSX.CellObject[][] })['!data'][4]![3]).toMatchObject({ t: 'z', f: 'SUM(D2:D4)' })
  })

  test('SUM, AVERAGE and arithmetic show numbers in the cell number format', () => {
    const { shown } = preview(aiBook({ Sales: sales }, { 'Sales!D5': '#,##0', 'Sales!E2': '0.0%' }))
    expect(shown('Sales', 'D2')).toBe('3600')
    expect(shown('Sales', 'B5')).toBe('8')
    expect(shown('Sales', 'C5')).toBe('866.6666667')
    expect(shown('Sales', 'D5')).toBe('6,100')
    expect(shown('Sales', 'E2')).toBe('59.0%')
    expect(shown('Sales', 'E5')).toBe('1')
  })

  test('IF takes the branch its condition picks (a guarded division by zero)', () => {
    const { shown } = preview(aiBook({ S: [['a', 'b', 'ratio', 'label'], [10, 0, '=IF(B2=0,0,A2/B2)', '=IF(A2>5,"high","low")'], [10, 4, '=IF(B3=0,0,A3/B3)', '=IF(A3>50,"high","low")']] }))
    expect(shown('S', 'C2')).toBe('0')
    expect(shown('S', 'C3')).toBe('2.5')
    expect(shown('S', 'D2')).toBe('high')
    expect(shown('S', 'D3')).toBe('low')
  })

  test('a reference to another sheet, also a quoted name with a space, and a chain of formulas', () => {
    const { shown } = preview(aiBook({ Sales: sales, 'My Summary': [['Total', '=Sales!D5'], ['Twice', "='My Summary'!B1*2"], ['Max', '=MAX(Sales!D2:D4)&" won"']] }))
    expect(shown('My Summary', 'B1')).toBe('6100')
    expect(shown('My Summary', 'B2')).toBe('12200')
    expect(shown('My Summary', 'B3')).toBe('3600 won')
  })

  test('a reference to a Korean sheet name without quotes', () => {
    const { shown } = preview(aiBook({ 매출: [['합계', 7]], 요약: [['=매출!B1+1']] }))
    expect(shown('요약', 'A1')).toBe('8')
  })

  test('a division by zero shows #DIV/0!, as Excel does', () => {
    const { shown, formulas } = preview(aiBook({ S: [[1, 0, '=A1/B1', '=C1+1', '=IFERROR(A1/B1,"-")']] }))
    expect(shown('S', 'C1')).toBe('#DIV/0!')
    expect(shown('S', 'D1')).toBe('#DIV/0!')
    expect(shown('S', 'E1')).toBe('-')
    expect(formulas.get('S')?.every((f) => f.shown)).toBe(true)
  })

  test('a formula it cannot work out stays as its formula, and so does every formula that uses it', () => {
    const { shown, formulas } = preview(
      aiBook({
        S: [
          ['Apple', 3, '=VLOOKUP("Apple",A1:B1,2,FALSE)', '=C1*2'],
          ['x', '=A2+1', '=Nowhere!A1', '=A1:B1'],
          ['=B3+1', '=A3+1', '=SUM(Total)', '=TODAY()'],
        ],
      }),
    )
    expect(shown('S', 'C1')).toBe('=VLOOKUP("Apple",A1:B1,2,FALSE)')
    expect(shown('S', 'D1')).toBe('=C1*2')
    expect(shown('S', 'B2')).toBe('=A2+1') // text in arithmetic is #VALUE! in Excel: not guessed
    expect(shown('S', 'C2')).toBe('=Nowhere!A1')
    expect(shown('S', 'D2')).toBe('=A1:B1')
    expect(shown('S', 'A3')).toBe('=B3+1') // circular
    expect(shown('S', 'C3')).toBe('=SUM(Total)') // a defined name
    expect(shown('S', 'D3')).toBe('=TODAY()')
    expect(formulas.get('S')?.filter((f) => f.shown)).toEqual([])
  })

  test('a stored result is kept, and its formula is still listed for hover', () => {
    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.aoa_to_sheet([[1, 2, 99]])
    ws.C1 = { t: 'n', v: 99, f: 'A1+B1' } // a stale cached result: the preview shows what the file says, as Excel's preview pane does
    XLSX.utils.book_append_sheet(wb, ws, 'S')
    const read = XLSX.read(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer, { type: 'array', dense: true, sheetStubs: true, cellNF: true })
    const { shown, formulas } = preview(read)
    expect(shown('S', 'C1')).toBe('99')
    expect(formulas.get('S')).toEqual([{ addr: 'C1', formula: 'A1+B1', shown: true }])
  })

  test('a file that asks for a full recalculation (XlsxWriter stores 0 as every result) shows results, not the zeros', () => {
    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.aoa_to_sheet([[2, 3]])
    ws.C1 = { t: 'n', v: 0, f: 'A1+B1' }
    ws.D1 = { t: 'n', v: 0, f: 'VLOOKUP(2,A1:B1,2,FALSE)' }
    ws['!ref'] = 'A1:D1'
    XLSX.utils.book_append_sheet(wb, ws, 'S')
    const read = XLSX.read(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer, { type: 'array', dense: true, sheetStubs: true, cellNF: true })
    expect(preview(read).shown('S', 'C1')).toBe('0') // without the flag the stored result is shown
    // <calcPr fullCalcOnLoad="1"/>, as openpyxl and XlsxWriter write it (SheetJS does not write calcPr: added to the zip)
    const zip = XLSX.CFB.read(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer), { type: 'array' })
    const entry = XLSX.CFB.find(zip, '/xl/workbook.xml')!
    const xml = new TextDecoder().decode(entry.content as Uint8Array).replace('</workbook>', '<calcPr calcId="124519" fullCalcOnLoad="1"/></workbook>')
    entry.content = new TextEncoder().encode(xml)
    const again = XLSX.read(XLSX.CFB.write(zip, { fileType: 'zip', type: 'array' }) as ArrayBuffer, { type: 'array', dense: true, sheetStubs: true, cellNF: true })
    const { shown } = preview(again)
    expect(shown('S', 'C1')).toBe('5')
    expect(shown('S', 'D1')).toBe('=VLOOKUP(2,A1:B1,2,FALSE)') // not the stored 0
  })

  test('a formula SheetJS wrote without a value (read back as an error with no value) is worked out', () => {
    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.aoa_to_sheet([[2, 3]])
    ws.C1 = { t: 'n', f: 'A1*B1' }
    ws['!ref'] = 'A1:C1'
    XLSX.utils.book_append_sheet(wb, ws, 'S')
    const read = XLSX.read(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer, { type: 'array', dense: true, sheetStubs: true, cellNF: true })
    expect(preview(read).shown('S', 'C1')).toBe('6')
  })

  test('a sum past the rows the preview read is not calculated on a cut sheet', () => {
    const rows: Cell[][] = [['n', 'total'], ...Array.from({ length: SHEET_PREVIEW_ROWS + 10 }, (_, i) => [i, null])]
    rows[1]![1] = `=SUM(A2:A${rows.length})`
    rows[2]![1] = '=SUM(A2:A100)'
    rows[3]![1] = '=SUM(A:A)'
    const { shown } = preview(aiBook({ Big: rows }))
    expect(shown('Big', 'B2')).toBe(`=SUM(A2:A${rows.length})`)
    expect(shown('Big', 'B3')).toBe('4851')
    expect(shown('Big', 'B4')).toBe('=SUM(A:A)')
  })

  test('operators, precedence, percent, ROUND, ABS, MIN, COUNT, COUNTA, AND/OR/NOT and text comparison', () => {
    const { shown } = preview(
      aiBook({
        S: [
          [2, 3, 'abc', null, '=-A1^2', '=A1+B1*2-1', '=50%*A1', '=ROUND(2.675,2)'],
          ['=ROUND(-1.5,0)', '=ABS(-A1)', '=MIN(A1:C1)', '=COUNT(A1:D1)', '=COUNTA(A1:D1)', '=AND(A1>1,OR(B1<0,TRUE))', '=NOT(C1="ABC")', '=D1&"x"'],
          ['=SUM(A1:D1,10)', '=A1=2', '=C1>A1', '=D1=0', '=AVERAGE(C1:D1)', '=A1<>B1', '=(A1+B1)/(A1-B1)', '=2^0.5'],
        ],
      }),
    )
    expect(['E1', 'F1', 'G1', 'H1'].map((a) => shown('S', a))).toEqual(['4', '7', '1', '2.68'])
    expect(['A2', 'B2', 'C2', 'D2', 'E2', 'F2', 'G2', 'H2'].map((a) => shown('S', a))).toEqual(['-2', '2', '2', '2', '3', 'TRUE', 'FALSE', 'x'])
    expect(['A3', 'B3', 'C3', 'D3', 'E3', 'F3', 'G3', 'H3'].map((a) => shown('S', a))).toEqual(['15', 'TRUE', 'TRUE', 'TRUE', '#DIV/0!', 'TRUE', '-5', '1.414213562'])
  })

  test('review cases: Excel rounding at 15 digits, array formulas, names past the grid, empty cells through IF, text order', () => {
    const { shown } = preview(
      aiBook({
        S: [
          [0.1, 0.2, '=0.5-0.4-0.1', '=10.1+20.2-30.3', '=(0.5-0.4-0.1)*1', '=A1+B1=0.3', '=IF(A1+B1=0.3,"OK","Mismatch")', '=XYZ1+1'],
          [null, true, '=IF(TRUE,A2)&"x"', '=MIN(IF(TRUE,A2),5)', '=SUM(IF(TRUE,B2))', '=IF(TRUE,A2)', '="é"<"f"', '="apple"<"Banana"'],
          ['=IFERROR(A2,"-")', '=SUM(TRUE,1)', '=IFERROR(1/0,A2)', null, null, null, null, null],
        ],
      }),
    )
    expect(['C1', 'D1', 'E1', 'F1', 'G1', 'H1'].map((a) => shown('S', a))).toEqual(['0', '0', '=(0.5-0.4-0.1)*1', 'TRUE', 'OK', '=XYZ1+1'])
    expect(['C2', 'D2', 'E2', 'F2', 'G2', 'H2'].map((a) => shown('S', a))).toEqual(['x', '5', '0', '0', '="é"<"f"', 'TRUE'])
    expect(['A3', 'B3', 'C3'].map((a) => shown('S', a))).toEqual(['0', '2', '0'])
  })

  test('cells inside an array formula are not read as empty', () => {
    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.aoa_to_sheet([[1], [2], [3]])
    XLSX.utils.sheet_set_array_formula(ws, 'B1:B3', 'A1:A3*2')
    ws.C1 = { t: 'z', f: 'B2+1' }
    ws.C2 = { t: 'z', f: 'A2+1' }
    ws['!ref'] = 'A1:C3'
    XLSX.utils.book_append_sheet(wb, ws, 'S')
    const read = XLSX.read(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer, { type: 'array', dense: true, sheetStubs: true, cellNF: true })
    const { shown } = preview(read)
    expect(shown('S', 'C1')).toBe('=B2+1')
    expect(shown('S', 'C2')).toBe('3')
  })

  test('the cell budget is per formula: a long running total is worked out to the end', () => {
    const rows: Cell[][] = [['n', 'running'], ...Array.from({ length: 3000 }, (_, i) => [1, `=SUM($A$2:A${i + 2})`])]
    const { shown } = preview(aiBook({ R: rows }))
    expect(shown('R', 'B3001')).toBe('3000')
  })
})
