// A seal lands on the mark of the right signer, whatever text the AI names (QA TC-8357, decision
// docs/decisions/20261123-signing-slots.md). Made-up forms in each format, placed by the real editors. Hangul files are
// laid out again by the pinned renderer and the drawn picture is measured against the mark; Word is measured through
// LibreOffice where it is installed, and by its saved XML everywhere.
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { which } from '../../server/src/config'
import '../../server/src/files/docx-edit'
import { hwpText } from '../../server/src/files/hwp'
import { editHwp } from '../../server/src/files/hwp-edit'
import { NativeHwpEngine, localHwpAssets } from '../../server/src/files/hwp-engine'
import { labelX, landings, layoutTextHits, partX, sanitizeImage, type HwpLayout, type HwpPictureNote } from '../../server/src/files/hwp-picture'
import { editHwpx } from '../../server/src/files/hwpx-edit'
import type { HwpChange } from '../../server/src/files/hwpx-check'
import { frame, officeEditRequest, unframe, type EditReport } from '../../server/src/files/office-edit'
import { bareMarkAsk, pickSignMark, placedOn, SEAL_TOLERANCE_MM, signMarks } from '../../server/src/files/sign-slots'
import { readZip, writeZip } from '../../server/src/files/zip-write'
import { hwpDoc, para as hwpPara, sectionDef, table as hwpTable } from '../lib/hwp'
import { hwpxDoc, para as hwpxPara, table as hwpxTable } from '../lib/hwpx'

setDefaultTimeout(60_000)
const FIX = path.join(import.meta.dir, '../fixtures/hwp')
const SEAL = new Uint8Array(fs.readFileSync(path.join(FIX, 'seal.png')))
const MM_PER_PX = 25.4 / 96

describe('the sign marks in a text', () => {
  const on = (s: string) => signMarks(s).map((m) => s.slice(m.from, m.to))
  test('every printed form of a mark, with spacing and full-width brackets', () => {
    for (const m of ['(인)', '( 인 )', '(印)', '(서명)', '(서 명)', '(날인)', '(날 인)', '(서명 또는 인)', '(서명또는인)', '(서명 또는 날인)', '(Seal)', '(SEAL)', '(Signature)', '(L.S.)', '(L. S.)', '（인）']) expect(on(`이름 ${m} 끝`)).toEqual([m])
  })
  test('the other printed forms: circled seal, joined words, square brackets, company seal', () => {
    for (const m of ['㊞', '(서명/날인)', '(서명·날인)', '(인 또는 서명)', '(서명 날인)', '(직인)', '[인]', '[서명]', '(도장)', '(Signature or Seal)']) expect(on(`이름 ${m} 끝`)).toEqual([m])
    for (const [m, w] of [['(인 또는 서명)', '인'], ['(서명/날인)', '날인'], ['(서명 날인)', '날인'], ['(서명·날인)', '날인']] as const) {
      const x = signMarks(m)[0]!
      expect(m.slice(x.aimFrom, x.aimTo)).toBe(w)
    }
  })
  test('words in brackets that are not marks, and text with none', () => {
    for (const s of ['(인사팀)', '(주식회사)', '(LS)', '(개인)', '(확인)', '(본인)', '(대리인)', '본인 확인', '개인 정보', '신청인: 김가나']) expect(on(s)).toEqual([])
  })
  test('text after the chosen mark, or a sign-like token nobody knows, is never passed over', () => {
    expect('ask' in pickSignMark('(인)   을: 홍길동', undefined, 1)).toBe(true)
    expect('ask' in pickSignMark('갑 ㊞  을 ㊞', undefined, 1)).toBe(true)
    expect('ask' in pickSignMark('갑: 김철수 (인)  을: 홍길동 (서명란)', undefined, 1)).toBe(true)
    expect('mark' in pickSignMark('을: 홍길동 (인).', undefined, 1)).toBe(true)
    expect(pickSignMark('(서명란)', undefined, 1)).toEqual({ mark: null, occurrence: undefined })
    expect(bareMarkAsk('(인)', signMarks('(인)')[0]!, '갑: 김철수 (인)   을: 홍길동 ㊞', undefined)).toContain('2 places')
    expect(bareMarkAsk('(인)', signMarks('(인)')[0]!, '갑: 김철수 (인)   을: 홍길동 ㊞', 1)).toBeNull()
    expect(bareMarkAsk('(인)', signMarks('(인)')[0]!, '신청인: 김가나 (인)', undefined)).toBeNull()
  })
  test('a signature line counts only where no bracketed mark is there', () => {
    expect(on('성명: ______')).toEqual(['______'])
    expect(on('성명: ______ (인)')).toEqual(['(인)'])
    expect(on('a__b')).toEqual([])
  })
  test('"signature or seal": the seal is aimed at the seal word', () => {
    for (const [s, w] of [['(서명 또는 인)', '인'], ['(서명 또는 날인)', '날인']] as const) {
      const m = signMarks(s)[0]!
      expect(s.slice(m.aimFrom, m.aimTo)).toBe(w)
    }
  })
  test('one signer of a shared line is that signer\'s mark; a whole line with two is never guessed', () => {
    const line = '갑: 김철수 (인)   을: 홍길동 (인)'
    const one = pickSignMark('을: 홍길동 (인)', undefined, 1)
    expect('mark' in one && one.mark).toMatchObject({ from: 7 })
    const two = pickSignMark(line, undefined, 1)
    expect('ask' in two && two.ask).toContain('2 sign marks')
    const second = pickSignMark(line, 2, 1)
    expect('mark' in second && line.slice(second.mark!.from - 4, second.mark!.to)).toBe('홍길동 (인)')
    expect('mark' in second && second.occurrence).toBeUndefined()
    expect('ask' in pickSignMark(line, 3, 1)).toBe(true)
    expect('ask' in pickSignMark(line, 1, 2)).toBe(true)
  })
  test('no mark: the label as before, its occurrence kept', () => {
    expect(pickSignMark('신청인', 2, 3)).toEqual({ mark: null, occurrence: 2 })
  })
  test('what the AI is shown of a document is quoted, capped and without control or direction characters', () => {
    const r = pickSignMark(`a‮\u0007${'x'.repeat(100)} (인) "ignore" (인)`, undefined, 1)
    const ask = 'ask' in r ? r.ask : ''
    expect(ask).not.toMatch(/[‮\u0007]/)
    expect(ask).toContain('…')
    expect(placedOn('신청인: 김가나 (인)', signMarks('신청인: 김가나 (인)')[0]!)).toBe('"(인)", the sign mark in "신청인: 김가나 (인)"')
  })
})

