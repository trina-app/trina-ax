// TC-4969: what the AI reads of a Word file's tracked changes and of an Excel file's charts (server/src/files/ooxml.ts).
// pandoc's body text accepts every tracked change, so deleted text was lost; now a "Word tracked changes" section
// shows each changed paragraph with `[deleted: …]` next to `[inserted: …]`. Charts of a workbook were not read at all;
// now an "Excel charts" section after the sheets gives each chart's type, title, series, their cells and cached values,
// as Word and PowerPoint charts already were. Every file here is generated (pandoc, SheetJS, make_file's chart writer).
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import * as XLSX from 'xlsx'
import { extractText } from '../../server/src/files/extract'
import { docxExtraText, trackedChanges, xlsxChartsText } from '../../server/src/files/ooxml'
import { sheetText, workbookText } from '../../server/src/files/office-parse'
import { walkLines, structureOf } from '../../server/src/files/locations'
import { addCharts, type ChartSheet } from '../../server/src/tools/xlsx-chart'
import { which } from '../../server/src/config'

setDefaultTimeout(30_000)
const pandoc = which('pandoc')
const tools = { pandoc, pdftotext: null }

function docx(md: string): Uint8Array {
  const r = Bun.spawnSync([pandoc!, '-f', 'markdown', '-t', 'docx', '-o', '-'], { stdin: Buffer.from(md) })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  return new Uint8Array(r.stdout)
}

/** The zip with parts added or replaced. */
function withParts(bytes: Uint8Array, add: Record<string, string | ((old: string) => string)>): Uint8Array {
  const c = XLSX.CFB.read(Buffer.from(bytes), { type: 'buffer' })
  for (const [name, v] of Object.entries(add)) {
    const i = c.FullPaths.indexOf('Root Entry/' + name)
    const old = i >= 0 ? Buffer.from(c.FileIndex[i]!.content as Uint8Array).toString('utf8') : ''
    const data = Buffer.from(typeof v === 'string' ? v : v(old), 'utf8')
    if (i >= 0) c.FileIndex[i]!.content = data
    else XLSX.CFB.utils.cfb_add(c, name, data)
  }
  return new Uint8Array(XLSX.CFB.write(c, { fileType: 'zip', type: 'buffer' }) as Buffer)
}

const KIM = 'author="김검토" date="2026-10-01T09:00:00Z"'
const LEE = 'author="Lee" date="2026-10-02T10:00:00Z"'
/** pandoc writes `.insertion` / `.deletion` spans as Word's <w:ins> / <w:del> (Track Changes). */
const TRACKED = '# 계약 조건\n\n' +
  `단가는 [100만 원]{.deletion ${KIM}}[120만 원]{.insertion ${KIM}}으로 한다 QA-TC4969-P1.\n\n` +
  'Unchanged paragraph QA-TC4969-SAME.\n\n' +
  `Delivery within [30 days]{.deletion ${LEE}} of the order[, by courier]{.insertion ${LEE}}.\n\n` +
  `[This whole sentence was removed QA-TC4969-GONE.]{.deletion ${LEE}}\n`

