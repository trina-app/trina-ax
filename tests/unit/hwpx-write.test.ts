// make_file's Hangul writer (server/src/files/hwpx-write.ts): pandoc's tree -> .hwpx. Each supported element, the
// refusal of each unsupported one, templates (the built-in one, a team's, a minimal one) and untrusted templates,
// the zip layout, well-formed XML, the read-back through hwp.ts, the office worker path and, when the HWP Preview
// renderer is in this checkout, a rendered page. Templates are built here; no third-party documents are in the repo.
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import zlib from 'node:zlib'
import { which } from '../../server/src/config'
import { officeWorkerText, officeWorkerWrite } from '../../server/src/files/extract'
import { hwpxText } from '../../server/src/files/hwp'
import { encodeHwpxRequest, firstDifference, HWPX_WRITE_MODE, hwpxExpectedLines, hwpxReadLines } from '../../server/src/files/hwpx-check'
import { defaultHeaderXml, defaultSecPrXml, defaultTemplate, NS_ATTRS, XML_DECL } from '../../server/src/files/hwpx-template'
import { HWPX_LIMITS, readTemplate, writeHwpx } from '../../server/src/files/hwpx-write'
import { NativeHwpEngine, localHwpAssets } from '../../server/src/files/hwp-engine'
import { checkZip } from '../../server/src/files/zip-guard'
import { writeZip } from '../../server/src/files/zip-write'
import { ToolError } from '../../server/src/policy/errors'
import { enc, hwpxParts as parts, hwpxTemplate as template } from '../lib/hwpx'

setDefaultTimeout(30_000)
const PANDOC = which('pandoc')
const ast = (md: string) => JSON.parse(execFileSync(PANDOC!, ['--sandbox', '-f', 'markdown', '-t', 'json'], { input: md }).toString())

const section = (b: Uint8Array) => parts(b).get('Contents/section0.xml')!
const header = (b: Uint8Array) => parts(b).get('Contents/header.xml')!
/** the first element `tag` with `id` in a header */
const byId = (xml: string, tag: string, id: string | number) => new RegExp(`<hh:${tag} id="${id}"[\\s\\S]*?</hh:${tag}>`).exec(xml)?.[0] ?? ''
const paras = (xml: string) => [...xml.matchAll(/<hp:p id="0" paraPrIDRef="(\d+)" styleIDRef="(\d+)" pageBreak="(\d)"[^>]*>([\s\S]*?)<\/hp:p>/g)].map((m) => ({ paraPr: m[1]!, style: m[2]!, pageBreak: m[3] === '1', body: m[4]! }))
const paraWith = (b: Uint8Array, text: string) => paras(section(b)).find((p) => p.body.includes(`>${text}<`))!
const roundTrip = (tree: unknown, bytes: Uint8Array) => firstDifference(hwpxExpectedLines(tree), hwpxReadLines(hwpxText(bytes)))
/**
 * A strict well-formedness check of its own (not the writer's parser): an XML declaration only first, one root, every
 * tag closed in order, attributes `name="value"` once each, `&` only in a known or numeric entity, no `<` in text or
 * attributes, no markup the writer never makes (comments, CDATA, DTD). Returns the root's qualified name and the
 * namespace prefixes the elements use, each of which must be declared on the root.
 */