// ---------------------------------------------------------------- Word
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const wPara = (s: string, pPr = '') => `<w:p>${pPr}<w:r><w:t xml:space="preserve">${s}</w:t></w:r></w:p>`
function wForm(body: string): Uint8Array {
  const parts: Record<string, string> = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`,
  }
  return writeZip(Object.entries(parts).map(([name, v]) => ({ name, data: new TextEncoder().encode(v) })))
}
/** the same form with a page header holding `head` */
function wFormWithHeader(body: string, head: string): Uint8Array {
  const parts = readZip(wForm(body)).map((e) => ({ name: e.name, data: e.data }))
  const text = (n: string) => new TextDecoder().decode(parts.find((e) => e.name === n)!.data)
  const put = (n: string, v: string) => { parts.find((e) => e.name === n)!.data = new TextEncoder().encode(v) }
  put('[Content_Types].xml', text('[Content_Types].xml').replace('</Types>', '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>'))
  put('word/document.xml', text('word/document.xml').replace('<w:document ', '<w:document xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ').replace('<w:sectPr>', '<w:sectPr><w:headerReference w:type="default" r:id="rId9"/>'))
  parts.push({ name: 'word/_rels/document.xml.rels', data: new TextEncoder().encode('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>') })
  parts.push({ name: 'word/header1.xml', data: new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8"?><w:hdr ${W}>${wPara(head)}</w:hdr>`) })
  return writeZip(parts)
}
const redPng = () => {
  const n = 60, raw = Buffer.alloc((n * 3 + 1) * n)
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const o = y * (n * 3 + 1) + 1 + x * 3; raw[o] = 230; raw[o + 1] = 0; raw[o + 2] = 0 }
  const crcT = Array.from({ length: 256 }, (_, k) => { let c = k; for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const b = Buffer.concat([Buffer.from(t), d]); const e = Buffer.alloc(4); e.writeUInt32BE(crc(b)); return Buffer.concat([l, b, e]) }
  const h = Buffer.alloc(13); h.writeUInt32BE(n, 0); h.writeUInt32BE(n, 4); h[8] = 8; h[9] = 2
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', h), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]))
}
const stampWord = (form: Uint8Array, changes: unknown[]) => {
  const o = unframe<EditReport>(officeEditRequest(frame({ kind: 'docx', changes }, [form, redPng()])))
  return { file: o.blobs[0]!, report: o.json }
}
const docXml = (b: Uint8Array) => new TextDecoder().decode(readZip(b).find((e) => e.name === 'word/document.xml')!.data)
/** the text just after the picture in the saved XML: what it is anchored on */
const anchoredOn = (xml: string) => /<\/w:drawing>(?:<\/w:r><w:r>)?<w:t[^>]*>([^<]*)/.exec(xml)?.[1] ?? ''

