// Excel values (files/xlsx-values.ts): only each formula cell's result comes from LibreOffice's recalculated copy; the
// original's formulas, styles and other parts stay as they were. Where the server has LibreOffice (Debian 13 with the
// office-view group) the whole route runs too (files/office-view.ts officeRecalc).
import { describe, expect, test } from 'bun:test'
import os from 'node:os'
import { mergeXlsxValues } from '../../server/src/files/xlsx-values'
import { officeRecalc, officeViewer } from '../../server/src/files/office-view'
import { readZip, writeZip } from '../../server/src/files/zip-write'

const enc = new TextEncoder(), dec = new TextDecoder()
function book(sheet: string, shared?: string[]): Uint8Array {
  return writeZip([
    { name: '[Content_Types].xml', data: enc.encode('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>') },
    { name: 'xl/workbook.xml', data: enc.encode('<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="예산" sheetId="1" r:id="rId1"/></sheets></workbook>') },
    { name: 'xl/_rels/workbook.xml.rels', data: enc.encode('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>') },
    { name: 'xl/worksheets/sheet1.xml', data: enc.encode(`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheet}</sheetData></worksheet>`) },
    ...(shared ? [{ name: 'xl/sharedStrings.xml', data: enc.encode(`<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${shared.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`) }] : []),
  ])
}
const sheetOf = (b: Uint8Array) => dec.decode(readZip(b).find((e) => e.name === 'xl/worksheets/sheet1.xml')!.data)

describe('the merge', () => {
  test('numbers, strings (shared or not), booleans and errors go in; the formula and style stay; other cells untouched', () => {
    const original = book('<row r="1"><c r="A1"><v>3200</v></c><c r="B1" s="4"><f>A1*2</f></c><c r="C1" t="str"><f>IF(A1&gt;1,"큼","작음")</f></c><c r="D1"><f>A1&gt;0</f></c><c r="E1"><f>1/0</f></c><c r="F1"><f>B1&amp;"x"</f></c></row>')
    const recalc = book('<row r="1"><c r="A1"><v>3200</v></c><c r="B1"><f>A1*2</f><v>6400</v></c><c r="C1" t="str"><f>IF(A1&gt;1,"큼","작음")</f><v>큼</v></c><c r="D1" t="b"><f>A1&gt;0</f><v>1</v></c><c r="E1" t="e"><f>1/0</f><v>#DIV/0!</v></c><c r="F1" t="s"><f>B1&amp;"x"</f><v>0</v></c></row>', ['6400x'])
    const m = mergeXlsxValues(original, recalc)
    expect(m).toMatchObject({ cells: 5, formulas: 5 })
    const x = sheetOf(m.bytes)
    expect(x).toContain('<c r="B1" s="4"><f>A1*2</f><v>6400</v></c>')
    expect(x).toContain('<c r="C1" t="str"><f>IF(A1&gt;1,"큼","작음")</f><v>큼</v></c>')
    expect(x).toContain('<c r="D1" t="b"><f>A1&gt;0</f><v>1</v></c>')
    expect(x).toContain('<c r="E1" t="e"><f>1/0</f><v>#DIV/0!</v></c>')
    expect(x).toContain('<c r="F1" t="str"><f>B1&amp;"x"</f><v>6400x</v></c>')
    expect(x).toContain('<c r="A1"><v>3200</v></c>')
  })
  test('nothing to fill: the original bytes come back', () => {
    const original = book('<row r="1"><c r="A1"><v>1</v></c></row>')
    expect(mergeXlsxValues(original, original).bytes).toBe(original)
  })
  test('not a workbook: refused', () => {
    expect(() => mergeXlsxValues(enc.encode('x'), enc.encode('y'))).toThrow()
  })
})

describe('the whole route, where the server has LibreOffice', () => {
  test.skipIf(!officeViewer())('an openpyxl-like workbook comes back with its results', async () => {
    const original = book('<row r="1"><c r="A1"><v>2</v></c><c r="B1"><f>A1*21</f></c></row>')
    const out = await officeRecalc(original, { user: 'test', workBase: os.tmpdir() })
    expect(sheetOf(out)).toContain('<f>A1*21</f><v>42</v>')
  })
})
