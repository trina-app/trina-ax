// Office files over 32 MB (QA TC-4910, docs/decisions/20261118-limits-office-read.md). Before, on Linux or with a plan, a
// spreadsheet or Hangul file over 32 MB could not be read at all, and a Word or PowerPoint file over 32 MB lost its
// speaker notes, chart data, headers, footers and comments. Now pictures and media are emptied before any reader sees
// the file (zip-slim.ts), a big .xlsx is read a sheet piece at a time (sheet-stream.ts) and comes as an overview with
// read's sheet / range for the rest, a big .hwp is read without its pictures, and the cap is 200 MB of text parts.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import zlib from 'node:zlib'
import path from 'node:path'
import * as XLSX from 'xlsx'
import { extractText, officeWorkerTimeoutMs, TOO_BIG_IN_PROCESS } from '../../server/src/files/extract'
import { sheetText, streamsSheets } from '../../server/src/files/office-parse'
import {
  bigSheetPart, bigSheetText, isDateFormat, OVERVIEW_HEAD, OVERVIEW_TAIL, PART_ROWS_MAX, parseRange, percentDecimals, serialDate,
} from '../../server/src/files/sheet-stream'
import { isTextPart, slimZip } from '../../server/src/files/zip-slim'
import { checkZip } from '../../server/src/files/zip-guard'
import { readCfb } from '../../server/src/files/cfb'
import { walkLines } from '../../server/src/files/locations'
import { IN_PROCESS_PARSE_MAX, setLimitsPlatformForTests, setPlanForTests } from '../../server/src/system/limits'
import { which } from '../../server/src/config'
import { makeHandler } from '../../server/src/mcp/protocol'
import { makeCApp, type CApp } from '../lib/c-app'

setDefaultTimeout(60_000)
const pandoc = which('pandoc')
const tools = { pandoc, pdftotext: null }
const MIB = 1024 * 1024
const FIXTURES = path.join(import.meta.dir, '..', 'fixtures', 'hwp')

/** A zip with parts added or replaced (`edit` gets the old text of a part); `stored`: no compression (fast for a big
 * picture). */
function withParts(bytes: Uint8Array, add: Record<string, string | Uint8Array | ((old: string) => string)>, stored = false): Uint8Array {
  const c = XLSX.CFB.read(Buffer.from(bytes), { type: 'buffer' })
  for (const [name, v] of Object.entries(add)) {
    const i = c.FullPaths.indexOf('Root Entry/' + name)
    const old = i >= 0 ? Buffer.from(c.FileIndex[i]!.content as Uint8Array).toString('utf8') : ''
    const data = v instanceof Uint8Array ? Buffer.from(v) : Buffer.from(typeof v === 'string' ? v : v(old), 'utf8')
    if (i >= 0) c.FileIndex[i]!.content = data
    else XLSX.CFB.utils.cfb_add(c, name, data)
  }
  return new Uint8Array(XLSX.CFB.write(c, { fileType: 'zip', type: 'buffer', compression: !stored }) as Buffer)
}
/** a picture's worth of bytes that does not compress (a photo) */
function photo(n: number): Uint8Array {
  const b = new Uint8Array(n)
  let x = 0x9e3779b9
  for (let i = 0; i < n; i += 4) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; b[i] = x & 255; b[i + 1] = (x >>> 8) & 255; b[i + 2] = (x >>> 16) & 255; b[i + 3] = x >>> 24 }
  return b
}
const BIG = 40 * MIB

function convert(md: string, to: 'docx' | 'pptx'): Uint8Array {
  const r = Bun.spawnSync([pandoc!, '-f', 'markdown', '-t', to, '-o', '-'], { stdin: Buffer.from(md) })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  return new Uint8Array(r.stdout)
}
const C = 'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
const strCache = (v: string[]) => `<c:strCache><c:ptCount val="${v.length}"/>${v.map((x, i) => `<c:pt idx="${i}"><c:v>${x}</c:v></c:pt>`).join('')}</c:strCache>`
const numCache = (v: number[]) => `<c:numCache><c:ptCount val="${v.length}"/>${v.map((x, i) => `<c:pt idx="${i}"><c:v>${x}</c:v></c:pt>`).join('')}</c:numCache>`
const chart = (title: string, cats: string[], vals: number[]) => `<?xml version="1.0" encoding="UTF-8"?><c:chartSpace ${C}><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>${title}</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:barChart><c:ser><c:tx><c:strRef>${strCache(['Units'])}</c:strRef></c:tx><c:cat><c:strRef>${strCache(cats)}</c:strRef></c:cat><c:val><c:numRef>${numCache(vals)}</c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>`
const chartRel = (id: string, target: string) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="${target}"/>`
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const para = (t: string) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`