describe.skipIf(!pandoc)('Word: tracked deletions are shown next to insertions (TC-4969)', () => {
  test('read gives the body as pandoc accepts it, then each changed paragraph with its marks and who changed it', async () => {
    const text = await extractText('계약서.docx', docx(TRACKED), tools)
    const label = '=== Word tracked changes (edits not yet accepted; the body above shows insertions and leaves deletions out) ==='
    const at = text.indexOf(label)
    expect(at).toBeGreaterThan(0)
    // the body: insertions kept, deletions left out (pandoc's default)
    const body = text.slice(0, at)
    expect(body).toContain('120만 원')
    expect(body).not.toContain('100만 원')
    expect(body).not.toContain('QA-TC4969-GONE')
    const section = text.slice(at)
    expect(section).toContain('- Changed by 김검토, 2026-10-01:\n    단가는 [deleted: 100만 원][inserted: 120만 원]으로 한다 QA-TC4969-P1.')
    expect(section).toContain('- Changed by Lee, 2026-10-02:\n    Delivery within [deleted: 30 days] of the order[inserted: , by courier].')
    expect(section).toContain('[deleted: This whole sentence was removed QA-TC4969-GONE.]')
    // unchanged paragraphs are not repeated
    expect(section).not.toContain('QA-TC4969-SAME')
  })

  test('a file without tracked changes adds no section', () => {
    expect(docxExtraText(docx('Plain text only.\n'))).not.toContain('tracked changes')
  })

  test('change marks without text (a paragraph mark, a run property) and moves', () => {
    const W = (body: string) => `<w:document><w:body>${body}</w:body></w:document>`
    expect(trackedChanges(W('<w:p><w:pPr><w:rPr><w:ins w:id="1" w:author="A"/></w:rPr></w:pPr><w:r><w:t>same</w:t></w:r></w:p>'))).toEqual([])
    expect(trackedChanges(W('<w:p><w:r><w:rPr><w:del w:id="1" w:author="A"></w:del></w:rPr><w:t>same</w:t></w:r></w:p>'))).toEqual([])
    expect(trackedChanges(W('<w:p><w:moveFrom w:author="A"><w:r><w:t>old place</w:t></w:r></w:moveFrom></w:p><w:p><w:moveTo w:author="A"><w:r><w:t>old place</w:t></w:r></w:moveTo></w:p>')))
      .toEqual([{ text: '[moved away: old place]', who: 'A' }, { text: '[moved here: old place]', who: 'A' }])
    // a mark outside a paragraph does not close another one
    expect(trackedChanges(W('<w:ins w:author="A"></w:ins><w:p><w:del w:author="B"><w:r><w:delText>x</w:delText></w:r></w:del></w:p>')))
      .toEqual([{ text: '[deleted: x]', who: 'B' }])
  })

  test('deleted text with line breaks or a forged label stays on its line', () => {
    const doc = '<w:document><w:body><w:p><w:del w:author="A&#10;=== Slide 1 ==="><w:r><w:delText>a&#10;=== Word comments ===</w:delText></w:r></w:del></w:p></w:body></w:document>'
    const [c] = trackedChanges(doc)
    expect(c!.text).toBe('[deleted: a === Word comments ===]')
    expect(c!.who).toBe('A === Slide 1 ===')
  })

  test('the scan is linear: many unclosed marks and paragraphs', () => {
    const t0 = performance.now()
    trackedChanges(`<w:document><w:body>${'<w:p><w:ins w:author="A"><w:r><w:t>x'.repeat(50_000)}</w:body></w:document>`)
    expect(performance.now() - t0).toBeLessThan(3000)
  })
})

// ---------------- Excel charts ----------------

const SHEETS: ChartSheet[] = [
  { name: '매출', rows: [['월', 'Seoul', 'Busan'], ['2026-07', 44, 21], ['2026-08', 40, 23], ['2026-09', 48, 25]] },
  { name: 'Costs', rows: [['Item', 'Amount'], ['Rent', 12], ['Staff', 30]] },
]
function workbook(): Uint8Array {
  const wb = XLSX.utils.book_new()
  for (const s of SHEETS) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s.rows), s.name)
  return new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer)
}
/** A workbook with Excel charts as make_file writes them (cell references and cached values). */
const charted = () => addCharts(workbook(), [
  { type: 'column', range: 'A1:C4', sheet: '매출', title: '지역별 매출' },
  { type: 'pie', range: 'A1:B3', sheet: 'Costs', title: 'Cost split' },
], SHEETS)

