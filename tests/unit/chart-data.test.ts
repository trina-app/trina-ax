// Charts in a deck or Word file the AI made keep their data sheet, so right-click > Edit Data in PowerPoint (Keynote,
// Google Slides, Word) opens their numbers (QA A-03-L, 2026-11-24). Root cause: the Office exit check refused the
// chart's own data workbook (a `package` relationship from ppt/charts/chartN.xml to ppt/embeddings/*.xlsx) as "an
// embedded object", so the AI deleted the workbooks to get the deck saved. Now the workbook passes when it passes the
// same scan itself (files/office-links-check.ts), and the save result reads every chart back (files/chart-data.ts).
// The decks are real files: tests/fixtures/charts/make-deck.cjs (pptxgenjs 4.0.1, the pptx skill's addChart) and
// make-python-pptx.py (python-pptx 1.0.2 with XlsxWriter).
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import * as XLSX from 'xlsx'
import { checkOfficeLinks, officeExitRequest } from '../../server/src/files/office-links-check'
import { assertSafeTeamFile } from '../../server/src/files/office-exit'
import { CHART_DATA_MODE, chartDataLine, chartDataRequest, chartDataReview } from '../../server/src/files/chart-data'
import { officeWorkerWrite } from '../../server/src/files/extract'
import { readZip, writeZip, type ZipEntry } from '../../server/src/files/zip-write'
import { docx } from '../lib/office-fixture'

const FIX = path.join(import.meta.dir, '..', 'fixtures', 'charts')
const DECK = new Uint8Array(fs.readFileSync(path.join(FIX, 'pptxgenjs-charts.pptx')))
const PY_DECK = new Uint8Array(fs.readFileSync(path.join(FIX, 'python-pptx-chart.pptx')))
const enc = new TextEncoder(), dec = new TextDecoder()
const PACKAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/package'

const entries = (b: Uint8Array) => readZip(b).map((e): ZipEntry => ({ name: e.name, data: e.data }))
const part = (b: Uint8Array, name: string) => readZip(b).find((e) => e.name === name)?.data
const text = (b: Uint8Array, name: string) => dec.decode(part(b, name)!)
/** the package with parts changed (a function of the text), added (bytes) or removed (null) */
function edit(b: Uint8Array, changes: Record<string, ((x: string) => string) | Uint8Array | null>): Uint8Array {
  const out = entries(b).filter((e) => changes[e.name] !== null).map((e) => {
    const c = changes[e.name]
    return typeof c === 'function' ? { name: e.name, data: enc.encode(c(dec.decode(e.data))) } : c instanceof Uint8Array ? { name: e.name, data: c } : e
  })
  for (const [name, c] of Object.entries(changes)) if (c instanceof Uint8Array && !out.some((e) => e.name === name)) out.push({ name, data: c })
  return writeZip(out)
}
function frame(kind: string, file: Uint8Array): Uint8Array {
  const head = enc.encode(JSON.stringify({ kind, sizes: [file.length] }))
  const out = new Uint8Array(4 + head.length + file.length)
  new DataView(out.buffer).setUint32(0, head.length); out.set(head, 4); out.set(file, 4 + head.length)
  return out
}
const WB1 = 'ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx'

describe('a real pptxgenjs deck holds a data sheet for every chart', () => {
  test('each chart part names its workbook through <c:externalData>, and the workbook holds the series', () => {
    const names = readZip(DECK).map((e) => e.name)
    const charts = names.filter((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n)).sort()
    expect(charts).toEqual(['ppt/charts/chart1.xml', 'ppt/charts/chart2.xml', 'ppt/charts/chart3.xml', 'ppt/charts/chart4.xml'])
    for (const c of charts) {
      const id = /<c:externalData r:id="([^"]+)"/.exec(text(DECK, c))?.[1]
      expect(id).toBeTruthy()
      const rel = new RegExp(`Id="${id}" Type="${PACKAGE}" Target="\\.\\./embeddings/([^"]+\\.xlsx)"`).exec(text(DECK, c.replace('charts/', 'charts/_rels/') + '.rels'))
      expect(rel).not.toBeNull()
      expect(names).toContain(`ppt/embeddings/${rel![1]}`)
    }
    // slide 1, "Sales by region": the workbook's cells are the numbers the chart shows
    const ws = XLSX.read(part(DECK, WB1)!, { type: 'buffer' }).Sheets.Sheet1!
    const col = (c: string) => [2, 3, 4, 5].map((r) => ws[`${c}${r}`]?.v)
    expect(col('A')).toEqual(['Q1', 'Q2', 'Q3', 'Q4'])
    expect([ws.B1?.v, ...col('B')]).toEqual(['North', 120, 135, 150, 171])
    expect([ws.C1?.v, ...col('C')]).toEqual(['South', 80, 92.5, 101, 99])
    expect(text(DECK, 'ppt/charts/chart1.xml')).toContain('<c:f>Sheet1!$B$2:$B$5</c:f>')
  })

  test('the read-back finds every chart with its data, on its slide', () => {
    const r = chartDataReview(DECK)
    expect(r.kind).toBe('pptx')
    expect(r.charts.map((c) => [c.where, c.state])).toEqual([['slide 1', 'ok'], ['slide 2', 'ok'], ['slide 3', 'ok'], ['slide 4', 'ok']])
    expect(r.charts[0]!.title).toBe('Sales by region')
    expect(chartDataLine(r)).toContain('all 4 charts are native charts with their data sheet')
    expect(chartDataReview(PY_DECK).charts.map((c) => c.state)).toEqual(['ok'])
  })
})