function wellFormed(xml: string, name: string): { root: string; prefixes: Set<string> } {
  const fail = (why: string): never => { throw new Error(`${name}: ${why}`) }
  const ENT = /&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g
  const text = (s: string) => { if (/[<]/.test(s) || /&/.test(s.replace(ENT, ''))) fail(`bad text ${JSON.stringify(s.slice(0, 40))}`) }
  let i = 0
  if (xml.startsWith('<?xml')) { i = xml.indexOf('?>') + 2; if (i < 2) fail('declaration') }
  const stack: string[] = []
  let root = ''
  const prefixes = new Set<string>()
  let declared = new Set<string>()
  while (i < xml.length) {
    const lt = xml.indexOf('<', i)
    const chunk = xml.slice(i, lt < 0 ? xml.length : lt)
    if (!stack.length && chunk.trim()) fail('text outside the root')
    text(chunk)
    if (lt < 0) break
    if (/^<[!?]/.test(xml.slice(lt, lt + 2))) fail('comment, CDATA, DTD or PI')
    let j = lt + 1, q = ''
    for (; j < xml.length; j++) { const c = xml[j]; if (q) { if (c === q) q = '' } else if (c === '"' || c === "'") q = c; else if (c === '>') break }
    const tag = xml.slice(lt + 1, j)
    i = j + 1
    if (tag.startsWith('/')) { if (stack.pop() !== tag.slice(1).trim()) fail(`unbalanced </${tag.slice(1)}>`); continue }
    const self = tag.endsWith('/')
    const m = /^([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*"[^"<]*")*)\s*\/?$/.exec(tag)
    if (!m) fail(`bad tag <${tag.slice(0, 60)}>`)
    const attrs = [...m![2]!.matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*"([^"]*)"/g)]
    const names = attrs.map((a) => a[1]!)
    if (new Set(names).size !== names.length) fail(`repeated attribute in <${m![1]}>`)
    for (const a of attrs) text(a[2]!)
    if (!stack.length) {
      if (root) fail('two roots')
      root = m![1]!
      declared = new Set(names.filter((n) => n.startsWith('xmlns:')).map((n) => n.slice(6)))
    }
    for (const n of [m![1]!, ...names.filter((n) => n.includes(':') && !n.startsWith('xmlns:'))]) {
      if (!n.includes(':')) continue
      const p = n.split(':')[0]!
      prefixes.add(p)
      if (!declared.has(p) && !names.includes(`xmlns:${p}`)) fail(`undeclared prefix ${p}`)
    }
    if (!self) stack.push(m![1]!)
  }
  if (stack.length || !root) fail('unclosed elements')
  return { root, prefixes }
}

const refused = (fn: () => unknown): string => {
  try { fn() } catch (e) { expect(e).toBeInstanceOf(ToolError); return (e as Error).message }
  throw new Error('not refused')
}

/** a header with one style (바탕글), one shape of each kind, no numbering or bullets: what Hangul keeps of a bare document */
const MINIMAL_HEAD = XML_DECL + `<hh:head ${NS_ATTRS} version="1.5" secCnt="1"><hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/><hh:refList>` +
  '<hh:fontfaces itemCnt="1"><hh:fontface lang="HANGUL" fontCnt="1"><hh:font id="0" face="함초롬바탕" type="TTF" isEmbedded="0"/></hh:fontface></hh:fontfaces>' +
  '<hh:borderFills itemCnt="1"><hh:borderFill id="1" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0"><hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/><hh:leftBorder type="NONE" width="0.1 mm" color="#000000"/><hh:rightBorder type="NONE" width="0.1 mm" color="#000000"/><hh:topBorder type="NONE" width="0.1 mm" color="#000000"/><hh:bottomBorder type="NONE" width="0.1 mm" color="#000000"/><hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/></hh:borderFill></hh:borderFills>' +
  '<hh:charProperties itemCnt="1"><hh:charPr id="0" height="1100" textColor="#000000" shadeColor="none" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="1"><hh:fontRef hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/><hh:ratio hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/><hh:spacing hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/><hh:relSz hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/><hh:offset hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/><hh:underline type="NONE" shape="SOLID" color="#000000"/><hh:strikeout shape="NONE" color="#000000"/><hh:outline type="NONE"/><hh:shadow type="NONE" color="#B2B2B2" offsetX="10" offsetY="10"/></hh:charPr></hh:charProperties>' +
  '<hh:tabProperties itemCnt="1"><hh:tabPr id="0" autoTabLeft="0" autoTabRight="0"/></hh:tabProperties>' +
  '<hh:paraProperties itemCnt="1"><hh:paraPr id="0" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0" textDir="AUTO"><hh:align horizontal="JUSTIFY" vertical="BASELINE"/><hh:heading type="NONE" idRef="0" level="0"/><hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="KEEP_WORD" widowOrphan="0" keepWithNext="0" keepLines="0" pageBreakBefore="0" lineWrap="BREAK"/><hh:autoSpacing eAsianEng="0" eAsianNum="0"/><hh:margin><hc:intent value="0" unit="HWPUNIT"/><hc:left value="0" unit="HWPUNIT"/><hc:right value="0" unit="HWPUNIT"/><hc:prev value="0" unit="HWPUNIT"/><hc:next value="0" unit="HWPUNIT"/></hh:margin><hh:lineSpacing type="PERCENT" value="180" unit="HWPUNIT"/><hh:border borderFillIDRef="1" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/></hh:paraPr></hh:paraProperties>' +
  '<hh:styles itemCnt="1"><hh:style id="0" type="PARA" name="바탕글" engName="Normal" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0" langID="1042" lockForm="0"/></hh:styles>' +
  '</hh:refList><hh:compatibleDocument targetProgram="HWP201X"><hh:layoutCompatibility/></hh:compatibleDocument><hh:docOption><hh:linkinfo path="" pageInherit="1" footnoteInherit="0"/></hh:docOption><hh:trackchageConfig flags="56"/></hh:head>'

