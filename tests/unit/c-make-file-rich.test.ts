// make_file: formatting in Word and Excel files and chart pictures (second limits audit N3/N4, QA TC-4915/TC-4916;
// docs/decisions/20261118-rich-office-output.md). Before: no text colour or highlight, no header, footer or page
// numbers in a .docx, no conditional formatting, number formats or column widths in an .xlsx, and no PNG output, so a
// Word report could not hold a chart picture.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeHandler } from '../../server/src/mcp/protocol'
import { readZip } from '../../server/src/files/zip-write'
import { which } from '../../server/src/config'
import { colorHex, colorStyles, finishDocx, footerWithPageNumber, headerFooterParagraph, markTextColors, pageGeometry } from '../../server/src/tools/docx-format'
import { parseArea } from '../../server/src/tools/xlsx-format'
import { drawSize, svgSize } from '../../server/src/tools/svg-png'
import { makeCApp, type CApp } from '../lib/c-app'

setDefaultTimeout(60_000)
const pandoc = which('pandoc')
const typst = process.env.MYCEL_TYPST_BIN ?? which('typst')
const xmllint = which('xmllint')

let A: CApp
beforeAll(async () => { A = await makeCApp('c-make-file-rich') })
afterAll(async () => { await A.close() })

let rpcId = 0
async function call(name: string, args: unknown) {
  const h = makeHandler(A.ctx.files, A.ctx.db, A.toolCtx('alice', null))
  const r = (await h({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } })).result
  return { text: r.content[0].text as string, isError: !!r.isError }
}
const file = (rel: string) => path.join(A.team, ...rel.split('/'))
const parts = (rel: string) => new Map(readZip(new Uint8Array(fs.readFileSync(file(rel)))).map((e) => [e.name, e.data]))
const partText = (rel: string) => new Map([...parts(rel)].map(([k, v]) => [k, new TextDecoder().decode(v)]))
function wellFormed(xml: string) {
  if (!xmllint) return
  const r = Bun.spawnSync([xmllint, '--noout', '-'], { stdin: new TextEncoder().encode(xml) })
  expect(r.exitCode, r.stderr.toString()).toBe(0)
}
const pngSize = (b: Uint8Array) => ({ w: new DataView(b.buffer, b.byteOffset).getUint32(16), h: new DataView(b.buffer, b.byteOffset).getUint32(20) })
const isPng = (b: Uint8Array) => Buffer.from(b.subarray(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))

const BAR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="240" viewBox="0 0 400 240"><rect width="400" height="240" fill="white"/>' +
  '<text x="200" y="24" font-size="16" text-anchor="middle">분기 매출 Revenue</text><rect x="40" y="60" width="60" height="150" fill="#4472C4"/>' +
  '<rect x="140" y="100" width="60" height="110" fill="#ED7D31"/></svg>'