describe('Word: the seal is tied to the mark', () => {
  const pic = (over: string, more: object = {}) => ({ insert_picture: { image: 0, over, width_mm: 15, ...more } })
  test('a whole line and the bare mark give the same place', () => {
    const f = wForm(wPara('신청인: 김가나테스트 (인)'))
    const a = docXml(stampWord(f, [pic('신청인: 김가나테스트 (인)')]).file), b = docXml(stampWord(f, [pic('(인)')]).file)
    expect(anchoredOn(a)).toBe('(인)')
    expect(/<wp:posOffset>-?\d+/.exec(a)![0]).toBe(/<wp:posOffset>-?\d+/.exec(b)![0])
  })
  test('the result names the text it landed on and says it was not rendered', () => {
    const r = stampWord(wForm(wPara('신청인: 김가나테스트 (인)')), [pic('신청인: 김가나테스트 (인)')])
    expect(r.report.notes[0]!.where).toContain('"(인)", the sign mark in "신청인: 김가나테스트 (인)"')
    expect(r.report.notes[0]!.where).toContain('not rendered')
  })
  test('one signer of a shared line lands on that signer\'s mark', () => {
    const r = docXml(stampWord(wForm(wPara('갑: 김철수 (인)   을: 홍길동 (인)')), [pic('을: 홍길동 (인)')]).file)
    expect(r).toContain('을: 홍길동 </w:t>')
    expect(anchoredOn(r)).toBe('(인)')
  })
  test('both signers of one line stamped in one call: a seal on each mark', () => {
    const xml = docXml(stampWord(wForm(wPara('갑: 김철수 (인)   을: 홍길동 (인)')), [pic('갑: 김철수 (인)'), pic('을: 홍길동 (인)')]).file)
    expect(xml.match(/<wp:anchor/g)).toHaveLength(2)
    expect(xml).toContain('갑: 김철수 </w:t>')
    expect(xml.replace(/<w:drawing>[\s\S]*?<\/w:drawing>/g, '@').replace(/<[^>]+>/g, '')).toBe('갑: 김철수 @(인)   을: 홍길동 @(인)')
  })
  test('a whole line with two marks is refused, and occurrence picks one', () => {
    const f = wForm(wPara('갑: 김철수 (인)   을: 홍길동 (인)'))
    expect(() => stampWord(f, [pic('갑: 김철수 (인)   을: 홍길동 (인)')])).toThrow('2 sign marks')
    expect(docXml(stampWord(f, [pic('갑: 김철수 (인)   을: 홍길동 (인)', { occurrence: 1 })]).file)).toContain('갑: 김철수 </w:t>')
  })
  test('"(서명 또는 인)": anchored on the seal word', () => {
    expect(anchoredOn(docXml(stampWord(wForm(wPara('신청인 김가나 (서명 또는 인)')), [pic('신청인 김가나 (서명 또는 인)')]).file))).toBe('인)')
  })
  test('a mark in a table cell, on a long line', () => {
    const long = `${'이 신청서의 내용이 사실임을 확인하며 관련 규정에 따라 제출합니다. '.repeat(4)}신청인 김가나 (인)`
    const cell = `<w:tbl><w:tblPr><w:tblW w:w="6000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="6000"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="6000" w:type="dxa"/></w:tcPr>${wPara('대표자 박다라 (인)')}</w:tc></w:tr></w:tbl>`
    const f = wForm(wPara(long) + cell + wPara('끝'))
    expect(anchoredOn(docXml(stampWord(f, [pic(long)]).file))).toBe('(인)')
    expect(anchoredOn(docXml(stampWord(f, [pic('대표자 박다라 (인)')]).file))).toBe('(인)')
  })
  test('a fill and the seal in one text run', () => {
    const r = stampWord(wForm(wPara('성명: {{이름}} (인)')), [{ find: '{{이름}}', replace: '홍길동' }, pic('(인)')])
    const xml = docXml(r.file)
    expect(xml).toContain('성명: 홍길동 </w:t>')
    expect(anchoredOn(xml)).toBe('(인)')
  })
  test('exact line spacing: centred on that line, not on a guess from the font', () => {
    const y = (pPr: string) => Number(/positionV[^>]*><wp:posOffset>(-?\d+)/.exec(docXml(stampWord(wForm(wPara('이름 (인)', pPr)), [pic('(인)')]).file))![1])
    const exact = y('<w:pPr><w:spacing w:line="600" w:lineRule="exact"/></w:pPr>'), plain = y('')
    expect(exact - plain).toBe(Math.round((30 * 0.8 - 11 * 0.3) * 12700) - Math.round(((11 * 1.2) / 2) * 12700))
  })
  test('text after the mark names another signer: refused', () => {
    expect(() => stampWord(wForm(wPara('갑: 김철수 (인)   을: 홍길동 ㊞')), [pic('(인)   을: 홍길동')])).toThrow('after its sign mark')
    expect(() => stampWord(wForm(wPara('갑 ㊞  을 ㊞')), [pic('갑 ㊞  을 ㊞')])).toThrow('2 sign marks')
    expect(() => stampWord(wForm(wPara('갑: 김철수 (인)   을: 홍길동 ㊞')), [pic('(인)')])).toThrow('2 places')
  })
  test('a mark split over runs and styles is found and anchored at its start', () => {
    const split = '<w:p><w:r><w:t xml:space="preserve">신청인 김가나 </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>(</w:t></w:r><w:r><w:rPr><w:sz w:val="28"/></w:rPr><w:t>인</w:t></w:r><w:r><w:t>)</w:t></w:r></w:p>'
    const xml = docXml(stampWord(wForm(split), [pic('신청인 김가나 (인)')]).file)
    expect(xml.replace(/<w:drawing>[\s\S]*?<\/w:drawing>/g, '@').replace(/<[^>]+>/g, '')).toBe('신청인 김가나 @(인)')
  })
  test('hidden text: w:vanish counts, w:vanish off is visible, and part of a split mark hidden is refused', () => {
    const v = (a: string) => `<w:p><w:r><w:t xml:space="preserve">이름 </w:t></w:r><w:r><w:rPr><w:vanish${a}/></w:rPr><w:t>(인)</w:t></w:r></w:p>`
    for (const off of [' w:val="0"', ' w:val="false"', ' w:val="off"']) expect(docXml(stampWord(wForm(v(off)), [pic('(인)')]).file)).toContain('<wp:anchor')
    expect(() => stampWord(wForm(v(' w:val="1"')), [pic('(인)')])).toThrow('hidden')
    const part = '<w:p><w:r><w:t>(</w:t></w:r><w:r><w:rPr><w:vanish/></w:rPr><w:t>인</w:t></w:r><w:r><w:t>)</w:t></w:r></w:p>'
    expect(() => stampWord(wForm(part), [pic('(인)')])).toThrow('hidden')
  })
  test('a mark in a page header or footer is not a place: only the body counts', () => {
    const f = wFormWithHeader(wPara('본문만 있음'), '머리글 (인)')
    expect(() => stampWord(f, [pic('(인)')])).toThrow('of the body')
    const both = wFormWithHeader(wPara('신청인 김가나 (인)'), '신청인 김가나 (인)')
    const r = stampWord(both, [pic('(인)')])
    expect(anchoredOn(docXml(r.file))).toBe('(인)')
    expect(new TextDecoder().decode(readZip(r.file).find((e) => e.name === 'word/header1.xml')!.data)).not.toContain('w:drawing')
  })
  test('a hidden mark is refused; no mark: centred on the label as before', () => {
    const hidden = '<w:p><w:r><w:t xml:space="preserve">이름 </w:t></w:r><w:r><w:rPr><w:vanish/></w:rPr><w:t>(인)</w:t></w:r></w:p>'
    expect(() => stampWord(wForm(hidden), [pic('(인)')])).toThrow('hidden')
    const r = stampWord(wForm(wPara('담당자 확인')), [pic('담당자')])
    expect(r.report.notes[0]!.where).toContain('picture over "담당자"')
  })

  const soffice = which('soffice') ?? which('libreoffice')
  const measured = soffice && which('pdftotext') && which('pdftoppm') ? test : test.skip
  /** the drawn red picture's centre against the centre of the mark's word, in mm, through LibreOffice */
  const offset = (file: Uint8Array, word: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-corpus-'))
    try {
      fs.writeFileSync(path.join(dir, 'f.docx'), file)
      expect(Bun.spawnSync([soffice!, `-env:UserInstallation=file://${dir}/p`, '--headless', '--convert-to', 'pdf', '--outdir', dir, path.join(dir, 'f.docx')]).exitCode).toBe(0)
      const box = Bun.spawnSync(['pdftotext', '-bbox', path.join(dir, 'f.pdf'), '-']).stdout.toString()
      const w = [...box.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)</g)].filter((m) => m[5] === word).at(-1)!
      expect(Bun.spawnSync(['pdftoppm', '-r', '96', '-singlefile', path.join(dir, 'f.pdf'), path.join(dir, 'p')]).exitCode).toBe(0)
      const ppm = fs.readFileSync(path.join(dir, 'p.ppm'))
      const head = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(ppm.subarray(0, 40).toString('latin1'))!
      const W2 = Number(head[1]), H = Number(head[2]), at = head[0].length
      let sx = 0, sy = 0, n = 0
      for (let y = 0; y < H; y++) for (let x = 0; x < W2; x++) { const o = at + (y * W2 + x) * 3; if (ppm[o]! > 180 && ppm[o + 1]! < 70 && ppm[o + 2]! < 70) { sx += x; sy += y; n++ } }
      expect(n).toBeGreaterThan(100)
      const pt = 25.4 / 72
      return { x: Math.abs((sx / n) * MM_PER_PX - ((Number(w[1]) + Number(w[3])) / 2) * pt), y: Math.abs((sy / n) * MM_PER_PX - ((Number(w[2]) + Number(w[4])) / 2) * pt) }
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  }
  for (const [name, text, over, pPr] of [
    ['a whole line', 'Applicant: Hong Gildong (Seal)', 'Applicant: Hong Gildong (Seal)', ''],
    ['one signer of two', 'A: Kim Cheolsu (Signature)   B: Hong Gildong (Seal)', 'B: Hong Gildong (Seal)', ''],
    ['exact line spacing', 'Applicant: Hong Gildong (Seal)', 'Applicant: Hong Gildong (Seal)', '<w:pPr><w:spacing w:line="600" w:lineRule="exact"/></w:pPr>'],
  ] as const) measured(`measured in LibreOffice: ${name}`, () => {
    const o = offset(stampWord(wForm(wPara(text, pPr)), [pic(over)]).file, '(Seal)')
    expect(o.x).toBeLessThanOrEqual(SEAL_TOLERANCE_MM)
    expect(o.y).toBeLessThanOrEqual(SEAL_TOLERANCE_MM)
  })
})