/** A deck of 40 MB: a slide with a speaker note, a slide with a chart, and a big photo. */
function bigDeck(): Uint8Array {
  const md = '## Plan\n\n- Launch BIG-DECK-BODY-1\n\n::: notes\nSay the launch moves to May BIG-DECK-NOTE-2\n:::\n\n## Sales\n\n- Total\n'
  return withParts(convert(md, 'pptx'), {
    'ppt/charts/chart1.xml': chart('Units by quarter', ['Q1', 'Q2'], [120, 150]),
    'ppt/slides/_rels/slide2.xml.rels': (o) => o.replace('</Relationships>', chartRel('rId99', '../charts/chart1.xml') + '</Relationships>'),
    'ppt/media/photo1.png': photo(BIG),
  }, true)
}
/** A report of 40 MB: body, header, footer, comment, a chart and a big photo. */
function bigReport(): Uint8Array {
  return withParts(convert('Body BIG-DOC-BODY-1.\n', 'docx'), {
    'word/header1.xml': `<?xml version="1.0" encoding="UTF-8"?><w:hdr ${W}>${para('Header BIG-DOC-HEAD-2')}</w:hdr>`,
    'word/footer1.xml': `<?xml version="1.0" encoding="UTF-8"?><w:ftr ${W}>${para('Footer BIG-DOC-FOOT-3')}</w:ftr>`,
    'word/comments.xml': `<?xml version="1.0" encoding="UTF-8"?><w:comments ${W}><w:comment w:id="0" w:author="Reviewer">${para('Check BIG-DOC-COMMENT-4')}</w:comment></w:comments>`,
    'word/charts/chart1.xml': chart('Units by region', ['North', 'South'], [340, 98]),
    'word/_rels/document.xml.rels': (o) => o.replace('</Relationships>', chartRel('rId98', 'charts/chart1.xml') + '</Relationships>'),
    'word/media/photo1.png': photo(BIG),
  }, true)
}

describe('pictures and media are emptied before a reader sees the file (zip-slim.ts)', () => {
  test('text parts stay byte for byte, the rest become empty parts under their own names', () => {
    expect(['word/document.xml', 'ppt/slides/_rels/slide1.xml.rels', '[Content_Types].xml', 'mimetype', 'META-INF/manifest.xml', 'Contents/content.hpf'].every(isTextPart)).toBe(true)
    expect(['ppt/media/image1.png', 'word/embeddings/Microsoft_Excel_Worksheet.xlsx', 'BinData/image1.bmp', 'ppt/fonts/font1.fntdata'].some(isTextPart)).toBe(false)
    const z = withParts(withParts(new Uint8Array(XLSX.CFB.write(XLSX.CFB.utils.cfb_new(), { fileType: 'zip', type: 'buffer' }) as Buffer), { 'word/document.xml': '<w:document>hi</w:document>' }), { 'word/media/a.png': photo(4096) }, true)
    const s = slimZip(z)!
    expect(s.dropped).toBe(1)
    expect(s.bytes.length).toBeLessThan(z.length - 4000)
    expect(() => checkZip(s.bytes)).not.toThrow()
    const c = XLSX.CFB.read(Buffer.from(s.bytes), { type: 'buffer' })
    const part = (n: string) => c.FileIndex[c.FullPaths.indexOf('Root Entry/' + n)]?.content
    expect(Buffer.from(part('word/document.xml') as Uint8Array).toString()).toBe('<w:document>hi</w:document>')
    expect(c.FullPaths).toContain('Root Entry/word/media/a.png')
    expect((part('word/media/a.png') ?? []).length).toBe(0)
    // nothing to drop, or not a zip: the original is used
    expect(slimZip(withParts(z, {}))).not.toBeNull()
    expect(slimZip(s.bytes)).toBeNull()
    expect(slimZip(new Uint8Array(100))).toBeNull()
  })
})

