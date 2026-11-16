// make_file xlsx `charts` (server/src/tools/xlsx-chart.ts): native Excel charts added to the zip exceljs wrote.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import * as XLSX from 'xlsx'
import { makeHandler } from '../../server/src/mcp/protocol'
import { readZip } from '../../server/src/files/zip-write'
import { which } from '../../server/src/config'
import { addCharts, placeCharts, type ChartSheet } from '../../server/src/tools/xlsx-chart'
import { makeCApp, type CApp, type Person } from '../lib/c-app'

setDefaultTimeout(30_000)

let A: CApp
beforeAll(async () => { A = await makeCApp('c-xlsx-chart') })
afterAll(async () => { await A.close() })

let rpcId = 0
async function call(user: Person, name: string, args: unknown) {
  const h = makeHandler(A.ctx.files, A.ctx.db, A.toolCtx(user, null))
  const r = await h({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } })
  return { text: r.result.content[0].text as string, isError: !!r.result.isError }
}

const parts = (file: string) => new Map(readZip(new Uint8Array(fs.readFileSync(file))).map((e) => [e.name, new TextDecoder().decode(e.data)]))
const xmllint = which('xmllint')

const SALES = '## 지역별 월 매출\n\n| 월 | Seoul | Busan | Daegu | 합계 |\n|---|---|---|---|---|\n' +
  '| 2026-07 | 44000000 | 21000000 | 9000000 | =SUM(B2:D2) |\n| 2026-08 | 44000000 | 23000000 | 8000000 | =SUM(B3:D3) |\n' +
  '| 2026-09 | 45000000 | 16000000 | 9000000 | =SUM(B4:D4) |\n\n## Sales\n\n| Region | Revenue |\n|---|---|\n| Seoul | 133 |\n| Busan | 60 |\n'