describe('the Office exit check keeps a chart\'s own data workbook (QA A-03-L)', () => {
  test('a pptxgenjs deck and a python-pptx deck pass, in make_file\'s check and the exit check', async () => {
    for (const d of [DECK, PY_DECK]) {
      expect(officeExitRequest(frame('pptx', d))).toBeInstanceOf(Uint8Array)
      expect(checkOfficeLinks('pptx', d)).toBe(d)
    }
    // through the office worker, as every exit calls it: the bytes come back whole, workbooks included
    const saved = await assertSafeTeamFile('deck.pptx', DECK, null)
    expect(readZip(saved).filter((e) => /^ppt\/embeddings\/.+\.xlsx$/.test(e.name)).length).toBe(4)
  })

  test('a Word file with a chart and its data workbook passes too', () => {
    expect(officeExitRequest(frame('docx', wordWithChart()))).toBeInstanceOf(Uint8Array)
    const r = chartDataReview(wordWithChart())
    expect(r.kind).toBe('docx')
    expect(r.charts.map((c) => [c.where, c.state])).toEqual([['chart 1', 'ok']])
    expect(chartDataLine(r)).toContain('Edit Data in Word')
  })

  test('a data workbook that holds a risky item is refused, naming it', () => {
    const wb = part(DECK, WB1)!
    // a macro project inside the workbook
    const macro = edit(DECK, { [WB1]: edit(wb, { 'xl/vbaProject.bin': enc.encode('macro') }) })
    expect(() => officeExitRequest(frame('pptx', macro))).toThrow(/data workbook.*macro project/)
    // a file: link inside the workbook
    const linkRels = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="file:///etc/passwd" TargetMode="External"/></Relationships>'
    const linked = edit(DECK, { [WB1]: edit(wb, { 'xl/worksheets/_rels/sheet1.xml.rels': enc.encode(linkRels) }) })
    expect(() => officeExitRequest(frame('pptx', linked))).toThrow(/data workbook.*file:\/\/\/etc\/passwd/)
    // a damaged workbook
    expect(() => officeExitRequest(frame('pptx', edit(DECK, { [WB1]: enc.encode('PK\x03\x04 not really') })))).toThrow()
    // a workbook whose own chart embeds another workbook (one level only)
    const nestedRels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${PACKAGE}" Target="../embeddings/inner.xlsx"/></Relationships>`
    const nested = edit(DECK, { [WB1]: edit(wb, { 'xl/charts/chart1.xml': enc.encode('<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"/>'), 'xl/charts/_rels/chart1.xml.rels': enc.encode(nestedRels), 'xl/embeddings/inner.xlsx': wb }) })
    expect(() => officeExitRequest(frame('pptx', nested))).toThrow(/embedded object.*package/)
  })

  test('anything but a chart\'s internal .xlsx is still an embedded object', () => {
    const rels = 'ppt/charts/_rels/chart1.xml.rels'
    // an OLE object from the chart, a binary .xls, an external target, a missing part
    expect(() => officeExitRequest(frame('pptx', edit(DECK, { [rels]: (x) => x.replace('/relationships/package', '/relationships/oleObject') })))).toThrow(/oleObject/)
    expect(() => officeExitRequest(frame('pptx', edit(DECK, { [rels]: (x) => x.replace('Worksheet1.xlsx', 'Worksheet1.xls'), 'ppt/embeddings/Microsoft_Excel_Worksheet1.xls': part(DECK, WB1)! })))).toThrow(/package/)
    expect(() => officeExitRequest(frame('pptx', edit(DECK, { [rels]: (x) => x.replace('Target="../embeddings/Microsoft_Excel_Worksheet1.xlsx"', 'Target="https://example.com/a.xlsx" TargetMode="External"') })))).toThrow(/package/)
    expect(() => officeExitRequest(frame('pptx', edit(DECK, { [WB1]: null })))).toThrow(/package/)
    // a package from a slide (an embedded file shown as an icon), not from a chart
    const slideRels = 'ppt/slides/_rels/slide1.xml.rels'
    const fromSlide = edit(DECK, { [slideRels]: (x) => x.replace('</Relationships>', `<Relationship Id="rId99" Type="${PACKAGE}" Target="../embeddings/Microsoft_Excel_Worksheet1.xlsx"/></Relationships>`) })
    expect(() => officeExitRequest(frame('pptx', fromSlide))).toThrow(/package/)
  })
})