const ALL = [
  '# 1분기 운영 보고', '', '이번 분기에는 **신규 회원**이 늘었고 *재방문율*도 올랐다. ***둘 다***인 곳도 있다.', '줄을 바꿔\\', '이어서 쓴다.', '',
  '## 주요 일정', '', '- 첫째 항목', '  - 안쪽 항목', '    - 더 안쪽', '- 둘째 항목', '', '3. 셋째부터', '4. 넷째', '', 'a) 소문자', 'b) 다음', '',
  '\\newpage', '', '### 표', '', '| 구분 | 수량 | 비고 |', '|:--|--:|:-:|', '| 사과 | 12 | **좋음** |', '| 배 | 3 | |', '', '#### 넷', '##### 다섯', '###### 여섯', '',
  '"인용 부호"와 \'작은 따옴표\', 그리고 & < > 기호.',
].join('\n')

describe.skipIf(!PANDOC)('supported elements', () => {
  const tree = ast(ALL)
  const b = writeHwpx(tree)
  const h = header(b)

  test('headings # to ###### are outline levels 1-6 with the 개요 styles of the template', () => {
    for (const [i, text] of ['1분기 운영 보고', '주요 일정', '표', '넷', '다섯', '여섯'].entries()) {
      const p = paraWith(b, text)
      expect(p.style).toBe(String(2 + i))
      expect(byId(h, 'paraPr', p.paraPr)).toContain(`<hh:heading type="OUTLINE" idRef="0" level="${i}"/>`)
      expect(byId(h, 'style', p.style) || h).toContain(`name="개요 ${i + 1}"`)
    }
    expect(hwpxText(b)).toContain('# 1분기 운영 보고\n')
    expect(hwpxText(b)).toContain('###### 여섯')
  })

  test('paragraphs in 바탕글, bold and italic as character shapes, a hard line break inside the paragraph', () => {
    const p = paraWith(b, '신규 회원')
    expect(p.style).toBe('0')
    const run = (text: string) => /charPrIDRef="(\d+)"><hp:t>([^<]*)/.exec(p.body.slice(p.body.indexOf(text) - 40))![1]!
    expect(byId(h, 'charPr', run('신규 회원'))).toContain('<hh:bold/>')
    expect(byId(h, 'charPr', run('신규 회원'))).not.toContain('<hh:italic/>')
    expect(byId(h, 'charPr', run('재방문율'))).toContain('<hh:italic/>')
    const both = byId(h, 'charPr', run('둘 다'))
    expect(both).toMatch(/<hh:offset [^>]*\/><hh:italic\/><hh:bold\/><hh:underline/)
    expect(section(b)).toContain('줄을 바꿔<hp:lineBreak/>이어서 쓴다.')
  })

  test('bullet lists by level, numbered lists with their own start, format and label', () => {
    const outer = byId(h, 'paraPr', paraWith(b, '첫째 항목').paraPr), inner = byId(h, 'paraPr', paraWith(b, '안쪽 항목').paraPr)
    expect(outer).toMatch(/<hh:heading type="BULLET" idRef="(\d+)" level="0"\/>/)
    expect(inner).toContain('<hc:left value="2000" unit="HWPUNIT"/>')
    expect(byId(h, 'paraPr', paraWith(b, '더 안쪽').paraPr)).toContain('<hc:left value="4000" unit="HWPUNIT"/>')
    const bullet = (x: string) => byId(h, 'bullet', /type="BULLET" idRef="(\d+)"/.exec(x)![1]!)
    expect(bullet(outer)).toContain('char="●"')
    expect(bullet(inner)).toContain('char="○"')
    expect(paraWith(b, '둘째 항목').paraPr).toBe(paraWith(b, '첫째 항목').paraPr)
    const num = (text: string) => byId(h, 'numbering', /type="NUMBER" idRef="(\d+)"/.exec(byId(h, 'paraPr', paraWith(b, text).paraPr))![1]!)
    expect(num('셋째부터')).toMatch(/^<hh:numbering id="\d+" start="3"><hh:paraHead start="3" level="1"[^>]* numFormat="DIGIT"[^>]*>\^1\.<\/hh:paraHead>/)
    expect(num('소문자')).toMatch(/numFormat="LATIN_SMALL"[^>]*>\^1\)<\/hh:paraHead>/)
    expect(num('소문자')).not.toBe(num('셋째부터'))
  })

  test('a simple table: header row bold and shaded, column alignment, every cell', () => {
    const tbl = /<hp:tbl [^>]*>/.exec(section(b))![0]
    expect(tbl).toContain('rowCnt="3" colCnt="3"')
    const cells = [...section(b).matchAll(/<hp:tc name="" header="(\d)"[^>]*borderFillIDRef="(\d+)">[\s\S]*?<\/hp:tc>/g)]
    expect(cells.length).toBe(9)
    expect(cells.slice(0, 3).every((c) => c[1] === '1')).toBe(true)
    expect(byId(h, 'borderFill', cells[0]![2]!)).toContain('faceColor="#E8E8E8"')
    expect(byId(h, 'borderFill', cells[3]![2]!)).toContain('<hh:leftBorder type="SOLID"')
    const align = (cell: string) => /horizontal="(\w+)"/.exec(byId(h, 'paraPr', /paraPrIDRef="(\d+)"/.exec(cell)![1]!))![1]
    expect([align(cells[3]![0]), align(cells[4]![0]), align(cells[5]![0])]).toEqual(['LEFT', 'RIGHT', 'CENTER'])
    expect(byId(h, 'charPr', /<hp:run charPrIDRef="(\d+)"><hp:t>구분/.exec(cells[0]![0])![1]!)).toContain('<hh:bold/>')
    expect(cells[8]![0]).toContain('<hp:t/>')
    const widths = [...cells.slice(0, 3).map((c) => Number(/<hp:cellSz width="(\d+)"/.exec(c[0])![1]))]
    expect(widths.reduce((a, w) => a + w, 0)).toBe(59528 - 8504 * 2 - 568)
  })

  test('a page break: the next paragraph starts a page; none before the first text, two make an empty page', () => {
    expect(paraWith(b, '표').pageBreak).toBe(true)
    expect(paras(section(b)).filter((p) => p.pageBreak).length).toBe(1)
    const two = writeHwpx(ast('\\newpage\n\n앞\n\n\\newpage\n\n\\pagebreak\n\n뒤\n\n\\newpage\n'))
    const ps = paras(section(two))
    expect(ps.map((p) => p.pageBreak)).toEqual([false, true, true])
    expect(ps[1]!.body).toContain('<hp:t/>')
  })

  test('quotes and XML characters are written as text', () => {
    expect(section(b)).toContain('“인용 부호”와 ‘작은 따옴표’, 그리고 &amp; &lt; &gt; 기호.')
    expect(hwpxText(b)).toContain('“인용 부호”와 ‘작은 따옴표’, 그리고 & < > 기호.')
  })

  test('the first paragraph carries the page setup; the title is the first heading', () => {
    const first = paras(section(b))[0]!
    expect(first.body.startsWith('<hp:run charPrIDRef="0"><hp:secPr ')).toBe(true)
    expect(first.body).toContain('<hp:colPr ')
    expect(parts(b).get('Contents/content.hpf')).toContain('<opf:title>1분기 운영 보고</opf:title>')
  })

  test('the file reads back through hwp.ts as the document', () => {
    expect(roundTrip(tree, b)).toBeNull()
    expect(hwpxReadLines(hwpxText(b))).toEqual(hwpxExpectedLines(tree))
    expect(hwpxExpectedLines(tree)).toContain('| 사과')
    // and a file that does not is told apart
    const other = writeHwpx(ast(ALL.replace('넷째', '다섯째')))
    expect(roundTrip(tree, other)).toContain('expected "| 넷째", read "| 다섯째"')
  })

  test('CSV through pandoc is one table', () => {
    const t = JSON.parse(execFileSync(PANDOC!, ['--sandbox', '-f', 'csv', '-t', 'json'], { input: '이름,수량\n김,3\n' }).toString())
    const out = writeHwpx(t)
    expect(section(out)).toContain('rowCnt="2" colCnt="2"')
    expect(roundTrip(t, out)).toBeNull()
  })
})