describe.skipIf(!pandoc)('Word and PowerPoint files over 32 MB on Linux keep every part', () => {
  beforeAll(() => { setLimitsPlatformForTests('linux'); setPlanForTests(null) })
  afterAll(() => { setLimitsPlatformForTests(null); setPlanForTests(undefined) })
  test('a 40 MB deck: slide text, speaker notes and chart data', async () => {
    const deck = bigDeck()
    expect(deck.length).toBeGreaterThan(BIG)
    const t0 = Date.now()
    const text = await extractText('deck.pptx', deck, tools)
    expect(Date.now() - t0).toBeLessThan(20_000)
    expect(text).toContain('BIG-DECK-BODY-1')
    expect(text).toContain('Speaker notes:\n  Say the launch moves to May BIG-DECK-NOTE-2')
    expect(text).toContain('- Chart "Units by quarter" (bar chart):\n  - series "Units": Q1 = 120; Q2 = 150')
    expect(text).not.toContain('were not read')
  })
  test('a 40 MB report: body, headers, footers, comments and chart data', async () => {
    const text = await extractText('report.docx', bigReport(), tools)
    for (const mark of ['BIG-DOC-BODY-1', 'Header BIG-DOC-HEAD-2', 'Footer BIG-DOC-FOOT-3', 'Check BIG-DOC-COMMENT-4']) expect(text).toContain(mark)
    expect(text).toContain('=== Word charts (the data of the charts in the body, in order) ===\n- Chart "Units by region" (bar chart):\n  - series "Units": North = 340; South = 98')
    expect(text).not.toContain('were not read')
  })
})

// ---------------- spreadsheets ----------------

/** A workbook written by SheetJS (`sheets`: name -> rows). */
function book(sheets: Record<string, unknown[][]>): Uint8Array {
  const wb = XLSX.utils.book_new()
  for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name)
  return new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
}
/** rows of an order export: a header, `n` orders, a blank row and a TOTAL row */
function orders(n: number): unknown[][] {
  const rows: unknown[][] = [['Store', 'Region', 'Orders', 'Revenue']]
  let o = 0, r = 0
  for (let i = 0; i < n; i++) { const a = 10 + (i % 90), b = (i * 37) % 5000; o += a; r += b; rows.push([`Store ${i}`, ['North', 'South'][i % 2], a, b]) }
  rows.push([], ['TOTAL', '', o, r])
  return rows
}

/** A hand-written .xlsx part by part (what other writers do: prefixes, inline strings, no `r` attributes, styles). */
function handBook(sheetXml: string, extra: Record<string, string> = {}): Uint8Array {
  const parts: Record<string, string> = {
    'xl/workbook.xml': '<x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><x:sheets><x:sheet name="Data &amp; more" sheetId="1" r:id="rId1"/><x:sheet name="Hidden" sheetId="2" state="hidden" r:id="rId2"/></x:sheets></x:workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': sheetXml,
    'xl/worksheets/sheet2.xml': '<worksheet><sheetData/></worksheet>',
    'xl/sharedStrings.xml': '<sst><si><t>plain</t></si><si><r><t>rich </t></r><r><rPr><b/></rPr><t>text</t></r><rPh><t>ふりがな</t></rPh></si><si><t>a &amp; b_x000D_c</t></si></sst>',
    'xl/styles.xml': '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd hh:mm"/><numFmt numFmtId="165" formatCode="0.0%"/><numFmt numFmtId="166" formatCode="#,##0 &quot;days&quot;"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="10"/><xf numFmtId="165"/><xf numFmtId="166"/></cellXfs></styleSheet>',
    ...extra,
  }
  return withParts(new Uint8Array(XLSX.CFB.write(XLSX.CFB.utils.cfb_new(), { fileType: 'zip', type: 'buffer' }) as Buffer), parts)
}

