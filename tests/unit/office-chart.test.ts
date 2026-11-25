// Charts in Word and PowerPoint files are native, editable charts by default (live QA 2026-11-25, dev
// 0.18.2-dev.20261125131845: "차트 하나 넣은 Word 보고서 만들어 줘" gave a .docx whose bar chart was word/media/image1.png and no
// word/charts, and the answer did not say so). Root cause: every way the AI was shown to put a chart in Word drew a
// picture (make_file's SVG -> PNG words; the docx skill writes no charts). Now: make_file's ```chart block writes a
// native chart with its data workbook (tools/office-chart.ts), the docx skill gets scripts/word_chart.py, the words say
// "native by default", and a saved file with pictures and no chart is told that a chart picture cannot be edited.
// Plan: docs/AGENTS/plan/20261125-1346-word-native-charts.md.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as XLSX from 'xlsx'
import { makeHandler } from '../../server/src/mcp/protocol'
import { readZip } from '../../server/src/files/zip-write'
import { which } from '../../server/src/config'
import { chartBlocks, chartWorkbook, docChartXml, parseChartBlock } from '../../server/src/tools/office-chart'
import { chartDataLine, chartDataReview, pictureChartLine } from '../../server/src/files/chart-data'
import { checkOfficeLinks } from '../../server/src/files/office-links-check'
import { CHART_BLOCK_HINT } from '../../server/src/tools/make-file'
import { DOC_CHART_RULE, makeFileRule } from '../../server/src/chat/prompt'
import { makeCApp, type CApp } from '../lib/c-app'

setDefaultTimeout(60_000)
const pandoc = which('pandoc')
const REPO = path.resolve(import.meta.dir, '../..')
const HELPER = path.join(REPO, 'resources/doc-skills/docx/scripts/word_chart.py')

const SALES = { type: 'column', title: '분기별 매출', categories: ['1분기', '2분기', '3분기'], series: [{ name: '2025', values: [120, 135, 150] }, { name: '2026', values: [130, null, 170] }] }
const block = (o: unknown) => '```chart\n' + JSON.stringify(o) + '\n```'

describe('a chart block (pure)', () => {
  test('reads type, title, categories and series', () => {
    const c = parseChartBlock(JSON.stringify(SALES), 'chart 1')
    expect(c).toEqual({ type: 'column', title: '분기별 매출', categories: ['1분기', '2분기', '3분기'], series: [{ name: '2025', values: [120, 135, 150] }, { name: '2026', values: [130, null, 170] }] })
    expect(parseChartBlock('{"categories":["a"],"series":[{"values":[1]}]}', 'c').type).toBe('column')
  })
  test('names what is wrong', () => {
    expect(() => parseChartBlock('{nope', 'chart 1')).toThrow(/one JSON object/)
    expect(() => parseChartBlock(JSON.stringify({ ...SALES, type: 'radar' }), 'chart 1')).toThrow(/type must be one of column, bar, line, pie/)
    expect(() => parseChartBlock(JSON.stringify({ ...SALES, colour: 'red' }), 'chart 1')).toThrow(/unknown field colour/)
    expect(() => parseChartBlock(JSON.stringify({ ...SALES, series: [{ name: 'x', values: [1, 2] }] }), 'chart 1')).toThrow(/one value per category \(3\), got 2/)
    expect(() => parseChartBlock(JSON.stringify({ ...SALES, series: [{ name: 'x', values: ['1', '2', '3'] }] }), 'chart 1')).toThrow(/plain numbers/)
    expect(() => parseChartBlock(JSON.stringify({ ...SALES, type: 'pie' }), 'chart 1')).toThrow(/pie chart takes one series/)
  })
  test('blocks in a pandoc tree become marker paragraphs, in document order; other code blocks stay', () => {
    const ast = { blocks: [
      { t: 'CodeBlock', c: [['', ['chart'], []], JSON.stringify(SALES)] },
      { t: 'BulletList', c: [[{ t: 'CodeBlock', c: [['', ['chart'], []], JSON.stringify({ ...SALES, type: 'line' })] }]] },
      { t: 'CodeBlock', c: [['', ['python'], []], 'print(1)'] },
    ] }
    const m = chartBlocks(ast)
    expect([...m.values()].map((c) => c.type)).toEqual(['column', 'line'])
    const [m1, m2] = [...m.keys()]
    expect(ast.blocks[0]).toEqual({ t: 'Para', c: [{ t: 'Str', c: m1 }] } as never)
    expect((ast.blocks[1]!.c as unknown[][])[0]![0]).toEqual({ t: 'Para', c: [{ t: 'Str', c: m2 }] })
    expect(ast.blocks[2]!.t).toBe('CodeBlock')
    expect(m1).toMatch(/^MYCELCHART[0-9a-f]{12}N1$/)
  })
  test('the chart part caches the values its own workbook holds, and names it through <c:externalData>', () => {
    const c = parseChartBlock(JSON.stringify(SALES), 'c')
    const xml = docChartXml(c)
    expect(xml).toContain('<c:externalData r:id="rId1"><c:autoUpdate val="0"/></c:externalData></c:chartSpace>')
    expect(xml).toContain("<c:f>'Sheet1'!$B$2:$B$4</c:f>")
    const wb = XLSX.read(chartWorkbook(c))
    const ws = wb.Sheets.Sheet1!
    const v = (a: string) => (ws[a] as XLSX.CellObject | undefined)?.v
    expect([v('B1'), v('C1'), v('A2'), v('B2'), v('C2'), v('C3'), v('C4')]).toEqual(['2025', '2026', '1분기', 120, 130, undefined, 170])
  })
})

