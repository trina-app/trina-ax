// TC-4969: what the AI reads of a Word file's tracked changes and of an Excel file's charts (server/src/files/ooxml.ts).
// pandoc's body text accepts every tracked change, so deleted text was lost; now a "Word tracked changes" section
// shows each changed paragraph with `[deleted: …]` next to `[inserted: …]`. Charts of a workbook were not read at all;
// now an "Excel charts" section after the sheets gives each chart's type, title, series, their cells and cached values,
// as Word and PowerPoint charts already were. Every file here is generated (pandoc, SheetJS, make_file's chart writer).
// The review of #1316 cases (crafted parts that made the reads slow) are at the end.
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as XLSX from 'xlsx'
import { OfficeCache, TEXT_CACHE_VERSION } from '../../server/src/files/search'
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

// ---------------- review of #1316: crafted parts stay linear and never lose the sheets ----------------

const REL = (id: string, type: string, t: string) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${t}"/>`
const TINY_CHART = '<c:chartSpace><c:chart><c:plotArea><c:barChart><c:ser><c:val><c:numRef><c:f>S!A1</c:f></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>'
/** A small real workbook whose one sheet is named `n` times in workbook.xml, with a large relationship part and drawing
 * (the review's PoC: each <sheet> tag read them again, 2,000 tags passed the worker's 60 s and lost the sheet text). */
function repeatedSheets(n: number): Uint8Array {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['k', 'v'], ['MARKER-CELL', 1]]), 'S')
  return withParts(new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer), {
    'xl/workbook.xml': (old) => old.replace('</sheets>', '<sheet name="S" sheetId="1" r:id="rId1"/>'.repeat(n) + '</sheets>'),
    'xl/worksheets/_rels/sheet1.xml.rels': `<Relationships>${REL('d1', 'drawing', '../drawings/drawing1.xml')}${'<Relationship Id="q" Type="t" Target="u"/>'.repeat(20_000)}</Relationships>`,
    'xl/drawings/drawing1.xml': `<xdr:wsDr><c:chart r:id="c1"/>${'r:id="z" '.repeat(100_000)}</xdr:wsDr>`,
    'xl/drawings/_rels/drawing1.xml.rels': `<Relationships>${REL('c1', 'chart', '../charts/chart1.xml')}</Relationships>`,
    'xl/charts/chart1.xml': TINY_CHART,
  })
}