describe('big spreadsheets: read a sheet piece at a time (sheet-stream.ts)', () => {
  test('the whole text is the same as SheetJS gives (labels, ranges, `# row N`, empty fields to the last column)', async () => {
    const b = book({ Sales: orders(300), Empty: [], Notes: [['note', 'with\ttab', 'with "quote"'], [], [], [null, null, 'far', 4.5]] })
    expect(await bigSheetText(b)).toBe(sheetText(b))
  })
  test('cells as other writers store them: shared and inline text, booleans, errors, dates, percentages, formulas', async () => {
    const xml = '<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:dimension ref="A1:H3"/><x:sheetData>' +
      '<x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c><x:c r="B1" t="s"><x:v>1</x:v></x:c><x:c r="C1" t="s"><x:v>2</x:v></x:c><x:c r="D1" t="inlineStr"><x:is><x:t>inline</x:t></x:is></x:c><x:c r="E1" t="b"><x:v>1</x:v></x:c><x:c r="F1" t="e"><x:v>#DIV/0!</x:v></x:c><x:c r="G1" t="str"><x:f>A1&amp;"x"</x:f><x:v>plainx</x:v></x:c></x:row>' +
      '<x:row r="2"><x:c r="A2" s="1"><x:v>46000</x:v></x:c><x:c r="B2" s="2"><x:v>46000.5</x:v></x:c><x:c r="C2" s="3"><x:v>0.1234</x:v></x:c><x:c r="D2" s="4"><x:v>0.5</x:v></x:c><x:c r="E2" s="5"><x:v>12</x:v></x:c><x:c r="F2"><x:f>SUM(A2:E2)</x:f></x:c></x:row>' +
      '<x:row><x:c><x:v>1</x:v></x:c><x:c/><x:c><x:v>3</x:v></x:c></x:row>' +
      '</x:sheetData></x:worksheet>'
    const text = await bigSheetText(handBook(xml))
    expect(text).toBe([
      '# sheet: Data & more · A1:H3 (tab-separated)',
      'plain\trich text\ta & b\rc\tinline\tTRUE\t#DIV/0!\tplainx\t',
      '2025-12-09\t2025-12-09 12:00:00\t12.34%\t50.0%\t12\t=SUM(A2:E2)\t\t',
      '1\t\t3\t\t\t\t\t',
      '',
      '# sheet: Hidden (tab-separated)',
      '',
    ].join('\n'))
  })
  test('too large to give whole: an overview with each sheet\'s size, first and last rows, and the range to read on', async () => {
    const b = book({ Jan: orders(500), Summary: orders(120) })
    const text = await bigSheetText(b, { fullMax: 1000 })
    const lines = text.split('\n')
    expect(lines[0]).toStartWith('# workbook: 2 sheets, too large to give whole.')
    expect(lines[0]).toContain('read\'s sheet and range')
    expect(text).toContain('# sheet: Summary · A1:D123 (tab-separated)\n# 122 rows with data, rows 1 to 123, columns A to D\n# row 1\nStore\tRegion\tOrders\tRevenue')
    expect(text).toContain(`# ${122 - OVERVIEW_HEAD - OVERVIEW_TAIL} rows with data not shown here: read them with sheet "Summary", range "A21:D112"`)
    const total = orders(120).at(-1)!.join('\t').replace(/\t+$/, '')
    expect(text).toEndWith(`# row 123\n${total}`)
    expect(lines.filter((l) => /^Store \d+\t/.test(l))).toHaveLength(2 * (OVERVIEW_HEAD - 1 + OVERVIEW_TAIL - 1))
    // the citation walker puts every shown row at its real row number
    const at = new Map<string, number | undefined>()
    walkLines(text, 'sheets', (l) => { if (l.row !== undefined) at.set(l.text, l.row) })
    expect(at.get(total)).toBe(123)
    expect(at.get('Store 0\tNorth\t10\t0')).toBe(2)
  })
  test('one range of one sheet: those rows, at most PART_ROWS_MAX, and where to read on', async () => {
    const b = book({ Jan: orders(3000), 'Q1 by store': orders(50) })
    expect(await bigSheetPart(b, { sheet: 'q1 BY store ', range: 'A50:D53' })).toBe(`# sheet: Q1 by store · A50:D53 (tab-separated)\nStore 48\tNorth\t58\t1776\nStore 49\tSouth\t59\t1813\n# row 53\n${orders(50).at(-1)!.join('\t').replace(/\t+$/, '')}`)
    const part = await bigSheetPart(b, { sheet: 'Jan', range: 'B2:C' })
    const lines = part.split('\n')
    expect(lines[0]).toBe(`# sheet: Jan · B2:C${PART_ROWS_MAX + 1} (tab-separated)`)
    expect(lines[1]).toBe('North\t10')
    expect(lines).toHaveLength(PART_ROWS_MAX + 2)
    expect(lines.at(-1)).toBe(`# more rows with data follow (from row ${(PART_ROWS_MAX + 2).toLocaleString('en-US')}): read on with sheet "Jan", range "B${PART_ROWS_MAX + 2}:C"`)
    expect(await bigSheetPart(b, { sheet: 'Jan', range: 'A9000:D9100' })).toBe('# sheet: Jan (tab-separated)\n# no rows with data in A9000:D9100; the sheet\'s rows with data end at row 3,003')
    await expect(bigSheetPart(b, { sheet: 'Feb' })).rejects.toThrow('this workbook has no sheet "Feb"; its sheets: "Jan", "Q1 by store"')
    await expect(bigSheetPart(b, { sheet: 'Jan', range: 'sum(A1)' })).rejects.toThrow(/is not a range like/)
  })
  test('ranges, formats and dates', () => {
    expect(parseRange('A1:H2000')).toEqual({ c0: 0, r0: 1, c1: 7, r1: 2000 })
    expect(parseRange('5000:7000')).toEqual({ c0: 0, r0: 5000, c1: 16383, r1: 7000 })
    expect(parseRange('C:F')).toEqual({ c0: 2, r0: 1, c1: 5, r1: Infinity })
    expect(parseRange('$B$5')).toEqual({ c0: 1, r0: 5, c1: 1, r1: 5 })
    expect(parseRange('A1200:')).toEqual({ c0: 0, r0: 1200, c1: 16383, r1: Infinity })
    expect(() => parseRange('B9:A1')).toThrow(/is empty/)
    expect(isDateFormat('yyyy-mm-dd')).toBe(true)
    expect(isDateFormat('[$-409]mmm d, yyyy')).toBe(true)
    expect(isDateFormat('#,##0 "days"')).toBe(false)
    expect(isDateFormat('[Red]0.00')).toBe(false)
    expect(isDateFormat('General')).toBe(false)
    expect(percentDecimals('0.00%')).toBe(2)
    expect(percentDecimals('0%')).toBe(0)
    expect(percentDecimals('0.00')).toBeNull()
    expect(serialDate(45658, false)).toBe('2025-01-01')
    expect(serialDate(0.75, false)).toBe('18:00:00')
    expect(serialDate(0, true)).toBe('1904-01-01')
  })
  test('which workbooks the streaming reader takes: an .xlsx over 2 MB, or one that expands past the zip check', () => {
    const small = book({ S: orders(10) })
    expect(streamsSheets('xlsx', small)).toBe(false)
    expect(streamsSheets('xls', small)).toBe(false)
    expect(streamsSheets('xlsx', book({ S: orders(80_000) }))).toBe(true)
  })
})

