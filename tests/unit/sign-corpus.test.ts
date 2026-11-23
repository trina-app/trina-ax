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
import { pickSignMark, placedOn, SEAL_TOLERANCE_MM, signMarks } from '../../server/src/files/sign-slots'
import { readZip, writeZip } from '../../server/src/files/zip-write'
import { hwpxDoc, para as hwpxPara } from '../lib/hwpx'

setDefaultTimeout(60_000)
const FIX = path.join(import.meta.dir, '../fixtures/hwp')
const SEAL = new Uint8Array(fs.readFileSync(path.join(FIX, 'seal.png')))
const MM_PER_PX = 25.4 / 96

describe('the sign marks in a text', () => {
  const on = (s: string) => signMarks(s).map((m) => s.slice(m.from, m.to))
  test('every printed form of a mark, with spacing and full-width brackets', () => {
    for (const m of ['(인)', '( 인 )', '(印)', '(서명)', '(서 명)', '(날인)', '(날 인)', '(서명 또는 인)', '(서명또는인)', '(서명 또는 날인)', '(Seal)', '(SEAL)', '(Signature)', '(L.S.)', '(L. S.)', '（인）']) expect(on(`이름 ${m} 끝`)).toEqual([m])
  })
  test('words in brackets that are not marks, and text with none', () => {
    for (const s of ['(인사팀)', '(주식회사)', '(LS)', '본인 확인', '신청인: 김가나']) expect(on(s)).toEqual([])
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

// ---------------------------------------------------------------- Hangul
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
  const near = (o: { x: number; y: number }, note: HwpPictureNote) => {
    expect(o.x).toBeLessThanOrEqual(SEAL_TOLERANCE_MM)
    // a document with no stored layout is placed from its paragraph, and this renderer draws that differently from Hangul
    if (!note.fromParagraph) expect(o.y).toBeLessThanOrEqual(SEAL_TOLERANCE_MM)
  }
  for (const ext of ['hwp', 'hwpx'] as const) describe(`.${ext}`, () => {
    test('a whole line', async () => {
      const r = await stamp(ext, docOf(ext, MARK_LINE), '신청인: 김가나테스트 (인)')
      expect(r.note.where).toContain('"(인)", the sign mark in')
      near(off(r.after, r.before, r.note, '(인)', 0), r.note)
    })
    test('one signer of a shared line', async () => {
      const r = await stamp(ext, docOf(ext, '갑: 김철수 (인)   을: 홍길동 (인)'), '을: 홍길동 (인)')
      near(off(r.after, r.before, r.note, '(인)', 1), r.note)
    })
    test('a whole line with two marks: refused; occurrence picks one', async () => {
      const line = '갑: 김철수 (인)   을: 홍길동 (인)'
      const doc = docOf(ext, line)
      await expect(stamp(ext, doc, line)).rejects.toThrow('2 sign marks')
      const r = await stamp(ext, doc, line, { occurrence: 1 })
      near(off(r.after, r.before, r.note, '(인)', 0), r.note)
    })
    test('"(서명 또는 인)": on the seal word', async () => {
      const line = '신청인 김가나 (서명 또는 인)'
      const r = await stamp(ext, docOf(ext, line), line)
      expect(r.note.where).toContain('"인" of the mark')
      near(off(r.after, r.before, r.note, '(서명 또는 인)', 0, '인'), r.note)
    })
    test('a long line that wraps', async () => {
      // no stored layout: Hangul wraps it by itself, so the renderer's line is not proof and the tool reports "not checked"
      const r = await stamp(ext, docOf(ext, LONG), LONG)
      expect(r.note.aim!.exact).toBe(false)
      expect(landings(r.before, r.after, [r.note], SEAL_TOLERANCE_MM)[0]!.state).toBe('not-checked')
      expect(landings(r.before, r.after, [{ ...r.note, aim: { ...r.note.aim!, exact: true } }], SEAL_TOLERANCE_MM)[0]!.state).toBe('checked')
    })
    test('a mark in a table cell', async () => {
      const r = await stamp(ext, docOf(ext, '신청인: 김가나', '박다라 (인)'), '박다라 (인)')
      expect(Math.abs(r.note.xMm + r.note.widthMm / 2 - (r.note.aim!.xMm))).toBeLessThanOrEqual(SEAL_TOLERANCE_MM)
    })
    test('after a fill', async () => {
      const r = await stamp(ext, docOf(ext, '신청인: {{이름}} (인)'), '신청인: 홍길동입니다 (인)', { fill: { find: '{{이름}}', replace: '홍길동입니다' } })
      near(off(r.after, r.before, r.note, '(인)', 0), r.note)
    })
    test('on a later page', async () => {
      const r = await stamp(ext, paged(ext), '신청인: 김가나 (인)')
      expect(r.note.page).toBeGreaterThan(1)
      near(off(r.after, r.before, r.note, '(인)', 0), r.note)
    })
    test('no mark: centred on the label as before', async () => {
      const r = await stamp(ext, docOf(ext, '확인자리 표시'), '확인자리')
      expect(r.note.where).toContain('over "확인자리"')
    })
    test('the landing check passes a right seal and reports one that moved', async () => {
      const r = await stamp(ext, docOf(ext, MARK_LINE), '신청인: 김가나테스트 (인)')
      const exact = { ...r.note, aim: { ...r.note.aim!, exact: true } }
      expect(landings(r.before, r.after, [exact], SEAL_TOLERANCE_MM)[0]!.state).toBe('checked')
      const moved = { ...exact, aim: { ...exact.aim, xMm: exact.aim.xMm + 10 } }
      expect(landings(r.before, r.after, [moved], SEAL_TOLERANCE_MM)[0]).toMatchObject({ state: 'missed' })
    })
  })
})
