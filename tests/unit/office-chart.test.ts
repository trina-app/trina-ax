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
import { chartDataLine, chartDataReview, newPictures, pictureChartLine } from '../../server/src/files/chart-data'
import { checkOfficeLinks } from '../../server/src/files/office-links-check'
import { CHART_BLOCK_HINT } from '../../server/src/tools/make-file'
import { DOC_CHART_RULE, makeFileRule } from '../../server/src/chat/prompt'
import { makeCApp, type CApp } from '../lib/c-app'

setDefaultTimeout(60_000)
const pandoc = which('pandoc')
const REPO = path.resolve(import.meta.dir, '../..')
const HELPER = path.join(REPO, 'resources/doc-skills/docx/scripts/word_chart.py')

const SALES = { type: 'column', title: '분기별 매출', categories: ['1분기', '2분기', '3분기'], series: [{ name: '2025', values: [120, 135, 150] }, { name: '2026', values: [130, null, 170] }] }
/** a minimal Word file whose body is one paragraph */
const docxOf = (text: string) => { const { docx } = require('../lib/office-fixture') as typeof import('../lib/office-fixture'); return docx({ body: text }) }
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
    const w = pictureChartLine('docx', ['word/media/image1.png'])
    expect(w).toContain('it has 1 new picture and no native chart')
    expect(w).toContain('scripts/word_chart.py')
    expect(w).toContain('say plainly in your answer that the chart is a picture')
    expect(pictureChartLine('pptx', ['ppt/media/image1.jpeg', 'ppt/media/image2.png'])).toContain('2 new pictures and no native chart')
    expect(pictureChartLine('pptx', ['ppt/media/image1.jpeg'])).toContain('addChart')
    expect(pictureChartLine('docx', [])).toBe('')
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

