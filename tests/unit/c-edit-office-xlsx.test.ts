// edit_office for Excel (server/src/files/xlsx-edit.ts in the office worker; QA TC-4906): a cell set keeps its style,
// formulas are written for the app to calculate, rows are appended in the look of the last row; the chart, the named
// range, the other sheet, shared strings and every other part stay byte for byte; what cannot be changed exactly
// (merged cells, array formulas, a table's header) is refused. The workbook is made with ExcelJS and a native chart
// (as make_file makes one), and saved again by LibreOffice when it is installed.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import ExcelJS from '../../server/node_modules/exceljs'
import * as XLSX from '../../server/node_modules/xlsx'
import { which } from '../../server/src/config'
import { officeEditRequest, officeVerifyRequest, frame, unframe, type EditReport } from '../../server/src/files/office-edit'
import '../../server/src/files/xlsx-edit'
import { addCharts } from '../../server/src/tools/xlsx-chart'
import { readZip, writeZip } from '../../server/src/files/zip-write'
import { readCentral, entryData } from '../../server/src/files/zip-guard'

setDefaultTimeout(60_000)
const soffice = which('soffice') ?? which('libreoffice')

async function budget(): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Budget')
  ws.columns = [{ width: 20 }, { width: 14 }, { width: 14 }]
  ws.addRow(['Item', 'Q1', 'Q2'])
  ws.getRow(1).font = { bold: true }
  const data = [['Rent', 1200, 1200], ['Travel', 300, 450], ['Software', 220, 240]]
  for (const r of data) ws.addRow(r)
  for (let r = 2; r <= 4; r++) for (const c of ['B', 'C']) { ws.getCell(`${c}${r}`).numFmt = '#,##0.00'; ws.getCell(`${c}${r}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } } }
  ws.getCell('A5').value = 'Total'
  ws.getCell('B5').value = { formula: 'SUM(B2:B4)', result: 1720 }
  ws.getCell('C5').value = { formula: 'SUM(C2:C4)', result: 1890 }
  ws.mergeCells('A7:C7')
  ws.getCell('A7').value = 'Approved by finance'
  wb.definedNames.add('Budget!$B$2:$B$4', 'Q1Costs')
  const notes = wb.addWorksheet('Notes')
  notes.addRow(['Keep this sheet'])
  const bytes = new Uint8Array(await wb.xlsx.writeBuffer() as ArrayBuffer)
  return addCharts(bytes, [{ type: 'column', range: 'A1:C4', sheet: 'Budget', title: 'Costs' }], [{ name: 'Budget', rows: [['Item', 'Q1', 'Q2'], ...data] }, { name: 'Notes', rows: [['Keep this sheet']] }])
}
/** with a calculation chain, as Excel saves a workbook with formulas */
function withCalcChain(b: Uint8Array): Uint8Array {
  const entries = readZip(b).map((e) => {
    const t = () => new TextDecoder().decode(e.data)
    if (e.name === '[Content_Types].xml') return { name: e.name, data: new TextEncoder().encode(t().replace('</Types>', '<Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/></Types>')) }
    if (e.name === 'xl/_rels/workbook.xml.rels') return { name: e.name, data: new TextEncoder().encode(t().replace('</Relationships>', '<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" Target="calcChain.xml"/></Relationships>')) }
    return e
  })
  entries.push({ name: 'xl/calcChain.xml', data: new TextEncoder().encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<calcChain xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><c r="B5" i="1"/><c r="C5"/></calcChain>') })
  return writeZip(entries)
}
function viaOffice(b: Uint8Array): Uint8Array {
  if (!soffice) return b
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-'))
  try {
    fs.writeFileSync(path.join(dir, 'in.xlsx'), b)
    const r = Bun.spawnSync([soffice, `-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', 'xlsx:Calc MS Excel 2007 XML', '--outdir', path.join(dir, 'out'), path.join(dir, 'in.xlsx')])
    if (r.exitCode !== 0) throw new Error(r.stderr.toString())
    return new Uint8Array(fs.readFileSync(path.join(dir, 'out', 'in.xlsx')))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}
/** LibreOffice opens the workbook, calculates it and saves it as CSV (the first sheet) */
function csvInOffice(b: Uint8Array): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-open-'))
  try {
    fs.writeFileSync(path.join(dir, 'x.xlsx'), b)
    const r = Bun.spawnSync([soffice!, `-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', 'csv', '--outdir', dir, path.join(dir, 'x.xlsx')])
    if (r.exitCode !== 0 || !fs.existsSync(path.join(dir, 'x.csv'))) throw new Error(`LibreOffice could not open it: ${r.stderr.toString().slice(0, 300)}`)
    return fs.readFileSync(path.join(dir, 'x.csv'), 'utf8')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}
const part = (b: Uint8Array, name: string) => { const e = readZip(b).find((x) => x.name === name); return e ? new TextDecoder().decode(e.data) : null }
function changedParts(a: Uint8Array, b: Uint8Array): string[] {
  const ra = new Map(readCentral(a).map((e) => [new TextDecoder().decode(e.nameBytes), Buffer.from(entryData(a, e))]))
  const rb = new Map(readCentral(b).map((e) => [new TextDecoder().decode(e.nameBytes), Buffer.from(entryData(b, e))]))
  return [...new Set([...ra.keys(), ...rb.keys()])].filter((n) => !ra.get(n) || !rb.get(n) || !ra.get(n)!.equals(rb.get(n)!)).sort()
}
function run(b: Uint8Array, changes: unknown[]): { file: Uint8Array; report: EditReport } {
  const out = unframe<EditReport>(officeEditRequest(frame({ kind: 'xlsx', changes }, [b])))
  const file = out.blobs[0]!
  officeVerifyRequest(frame({ kind: 'xlsx', changed: out.json.changed, added: out.json.added, notes: out.json.notes, cells: out.json.cells }, [b, file]))
  return { file, report: out.json }
}
const cell = (b: Uint8Array, sheet: string, ref: string) => XLSX.read(b, { type: 'array', cellFormula: true, sheetStubs: true }).Sheets[sheet]![ref] as XLSX.CellObject | undefined

describe('edit_office: Excel workbooks', () => {
  test('a value and a formula: styles kept, only the sheet and the workbook change, the chart and the other sheet stay', async () => {
    const before = await budget()
    const { file, report } = run(before, [{ cell: { sheet: 'Budget', ref: 'B3', value: 350 } }, { cell: { sheet: 'Budget', ref: 'D5', value: '=B5+C5' } }])
    expect(changedParts(before, file)).toEqual(['xl/workbook.xml', 'xl/worksheets/sheet1.xml'])
    expect(report.recalc).toBe(true)
    const sheet = part(file, 'xl/worksheets/sheet1.xml')!
    const oldB3 = /<c r="B3"[^>]*>/.exec(part(before, 'xl/worksheets/sheet1.xml')!)![0]
    const style = /s="(\d+)"/.exec(oldB3)![1]
    expect(sheet).toContain(`<c r="B3" s="${style}"><v>350</v></c>`)
    expect(sheet).toContain('<f>B5+C5</f>')
    expect(part(file, 'xl/workbook.xml')).toContain('fullCalcOnLoad="1"')
    expect(part(file, 'xl/workbook.xml')).toContain('Q1Costs')
    expect(cell(file, 'Budget', 'B3')!.v).toBe(350)
    expect(cell(file, 'Notes', 'A1')!.v).toBe('Keep this sheet')
    expect(report.notes[0]).toMatchObject({ where: 'Budget!B3', before: '300', after: ['350'] })
    if (soffice) {
      const csv = csvInOffice(file)
      expect(csv).toMatch(/Travel,350(\.00)?,450/)
      // LibreOffice calculated the formulas: the total of Q1 with the new value, and the new cell
      expect(csv).toMatch(/Total,"?1,?770(\.00)?"?,"?1,?890(\.00)?"?,"?3,?660/)
    }
  })

  test('text is an inline string: the shared strings part is not rewritten (a LibreOffice-saved workbook)', async () => {
    const before = viaOffice(await budget())
    const { file } = run(before, [{ cell: { sheet: 'Budget', ref: 'A3', value: 'Flights' } }, { cell: { ref: 'A9', value: 'new note' } }])
    const changed = changedParts(before, file)
    expect(changed).not.toContain('xl/sharedStrings.xml')
    expect(changed.every((n) => /^xl\/(workbook\.xml|worksheets\/sheet1\.xml)$/.test(n))).toBe(true)
    expect(cell(file, 'Budget', 'A3')!.v).toBe('Flights')
    expect(cell(file, 'Budget', 'A9')!.v).toBe('new note')
    if (soffice) expect(csvInOffice(file)).toContain('Flights,')
  })

  test('appended rows take the style of the last row; the used range grows', async () => {
    const before = await budget()
    const { file } = run(before, [{ append_rows: { sheet: 'Budget', rows: [['Training', 500, 650], ['Misc', 40, '=B9*2']] } }])
    expect(cell(file, 'Budget', 'A8')!.v).toBe('Training')
    expect(cell(file, 'Budget', 'C9')!.f).toBe('B9*2')
    const sheet = part(file, 'xl/worksheets/sheet1.xml')!
    expect(sheet).toMatch(/<dimension ref="A1:C9"\/>/)
    expect(sheet.indexOf('<row r="8"')).toBeGreaterThan(sheet.indexOf('<row r="7"'))
    if (soffice) expect(csvInOffice(file)).toContain('Misc,40,80')
  })

  test('a changed formula cell drops a stale calculation chain (its relationship and content type too)', async () => {
    const before = withCalcChain(await budget())
    const { file, report } = run(before, [{ cell: { sheet: 'Budget', ref: 'B5', value: '=SUM(B2:B3)' } }])
    expect(report.removed).toEqual(['xl/calcChain.xml'])
    expect(part(file, 'xl/calcChain.xml')).toBeNull()
    expect(part(file, 'xl/_rels/workbook.xml.rels')).not.toContain('calcChain')
    expect(part(file, '[Content_Types].xml')).not.toContain('calcChain')
    // a plain value change elsewhere keeps the chain
    expect(run(before, [{ cell: { sheet: 'Budget', ref: 'A2', value: 'Office rent' } }]).report.removed).toEqual([])
  })

  test('refused: inside merged cells, a sheet that is not there, a bad address', async () => {
    const before = await budget()
    expect(() => run(before, [{ cell: { sheet: 'Budget', ref: 'B7', value: 'x' } }])).toThrow(/inside the merged cells A7:C7; write to A7/)
    expect(() => run(before, [{ cell: { sheet: 'Plan', ref: 'A1', value: 'x' } }])).toThrow(/there is no sheet "Plan"/)
    expect(() => run(before, [{ cell: { sheet: 'Budget', ref: 'ZZZZ1', value: 'x' } }])).toThrow(/not a cell address/)
    expect(() => run(before, [{ cell: { ref: 'A1', value: 1 } }, { cell: { ref: 'a1', value: 2 } }])).toThrow(/both write/)
    expect(run(before, [{ cell: { sheet: 'budget', ref: 'A7', value: 'Approved' } }]).report.cells).toEqual([{ sheet: 'Budget', ref: 'A7', value: 'Approved' }])
  })

  test('stored results: kept for formulas that cannot be calculated again (CUBE, another workbook, RTD); none cleared when no cell reads differently', async () => {
    const before = writeZip(readZip(await budget()).map((e) => (e.name === 'xl/worksheets/sheet1.xml' ? { name: e.name, data: new TextEncoder().encode(new TextDecoder().decode(e.data).replace('</sheetData>', '<row r="20"><c r="A20" t="str"><f>CUBEVALUE("Sales","[Measures].[Total]")</f><v>99</v></c><c r="B20"><f>[1]Rates!A1</f><v>1.5</v></c><c r="C20" t="str"><f>RTD("x",,"y")</f><v>live</v></c><c r="D20"><f>B2*2</f><v>2400</v></c></row></sheetData>')) } : e)))
    const { file } = run(before, [{ cell: { sheet: 'Budget', ref: 'B3', value: 350 } }])
    const x = part(file, 'xl/worksheets/sheet1.xml')!
    expect(x).toContain('<v>99</v>')
    expect(x).toContain('<v>1.5</v>')
    expect(x).toContain('<v>live</v>')
    expect(x).toMatch(/<c r="D20"><f>B2\*2<\/f><\/c>/)
    // the same value again: nothing reads differently, every stored result stays
    const same = run(before, [{ cell: { sheet: 'Budget', ref: 'B3', value: 300 } }])
    expect(part(same.file, 'xl/worksheets/sheet1.xml')).toContain('<v>2400</v>')
    expect(same.report.recalc).toBe(false)
  })

  test('the verifier catches a cell changed that no change named', async () => {
    const before = await budget()
    const out = unframe<EditReport>(officeEditRequest(frame({ kind: 'xlsx', changes: [{ cell: { sheet: 'Budget', ref: 'B3', value: 350 } }] }, [before])))
    const sneaky = writeZip(readZip(out.blobs[0]!).map((e) => (e.name === 'xl/worksheets/sheet1.xml' ? { name: e.name, data: new TextEncoder().encode(new TextDecoder().decode(e.data).replace('<v>1200</v>', '<v>1</v>')) } : e)))
    expect(() => officeVerifyRequest(frame({ kind: 'xlsx', changed: out.json.changed, added: [], notes: out.json.notes, cells: out.json.cells }, [before, sneaky]))).toThrow(/changed, but no change named it/)
  })
})