describe.skipIf(!PANDOC)('refused: nothing is written, every kind is named at once', () => {
  const cases: [string, string][] = [
    ['![그림](a.png)', 'images'], ['본문[^1]\n\n[^1]: 각주', 'footnotes'], ['[링크](https://example.com)', 'links'], ['`코드`', 'inline code'],
    ['```\ncode\n```', 'code blocks'], ['> 인용', 'block quotes'], ['앞\n\n---\n\n뒤', 'horizontal rules'], ['<div>x</div>', 'divs'], ['<table><tr><td>x</td></tr></table>', 'raw HTML'],
    ['글 <b>굵게</b>', 'raw HTML'], ['$x^2$', 'math'], ['~~취소~~', 'strikethrough'], ['---\ntitle: 제목\n---\n\n본문', 'YAML metadata'],
    ['용어\n: 정의', 'definition lists'], ['::: note\n안\n:::', 'divs (::: or <div>)'], ['| 줄\n| 블록', 'line blocks'], ['H~2~O', 'subscript'],
    ['x^2^', 'superscript'], ['[밑줄]{.underline}', 'underline'], ['\\begin{x}\\end{x}', 'raw tex markup'],
    ['- 1\n  - 2\n    - 3\n      - 4\n        - 5\n          - 6\n            - 7', 'lists nested more than 6 levels'],
    ['| a |\n|---|\n| b |\n\n: 캡션', 'table captions'],
    ['+-----+-----+\n| a   | b   |\n+=====+=====+\n| - x | y   |\n|     |     |\n+-----+-----+', 'lists inside table cells'],
    ['- 항목\n\n  | a |\n  |---|\n  | b |', 'tables inside list items'],
  ]
  for (const [md, name] of cases) {
    test(name, () => {
      const msg = refused(() => writeHwpx(ast(md)))
      expect(msg).toContain(name)
      expect(msg).toContain('Nothing was saved')
    })
  }
  test('nested tables and merged cells (trees pandoc makes from other inputs)', () => {
    const cell = (blocks: unknown[], span = 1) => [['', [], []], { t: 'AlignDefault' }, span, 1, blocks]
    const table = (cells: unknown[]) => ({ t: 'Table', c: [['', [], []], [null, []], [[{ t: 'AlignDefault' }, { t: 'ColWidthDefault' }]], [['', [], []], []], [[['', [], []], 0, [], [[['', [], []], cells]]]], [['', [], []], []]] })
    const inner = table([cell([{ t: 'Plain', c: [{ t: 'Str', c: '안' }] }])])
    expect(refused(() => writeHwpx({ 'pandoc-api-version': [1, 23, 1], meta: {}, blocks: [table([cell([inner])])] }))).toContain('nested tables')
    expect(refused(() => writeHwpx({ 'pandoc-api-version': [1, 23, 1], meta: {}, blocks: [table([cell([{ t: 'Plain', c: [{ t: 'Str', c: 'x' }] }], 2)])] }))).toContain('merged table cells')
  })
  test('one message lists them all, with counts', () => {
    const msg = refused(() => writeHwpx(ast('![a](a.png) ![b](b.png)\n\n[l](https://example.com)\n\n> q')))
    expect(msg).toContain('images (2)')
    expect(msg).toContain('links')
    expect(msg).toContain('block quotes')
  })
  test('an empty document, and a tree that is not pandoc\'s', () => {
    expect(refused(() => writeHwpx(ast('')))).toContain('empty')
    expect(refused(() => writeHwpx({ nope: 1 }))).toContain('unexpected document tree')
  })
})