let A: CApp
beforeAll(async () => { A = await makeCApp('office-chart') })
afterAll(async () => { await A.close() })
let rpcId = 0
async function call(name: string, args: unknown) {
  const h = makeHandler(A.ctx.files, A.ctx.db, A.toolCtx('alice', null))
  const r = (await h({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } })).result
  return { text: r.content[0].text as string, isError: !!r.isError }
}
const bytesOf = (rel: string) => new Uint8Array(fs.readFileSync(path.join(A.team, ...rel.split('/'))))
const names = (b: Uint8Array) => readZip(b).map((e) => e.name)

describe.skipIf(!pandoc)('make_file writes a ```chart block as a native chart', () => {
  test('Word: a native chart with its data sheet where the block was; Edit Data has the numbers; the exit check passes', async () => {
    const r = await call('make_file', { format: 'docx', output: 'users/alice/report.docx', content: `# 매출 보고서\n\n앞 문단.\n\n${block(SALES)}\n\n뒤 문단.\n` })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain('a native chart with its data sheet: right-click > Edit Data in Word opens the numbers')
    const b = bytesOf('users/alice/report.docx')
    expect(names(b)).toEqual(expect.arrayContaining(['word/charts/chart1.xml', 'word/charts/_rels/chart1.xml.rels', 'word/embeddings/Microsoft_Excel_Worksheet1.xlsx']))
    expect(names(b).some((n) => n.startsWith('word/media/'))).toBe(false)
    const doc = new TextDecoder().decode(readZip(b).find((e) => e.name === 'word/document.xml')!.data)
    expect(doc).not.toContain('MYCELCHART')
    expect(doc.indexOf('앞 문단')).toBeLessThan(doc.indexOf('<c:chart '))
    expect(doc.indexOf('<c:chart ')).toBeLessThan(doc.indexOf('뒤 문단'))
    const review = chartDataReview(b)
    expect(review.charts).toEqual([{ where: 'chart 1', title: '분기별 매출', state: 'ok' }])
    expect(chartDataLine(review)).toContain('its chart is a native chart with its data sheet')
    expect(checkOfficeLinks('docx', b)).toBe(b)
  })
  test('PowerPoint: the chart takes the slide\'s content area; the deck reads back', async () => {
    const r = await call('make_file', { format: 'pptx', output: 'users/alice/deck.pptx', content: `# 분기 실적\n\n## 매출\n\n${block(SALES)}\n\n## 다음 단계\n\n- 확대\n`, expected_slides: 3 })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain('Edit Data in PowerPoint, Keynote or Google Slides opens the numbers')
    const b = bytesOf('users/alice/deck.pptx')
    expect(names(b)).toEqual(expect.arrayContaining(['ppt/charts/chart1.xml', 'ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx']))
    const slide = new TextDecoder().decode(readZip(b).find((e) => e.name === 'ppt/slides/slide2.xml')!.data)
    expect(slide).toContain('<p:graphicFrame>')
    expect(slide).toMatch(/<a:off x="\d+" y="\d+"\/><a:ext cx="[1-9]\d+" cy="[1-9]\d+"\/>/)
    expect(slide).not.toContain('MYCELCHART')
    expect(chartDataReview(b).charts).toEqual([{ where: 'slide 2', title: '분기별 매출', state: 'ok' }])
    expect(checkOfficeLinks('pptx', b)).toBe(b)
  })
  test('PowerPoint: a chart block with other text on its slide is refused with the way to fix it', async () => {
    const r = await call('make_file', { format: 'pptx', output: 'users/alice/deck2.pptx', content: `## 매출\n\n설명 문장.\n\n${block(SALES)}\n` })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('a chart block goes on a slide of its own')
    expect(fs.existsSync(path.join(A.team, 'users/alice/deck2.pptx'))).toBe(false)
  })
  test('PDF: refused, with the picture way', async () => {
    const r = await call('make_file', { format: 'pdf', output: 'users/alice/r.pdf', content: `# R\n\n${block(SALES)}\n` })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('a PDF cannot hold one')
  })
  test('a wrong block saves nothing and says what is wrong', async () => {
    const r = await call('make_file', { format: 'docx', output: 'users/alice/bad.docx', content: block({ ...SALES, series: [{ name: 'x', values: [1] }] }) })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('chart 1: series 1 needs one value per category (3), got 1')
    expect(fs.existsSync(path.join(A.team, 'users/alice/bad.docx'))).toBe(false)
  })
})