describe('the description', () => {
  test('says how to colour text, set a header, footer and page numbers, format sheets and make a PNG', async () => {
    const h = makeHandler(A.ctx.files, A.ctx.db, A.toolCtx('alice', null))
    const tools = (await h({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/list', params: {} })).result.tools as { name: string; description: string }[]
    const d = tools.find((t) => t.name === 'make_file')!.description
    expect(d).toContain('[overdue]{color=red}')
    expect(d).toContain('page_numbers: true')
    expect(d).toContain('{page} and {pages}')
    expect(d).toContain('conditional `when`')
    expect(d).toContain('format "png" saves an SVG')
    expect(d).toContain('Never say text colours, headers, footers, page numbers, conditional formatting or chart pictures cannot be made')
  })
})

describe('docx text colours (pure)', () => {
  test('colour names and hex', () => {
    expect(colorHex('red')).toBe('FF0000')
    expect(colorHex('Dark Red')).toBe('C00000')
    expect(colorHex('#f00')).toBe('FF0000')
    expect(colorHex('c00000')).toBe('C00000')
    expect(colorHex('reddish')).toBeNull()
  })
  test('a span with color/highlight gets a custom style; .mark is a yellow highlight', () => {
    const ast = { blocks: [{ t: 'Para', c: [
      { t: 'Span', c: [['', [], [['color', 'red'], ['highlight', 'yellow']]], [{ t: 'Str', c: 'a' }]] },
      { t: 'Span', c: [['', ['mark'], []], [{ t: 'Str', c: 'b' }]] },
      { t: 'Span', c: [['', [], [['highlight', '#FFEB9C']]], [{ t: 'Str', c: 'c' }]] },
    ] }] }
    const used = markTextColors(ast)
    expect([...used.keys()].sort()).toEqual(['Color FF0000 Highlight FFFF00', 'Highlight FFEB9C', 'Highlight FFFF00'])
    const span = (ast.blocks[0]!.c[0] as unknown as { c: [unknown[]] }).c[0]
    expect(span).toEqual(['', [], [['custom-style', 'Color FF0000 Highlight FFFF00']]])
    const styles = colorStyles('<w:styles><w:style w:type="character" w:customStyle="1" w:styleId="HighlightFFEB9C"><w:name w:val="Highlight FFEB9C" /><w:basedOn w:val="BodyTextChar" /></w:style></w:styles>', used)
    expect(styles).toContain('<w:basedOn w:val="BodyTextChar" /><w:rPr><w:shd w:val="clear" w:color="auto" w:fill="FFEB9C"/></w:rPr></w:style>')
  })
  test('a colour that is not one is refused', () => {
    expect(() => markTextColors({ t: 'Span', c: [['', [], [['color', 'bloodish']]], []] })).toThrow(/is not a colour/)
  })
})

describe('docx page (pure)', () => {
  test('geometry: A4 landscape, margins in cm; too wide margins refused', () => {
    const g = pageGeometry({ orientation: 'landscape', margins_cm: 2 })
    expect([g.w, g.h, g.landscape, g.left]).toEqual([16838, 11906, true, 1134])
    expect(g.text).toBe(16838 - 2 * 1134)
    expect(() => pageGeometry({ margins_cm: 10 })).toThrow(/margins/)
  })
  test('page numbers join the footer unless it has {page}', () => {
    expect(footerWithPageNumber(undefined)).toBe('{page}')
    expect(footerWithPageNumber('Page {page} of {pages}')).toBe('Page {page} of {pages}')
    expect(footerWithPageNumber('Confidential')).toEqual({ left: 'Confidential', right: '{page}' })
    expect(footerWithPageNumber({ left: 'Acme' })).toEqual({ left: 'Acme', center: '{page}' })
  })
  test('header parts: fields, escaping, tab stops', () => {
    const p = headerFooterParagraph({ left: 'A & B <Ltd>', right: '{page} / {pages}' }, 9000)
    expect(p).toContain('A &amp; B &lt;Ltd&gt;')
    expect(p).toContain('<w:tab w:val="right" w:pos="9000"/>')
    expect(p).toContain('<w:fldSimple w:instr=" PAGE ">')
    expect(p).toContain('<w:fldSimple w:instr=" NUMPAGES ">')
  })
  test('nothing to do: the same bytes', () => {
    const b = new Uint8Array([1, 2, 3])
    expect(finishDocx(b, new Map(), undefined)).toBe(b)
  })
})

describe.skipIf(!pandoc)('docx through make_file', () => {
  test('a red, highlighted risk line, a company header, page numbers, landscape', async () => {
    const out = 'users/alice/report.docx'
    const r = await call('make_file', {
      format: 'docx', output: out,
      content: '# Q3 report\n\nAll good.\n\n[**Risk:** the supplier contract ends in October]{color=red highlight=yellow}\n\n::: {color=blue}\nA blue paragraph.\n:::\n\nAnd [blue words]{color=blue}.\n',
      page: { header: { left: 'Acme Ltd.', right: 'Confidential' }, page_numbers: true, orientation: 'landscape', margins_cm: 2 },
    })
    expect(r.isError, r.text).toBe(false)
    const p = partText(out)
    const doc = p.get('word/document.xml')!
    const styles = p.get('word/styles.xml')!
    // the colours: on the style pandoc made, which the runs use; bold inside the span stays bold
    expect(styles).toMatch(/<w:name w:val="Color FF0000 Highlight FFFF00" \/>[\s\S]*?<w:rPr><w:color w:val="FF0000"\/><w:shd w:val="clear" w:color="auto" w:fill="FFFF00"\/><\/w:rPr><\/w:style>/)
    expect(styles).toMatch(/<w:name w:val="Paragraph Color 0070C0" \/>[\s\S]*?<w:rPr><w:color w:val="0070C0"\/><\/w:rPr><\/w:style>/)
    expect(doc).toMatch(/<w:rStyle w:val="ColorFF0000HighlightFFFF00" \/><w:b \/>[\s\S]*?Risk:/)
    expect(doc).toContain('<w:pStyle w:val="ParagraphColor0070C0" />')
    // the same colour on a span and a block: two styles, two ids
    expect(doc).toContain('<w:rStyle w:val="Color0070C0" />')
    const ids = [...styles.matchAll(/w:styleId="([^"]+)"/g)].map((m) => m[1])
    expect(new Set(ids).size).toBe(ids.length)
    // the section: header and footer references first, then the size and margins
    const sect = doc.slice(doc.lastIndexOf('<w:sectPr'))
    expect(sect).toMatch(/^<w:sectPr><w:headerReference w:type="default" r:id="rIdMkH1"\/><w:footerReference w:type="default" r:id="rIdMkF1"\/><w:footnotePr>[\s\S]*<\/w:footnotePr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"\/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/)
    expect(p.get('word/header-mk1.xml')).toContain('Acme Ltd.')
    expect(p.get('word/footer-mk1.xml')).toContain('<w:fldSimple w:instr=" PAGE ">')
    expect(p.get('word/_rels/document.xml.rels')).toContain('Id="rIdMkH1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header-mk1.xml"')
    expect(p.get('[Content_Types].xml')).toContain('<Override PartName="/word/footer-mk1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>')
    for (const name of ['word/document.xml', 'word/styles.xml', 'word/header-mk1.xml', 'word/footer-mk1.xml', 'word/_rels/document.xml.rels', '[Content_Types].xml']) wellFormed(p.get(name)!)
  })

  test('a colour that is not one: nothing saved', async () => {
    const r = await call('make_file', { format: 'docx', output: 'users/alice/bad-colour.docx', content: '[x]{color=reddish}\n' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('is not a colour')
    expect(fs.existsSync(file('users/alice/bad-colour.docx'))).toBe(false)
  })

  test('page is for docx only', async () => {
    const r = await call('make_file', { format: 'pptx', output: 'users/alice/x.pptx', content: '# a\n', page: { page_numbers: true } })
    expect(r.isError).toBe(true)
  })
})

describe('xlsx sheets', () => {
  test('ranges', () => {
    expect(parseArea('B2:D50', 10)).toEqual({ c1: 2, r1: 2, c2: 4, r2: 50 })
    expect(parseArea('$C$3', 10)).toEqual({ c1: 3, r1: 3, c2: 3, r2: 3 })
    expect(parseArea('C:D', 10)).toEqual({ c1: 3, r1: 2, c2: 4, r2: 10 })
    expect(parseArea('nope', 10)).toBeNull()
  })

  test('conditional formatting, number formats, widths, frozen panes, no filter', async () => {
    const out = 'users/alice/budget.xlsx'
    const r = await call('make_file', {
      format: 'xlsx', output: out,
      content: '## Budget\n\n| Item | Plan | Actual | Diff | Note |\n|---|---|---|---|---|\n| Rent | 1000 | 1000 | =C2-B2 | ok |\n| Ads | 500 | 800 | =C3-B3 | over "budget" |\n| Travel | 300 | 100 | =C4-B4 | ok |\n',
      sheets: [{
        sheet: 'Budget',
        number_formats: [{ range: 'B:D', format: '#,##0' }],
        column_widths: { A: 30, E: 18 },
        freeze: { rows: 1, columns: 1 },
        filter: false,
        conditional: [
          { range: 'D2:D4', when: 'greater_than', value: 0, fill: 'red', font_color: 'white', bold: true },
          { range: 'E2:E4', when: 'contains', value: 'over "budget"' },
          { range: 'C2:C4', when: 'data_bar' },
          { range: 'B2:B4', when: 'color_scale', fill: 'green' },
          { range: 'A2:A4', when: 'formula', formula: '=$D2<0' },
          { range: 'A2:A4', when: 'duplicates' },
          { range: 'C2:C4', when: 'top', value: 1 },
        ],
      }],
    })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain('7 conditional formatting rules')
    const p = partText(out)
    const s = p.get('xl/worksheets/sheet1.xml')!
    wellFormed(s)
    expect(s).toContain('<conditionalFormatting sqref="D2:D4">')
    expect(s).toMatch(/<cfRule type="cellIs" dxfId="\d+" priority="\d+" operator="greaterThan"><formula>0<\/formula>/)
    expect(s).toContain('<formula>NOT(ISERROR(SEARCH(&quot;over &quot;&quot;budget&quot;&quot;&quot;,E2)))</formula>')
    expect(s).toContain('<formula>COUNTIF($A$2:$A$4,A2)&gt;1</formula>')
    expect(s).toContain('<formula>$D2&lt;0</formula>')
    expect(s).toContain('type="dataBar"')
    expect(s).toContain('type="colorScale"')
    expect(s).toMatch(/type="top10"[^>]*rank="1"/)
    expect(s).toContain('<pane xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"/>')
    expect(s).not.toContain('<autoFilter')
    expect(s).toMatch(/<col min="1" max="1" width="30"/)
    const st = p.get('xl/styles.xml')!
    // "#,##0" is Excel's built-in format 3 (no formatCode of its own); the numbers use it
    expect(st).toMatch(/<cellXfs count="\d+">[\s\S]*<xf numFmtId="3"/)
    // the fill and the font of the first rule: a differential format
    expect(st).toMatch(/<dxf><font><b\/><color rgb="FFFFFFFF"\/><\/font><fill><patternFill patternType="solid"><bgColor rgb="FFFF0000"\/>/)
  })

  test('a rule formula that reaches outside the workbook, an unknown sheet, a bad range: nothing saved', async () => {
    const content = '| A | B |\n|---|---|\n| 1 | 2 |\n'
    for (const [sheets, why] of [
      [[{ conditional: [{ range: 'A2:A2', when: 'formula', formula: '=INDIRECT("A1")>0' }] }], 'INDIRECT is not allowed'],
      [[{ sheet: 'Nope', filter: false }], 'there is no sheet "Nope"'],
      [[{ number_formats: [{ range: 'A1-B2', format: '0' }] }], 'is not a range'],
      [[{ conditional: [{ range: 'A2:A2', when: 'between', value: 1 }] }], 'value2'],
    ] as const) {
      const out = `users/alice/refused-${why.length}.xlsx`
      const r = await call('make_file', { format: 'xlsx', output: out, content, sheets })
      expect(r.isError, r.text).toBe(true)
      expect(r.text).toContain(why)
      expect(fs.existsSync(file(out))).toBe(false)
    }
  })
})

describe('svg to png (pure)', () => {
  test('size from width/height, the viewBox, units; drawn twice as large, at most 4000 px', () => {
    expect(svgSize('<svg width="400" height="240">')).toEqual({ w: 400, h: 240 })
    expect(svgSize('<svg viewBox="0 0 800 400">')).toEqual({ w: 800, h: 400 })
    expect(svgSize('<svg width="100%" viewBox="0 0 800 400">')).toEqual({ w: 800, h: 400 })
    expect(svgSize('<svg width="600" viewBox="0 0 300 100">')).toEqual({ w: 600, h: 200 })
    expect(drawSize({ w: 400, h: 240 })).toEqual({ wPt: 300, hPt: 180 })
    expect(drawSize({ w: 10000, h: 5000 }).wPt).toBe(1500)
    expect(() => svgSize('<html>')).toThrow(/not an SVG/)
  })
})

describe.skipIf(!typst)('png through make_file', () => {
  test('an SVG chart as content becomes a PNG at twice its size', async () => {
    const r = await call('make_file', { format: 'png', output: 'users/alice/charts/sales', content: BAR_SVG })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain('![](users/alice/charts/sales.png){width=15cm}')
    const b = new Uint8Array(fs.readFileSync(file('users/alice/charts/sales.png')))
    expect(isPng(b)).toBe(true)
    expect(pngSize(b)).toEqual({ w: 800, h: 480 })
  })

  test('an .svg source; something that is not SVG is refused', async () => {
    fs.mkdirSync(file('users/alice/charts'), { recursive: true })
    fs.writeFileSync(file('users/alice/charts/gantt.svg'), BAR_SVG)
    const ok = await call('make_file', { format: 'png', output: 'users/alice/charts/gantt.png', source: 'users/alice/charts/gantt.svg' })
    expect(ok.isError, ok.text).toBe(false)
    expect(isPng(new Uint8Array(fs.readFileSync(file('users/alice/charts/gantt.png'))))).toBe(true)
    const bad = await call('make_file', { format: 'png', output: 'users/alice/charts/not.png', content: '# a heading' })
    expect(bad.isError).toBe(true)
    expect(bad.text).toContain('give an SVG picture')
    expect(fs.existsSync(file('users/alice/charts/not.png'))).toBe(false)
  })

  test.skipIf(!pandoc)('an .svg picture in a Word file goes in as a PNG', async () => {
    fs.mkdirSync(file('users/alice/charts'), { recursive: true })
    fs.writeFileSync(file('users/alice/charts/bar.svg'), BAR_SVG)
    const out = 'users/alice/chart-report.docx'
    const r = await call('make_file', { format: 'docx', output: out, content: '# Sales\n\n![](users/alice/charts/bar.svg){width=15cm}\n' })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain('1 SVG picture was put in as PNG')
    const media = [...parts(out)].filter(([n]) => n.startsWith('word/media/'))
    expect(media.length).toBe(1)
    expect(isPng(media[0]![1])).toBe(true)
    expect(media.some(([n]) => n.endsWith('.svg'))).toBe(false)
  })
})