describe.skipIf(!PANDOC)('templates', () => {
  const doc = ast('# 제목\n\n본문 **굵게**\n\n- 하나\n\n1. 첫째\n\n| a | b |\n|---|---|\n| 1 | 2 |\n')

  test('the built-in template is a .hwpx that passes the same checks as a team template', () => {
    const t = readTemplate(defaultTemplate())
    expect(t.textWidth).toBe(59528 - 8504 * 2)
    expect(writeHwpx(doc, defaultTemplate())).toEqual(writeHwpx(doc))
  })

  test('a team template: its styles, fonts and page setup are used, its text is not', () => {
    const head = defaultHeaderXml().replace(/(<hh:charPr id="1" height=")1600/, '$12400').replace(/함초롬돋움/g, '나눔고딕')
    const secPr = defaultSecPrXml().replace('landscape="WIDELY"', 'landscape="NARROWLY"')
    const out = writeHwpx(doc, template({ head, secPr, text: '템플릿에만 있는 글' }))
    const h = header(out)
    expect(byId(h, 'charPr', 1)).toContain('height="2400"')
    expect(h).toContain('face="나눔고딕"')
    const title = paraWith(out, '제목')
    expect(title.style).toBe('2')
    expect(title.body).toContain('<hp:run charPrIDRef="1"><hp:t>제목</hp:t>')
    expect(section(out)).toContain('landscape="NARROWLY"')
    expect(section(out)).not.toContain('템플릿에만 있는 글')
    const widths = [...section(out).matchAll(/<hp:cellSz width="(\d+)"/g)].slice(0, 2).map((m) => Number(m[1]))
    expect(widths[0]! + widths[1]!).toBe(84186 - 8504 * 2 - 568)
    expect(roundTrip(doc, out)).toBeNull()
  })

  test('a minimal template (one style, no numbering or bullets): what is missing is added in Hangul\'s order', () => {
    const out = writeHwpx(doc, template({ head: MINIMAL_HEAD }))
    const h = header(out)
    const order = ['fontfaces', 'borderFills', 'charProperties', 'tabProperties', 'numberings', 'bullets', 'paraProperties', 'styles'].map((c) => h.indexOf(`<hh:${c} `))
    expect(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1]!))).toBe(true)
    expect(h).toContain('<hh:numberings itemCnt="1">')
    expect(h).toContain('<hh:bullets itemCnt="1">')
    expect(h).toMatch(/<hh:paraProperties itemCnt="(\d+)">/)
    expect(Number(/<hh:paraProperties itemCnt="(\d+)">/.exec(h)![1])).toBe((h.match(/<hh:paraPr id=/g) ?? []).length)
    expect(Number(/<hh:charProperties itemCnt="(\d+)">/.exec(h)![1])).toBe((h.match(/<hh:charPr id=/g) ?? []).length)
    // the heading: an outline paragraph shape of ours, bold, with the template's line spacing
    const title = paraWith(out, '제목')
    expect(title.style).toBe('0')
    expect(byId(h, 'paraPr', title.paraPr)).toContain('<hh:heading type="OUTLINE" idRef="0" level="0"/>')
    expect(byId(h, 'paraPr', title.paraPr)).toContain('<hh:lineSpacing type="PERCENT" value="180" unit="HWPUNIT"/>')
    expect(byId(h, 'charPr', /charPrIDRef="(\d+)"><hp:t>제목/.exec(title.body)![1]!)).toContain('height="1100"')
    expect(roundTrip(doc, out)).toBeNull()
  })

  test('a written document can be the next template; master pages of a template are not carried over', () => {
    const first = writeHwpx(doc)
    expect(roundTrip(doc, writeHwpx(doc, first))).toBeNull()
    const secPr = defaultSecPrXml().replace('masterPageCnt="0">', 'masterPageCnt="1">').replace('</hp:secPr>', '<hp:masterPage idRef="masterpage0"/></hp:secPr>')
    const out = section(writeHwpx(doc, template({ secPr })))
    expect(out).toContain('masterPageCnt="0"')
    expect(out).not.toContain('masterPage idRef')
  })
})