describe('big spreadsheets through the office worker', () => {
  beforeAll(() => { setLimitsPlatformForTests('linux'); setPlanForTests(null) })
  afterAll(() => { setLimitsPlatformForTests(null); setPlanForTests(undefined) })
  test('a workbook over 32 MB because of a picture reads (it was refused before), and so do its ranges', async () => {
    const b = withParts(book({ Data: orders(30) }), { 'xl/media/image1.png': photo(BIG) }, true)
    expect(b.length).toBeGreaterThan(BIG)
    const text = await extractText('pictured.xlsx', b, tools)
    expect(text).toStartWith('# sheet: Data · A1:D33 (tab-separated)\nStore\tRegion\tOrders\tRevenue\nStore 0\tNorth\t10\t0')
    expect(await extractText('pictured.xlsx', b, { ...tools, sheet: { sheet: 'Data', range: 'A33:D33' } })).toBe(`# sheet: Data · A33:D33 (tab-separated)\n${orders(30).at(-1)!.join('\t')}`)
  })
  test('a big workbook: the streaming reader in the worker, whole and by range', async () => {
    const b = book({ Data: orders(80_000) })
    expect(b.length).toBeGreaterThan(2 * MIB)
    const whole = await extractText('big.xlsx', b, tools)
    expect(whole.split('\n')).toHaveLength(80_004)
    const part = await extractText('big.xlsx', b, { ...tools, sheet: { sheet: 'Data', range: 'A80001:D' } })
    expect(part).toBe(`# sheet: Data · A80001:D80003 (tab-separated)\nStore 79999\tSouth\t${10 + (79_999 % 90)}\t${(79_999 * 37) % 5000}\n# row 80003\n${orders(80_000).at(-1)!.join('\t').replace(/\t+$/, '')}`)
  })
  test('the cap is 200 MB, counted without the emptied pictures; the worker gets more time for a bigger file', async () => {
    expect(IN_PROCESS_PARSE_MAX).toBe(200 * MIB)
    const big = new Uint8Array(IN_PROCESS_PARSE_MAX + 1)
    await expect(extractText('a.hwp', big, tools)).rejects.toThrow(TOO_BIG_IN_PROCESS)
    expect(officeWorkerTimeoutMs(MIB)).toBe(60_000)
    expect(officeWorkerTimeoutMs(200 * MIB)).toBe(144_000)
  })
})