const N_MARKS = 20_000
describe('review of #1316: crafted charts and tracked changes', () => {
  test('2,000 <sheet> tags naming one sheet: its parts are read once, the chart once, quickly', () => {
    const bytes = repeatedSheets(2000)
    const t0 = performance.now()
    const text = xlsxChartsText(bytes)
    expect(performance.now() - t0).toBeLessThan(5000)
    expect(text.match(/- Chart/g)?.length).toBe(1)
  })

  test('through the office worker the sheet text is kept', async () => {
    const t0 = performance.now()
    const text = await extractText('a.xlsx', repeatedSheets(2000), tools)
    expect(text).toContain('MARKER-CELL')
    expect(text).toContain('=== Excel charts')
    // SheetJS read the sheet and its relationships again for each name; the streaming reader gives it under each name
    expect(text.match(/# sheet: S /g)?.length).toBe(2001)
    expect(performance.now() - t0).toBeLessThan(30_000)
  }, 120_000)

  test('the charts give way to the sheets at the worker\'s end, and stop at their own time', async () => {
    const was = process.env.OFFICE_DEADLINE_MS
    try {
      process.env.OFFICE_DEADLINE_MS = String(Date.now() + 1000)
      const text = await workbookText('xlsx', charted())
      expect(text).toContain('# sheet: 매출')
      expect(text).toContain('=== The charts of this workbook were not read (no time was left after the sheets) ===')
    } finally { if (was === undefined) delete process.env.OFFICE_DEADLINE_MS; else process.env.OFFICE_DEADLINE_MS = was }
    expect(() => xlsxChartsText(charted(), { timeMs: -1 })).toThrow(/took longer than/)
  })

  test('a stored chart part whose declared size is not its stored size is not read (as checkZip)', () => {
    const bytes = withParts(charted(), {}) // written stored, not deflated
    const name = new TextEncoder().encode('xl/charts/chart1.xml')
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let patched = false
    for (let i = 0; i + 46 < bytes.length; i++) {
      if (v.getUint32(i, true) !== 0x02014b50 || v.getUint16(i + 28, true) !== name.length) continue
      if (!name.every((b, j) => bytes[i + 46 + j] === b)) continue
      expect(v.getUint16(i + 10, true)).toBe(0)
      v.setUint32(i + 24, v.getUint32(i + 20, true) + 4096, true)
      patched = true
    }
    expect(patched).toBe(true)
    const text = xlsxChartsText(bytes)
    expect(text).toContain('- A chart on sheet "매출" was not read (a chart part is damaged)')
    expect(text).toContain('- Chart "Cost split"')
  })

  test('a chart part under another name is read; a missing one gets its own line', () => {
    const renamed = withParts(charted(), {
      'xl/charts/sales-chart.xml': TINY_CHART.replace('<c:chart>', '<c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>Renamed</a:t></a:r></a:p></c:rich></c:tx></c:title>'),
      'xl/drawings/_rels/drawing1.xml.rels': (old) => old.replace(/Target="[^"]*chart1\.xml"/, 'Target="../charts/sales-chart.xml"'),
      'xl/drawings/_rels/drawing2.xml.rels': (old) => old.replace(/Target="[^"]*chart2\.xml"/, 'Target="../charts/gone.xml"'),
    })
    const text = xlsxChartsText(renamed)
    expect(text).toContain('- Chart "Renamed" (bar chart) on sheet "매출":')
    expect(text).toContain('- A chart on sheet "Costs" was not read (its part is missing from the file)')
  })

  test('a cell that reads like the chart label is quoted and keeps its sheet place', async () => {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['=== Excel charts (x) ==='], ['after']]), 'S')
    const text = await workbookText('xlsx', new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer))
    expect(text).toContain('\n === Excel charts (x) ===\n')
    const places: (string | undefined)[] = []
    walkLines(text, 'sheets', (l) => { if (l.text.trim() === 'after') places.push(l.loc && l.loc.kind === 'sheet' ? l.loc.range : undefined) })
    expect(places).toEqual(['A2:A2'])
  })

  test(`tracked changes: ${N_MARKS} unclosed <w:del> then as many empty paragraphs, and a long line with many empty marks`, () => {
    let t0 = performance.now()
    trackedChanges(`<w:document><w:body><w:p>${'<w:del>'.repeat(N_MARKS)}${'<w:p></w:p>'.repeat(N_MARKS)}</w:p></w:body></w:document>`)
    expect(performance.now() - t0).toBeLessThan(3000)
    t0 = performance.now()
    const out = trackedChanges(`<w:document><w:body><w:p><w:r><w:t>${'x'.repeat(1_000_000)}</w:t></w:r>${'<w:del></w:del>'.repeat(N_MARKS)}<w:ins><w:r><w:t>y</w:t></w:r></w:ins></w:p></w:body></w:document>`)
    expect(performance.now() - t0).toBeLessThan(3000)
    expect(out[0]!.text.endsWith('x[inserted: y]')).toBe(true)
  })
})

test('text cache format 8: .docx and .xlsx text of format 7 is made again; format 6 Word, OpenDocument and sheet text too; PDFs, decks and Hangul files stay current', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'textcache-8-'))
  fs.writeFileSync(path.join(dir, '.format-version'), '5\n')
  const cache = new OfficeCache(dir, { root: dir } as never, tools)
  const side = (rel: string, format: string) => {
    fs.writeFileSync(path.join(dir, rel + '.txt'), 'text')
    fs.writeFileSync(path.join(dir, rel + '.txt.source.json'), JSON.stringify({ source: 'x', text: 'y', format }))
  }
  for (const rel of ['a.pdf', 'b.pptx', 'c.hwp', 'd.DOCX', 'e.xlsx', 'f.png', 'i.odt', 'j.ods']) side(rel, '6')
  side('g.docx', TEXT_CACHE_VERSION)
  side('h.pdf', '5')
  // format 7 (a Word title, spreadsheet formulas): only its .docx and .xlsx text lacks tracked changes and charts
  for (const rel of ['k.docx', 'l.XLSX', 'm.pdf', 'n.pptx', 'o.odt', 'p.hwpx']) side(rel, '7')
  expect(TEXT_CACHE_VERSION).toBe('8')
  expect(['a.pdf', 'b.pptx', 'c.hwp', 'd.DOCX', 'e.xlsx', 'f.png', 'g.docx', 'h.pdf', 'i.odt', 'j.ods'].map((r) => cache.current(r))).toEqual([true, true, true, false, false, true, true, false, false, false])
  expect(['k.docx', 'l.XLSX', 'm.pdf', 'n.pptx', 'o.odt', 'p.hwpx'].map((r) => cache.current(r))).toEqual([false, false, true, true, true, true])
  fs.rmSync(dir, { recursive: true, force: true })
})