describe('the read-back names charts that cannot be edited', () => {
  test('a deck whose data workbooks were removed (the A-03-L file)', () => {
    const strip: Record<string, ((x: string) => string) | null> = {}
    for (const e of readZip(DECK)) {
      if (e.name.startsWith('ppt/embeddings/')) strip[e.name] = null
      if (/^ppt\/charts\/_rels\//.test(e.name)) strip[e.name] = null
      if (/^ppt\/charts\/chart\d+\.xml$/.test(e.name)) strip[e.name] = (x) => x.replace(/<c:externalData\b[\s\S]*?<\/c:externalData>/, '')
    }
    const bare = edit(DECK, strip)
    // it passes the exit check (nothing embedded), and the save result says the charts cannot be edited
    expect(officeExitRequest(frame('pptx', bare))).toBeInstanceOf(Uint8Array)
    const r = chartDataReview(bare)
    expect(r.charts.map((c) => c.state)).toEqual(['none', 'none', 'none', 'none'])
    const line = chartDataLine(r)
    expect(line).toContain('4 charts of 4 cannot be edited in PowerPoint')
    expect(line).toContain('slide 1 "Sales by region": no data sheet')
    expect(line).toContain('addChart')
  })

  test('a workbook removed but still named, and a workbook with other numbers', () => {
    expect(chartDataReview(edit(DECK, { [WB1]: null })).charts[0]!.state).toBe('missing')
    // the sheet says 999 where the chart shows 135
    const wb = part(DECK, WB1)!
    const changed = edit(DECK, { [WB1]: edit(wb, { 'xl/worksheets/sheet1.xml': (x) => x.replace(/(<c r="B3"[^>]*><v>)135(<\/v>)/, '$1999$2') }) })
    const c = chartDataReview(changed).charts[0]!
    expect(c.state).toBe('mismatch')
    expect(c.detail).toContain('"North" shows 135')
    expect(c.detail).toContain('999')
    expect(chartDataLine(chartDataReview(changed))).toContain('1 chart of 4 cannot be edited')
  })

  test('a file without charts gets no line; the office worker answers the mode', async () => {
    expect(chartDataLine(chartDataReview(docx()))).toBe('')
    expect(JSON.parse(dec.decode(chartDataRequest(DECK))).charts).toHaveLength(4)
    const r = JSON.parse((await officeWorkerWrite(CHART_DATA_MODE, DECK, undefined, 256 * 1024)).toString('utf8'))
    expect(r.charts.map((x: { state: string }) => x.state)).toEqual(['ok', 'ok', 'ok', 'ok'])
  })
})

/** A Word file holding slide 1's chart as Word keeps one: word/charts/chart1.xml, its rels to word/embeddings/. */
function wordWithChart(): Uint8Array {
  const base = docx({ extra: '<w:p><w:r><w:drawing><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId7"/></w:drawing></w:r></w:p>' })
  return edit(base, {
    'word/_rels/document.xml.rels': (x) => x.replace('</Relationships>', '<Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="charts/chart1.xml"/></Relationships>'),
    'word/charts/chart1.xml': part(DECK, 'ppt/charts/chart1.xml')!,
    'word/charts/_rels/chart1.xml.rels': part(DECK, 'ppt/charts/_rels/chart1.xml.rels')!,
    'word/embeddings/Microsoft_Excel_Worksheet1.xlsx': part(DECK, WB1)!,
  })
}