// The invariant, tried on generated documents: repeated tables and lines, tables split over pages, drawn in any order.
// Whatever the document, the seal is on the true target or the call is refused, never on another place.
describe('Hangul: seal on the true target or refused, never on another', () => {
  const clean = sanitizeImage(SEAL, 'seal.png')
  const rng = (seed: number) => () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  type Row = [string, string]
  type Item = { kind: 'line'; text: string } | { kind: 'table'; rows: Row[] }
  const VALUES = ['홍길동 (인)', '이몽룡 (인)', '메모', '123']
  const generate = (r: () => number): Item[] => {
    const pick = <T,>(a: readonly T[]) => a[Math.floor(r() * a.length)]!
    const items: Item[] = [{ kind: 'line', text: '머리말' }]
    let last: Row[] | null = null
    for (let n = 2 + Math.floor(r() * 3); n > 0; n--) {
      const rows: Row[] = last && r() < 0.55 ? last.map((x) => [...x] as Row) : Array.from({ length: 1 + Math.floor(r() * 5) }, () => [pick(['성명', '대표']), pick(VALUES)] as Row)
      items.push({ kind: 'table', rows })
      last = rows
      items.push({ kind: 'line', text: pick(['을: 홍길동 (인)', '중간', '이몽룡 (인)']) })
    }
    return items
  }
  const build = (ext: 'hwp' | 'hwpx', items: Item[]) => {
    const spec = (rows: Row[]) => rows.map(([a, b]) => [{ text: a, width: 8000 }, { text: b, width: 30000 }])
    if (ext === 'hwpx') return hwpxDoc([items.map((x, i) => (x.kind === 'line' ? hwpxPara(x.text, { cache: true, vert: i * 1000 }) : hwpxTable(spec(x.rows), { cache: true }))).join('') + hwpxPara('끝', { cache: true, vert: 90000 })])
    return hwpDoc([Buffer.concat([hwpPara([[0, sectionDef()]]), ...items.map((x) => (x.kind === 'line' ? hwpPara(x.text) : hwpTable(spec(x.rows)))), hwpPara('끝', { last: true })])])
  }
  /** the items drawn on up to four pages in a shuffled order, each table whole or split in two; where each text is drawn */
  const draw = (r: () => number, items: Item[]) => {
    const pages: HwpLayout['pages'] = Array.from({ length: 4 }, () => ({ w: 793.7, h: 1122.5, section: 0, continued: [], tables: [], cells: [], starts: [], lines: [] }))
    const nextY = [150, 150, 150, 150], ids = [0, 0, 0, 0]
    const at = new Map<string, { page: number; y: number }>()
    const put = (page: number, height: number) => { const y = nextY[page]!; nextY[page] = y + height + 8; return y }
    const blocks: (() => void)[] = []
    items.forEach((x, i) => {
      const para = i + 1
      if (x.kind === 'line') {
        blocks.push(() => {
          const page = Math.floor(r() * 4), y = put(page, 16)
          pages[page]!.lines.push({ x: 113.4, y, w: 566.9, h: 13.3, text: x.text, runs: [{ x: 113.4, w: x.text.length * 13.3, text: x.text }], para: `0:${para}`, cell: -1 })
          pages[page]!.starts.push({ para, table: false, preview: '' })
          at.set(`${i}:line`, { page, y })
        })
        return
      }
      const cut = x.rows.length > 1 && r() < 0.6 ? 1 + Math.floor(r() * (x.rows.length - 1)) : x.rows.length
      for (const [from, to] of [[0, cut], [cut, x.rows.length]] as const) {
        if (from === to) continue
        blocks.push(() => {
          const page = Math.floor(r() * 4), pg = pages[page]!, id = ++ids[page]!, top = put(page, (to - from) * 20)
          pg.tables.push({ x: 113, y: top, w: 500, h: (to - from) * 20 })
          pg.starts.push({ para, table: true, preview: '' })
          for (let row = from; row < to; row++) x.rows[row]!.forEach((text, col) => {
            const y = top + (row - from) * 20
            const cell = pg.cells.push({ table: id, row, col, x: 113 + col * 100, y, w: col ? 400 : 100, h: 20 }) - 1
            pg.lines.push({ x: 120 + col * 100, y: y + 3, w: 380, h: 13.3, text, runs: [{ x: 120 + col * 100, w: text.length * 13.3, text }], para: `${id * 100 + cell}:0`, cell })
            at.set(`${i}:${row}:${col}`, { page, y: y + 3 })
          })
        })
      }
    })
    for (let k = blocks.length - 1; k > 0; k--) { const j = Math.floor(r() * (k + 1)); [blocks[k], blocks[j]] = [blocks[j]!, blocks[k]!] }
    blocks.forEach((b) => b())
    // a table's two parts on one page would be one drawn table with a gap: such a drawing is still data the code must survive
    return { layout: { pages: pages.filter((p) => p.lines.length) } as HwpLayout, at, kept: pages.map((p, n) => (p.lines.length ? n : -1)).filter((n) => n >= 0) }
  }
  /** every place of the text in the document's reading order */
  const places = (items: Item[], text: string) => items.flatMap((x, i) => x.kind === 'line'
    ? (x.text.includes(text) ? [`${i}:line`] : [])
    : x.rows.flatMap((row, r2) => row.flatMap((c, col) => (c.includes(text) ? [`${i}:${r2}:${col}`] : []))))
  for (const ext of ['hwp', 'hwpx'] as const) test(`.${ext}: 400 generated documents`, () => {
    let placed = 0, refused = 0
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed), items = generate(r), doc = build(ext, items), { layout, at, kept } = draw(r, items)
      for (const label of ['홍길동 (인)', '이몽룡 (인)']) {
        const where = places(items, label)
        for (let k = 1; k <= where.length; k++) {
          let got: HwpPictureNote
          try {
            got = (ext === 'hwp' ? editHwp(doc, [{ image: 'seal.png', at: label, occurrence: k }], { layout, images: new Map([[0, clean]]) }) : editHwpx(doc, [{ image: 'seal.png', at: label, occurrence: k }], { layout, images: new Map([[0, clean]]) })).report.pictures![0]!
          } catch { refused++; continue }
          placed++
          const truth = at.get(where[k - 1]!)!
          const failure = `seed ${seed}, ${label} occurrence ${k}`
          expect([failure, kept[got.page - 1]]).toEqual([failure, truth.page])
          expect([failure, Math.abs(got.yMm + got.heightMm / 2 - (truth.y + 13.3 / 2) * MM_PER_PX) <= SEAL_TOLERANCE_MM]).toEqual([failure, true])
        }
      }
    }
    // neither side may be empty, or the test proves nothing
    expect(placed).toBeGreaterThan(50)
    expect(refused).toBeGreaterThan(50)
  }, 120_000)
})