describe.skipIf(!PANDOC)('untrusted templates are refused', () => {
  const doc = ast('# 제목\n\n본문')
  const ole = Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(504)])
  const cases: [string, () => Uint8Array, RegExp][] = [
    ['scripts', () => template({ extra: { 'Scripts/headerScripts.js': 'function OnDocument_New() {}' } }), /scripts/],
    ['an OLE object by name', () => template({ extra: { 'BinData/BIN0001.ole': ole } }), /OLE object/],
    ['an OLE object by content', () => template({ extra: { 'BinData/image1.png': ole } }), /OLE object/],
    ['an OLE control in the section', () => template({ text: '</hp:t><hp:ole id="1"/><hp:t>' }), /embedded object/],
    ['encryption', () => template({ extra: { 'META-INF/manifest.xml': XML_DECL + '<odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><odf:file-entry odf:full-path="Contents/section0.xml"><odf:encryption-data/></odf:file-entry></odf:manifest>' } }), /encrypted/],
    ['a DTD', () => template({ head: defaultHeaderXml().replace(XML_DECL, XML_DECL + '<!DOCTYPE hh:head [<!ENTITY x "y">]>') }), /DTD/],
    ['comments', () => template({ head: defaultHeaderXml().replace('<hh:refList>', '<hh:refList><!-- </hh:charProperties> -->') }), /comments/],
    ['CDATA', () => template({ head: defaultHeaderXml().replace('<hh:refList>', '<hh:refList><![CDATA[x]]>') }), /CDATA/],
    ['another prefix for Hangul\'s namespace', () => template({ head: defaultHeaderXml().replace(/hh:/g, 'h:').replace('xmlns:hh=', 'xmlns:h=') }), /prefix "h"/],
    ['a Hangul prefix bound elsewhere', () => template({ head: defaultHeaderXml().replace('<hh:refList>', '<hh:refList xmlns:hp="urn:other">') }), /bound to another namespace/],
    ['not well-formed', () => template({ head: defaultHeaderXml().replace('</hh:styles>', '') }), /not well-formed/],
    ['too deep', () => template({ head: defaultHeaderXml().replace('<hh:docOption>', '<hh:docOption>' + '<hh:x>'.repeat(70) + '</hh:x>'.repeat(70)) }), /nested more than/],
    ['pictures in the styles', () => template({ head: defaultHeaderXml().replace('<hc:winBrush faceColor="none"', '<hc:imgBrush mode="TILE"><hc:img binaryItemIDRef="image1" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/></hc:imgBrush><hc:winBrush faceColor="none"') }), /pictures/],
    ['ids out of order', () => template({ head: defaultHeaderXml().replace('<hh:charPr id="1" ', '<hh:charPr id="7" ') }), /ids are not/],
    ['a style to a shape that is not there', () => template({ head: defaultHeaderXml().replace('paraPrIDRef="12" charPrIDRef="0" nextStyleIDRef="14"', 'paraPrIDRef="99" charPrIDRef="0" nextStyleIDRef="14"') }), /refers to a shape/],
    ['no header', () => writeZip([{ name: 'mimetype', data: enc('application/hwp+zip'), store: true }, { name: 'Contents/section0.xml', data: enc(XML_DECL + '<hs:sec/>') }]), /no Contents\/header\.xml/],
    ['no mimetype', () => template({ mimetype: null }), /mimetype/],
    ['another mimetype', () => template({ mimetype: 'application/epub+zip' }), /mimetype/],
    ['not a zip', () => enc('plain text'), /not a \.hwpx/],
    ['a .hwp', () => new Uint8Array(ole), /\.hwp file/],
    ['too large', () => new Uint8Array(HWPX_LIMITS.templateBytes + 1), /larger than 20 MB/],
    ['a zip bomb', () => template({ extra: { 'Contents/big.xml': new Uint8Array(70 * 1024 * 1024) } }), /damaged or too large/],
    ['too many parts', () => template({ extra: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`Contents/x${i}.txt`, 'x'])) }), /damaged or too large/],
  ]
  for (const [name, make, why] of cases) {
    test(name, () => {
      const msg = refused(() => writeHwpx(doc, make()))
      expect(msg).toMatch(/^the template cannot be used/)
      expect(msg).toMatch(why)
    })
  }
})