describe('big Hangul files', () => {
  beforeAll(() => { setLimitsPlatformForTests('linux'); setPlanForTests(null) })
  afterAll(() => { setLimitsPlatformForTests(null); setPlanForTests(undefined) })
  test('a .hwp of 40 MB of pictures reads like the small one, without reading its pictures', async () => {
    const small = new Uint8Array(fs.readFileSync(path.join(FIXTURES, 'agreement.hwp')))
    const c = XLSX.CFB.read(Buffer.from(small), { type: 'buffer' })
    XLSX.CFB.utils.cfb_add(c, 'BinData/BIN0099.bmp', Buffer.from(photo(BIG)))
    const big = new Uint8Array(XLSX.CFB.write(c, { type: 'buffer' }) as Buffer)
    expect(big.length).toBeGreaterThan(BIG)
    expect(readCfb(big, undefined, (p) => !p.startsWith('BinData/')).streams.get('BinData/BIN0099.bmp')!.data.length).toBe(0)
    const text = await extractText('agreement.hwp', big, tools)
    expect(text).toBe(await extractText('agreement.hwp', small, tools))
    expect(text).toContain('QA-MARK-HWP5-6137')
  })
  test('a .hwpx with a 40 MB picture reads', async () => {
    const small = new Uint8Array(fs.readFileSync(path.join(FIXTURES, 'notice.hwpx')))
    const big = withParts(small, { 'BinData/image99.bmp': photo(BIG) }, true)
    expect(await extractText('notice.hwpx', big, tools)).toBe(await extractText('notice.hwpx', small, tools))
  })
})

describe('read takes sheet and range', () => {
  let A: CApp
  beforeAll(async () => { A = await makeCApp('office-big') })
  afterAll(async () => { await A.close() })
  let rpcId = 0
  async function call(name: string, args: Record<string, unknown>) {
    const h = makeHandler(A.ctx.files, A.ctx.db, A.toolCtx('alice', null))
    const r = await h({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } })
    return { text: r.result.content[0].text as string, isError: !!r.result.isError }
  }
  test('a range of a sheet comes as numbered lines; sheet and range on another kind of file are refused', async () => {
    fs.mkdirSync(path.join(A.team, 'shared', 'QA'), { recursive: true })
    fs.writeFileSync(path.join(A.team, 'shared', 'QA', 'orders.xlsx'), book({ Jan: orders(10), Totals: orders(3) }))
    fs.writeFileSync(path.join(A.team, 'shared', 'QA', 'notes.txt'), 'hello')
    const r = await call('read', { file_path: 'shared/QA/orders.xlsx', sheet: 'Totals', range: 'A5:D6' })
    expect(r.isError).toBe(false)
    expect(r.text).toBe('     1\t# sheet: Totals · A5:D6 (tab-separated)\n     2\t# row 6\n     3\tTOTAL\t\t33\t111')
    const bad = await call('read', { file_path: 'shared/QA/notes.txt', range: 'A1:B2' })
    expect(bad.isError).toBe(true)
    expect(bad.text).toContain('sheet and range are only for spreadsheets')
  })
})