/** python3 with python-docx and python-pptx (a run has both: scripts/system/packages.json) */
const py = (() => {
  const bin = Bun.which('python3')
  if (!bin) return null
  return Bun.spawnSync([bin, '-c', 'import docx, pptx']).exitCode === 0 ? bin : null
})()

describe.skipIf(!py)('the docx skill\'s word_chart.py (a run builds Word files with docx-js, which writes no charts)', () => {
  test('puts native charts at placeholder paragraphs; the read-back says Edit Data works and the exit check passes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'word-chart-'))
    try {
      const make = `from docx import Document\nd = Document()\nd.add_heading('Report', 1)\nd.add_paragraph('Before.')\nd.add_paragraph('[[chart:sales]]')\nd.add_paragraph('[[chart:share]]')\nd.add_paragraph('After.')\nd.save('in.docx')\n`
      expect(Bun.spawnSync([py!, '-c', make], { cwd: dir }).exitCode).toBe(0)
      fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify([
        { placeholder: '[[chart:sales]]', ...SALES },
        { placeholder: '[[chart:share]]', type: 'pie', title: 'Share', categories: ['A', 'B'], series: [{ name: 'share', values: [60, 40] }], data_labels: true },
      ]))
      const r = Bun.spawnSync([py!, HELPER, 'in.docx', 'out.docx', 'c.json'], { cwd: dir })
      expect(r.exitCode, r.stderr.toString()).toBe(0)
      expect(r.stdout.toString()).toContain('2 native charts with their data sheet')
      const b = new Uint8Array(fs.readFileSync(path.join(dir, 'out.docx')))
      const review = chartDataReview(b)
      expect(review.charts.map((c) => [c.title, c.state])).toEqual([['분기별 매출', 'ok'], ['Share', 'ok']])
      expect(checkOfficeLinks('docx', b)).toBe(b)
      const doc = new TextDecoder().decode(readZip(b).find((e) => e.name === 'word/document.xml')!.data)
      expect(doc).not.toContain('[[chart:')
      // a placeholder that is not there: a plain error, nothing written
      fs.writeFileSync(path.join(dir, 'd.json'), JSON.stringify([{ placeholder: '[[chart:none]]', ...SALES }]))
      const bad = Bun.spawnSync([py!, HELPER, 'in.docx', 'out2.docx', 'd.json'], { cwd: dir })
      expect(bad.exitCode).toBe(1)
      expect(bad.stderr.toString()).toContain("no paragraph whose whole text is '[[chart:none]]'")
      expect(fs.existsSync(path.join(dir, 'out2.docx'))).toBe(false)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('a saved Word file or deck with pictures and no chart', () => {
  test('is told that a chart picture cannot be edited, with the way to fix it', () => {
    const w = pictureChartLine('docx', ['word/document.xml', 'word/media/image1.png'])
    expect(w).toContain('it has 1 picture and no native chart')
    expect(w).toContain('scripts/word_chart.py')
    expect(w).toContain('say plainly in your answer that the chart is a picture')
    expect(pictureChartLine('pptx', ['ppt/media/image1.jpeg', 'ppt/media/image2.png'])).toContain('2 pictures and no native chart')
    expect(pictureChartLine('pptx', ['ppt/media/image1.jpeg'])).toContain('addChart')
    expect(pictureChartLine('docx', ['word/document.xml'])).toBe('')
  })
})

describe('the words', () => {
  test('say native by default, in any language, for both routes', () => {
    for (const s of [CHART_BLOCK_HINT, DOC_CHART_RULE]) {
      expect(s).toContain('even when')
      expect(s).toContain('Edit Data')
    }
    expect(DOC_CHART_RULE).toContain('docx/scripts/word_chart.py')
    expect(makeFileRule(false, false, true)).toContain(DOC_CHART_RULE)
    expect(makeFileRule(false, false, false)).toContain('```chart block')
    expect(makeFileRule(false, false, false)).not.toContain('word_chart.py')
  })
})