describe('review fixes (#598)', () => {
  test('a chart block in a footnote, speaker notes or a slide\'s table is refused as the AI\'s to fix; a marker that went missing is a ToolError', async () => {
    const { ToolError } = await import('../../server/src/policy/errors')
    const { insertDocxCharts } = await import('../../server/src/tools/office-chart')
    const note = { blocks: [{ t: 'Para', c: [{ t: 'Note', c: [{ t: 'CodeBlock', c: [['', ['chart'], []], JSON.stringify(SALES)] }] }] }] }
    expect(() => chartBlocks(note)).toThrow(/cannot stand in a footnote/)
    const notes = { blocks: [{ t: 'Div', c: [['', ['notes'], []], [{ t: 'CodeBlock', c: [['', ['chart'], []], JSON.stringify(SALES)] }]] }] }
    expect(() => chartBlocks(notes, 'pptx')).toThrow(/cannot stand in speaker notes/)
    const table = { blocks: [{ t: 'Table', c: [[{ t: 'CodeBlock', c: [['', ['chart'], []], JSON.stringify(SALES)] }]] }] }
    expect(() => chartBlocks(table, 'pptx')).toThrow(/cannot stand in a table/)
    expect(chartBlocks(structuredClone(table), 'docx').size).toBe(1)
    let err: unknown
    try { insertDocxCharts(docxOf('no marker here'), new Map([['MYCELCHARTx', parseChartBlock(JSON.stringify(SALES), 'c')]])) } catch (e) { err = e }
    expect(err).toBeInstanceOf(ToolError)
    expect(String((err as Error).message)).toContain('must stand in the document body')
  })
  test.skipIf(!pandoc)('make_file: a footnote chart and speaker-notes chart are refused with a plain reason', async () => {
    const r = await call('make_file', { format: 'docx', output: 'users/alice/fn.docx', content: `Text.[^1]\n\n[^1]: Note.\n\n    ${block(SALES).split('\n').join('\n    ')}\n` })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('cannot stand in a footnote')
    const n = await call('make_file', { format: 'pptx', output: 'users/alice/notes.pptx', content: `## Sales\n\n- one\n\n::: notes\n${block(SALES)}\n:::\n` })
    expect(n.isError).toBe(true)
    expect(n.text).toContain('cannot stand in speaker notes')
  })
  test.skipIf(!pandoc)('a title with control characters makes valid XML (no misleading exit-check refusal)', async () => {
    const r = await call('make_file', { format: 'docx', output: 'users/alice/ctl.docx', content: block({ ...SALES, title: 'Sales\u0001\u001f by quarter' }) })
    expect(r.isError, r.text).toBe(false)
    const b = bytesOf('users/alice/ctl.docx')
    const doc = new TextDecoder().decode(readZip(b).find((e) => e.name === 'word/document.xml')!.data)
    expect(doc).toContain('descr="Sales by quarter"')
    expect(chartDataReview(b).charts[0]!.state).toBe('ok')
  })
  test.skipIf(!py)('word_chart.py: control characters are dropped; a bad spec is a plain error, not a traceback', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'word-chart-'))
    try {
      expect(Bun.spawnSync([py!, '-c', "from docx import Document\nd = Document()\nd.add_paragraph('[[c]]')\nd.save('in.docx')\n"], { cwd: dir }).exitCode).toBe(0)
      fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify([{ placeholder: '[[c]]', ...SALES, title: 'T\u0001itle', series: [{ name: 'a\u0002', values: [1, 2, 3] }] }]))
      const r = Bun.spawnSync([py!, HELPER, 'in.docx', 'out.docx', 'c.json'], { cwd: dir })
      expect(r.exitCode, r.stderr.toString()).toBe(0)
      const b = new Uint8Array(fs.readFileSync(path.join(dir, 'out.docx')))
      expect(chartDataReview(b).charts.map((c) => [c.title, c.state])).toEqual([['Title', 'ok']])
      fs.writeFileSync(path.join(dir, 'd.json'), JSON.stringify(['not a chart']))
      const bad = Bun.spawnSync([py!, HELPER, 'in.docx', 'out2.docx', 'd.json'], { cwd: dir })
      expect(bad.exitCode).toBe(1)
      expect(bad.stderr.toString()).toContain('word_chart.py: chart 1: each chart is an object')
      expect(bad.stderr.toString()).not.toContain('Traceback')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
  test('a template deck\'s logo (on its layout) is never taken for a chart; a slide picture is, unless a file read holds it', () => {
    const { writeZip } = require('../../server/src/files/zip-write') as typeof import('../../server/src/files/zip-write')
    const deck = new Uint8Array(fs.readFileSync(path.join(REPO, 'tests/fixtures/charts/python-pptx-chart.pptx')))
    const IMG = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image'
    const logo = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]), shot = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5, 5])
    const relsAdd = (x: string, id: string, target: string) => x.replace('</Relationships>', `<Relationship Id="${id}" Type="${IMG}" Target="${target}"/></Relationships>`)
    const build = (onSlide: Uint8Array | null) => {
      const es = readZip(deck).map((e) => ({ name: e.name, data: e.data }))
        // no chart: only pictures
        .filter((e) => !/^ppt\/(charts|embeddings)\//.test(e.name))
        .map((e) => {
          const t = new TextDecoder().decode(e.data)
          if (e.name === 'ppt/slideLayouts/_rels/slideLayout7.xml.rels') return { name: e.name, data: new TextEncoder().encode(relsAdd(t, 'rIdLogo', '../media/logo.png')) }
          if (e.name === 'ppt/slides/_rels/slide1.xml.rels') return { name: e.name, data: new TextEncoder().encode(relsAdd(t.replace(/<Relationship [^>]*chart[^>]*\/>/, ''), 'rIdShot', '../media/shot.png')) }
          return e
        })
      es.push({ name: 'ppt/media/logo.png', data: logo })
      if (onSlide) es.push({ name: 'ppt/media/shot.png', data: onSlide })
      return writeZip(es)
    }
    const layoutOnly = chartDataReview(build(null))
    expect(layoutOnly.pictures).toEqual([])
    expect(pictureChartLine('pptx', newPictures(layoutOnly, []))).toBe('')
    const withShot = build(shot)
    const r = chartDataReview(withShot)
    expect(r.pictures!.map((x) => x.name)).toEqual(['ppt/media/shot.png'])
    expect(pictureChartLine('pptx', newPictures(r, []))).toContain('1 new picture and no native chart')
    // the same picture in a file this answer read (the template, the file being replaced): not new
    expect(newPictures(r, [withShot])).toEqual([])
  })
})