describe.skipIf(!PANDOC)('the file', () => {
  const tree = ast(ALL)
  const b = writeHwpx(tree)

  test('zip layout: mimetype first, stored, at byte 30 with no extra field; Hangul\'s part order; a sound zip', () => {
    const v = Buffer.from(b)
    expect(v.readUInt32LE(0)).toBe(0x04034b50)
    expect(v.readUInt16LE(8)).toBe(0) // stored
    expect(v.readUInt16LE(26)).toBe(8)
    expect(v.readUInt16LE(28)).toBe(0)
    expect(v.subarray(30, 38).toString()).toBe('mimetype')
    expect(v.subarray(38, 57).toString()).toBe('application/hwp+zip')
    expect(v.readUInt32LE(18)).toBe(v.readUInt32LE(22))
    expect(() => checkZip(b)).not.toThrow()
    const names: string[] = []
    for (let p = 0; v.readUInt32LE(p) === 0x04034b50;) {
      const n = v.readUInt16LE(p + 26), e = v.readUInt16LE(p + 28)
      names.push(v.subarray(p + 30, p + 30 + n).toString())
      if (names.length > 1) expect(v.readUInt16LE(p + 8)).toBe(8)
      p += 30 + n + e + v.readUInt32LE(p + 18)
      if (names.length > 20) break
    }
    expect(names).toEqual(['mimetype', 'version.xml', 'Contents/header.xml', 'Contents/section0.xml', 'Preview/PrvText.txt', 'settings.xml', 'META-INF/container.rdf', 'Contents/content.hpf', 'META-INF/container.xml', 'META-INF/manifest.xml'])
    // each deflated part inflates to its stored CRC (SheetJS checks while reading)
    expect(parts(b).get('Contents/section0.xml')).toContain('<hs:sec ')
    expect(zlib.inflateRawSync(v.subarray(57 + 30 + 'version.xml'.length, 57 + 30 + 'version.xml'.length + v.readUInt32LE(57 + 18))).toString()).toContain('HCFVersion')
  })

  test('every XML part is well-formed, in Hangul\'s namespaces', () => {
    for (const [name, xml] of [...parts(b), ...parts(writeHwpx(tree, template({ head: MINIMAL_HEAD })))]) {
      if (!/\.(xml|hpf|rdf)$/.test(name)) continue
      const { root } = wellFormed(xml, name)
      const roots: Record<string, string> = { 'version.xml': 'hv:HCFVersion', 'Contents/header.xml': 'hh:head', 'Contents/section0.xml': 'hs:sec', 'settings.xml': 'ha:HWPApplicationSetting', 'META-INF/container.rdf': 'rdf:RDF', 'Contents/content.hpf': 'opf:package', 'META-INF/container.xml': 'ocf:container', 'META-INF/manifest.xml': 'odf:manifest' }
      expect(`${name}: ${root}`).toBe(`${name}: ${roots[name]}`)
    }
    expect(parts(b).get('Contents/header.xml')).toContain('secCnt="1"')
    expect(parts(b).get('Preview/PrvText.txt')!.startsWith('1분기 운영 보고\r\n')).toBe(true)
  })

  test('the same tree gives the same bytes', () => {
    expect(writeHwpx(tree)).toEqual(b)
  })
})