// ---------------- hostile input (security review of #1290) ----------------

/** A zip built by hand: an entry may alias an earlier entry's local header (`alias`), lie about its size (`usize`), or
 * carry flags (`flags`, e.g. 1 = encrypted). */
type HE = { name: string; data?: Uint8Array | string; deflate?: boolean; alias?: number; usize?: number; flags?: number }
function hzip(es: HE[], o: { count?: number } = {}): Uint8Array {
  const locals: Buffer[] = [], cds: Buffer[] = []
  const info: { off: number; crc: number; cs: number; us: number; m: number }[] = []
  let off = 0
  for (const e of es) {
    const nb = Buffer.from(e.name)
    let a: (typeof info)[number]
    if (e.alias !== undefined) a = info[e.alias]!
    else {
      const raw = Buffer.from(typeof e.data === 'string' ? Buffer.from(e.data) : e.data!)
      const comp = e.deflate ? zlib.deflateRawSync(raw) : raw
      a = { off, crc: Bun.hash.crc32(raw) >>> 0, cs: comp.length, us: e.usize ?? raw.length, m: e.deflate ? 8 : 0 }
      const l = Buffer.alloc(30)
      l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(e.flags ?? 0, 6); l.writeUInt16LE(a.m, 8); l.writeUInt32LE(a.crc, 14); l.writeUInt32LE(a.cs, 18); l.writeUInt32LE(a.us, 22); l.writeUInt16LE(nb.length, 26)
      locals.push(l, nb, comp)
      off += 30 + nb.length + comp.length
    }
    info.push(a)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(e.flags ?? 0, 8); c.writeUInt16LE(a.m, 10)
    c.writeUInt32LE(a.crc, 16); c.writeUInt32LE(a.cs, 20); c.writeUInt32LE(a.us, 24); c.writeUInt16LE(nb.length, 28); c.writeUInt32LE(a.off, 42)
    cds.push(c, nb)
  }
  const cd = Buffer.concat(cds)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(o.count ?? es.length, 8); end.writeUInt16LE(o.count ?? es.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16)
  return new Uint8Array(Buffer.concat([...locals, cd, end]))
}
const pic = (n = 4096): HE => ({ name: 'word/media/a.png', data: photo(n) })

describe('zip-slim: hostile zips give null (the reader then refuses the original)', () => {
  test('central entries that alias one local header (200 x 20 MB would be 4 GB) or overlap', () => {
    const doc: HE = { name: 'word/document.xml', data: new Uint8Array(20 * MIB).fill(0x41) }
    const z = hzip([doc, pic(), ...Array.from({ length: 200 }, (_, i): HE => ({ name: `word/x${i}.xml`, alias: 0 }))])
    const rss0 = process.memoryUsage().rss
    expect(slimZip(z)).toBeNull()
    expect(process.memoryUsage().rss - rss0).toBeLessThan(200 * MIB)
    // one alias of the picture is enough
    expect(slimZip(hzip([{ name: 'word/document.xml', data: '<w:document/>' }, pic(), { name: 'word/b.png', alias: 1 }]))).toBeNull()
  })
  test('zip64, encrypted, damaged', () => {
    const parts = [{ name: 'word/document.xml', data: '<w:document/>' }, pic()]
    expect(slimZip(hzip(parts))).not.toBeNull()
    expect(slimZip(hzip(parts, { count: 0xffff }))).toBeNull()
    expect(slimZip(hzip([parts[0]!, { ...pic(), flags: 1 }]))).toBeNull()
    const z = hzip(parts)
    expect(slimZip(z.subarray(0, z.length - 30))).toBeNull()
  })
  test('the slim copy is used only when the emptied parts are over a quarter of the file', async () => {
    // a 1.5 MB sheet with a 4 KB picture: the original goes to the reader (no copy), the text is the same
    const b = withParts(book({ Data: orders(20) }), { 'xl/media/image1.png': photo(4096), 'xl/worksheets/pad.xml': 'x'.repeat(1536 * 1024) }, true)
    expect(slimZip(b)!.droppedBytes).toBeLessThan(b.length / 4)
    expect(await extractText('a.xlsx', b, tools)).toStartWith('# sheet: Data · A1:D23 (tab-separated)')
  })
})