// ---------------------------------------------------------------- Hangul
// The renderer's order and line boxes, set by hand: what real files show only with a floating table or tight line spacing.
describe('Hangul: the mark is paired by its own paragraph, not by counting', () => {
  const clean = () => sanitizeImage(SEAL, 'seal.png')
  const box = { w: 793.7, h: 1122.5, section: 0, continued: [] as number[] }
  const ln = (text: string, y: number, para: string, cell = -1, h = 13.3) => ({ x: 113.4, y, w: 566.9, h, text, runs: [{ x: 113.4, w: text.length * 13.3, text }], para, cell })
  const edit = (ext: 'hwp' | 'hwpx', doc: Uint8Array, ch: HwpChange[], x: { layout: HwpLayout; images: Map<number, ReturnType<typeof clean>> }) => (ext === 'hwp' ? editHwp(doc, ch, x) : editHwpx(doc, ch, x))
  const doc = (ext: 'hwp' | 'hwpx', cache: boolean) => ext === 'hwpx'
    ? hwpxDoc([hwpxPara('머리말', { cache, vert: 0 }) + hwpxTable([[{ text: '갑', width: 8000 }, { text: '김철수 (인)', width: 30000 }]], { cache }) + hwpxPara('을: 홍길동 (인)', { cache, vert: 6000 }) + hwpxPara('끝', { cache, vert: 8000 })])
    : hwpDoc([Buffer.concat([hwpPara([[0, sectionDef()]], { lines: cache ? 1 : 0 }), hwpPara('머리말', { lines: cache ? 1 : 0 }), hwpTable([[{ text: '갑', width: 8000 }, { text: '김철수 (인)', width: 30000 }]]), hwpPara('을: 홍길동 (인)', { lines: cache ? 1 : 0 }), hwpPara('끝', { lines: cache ? 1 : 0, last: true })])])
  /** the body drawn first, then the floating table: the opposite of the document's order */
  const floating = (bodyPara: number): HwpLayout => ({ pages: [{
    ...box, tables: [{ x: 113, y: 640, w: 500, h: 20 }],
    cells: [{ table: 1, row: 0, col: 0, x: 113, y: 640, w: 100, h: 20 }, { table: 1, row: 0, col: 1, x: 213, y: 640, w: 400, h: 20 }],
    starts: [0, 1, 2, 3, 4].map((para) => ({ para, table: para === bodyPara - 1, preview: '' })),
    lines: [ln('머리말', 120, '0:1'), ln('을: 홍길동 (인)', 400, `0:${bodyPara}`), ln('끝', 420, `0:${bodyPara + 1}`), ln('갑', 642, '1:0', 0), ln('김철수 (인)', 642, '2:0', 1)],
  }] })
  for (const ext of ['hwp', 'hwpx'] as const) {
    const bodyPara = ext === 'hwp' ? 3 : 2
    test(`.${ext}: a floating table's mark is not taken for the body line's`, () => {
      const r = edit(ext, doc(ext, true), [{ image: 'seal.png', at: '을: 홍길동 (인)' }], { layout: floating(bodyPara), images: new Map([[0, clean()]]) })
      const y = r.report.pictures![0]!.yMm + r.report.pictures![0]!.heightMm / 2
      expect(Math.abs(y - (400 + 13.3 / 2) * MM_PER_PX)).toBeLessThanOrEqual(SEAL_TOLERANCE_MM)
    })
    test(`.${ext}: and the table's own mark lands in the table`, () => {
      const r = edit(ext, doc(ext, true), [{ image: 'seal.png', at: '김철수 (인)' }], { layout: floating(bodyPara), images: new Map([[0, clean()]]) })
      const y = r.report.pictures![0]!.yMm + r.report.pictures![0]!.heightMm / 2
      expect(Math.abs(y - (642 + 13.3 / 2) * MM_PER_PX)).toBeLessThanOrEqual(SEAL_TOLERANCE_MM)
    })
    test(`.${ext}: a mark whose line reads differently from its paragraph is refused`, () => {
      const layout = floating(bodyPara)
      layout.pages[0]!.lines[1] = ln('다른 사람 (인)', 400, `0:${bodyPara}`)
      expect(() => edit(ext, doc(ext, true), [{ image: 'seal.png', at: '을: 홍길동 (인)' }], { layout, images: new Map([[0, clean()]]) })).toThrow('its own line')
    })
    test(`.${ext}: a row repeated on the page draws the mark twice: refused`, () => {
      const layout = floating(bodyPara)
      layout.pages[0]!.lines.push(ln('김철수 (인)', 700, '3:0', 1))
      expect(() => edit(ext, doc(ext, true), [{ image: 'seal.png', at: '김철수 (인)' }], { layout, images: new Map([[0, clean()]]) })).toThrow()
    })
    // two tables with the same "name (seal)" row, the second drawn first: only a whole-table match says which is which
    const twoTables = (cache = true) => {
      const row = [{ text: '성명', width: 8000 }, { text: '홍길동 (인)', width: 30000 }]
      const note = [{ text: '비고', width: 8000 }, { text: '메모', width: 30000 }]
      return ext === 'hwpx'
        ? hwpxDoc([hwpxPara('머리말', { cache, vert: 0 }) + hwpxTable([row, note], { cache }) + hwpxPara('중간', { cache, vert: 6000 }) + hwpxTable([row], { cache }) + hwpxPara('끝', { cache, vert: 9000 })])
        : hwpDoc([Buffer.concat([hwpPara([[0, sectionDef()]]), hwpPara('머리말'), hwpTable([row, note]), hwpPara('중간'), hwpTable([row]), hwpPara('끝', { last: true })])])
    }
    const drawnTwo = (memo = '메모', y2 = 300, y1 = 600): HwpLayout => ({ pages: [{
      ...box, tables: [{ x: 113, y: y2, w: 500, h: 20 }, { x: 113, y: y1, w: 500, h: 40 }],
      cells: [
        { table: 1, row: 0, col: 0, x: 113, y: y2, w: 100, h: 20 }, { table: 1, row: 0, col: 1, x: 213, y: y2, w: 400, h: 20 },
        { table: 2, row: 0, col: 0, x: 113, y: y1, w: 100, h: 20 }, { table: 2, row: 0, col: 1, x: 213, y: y1, w: 400, h: 20 },
        { table: 2, row: 1, col: 0, x: 113, y: y1 + 20, w: 100, h: 20 }, { table: 2, row: 1, col: 1, x: 213, y: y1 + 20, w: 400, h: 20 },
      ],
      starts: [0, 1, 2, 3, 4, 5].map((para) => ({ para, table: false, preview: '' })),
      lines: [ln('성명', y2 + 2, '1:0', 0), ln('홍길동 (인)', y2 + 2, '2:0', 1), ln('성명', y1 + 2, '3:0', 2), ln('홍길동 (인)', y1 + 2, '4:0', 3), ln('비고', y1 + 22, '5:0', 4), ln(memo, y1 + 22, '6:0', 5)],
    }] })
    const centre = (r: { report: { pictures?: HwpPictureNote[] } }) => r.report.pictures![0]!.yMm + r.report.pictures![0]!.heightMm / 2
    test(`.${ext}: two tables with the same row: each lands in its own, named by what was placed`, () => {
      const a = edit(ext, twoTables(), [{ image: 'seal.png', at: '홍길동 (인)', occurrence: 1 }], { layout: drawnTwo(), images: new Map([[0, clean()]]) })
      expect(Math.abs(centre(a) - (602 + 13.3 / 2) * MM_PER_PX)).toBeLessThanOrEqual(SEAL_TOLERANCE_MM)
      expect(a.report.pictures![0]!.where).toStartWith('table 1,')
      const b = edit(ext, twoTables(), [{ image: 'seal.png', at: '홍길동 (인)', occurrence: 2 }], { layout: drawnTwo(), images: new Map([[0, clean()]]) })
      expect(Math.abs(centre(b) - (302 + 13.3 / 2) * MM_PER_PX)).toBeLessThanOrEqual(SEAL_TOLERANCE_MM)
      expect(b.report.pictures![0]!.where).toStartWith('table 2,')
    })
    test(`.${ext}: a soft hyphen the renderer draws does not make a table lose to the other`, () => {
      const r = edit(ext, twoTables(), [{ image: 'seal.png', at: '홍길동 (인)', occurrence: 1 }], { layout: drawnTwo('메\u00AD모'), images: new Map([[0, clean()]]) })
      expect(Math.abs(centre(r) - (602 + 13.3 / 2) * MM_PER_PX)).toBeLessThanOrEqual(SEAL_TOLERANCE_MM)
    })
    test(`.${ext}: the target table drawn differently is refused, never given to the other table`, () => {
      expect(() => edit(ext, twoTables(), [{ image: 'seal.png', at: '홍길동 (인)', occurrence: 1 }], { layout: drawnTwo('다른 글'), images: new Map([[0, clean()]]) })).toThrow('its own line')
    })
    test(`.${ext}: a target table split over two pages is refused when another table has the same row`, () => {
      const one = drawnTwo().pages[0]!
      const first = { ...one, tables: one.tables, cells: one.cells.slice(0, 4), lines: one.lines.slice(0, 4) }
      const rest = { ...one, tables: [one.tables[1]!], cells: one.cells.slice(4).map((c) => ({ ...c, table: 1, row: c.row })), lines: one.lines.slice(4).map((l) => ({ ...l, cell: l.cell - 4 })), starts: [] }
      expect(() => edit(ext, twoTables(), [{ image: 'seal.png', at: '홍길동 (인)', occurrence: 1 }], { layout: { pages: [first, rest] }, images: new Map([[0, clean()]]) })).toThrow('its own line')
    })
    test(`.${ext}: two equal tables cannot be told apart: refused`, () => {
      const row = [{ text: '성명', width: 8000 }, { text: '홍길동 (인)', width: 30000 }]
      const same = ext === 'hwpx'
        ? hwpxDoc([hwpxPara('머리말', { cache: true, vert: 0 }) + hwpxTable([row], { cache: true }) + hwpxPara('중간', { cache: true, vert: 6000 }) + hwpxTable([row], { cache: true }) + hwpxPara('끝', { cache: true, vert: 9000 })])
        : hwpDoc([Buffer.concat([hwpPara([[0, sectionDef()]]), hwpPara('머리말'), hwpTable([row]), hwpPara('중간'), hwpTable([row]), hwpPara('끝', { last: true })])])
      const d = drawnTwo().pages[0]!
      const layout: HwpLayout = { pages: [{ ...d, cells: d.cells.slice(0, 4), lines: d.lines.slice(0, 4) }] }
      expect(() => edit(ext, same, [{ image: 'seal.png', at: '홍길동 (인)', occurrence: 1 }], { layout, images: new Map([[0, clean()]]) })).toThrow('its own line')
    })
    test(`.${ext}: two equal body lines: each by its own paragraph, and refused when the renderer gives no index for it`, () => {
      const line = '을: 홍길동 (인)'
      const d = ext === 'hwpx'
        ? hwpxDoc([hwpxPara(line, { cache: true, vert: 0 }) + hwpxPara('중간', { cache: true, vert: 2000 }) + hwpxPara(line, { cache: true, vert: 4000 })])
        : hwpDoc([Buffer.concat([hwpPara([[0, sectionDef()]]), hwpPara(line), hwpPara('중간'), hwpPara(line, { last: true })])])
      // the body's first paragraph holds the section definition in both builders
      const first = 1
      const lay = (a: number, b: number): HwpLayout => ({ pages: [{ ...box, tables: [], cells: [], starts: [0, 1, 2, 3].map((para) => ({ para, table: false, preview: '' })), lines: [ln(line, 200, `0:${a}`), ln('중간', 240, `0:${first + 1}`), ln(line, 280, `0:${b}`)] }] })
      const r = edit(ext, d, [{ image: 'seal.png', at: line, occurrence: 2 }], { layout: lay(first, first + 2), images: new Map([[0, clean()]]) })
      expect(Math.abs(centre(r) - (280 + 13.3 / 2) * MM_PER_PX)).toBeLessThanOrEqual(SEAL_TOLERANCE_MM)
      expect(() => edit(ext, d, [{ image: 'seal.png', at: line, occurrence: 2 }], { layout: lay(first, 99), images: new Map([[0, clean()]]) })).toThrow('its own line')
    })
    for (const spacing of [1.05, 1, 0.95, 0.9, 0.8]) test(`.${ext}: no stored layout, a mark on the second line at ${spacing * 100}% spacing is refused`, () => {
      const text = '을: 홍길동 신청합니다 (인)'
      const d = ext === 'hwpx'
        ? hwpxDoc([hwpxPara(text, { cache: false }) + hwpxPara('끝', { cache: false })])
        : hwpDoc([Buffer.concat([hwpPara([[0, sectionDef()]], { lines: 0 }), hwpPara(text, { lines: 0 }), hwpPara('끝', { lines: 0, last: true })])])
      const pi = ext === 'hwp' ? 1 : 0
      const layout: HwpLayout = { pages: [{ ...box, tables: [], cells: [], starts: [{ para: pi, table: false, preview: '' }, { para: pi + 1, table: false, preview: '' }],
        lines: [ln('을: 홍길동', 200, `0:${pi}`), ln('신청합니다 (인)', 200 + 13.3 * spacing, `0:${pi}`), ln('끝', 240, `0:${pi + 1}`)] }] }
      expect(() => edit(ext, d, [{ image: 'seal.png', at: '(인)' }], { layout, images: new Map([[0, clean()]]) })).toThrow('wraps')
    })
  }
})