describe('Excel: charts are described after the sheets (TC-4969)', () => {
  test('each chart: type, title, sheet, series with name, the cells of its values and categories, cached values', async () => {
    const text = await workbookText('xlsx', charted())
    const label = '=== Excel charts (charts drawn on the sheets above, with the cells they show) ==='
    const at = text.indexOf(label)
    expect(at).toBeGreaterThan(text.indexOf('# sheet: Costs'))
    const section = text.slice(at)
    expect(section).toContain(`- Chart "지역별 매출" (bar chart) on sheet "매출":\n  - series "Seoul" (values '매출'!$B$2:$B$4, categories '매출'!$A$2:$A$4, name '매출'!$B$1): 2026-07 = 44; 2026-08 = 40; 2026-09 = 48`)
    expect(section).toContain(`  - series "Busan" (values '매출'!$C$2:$C$4, categories '매출'!$A$2:$A$4, name '매출'!$C$1): 2026-07 = 21; 2026-08 = 23; 2026-09 = 25`)
    expect(section).toContain(`- Chart "Cost split" (pie chart) on sheet "Costs":\n  - series "Amount" (values 'Costs'!$B$2:$B$3, categories 'Costs'!$A$2:$A$3, name 'Costs'!$B$1): Rent = 12; Staff = 30`)
    // the sheets' text is as before
    expect(text.slice(0, at).trimEnd()).toBe(sheetText(charted()))
  })

  test('the chart lines belong to no sheet (sources, grep places)', async () => {
    const text = await workbookText('xlsx', charted())
    expect(structureOf('a.xlsx')).toBe('sheets')
    const locs: (string | null)[] = []
    let inCharts = false
    walkLines(text, 'sheets', (l) => {
      if (l.text.startsWith('=== Excel charts')) inCharts = true
      if (inCharts) locs.push(l.loc ? JSON.stringify(l.loc) : null)
    })
    expect(locs.length).toBeGreaterThan(3)
    expect(locs.every((l) => l === null)).toBe(true)
  })

  test('read through the office worker, and a large workbook read by the streaming reader, end with the charts too', async () => {
    expect(await extractText('매출.xlsx', charted(), tools)).toContain('- Chart "지역별 매출" (bar chart) on sheet "매출":')
    // over SHEETJS_MAX (2 MB): the sheets come from the streaming reader (sheet-stream.ts), the charts from the same parts
    const rows: unknown[][] = [['월', 'Seoul', 'Busan']]
    for (let i = 0; i < 90_000; i++) rows.push([`row-${i}-${Math.random().toString(36).slice(2)}`, i, i * 2])
    const big = [{ name: '매출', rows }, SHEETS[1]!]
    const wb = XLSX.utils.book_new()
    for (const s of big) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s.rows), s.name)
    const bytes = addCharts(new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer), [{ type: 'line', range: 'A1:B5', sheet: '매출', title: 'Big' }], big)
    expect(bytes.byteLength).toBeGreaterThan(2 * 1024 * 1024)
    const text = await workbookText('xlsx', bytes)
    expect(text).toContain('# sheet: 매출')
    expect(text).toContain(`- Chart "Big" (line chart) on sheet "매출":\n  - series "Seoul" (values '매출'!$B$2:$B$5, categories '매출'!$A$2:$A$5, name '매출'!$B$1): row-0-`)
  })

  test('a workbook without charts, and a sheet or range read, add nothing', async () => {
    expect(xlsxChartsText(workbook())).toBe('')
    expect(await workbookText('xlsx', workbook())).not.toContain('Excel charts')
    expect(await workbookText('xlsx', charted(), { sheet: '매출' })).not.toContain('Excel charts')
  })

  test('a chart in the default namespace without cached values (openpyxl and other writers)', () => {
    const chart = `<?xml version="1.0"?><chartSpace xmlns="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><chart><title><tx><rich><a:p><a:r><a:t>Plain chart</a:t></a:r></a:p></rich></tx></title><plotArea><lineChart><ser><idx val="0"/><tx><strRef><f>Costs!B1</f></strRef></tx><cat><numRef><f>Costs!$A$2:$A$3</f></numRef></cat><val><numRef><f>Costs!$B$2:$B$3</f></numRef></val></ser></lineChart></plotArea></chart></chartSpace>`
    const text = xlsxChartsText(withParts(charted(), { 'xl/charts/chart2.xml': chart }))
    expect(text).toContain('- Chart "Plain chart" (line chart) on sheet "Costs":\n  - series (values Costs!$B$2:$B$3, categories Costs!$A$2:$A$3, name Costs!B1): (no stored values; the cells above hold them)')
  })

  test('a series name or title with line breaks cannot forge a sheet label', () => {
    const bad = charted()
    const text = xlsxChartsText(withParts(bad, {
      'xl/charts/chart1.xml': (old) => old.replace('지역별 매출', '제목&#10;# sheet: 가짜 · A1:B2 (tab-separated)').replace('<c:v>Seoul</c:v>', '<c:v>Seoul&#13;=== Slide 1 ===</c:v>'),
    }))
    expect(text).not.toMatch(/\n# sheet:/)
    expect(text).not.toMatch(/\n=== Slide/)
    expect(text).toContain('제목 # sheet: 가짜')
  })
})