const WB = '<workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>'
const WBR = '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'
/** a one-sheet .xlsx of hand-written parts, deflated (the sheet's declared size can lie: `sheetUsize`) */
function rawBook(sheet: string, shared?: string, sheetUsize?: number): Uint8Array {
  return hzip([
    { name: 'xl/workbook.xml', data: WB, deflate: true },
    { name: 'xl/_rels/workbook.xml.rels', data: WBR, deflate: true },
    { name: 'xl/worksheets/sheet1.xml', data: sheet, deflate: true, usize: sheetUsize },
    ...(shared ? [{ name: 'xl/sharedStrings.xml', data: shared, deflate: true }] : []),
  ])
}
/** `unit` n times, with a random comment every `every` (real files do not deflate 100 times; zip-guard refuses those) */
function vary(unit: string, n: number, every = 8): string {
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(i % every ? unit : unit + `<!--${Math.random().toString(36).slice(2, 8)}-->`)
  return out.join('')
}
const ws = (rows: string, head = '') => `<worksheet>${head}<sheetData>${rows}</sheetData></worksheet>`

describe('sheet-stream: hostile workbooks are refused or cut, within bounded memory and time', () => {
  test('a row that never ends, and a part that inflates past its declared size', async () => {
    await expect(bigSheetText(rawBook(`<worksheet><sheetData><row r="1">${vary('<c><v>1</v></c>', 1_200_000)}`))).rejects.toThrow(/a sheet row is over 16 MB or does not end/)
    const sheet = ws(vary('<row r="1"><c><v>1</v></c></row>', 20_000))
    await expect(bigSheetText(rawBook(sheet, undefined, 1000))).rejects.toThrow(/larger than its header says/)
  })
  test('a long row is read in one pass (the search for its end goes on where it stopped)', async () => {
    const t0 = Date.now()
    const text = await bigSheetText(rawBook(ws(vary(`<row>${vary('<c><v>7</v></c>', 16_000)}</row>`, 50, 1))))
    expect(Date.now() - t0).toBeLessThan(15_000)
    expect(text.split('\n')).toHaveLength(51)
  })
  test('one cell in column XFD does not pad every row to 16,384 fields: the overview instead', async () => {
    const rows = '<row r="1"><c r="XFD1"><v>1</v></c></row>' + Array.from({ length: 3000 }, (_, i) => `<row r="${i + 2}"><c r="A${i + 2}"><v>1</v></c></row>`).join('')
    const text = await bigSheetText(rawBook(ws(rows, '<dimension ref="A1:A1"/>')), { fullMax: 1 * MIB })
    expect(text).toStartWith('# workbook: 1 sheet, too large to give whole.')
    expect(text.length).toBeLessThan(200_000)
  })
  test('shared text: past the item count or size, cells say their text was not read', async () => {
    const sst = '<sst>' + vary('<si/>', 6_500_000, 90) + '<si><t>late</t></si></sst>'
    const text = await bigSheetText(rawBook(ws('<row r="1"><c t="s"><v>6500000</v></c></row>'), sst))
    expect(text).toContain('(text not read: the workbook holds too much text)')
  })
  test('a cell is cut at 32,767 characters with a note; a row over 8 MB of text is refused as too large', async () => {
    const long = 'x'.repeat(40_000)
    const text = await bigSheetText(rawBook(ws(`<row r="1"><c t="inlineStr"><is><t>${long}</t></is></c><c><v>2</v></c></row>`)))
    expect(text).toContain(`${'x'.repeat(32_767)}… (cut: the cell holds 40,000 characters)\t2`)
    const shared = `<sst><si><t>${'y'.repeat(40_000)}</t></si></sst>`
    await expect(bigSheetText(rawBook(ws(`<row r="1">${'<c t="s"><v>0</v></c>'.repeat(300)}</row>`), shared))).rejects.toThrow(/a row holds more than 8 MB of text/)
  })
})