describe('make_file xlsx charts', () => {
  test('a column chart and a pie chart: parts, references, cached values; the data stays as it was', async () => {
    const out = 'users/alice/out/sales-chart.xlsx'
    const r = await call('alice', 'make_file', {
      content: SALES, format: 'xlsx', output: out,
      charts: [{ type: 'column', range: 'A1:D4', title: '지역별 매출 & 월' }, { type: 'pie', range: 'A1:B3', sheet: 'Sales' }, { type: 'line', range: 'A1:B4', anchor: 'H20' }],
    })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain('3 native Excel charts')
    const file = path.join(A.team, out)
    const p = parts(file)
    const charts = [...p.keys()].filter((n) => /^xl\/charts\/chart\d+\.xml$/.test(n))
    expect(charts).toHaveLength(3) // what the scenario runner counts
    expect([...p.keys()].filter((n) => /^xl\/drawings\/drawing\d+\.xml$/.test(n))).toHaveLength(2) // one per sheet
    const types = p.get('[Content_Types].xml')!
    for (const c of charts) expect(types).toContain(`PartName="/${c}" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"`)
    // the first sheet: two charts, the drawing element before pageMargins' followers, its relationship
    const s1 = p.get('xl/worksheets/sheet1.xml')!
    expect(s1).toMatch(/<pageSetup[^>]*\/><drawing r:id="rIdChart1"\/><\/worksheet>$/)
    expect(p.get('xl/worksheets/_rels/sheet1.xml.rels')).toContain('Target="../drawings/drawing1.xml"')
    const col = p.get('xl/charts/chart1.xml')!
    expect(col).toContain('<c:barDir val="col"/>')
    expect(col).toContain("<c:f>'지역별 월 매출'!$A$2:$A$4</c:f>")
    expect(col).toContain("<c:f>'지역별 월 매출'!$D$2:$D$4</c:f>")
    expect(col).toContain('<c:v>Daegu</c:v>')
    expect(col).toContain('<c:pt idx="2"><c:v>9000000</c:v></c:pt>')
    expect(col).toContain('<a:t>지역별 매출 &amp; 월</a:t>')
    expect((col.match(/<c:ser>/g) ?? []).length).toBe(3)
    expect(p.get('xl/charts/chart2.xml')).toContain('<c:lineChart>')
    const pie = p.get('xl/charts/chart3.xml')!
    expect(pie).toContain('<c:pieChart>')
    expect(pie).toContain("'Sales'!$B$2:$B$3")
    const d1 = p.get('xl/drawings/drawing1.xml')!
    expect(d1).toContain('<xdr:from><xdr:col>6</xdr:col>') // right of the five data columns, one column apart
    expect(d1).toContain('<xdr:from><xdr:col>7</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>19</xdr:row>') // anchor H20
    // the cells as they were: SheetJS and exceljs still read them
    const wb = XLSX.read(fs.readFileSync(file))
    expect(wb.SheetNames).toEqual(['지역별 월 매출', 'Sales'])
    expect(wb.Sheets['지역별 월 매출']!.E2.f).toBe('SUM(B2:D2)')
    expect(wb.Sheets.Sales!.B2.v).toBe(133)
  })

  test.skipIf(!xmllint)('every part is well-formed XML', async () => {
    const out = 'users/alice/out/wf.xlsx'
    const r = await call('alice', 'make_file', { content: SALES, format: 'xlsx', output: out, charts: [{ type: 'bar', range: 'A1:C4', title: '<a> "b"' }] })
    expect(r.isError, r.text).toBe(false)
    const dir = fs.mkdtempSync(path.join(A.data, 'wf-'))
    for (const [name, xml] of parts(path.join(A.team, out))) {
      if (!/\.(xml|rels)$/.test(name)) continue
      const f = path.join(dir, name.replace(/[/[\]]/g, '_'))
      fs.writeFileSync(f, xml)
      const lint = Bun.spawnSync([xmllint!, '--noout', f])
      expect(lint.exitCode, `${name}: ${lint.stderr.toString()}`).toBe(0)
    }
  })

  test('a chart that does not fit is refused and nothing is saved', async () => {
    const cases: [unknown, RegExp][] = [
      [{ type: 'column', range: 'A1:Z40' }, /outside sheet/],
      [{ type: 'column', range: 'B2-D4' }, /range must be like/],
      [{ type: 'pie', range: 'A1:C3' }, /one column of numbers/],
      [{ type: 'column', range: 'A1:A4' }, /label column/],
      [{ type: 'line', range: 'A1:B3', sheet: 'Nope' }, /no sheet 'Nope'/],
    ]
    for (const [chart, why] of cases) {
      const out = 'users/alice/out/refused.xlsx'
      const r = await call('alice', 'make_file', { content: SALES, format: 'xlsx', output: out, charts: [chart] })
      expect(r.isError).toBe(true)
      expect(r.text).toMatch(why)
      expect(fs.existsSync(path.join(A.team, out))).toBe(false)
    }
    const docx = await call('alice', 'make_file', { content: '# a', format: 'docx', output: 'users/alice/out/x.docx', charts: [{ type: 'pie', range: 'A1:B2' }] })
    expect(docx.isError).toBe(true)
    expect(docx.text).toContain('charts are only for format "xlsx"')
  })
})

describe('xlsx-chart', () => {
  const sheet: ChartSheet = { name: "Q3's", rows: [['Label', 'Text', 'N'], ['a', 'x', 1], ['b', 'y', { formula: 'N2*2', result: 2 }]] }
  test('a column of text only is refused; a formula column counts as numbers; quotes in sheet names are doubled', () => {
    expect(() => placeCharts([{ type: 'column', range: 'A1:B3' }], [sheet])).toThrow(/column B has no numbers/)
    const numbers: ChartSheet = { name: "Q3's", rows: [['Label', 'A', 'N'], ['a', 1, 1], ['b', 2, { formula: 'C2*2', result: 2 }]] }
    // a workbook another writer made (SheetJS: other part names and relationship ids)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Label', 'A', 'N'], ['a', 1, 1], ['b', 2, 2]]), "Q3's")
    const bytes = new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
    const made = addCharts(bytes, [{ type: 'line', range: 'A1:C3' }, { type: 'line', range: 'C3:A1' }], [numbers])
    const outp = new Map(readZip(made).map((e) => [e.name, new TextDecoder().decode(e.data)]))
    const c = outp.get('xl/charts/chart1.xml')!
    expect(c).toContain("'Q3''s'!$C$2:$C$3")
    expect(c).toContain('<c:pt idx="1"><c:v>2</c:v></c:pt>')
    expect(outp.get('xl/charts/chart2.xml')).toBe(c) // the corners in any order
    expect(addCharts(bytes, [], [sheet])).toBe(bytes)
  })
})