describe.skipIf(!PANDOC)('through the office worker', () => {
  const tree = ast('# 제목\n\n본문 **굵게**\n')
  test('the worker writes what the writer writes, and hwp.ts in the worker reads it back', async () => {
    const out = await officeWorkerWrite(HWPX_WRITE_MODE, encodeHwpxRequest(JSON.stringify(tree)))
    expect(Buffer.from(out).equals(Buffer.from(writeHwpx(tree)))).toBe(true)
    expect(firstDifference(hwpxExpectedLines(tree), hwpxReadLines(await officeWorkerText('hwpx', out)))).toBeNull()
    const tpl = template({ head: MINIMAL_HEAD })
    expect(Buffer.from(await officeWorkerWrite(HWPX_WRITE_MODE, encodeHwpxRequest(JSON.stringify(tree), tpl))).equals(Buffer.from(writeHwpx(tree, tpl)))).toBe(true)
  })
  test('a refusal comes back as the writer\'s message', async () => {
    await expect(officeWorkerWrite(HWPX_WRITE_MODE, encodeHwpxRequest(JSON.stringify(ast('![x](a.png)'))))).rejects.toThrow(/images/)
    await expect(officeWorkerWrite(HWPX_WRITE_MODE, encodeHwpxRequest(JSON.stringify(tree), template({ extra: { 'Scripts/a.js': 'x' } })))).rejects.toThrow(/scripts/)
    await expect(officeWorkerWrite(HWPX_WRITE_MODE, new Uint8Array([0, 0, 0, 9, 1]))).rejects.toThrow(/damaged request/)
  })
})

// The HWP Preview plugin's renderer (rhwp, pinned) when this checkout has it (bun run prepare:hwp); skipped otherwise.
const RHWP = fs.existsSync(localHwpAssets().bin)
describe.skipIf(!PANDOC || !RHWP)('rendered by the HWP Preview renderer (when it is here)', () => {
  test('page 1 of a written document and of one with a team template is a PNG', async () => {
    const engine = new NativeHwpEngine()
    for (const b of [writeHwpx(ast(ALL)), writeHwpx(ast(ALL), template({ head: MINIMAL_HEAD }))]) {
      const r = await engine.render(Buffer.from(b), 'hwpx', 1)
      expect(r.bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
      expect(r.meta.pageCount).toBeGreaterThanOrEqual(2)
    }
  })
})
if (!RHWP) test('HWP Preview renderer not in this checkout: rendering skipped', () => { console.log(`skipped: no ${localHwpAssets().bin}`) })