const RHWP = fs.existsSync(localHwpAssets().bin)
if (!RHWP) test('HWP Preview renderer not in this checkout: Hangul corpus skipped', () => { console.log(`skipped: no ${localHwpAssets().bin}`) })
else describe('Hangul: the drawn seal is on the mark', () => {
  const engine = new NativeHwpEngine()
  type Ext = 'hwp' | 'hwpx'
  const clean = () => sanitizeImage(SEAL, 'seal.png')
  const LONG = `${'이 신청서의 내용이 사실임을 확인하며 관련 규정에 따라 제출합니다. '.repeat(4)}신청인 김가나 (인)`
  const MARK_LINE = '신청인: 김가나테스트 (인)'
  /** the made-up signing form (fixtures/hwp/sign-form), its signer's line replaced, or a text of its table */
  const docOf = (ext: Ext, line: string, cell?: string): Uint8Array => {
    const form = new Uint8Array(fs.readFileSync(path.join(FIX, `sign-form.${ext}`)))
    const changes: HwpChange[] = [...(line === MARK_LINE ? [] : [{ find: MARK_LINE, replace: line }]), ...(cell ? [{ find: '멘토', replace: cell }] : [])]
    return changes.length ? edit(ext, form, changes).file : form
  }
  /** a form whose signer's line is on page 2 */
  const paged = (ext: Ext): Uint8Array => {
    const lines = [...Array.from({ length: 70 }, (_, i) => `본문 ${i + 1}`), '신청인: 김가나 (인)', '끝']
    if (ext === 'hwpx') return hwpxDoc([lines.map((l) => hwpxPara(l, { cache: false })).join('')])
    const form = new Uint8Array(fs.readFileSync(path.join(FIX, 'two-pages.hwp')))
    const last = hwpText(form).trim().split(/\n+/).filter((l) => l.trim()).at(-1)!.trim()
    return edit('hwp', form, [{ find: last, replace: '신청인: 김가나 (인)' }]).file
  }
  const edit = (ext: Ext, doc: Uint8Array, ch: HwpChange[], extra?: { layout: HwpLayout; images: Map<number, ReturnType<typeof clean>> }) => (ext === 'hwp' ? editHwp(doc, ch, extra) : editHwpx(doc, ch, extra))
  /** the real order of edit_hwp: text first, then the layout, the picture, and the layout of the result */
  const stamp = async (ext: Ext, doc: Uint8Array, at: string, more: { occurrence?: number; fill?: HwpChange } = {}) => {
    const base = more.fill ? edit(ext, doc, [more.fill]).file : doc
    const before = await engine.layout(Buffer.from(base), ext)
    const ch: HwpChange = { image: 'seal.png', at, ...(more.occurrence ? { occurrence: more.occurrence } : {}) }
    const r = edit(ext, base, [ch], { layout: before, images: new Map([[0, clean()]]) })
    const after = await engine.layout(Buffer.from(r.file), ext)
    return { before, after, note: r.report.pictures![0]! as HwpPictureNote }
  }
  /** the drawn picture's centre against the centre of `aim` inside the nth `mark` on the saved file's page, in mm */
  const off = (after: HwpLayout, before: HwpLayout, note: HwpPictureNote, mark: string, nth: number, aim = mark) => {
    const hit = layoutTextHits(after, mark)[nth]!
    expect(hit.page).toBe(note.page - 1)
    const pg = after.pages[hit.page]!, line = pg.lines[hit.line]!
    const [m0, m1] = labelX(line, hit.at, [...mark].length)
    const from = mark.indexOf(aim)
    const [x0, x1] = partX(m0, m1, mark, from, from + aim.length)
    const old = before.pages[hit.page]?.images ?? []
    const img = (pg.images ?? []).find((b) => !old.some((o) => Math.abs(o.x - b.x) < 0.5 && Math.abs(o.y - b.y) < 0.5))!
    return { x: Math.abs(img.x + img.w / 2 - (x0 + x1) / 2) * MM_PER_PX, y: Math.abs(img.y + img.h / 2 - (line.y + line.h / 2)) * MM_PER_PX }
  }
  type Stamped = Awaited<ReturnType<typeof stamp>>
  /** Numerically, on both axes. Always: the saved picture box against the mark in the layout it was placed from. With a
   * stored layout, also the picture as drawn from the saved file against the mark found again there. Without one, the
   * renderer's drawing of the saved file is not Hangul's, so that part is proved only in Hancom Docs, by hand. */
  const onMark = (r: Stamped, mark: string, nth: number, aim = mark) => {
    const hit = layoutTextHits(r.before, mark)[nth]!
    expect(hit.page).toBe(r.note.page - 1)
    const line = r.before.pages[hit.page]!.lines[hit.line]!
    const [m0, m1] = labelX(line, hit.at, [...mark].length)
    const from = mark.indexOf(aim)
    const [x0, x1] = partX(m0, m1, mark, from, from + aim.length)
    expect(Math.abs(r.note.xMm + r.note.widthMm / 2 - ((x0 + x1) / 2) * MM_PER_PX)).toBeLessThanOrEqual(SEAL_TOLERANCE_MM)
    expect(Math.abs(r.note.yMm + r.note.heightMm / 2 - (line.y + line.h / 2) * MM_PER_PX)).toBeLessThanOrEqual(SEAL_TOLERANCE_MM)
    if (r.note.aim?.exact) {
      const o = off(r.after, r.before, r.note, mark, nth, aim)
      expect(o.x).toBeLessThanOrEqual(SEAL_TOLERANCE_MM)
      expect(o.y).toBeLessThanOrEqual(SEAL_TOLERANCE_MM)
    }
  }
  for (const ext of ['hwp', 'hwpx'] as const) describe(`.${ext}`, () => {
    test('a whole line', async () => {
      const r = await stamp(ext, docOf(ext, MARK_LINE), '신청인: 김가나테스트 (인)')
      expect(r.note.where).toContain('"(인)", the sign mark in')
      onMark(r, '(인)', 0)
    })
    test('one signer of a shared line', async () => {
      const r = await stamp(ext, docOf(ext, '갑: 김철수 (인)   을: 홍길동 (인)'), '을: 홍길동 (인)')
      onMark(r, '(인)', 1)
    })
    test('a whole line with two marks: refused; occurrence picks one', async () => {
      const line = '갑: 김철수 (인)   을: 홍길동 (인)'
      const doc = docOf(ext, line)
      await expect(stamp(ext, doc, line)).rejects.toThrow('2 sign marks')
      const r = await stamp(ext, doc, line, { occurrence: 1 })
      onMark(r, '(인)', 0)
    })
    test('"(서명 또는 인)": on the seal word', async () => {
      const line = '신청인 김가나 (서명 또는 인)'
      const r = await stamp(ext, docOf(ext, line), line)
      expect(r.note.where).toContain('"인" of the mark')
      onMark(r, '(서명 또는 인)', 0, '인')
    })
    test('a long line that wraps', async () => {
      // no stored layout: Hangul wraps it by itself (in Hancom Docs the seal landed about 17 mm off), so it is refused
      await expect(stamp(ext, docOf(ext, LONG), LONG)).rejects.toThrow('wraps')
    })
    test('a mark in a table cell', async () => {
      const r = await stamp(ext, docOf(ext, '신청인: 김가나', '박다라 (인)'), '박다라 (인)')
      onMark(r, '(인)', layoutTextHits(r.before, '(인)').findIndex((h) => r.before.pages[h.page]!.lines[h.line]!.text.includes('박다라')))
    })
    test('after a fill', async () => {
      const r = await stamp(ext, docOf(ext, '신청인: {{이름}} (인)'), '신청인: 홍길동입니다 (인)', { fill: { find: '{{이름}}', replace: '홍길동입니다' } })
      onMark(r, '(인)', 0)
    })
    test('on a later page', async () => {
      const r = await stamp(ext, paged(ext), '신청인: 김가나 (인)')
      expect(r.note.page).toBeGreaterThan(1)
      onMark(r, '(인)', 0)
    })
    if (ext === 'hwpx') test('two tables, the first with a hyphen mark the renderer draws: the seal stays in the first', async () => {
      const row = [{ text: '성명', width: 8000 }, { text: '홍길동 (인)', width: 30000 }]
      const doc = hwpxDoc([hwpxPara('머리말', { cache: false }) + hwpxTable([row, [{ text: '사업자§번호', width: 8000 }, { text: '123', width: 30000 }]], { cache: false }).replace('§', '<hp:hyphen/>') + hwpxPara('중간', { cache: false }) + hwpxTable([row], { cache: false }) + hwpxPara('끝', { cache: false })])
      const r = await stamp('hwpx', doc, '홍길동 (인)', { occurrence: 1 })
      const ys = layoutTextHits(r.before, '홍길동 (인)').map((h) => r.before.pages[h.page]!.lines[h.line]!).map((l) => l.y + l.h / 2).sort((a, b) => a - b)
      expect(Math.abs(r.note.yMm + r.note.heightMm / 2 - ys[0]! * MM_PER_PX)).toBeLessThanOrEqual(SEAL_TOLERANCE_MM)
      expect(r.note.where).toStartWith('table 1,')
      const q = await stamp('hwpx', doc, '홍길동 (인)', { occurrence: 2 })
      expect(Math.abs(q.note.yMm + q.note.heightMm / 2 - ys[1]! * MM_PER_PX)).toBeLessThanOrEqual(SEAL_TOLERANCE_MM)
      expect(q.note.where).toStartWith('table 2,')
    })
    if (ext === 'hwpx') {
      const rows9 = Array.from({ length: 9 }, (_, n) => [{ text: n === 1 ? '갑' : n === 6 ? '을' : `행${n}`, width: 8000, height: 7000 }, { text: n === 1 ? '홍길동 (인)' : n === 6 ? '이몽룡 (인)' : '메모', width: 30000, height: 7000 }])
      const fill = (n: number) => Array.from({ length: n }, (_, i) => hwpxPara(`본문 ${i}`, { cache: false })).join('')
      const splits = hwpxTable(rows9, { cache: false, treatAsChar: false, pageBreak: 'CELL' }), whole = hwpxTable(rows9, { cache: false, treatAsChar: false, pageBreak: 'NONE' })
      const parts = (l: HwpLayout) => l.pages.reduce((n, p) => n + new Set(p.cells.map((c) => c.table)).size, 0)
      for (const [name, body] of [['the second split', fill(1) + whole + fill(15) + splits], ['the first split', fill(15) + splits + hwpxPara('중간', { cache: false }) + whole]] as const) {
        test(`two equal tables, ${name} over pages: refused for both signers and both tables`, async () => {
          const doc = hwpxDoc([body + hwpxPara('끝', { cache: false })])
          expect(parts(await engine.layout(Buffer.from(doc), 'hwpx'))).toBe(3)
          for (const at of ['홍길동 (인)', '이몽룡 (인)']) for (const occurrence of [1, 2]) await expect(stamp('hwpx', doc, at, { occurrence })).rejects.toThrow('its own line')
        })
      }
      test('one table split over pages with no twin: the seal goes on its mark on the right page', async () => {
        const rows = Array.from({ length: 14 }, (_, n) => [{ text: `행${n}`, width: 8000, height: 7000 }, { text: n === 11 ? '홍길동 (인)' : '메모', width: 30000, height: 7000 }])
        const doc = hwpxDoc([fill(1) + hwpxTable(rows, { cache: false, treatAsChar: false, pageBreak: 'CELL' }) + hwpxPara('끝', { cache: false })])
        const l = await engine.layout(Buffer.from(doc), 'hwpx')
        expect(parts(l)).toBeGreaterThan(1)
        const r = await stamp('hwpx', doc, '홍길동 (인)')
        const h = layoutTextHits(l, '홍길동 (인)')[0]!
        expect(r.note.page).toBe(h.page + 1)
        onMark(r, '(인)', 0)
      })
    }
    test('no mark: centred on the label as before', async () => {
      const r = await stamp(ext, docOf(ext, '확인자리 표시'), '확인자리')
      expect(r.note.where).toContain('over "확인자리"')
    })
    test('the landing check passes a right seal and reports one that moved', async () => {
      const r = await stamp(ext, docOf(ext, MARK_LINE), '신청인: 김가나테스트 (인)')
      const exact = { ...r.note, aim: { ...r.note.aim!, exact: true } }
      expect(landings(r.before, r.after, [exact], SEAL_TOLERANCE_MM)[0]!.state).toBe('checked')
      // the same mark is looked for again in the saved file: all text 30 mm lower is a miss, a mark that is gone is not a pass
      const shift = (d: number): HwpLayout => ({ pages: r.after.pages.map((pg) => ({ ...pg, lines: pg.lines.map((l) => ({ ...l, y: l.y + d })) })) })
      expect(landings(r.before, shift(30 / MM_PER_PX), [exact], SEAL_TOLERANCE_MM)[0]).toMatchObject({ state: 'missed' })
      const gone: HwpLayout = { pages: r.after.pages.map((pg) => ({ ...pg, lines: pg.lines.filter((l) => !l.text.includes('(인)')) })) }
      expect(landings(r.before, gone, [exact], SEAL_TOLERANCE_MM)[0]!.state).toBe('not-checked')
    })
  })
})
