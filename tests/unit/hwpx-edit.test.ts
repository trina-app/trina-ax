// edit_hwp's editor (server/src/files/hwpx-edit.ts): each change kind, the refusals, byte-for-byte preservation of
// what is not changed, untrusted documents, the read-back, and the office worker. Documents are made up here
// (tests/lib/hwpx.ts); Hangul-saved samples are read only when MYCEL_HWPX_SAMPLES names a folder of them.
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { officeWorkerWrite } from '../../server/src/files/extract'
import { hwpxText } from '../../server/src/files/hwp'
import {
  applyLineEdits, decodeHwpEditResult, encodeHwpEditRequest, HWPX_EDIT_MODE, HWPX_VERIFY_MODE, hwpEditMismatch, hwpOutputPath, hwpxPartsMismatch,
  hwpxReadLines, type HwpChange,
} from '../../server/src/files/hwpx-check'
import { editHwpx } from '../../server/src/files/hwpx-edit'
import { XML_DECL } from '../../server/src/files/hwpx-template'
import { readZip, writeZip } from '../../server/src/files/zip-write'
import { ToolError } from '../../server/src/policy/errors'
import { clickHere, employmentForm, enc, FORM, formHeaderXml, hwpxDoc, hwpxParts, para, picture, PICTURE_ITEM, PNG_1PX, purchaseForm, table } from '../lib/hwpx'

setDefaultTimeout(60_000)

const section = (b: Uint8Array, n = 0) => hwpxParts(b).get(`Contents/section${n}.xml`)!
const lines = (b: Uint8Array) => hwpxReadLines(hwpxText(b))
const refusal = (doc: Uint8Array, changes: HwpChange[]): string => {
  try { editHwpx(doc, changes) } catch (e) { expect(e).toBeInstanceOf(ToolError); return (e as Error).message }
  throw new Error('not refused')
}
/** the paragraph of a section that holds `text` (its whole <hp:p>, innermost) */
const paraWith = (xml: string, text: string) => {
  const at = xml.indexOf(text)
  const start = xml.lastIndexOf('<hp:p ', at)
  return xml.slice(start, xml.indexOf('</hp:p>', at) + 7)
}
/** a document whose one section has these paragraphs */
const doc1 = (body: string, o: Parameters<typeof hwpxDoc>[1] = {}) => hwpxDoc([body], o)

describe('find and replace', () => {
  test('a placeholder in a body paragraph: the text changes, its run and shapes stay, its layout cache goes', () => {
    const before = employmentForm()
    const r = editHwpx(before, [{ find: '{{대표자}}', replace: '김예시' }])
    const old = section(before), now = section(r.file)
    const p = paraWith(old, '{{대표자}}')
    const want = p.replace('{{대표자}}', '김예시').replace(/<hp:linesegarray>.*?<\/hp:linesegarray>/, '')
    // the only difference in the whole section: that text and that paragraph's cache
    expect(now).toBe(old.replace(p, want))
    expect(want).toContain(`<hp:run charPrIDRef="${FORM.bold}"><hp:t>주식회사 가나다상사</hp:t></hp:run><hp:run charPrIDRef="0"><hp:t>  대표이사 김예시 (인)</hp:t></hp:run>`)
    expect(lines(r.file)).toContain('| 주식회사 가나다상사 대표이사 김예시 (인)')
    expect(r.report.notes).toEqual([{ change: 0, where: 'a paragraph', before: '주식회사 가나다상사  대표이사 {{대표자}} (인)', after: '주식회사 가나다상사  대표이사 김예시 (인)' }])
    expect(r.report.placeholders).toEqual(['{{입사일}}', '{{발급일}}'])
  })

  test('text in a bold run keeps the bold shape; text inside a click-here field stays in the field', () => {
    const r = editHwpx(employmentForm(), [{ find: '{{발급일}}', replace: '2026년 11월 3일' }, { find: '가나다상사', replace: '라마바물산' }])
    const s = section(r.file)
    expect(s).toContain(`<hp:run charPrIDRef="${FORM.bold}"><hp:t>2026년 11월 3일</hp:t></hp:run>`)
    expect(s).toContain(`<hp:run charPrIDRef="${FORM.bold}"><hp:t>주식회사 라마바물산</hp:t></hp:run>`)
    const field = doc1(para([], { raw: clickHere('담당자 이름') }))
    const f = section(editHwpx(field, [{ find: '담당자 이름', replace: '박예시 (내선 1234)' }]).file)
    expect(f).toMatch(/<hp:fieldBegin [^>]*type="CLICK_HERE"[\s\S]*<hp:t>박예시 \(내선 1234\)<\/hp:t><\/hp:run><hp:run charPrIDRef="0"><hp:ctrl><hp:fieldEnd /)
  })

  test('text split over runs of the same shape is replaced in the first run; XML characters and line breaks are written as Hangul writes them', () => {
    const d = doc1(para([[0, '계약 금'], [0, '액: {{금액}}'], [FORM.bold, ' 끝']]))
    const r = editHwpx(d, [{ find: '금액: {{금액}}', replace: '금액: 1,000원 & <부가세 별도>\n(분할 지급)' }])
    const p = paraWith(section(r.file), '계약')
    expect(p).toContain('<hp:run charPrIDRef="0"><hp:t>계약 금액: 1,000원 &amp; &lt;부가세 별도&gt;<hp:lineBreak/>(분할 지급)</hp:t></hp:run><hp:run charPrIDRef="0"><hp:t></hp:t></hp:run>')
    expect(lines(r.file)).toEqual(['| 계약 금액: 1,000원 & <부가세 별도>', '| (분할 지급) 끝'])
  })

  test('occurrence picks one match in reading order, all replaces every one; more than one without either is refused', () => {
    const d = doc1(para('{{이름}} 귀하') + table([[{ text: '{{이름}}', width: 9000 }]]) + para('담당: {{이름}}'))
    const msg = refusal(d, [{ find: '{{이름}}', replace: '홍길동' }])
    expect(msg).toContain('appears 3 times')
    expect(msg).toContain('Give occurrence (1-3)')
    expect(lines(editHwpx(d, [{ find: '{{이름}}', replace: '홍길동', occurrence: 2 }]).file)).toEqual(['| {{이름}} 귀하', '| 홍길동', '| 담당: {{이름}}'])
    expect(lines(editHwpx(d, [{ find: '{{이름}}', replace: '홍길동', all: true }]).file)).toEqual(['| 홍길동 귀하', '| 홍길동', '| 담당: 홍길동'])
    expect(refusal(d, [{ find: '{{이름}}', replace: 'x', occurrence: 4 }])).toContain('no occurrence 4')
  })

  test('refused, with the reason: not found (with a spacing hint), across shapes, across a tab, a line break or a field, tracked changes, the same text twice', () => {
    const d = doc1(
      para([[0, '서명란 '], [FORM.bold, '(인)']]) +
      para([], { raw: '<hp:run charPrIDRef="0"><hp:t>성명<hp:tab width="4000" leader="0" type="1"/>홍길동</hp:t></hp:run>' }) +
      para([], { raw: '<hp:run charPrIDRef="0"><hp:t>첫 줄<hp:lineBreak/>둘째 줄</hp:t></hp:run>' }) +
      para([], { raw: '<hp:run charPrIDRef="0"><hp:t>앞 글</hp:t></hp:run>' + clickHere('안 글') }) +
      para([], { raw: '<hp:run charPrIDRef="0"><hp:t>고친 <hp:insertBegin Id="1" TcId="1" paraend="0"/>글</hp:t></hp:run>' }),
    )
    expect(refusal(d, [{ find: '없는 글', replace: 'x' }])).toBe('change 1: "없는 글" is not in the document. Nothing was saved.')
    expect(refusal(d, [{ find: '서명란(인)', replace: 'x' }])).toContain('It is there with other spacing or line breaks')
    expect(refusal(d, [{ find: '서명란 (인)', replace: 'x' }])).toContain('has more than one formatting (character shapes 0 and 11)')
    expect(refusal(d, [{ find: '성명\t홍길동', replace: 'x' }])).toContain('runs across a tab')
    expect(refusal(d, [{ find: '첫 줄\n둘째', replace: 'x' }])).toContain('runs across a line break')
    expect(refusal(d, [{ find: '앞 글안 글', replace: 'x' }])).toContain('runs across a field, bookmark or other control')
    expect(refusal(d, [{ find: '고친', replace: 'x' }])).toContain('has tracked changes')
    expect(refusal(d, [{ find: '첫 줄', replace: 'x' }, { find: '줄', replace: 'y', occurrence: 1 }])).toContain('changes the same text as change 1')
    expect(refusal(d, [{ find: '둘째', replace: '둘째' }])).toContain('find and replace are the same')
  })
})

describe('an empty table cell', () => {
  test('next to a label, right or below, or by table, row and column: the cell gets the text in its own shapes', () => {
    const r = editHwpx(employmentForm(), [
      { cell: { next_to: '성명' }, value: '홍길동' },
      { cell: { next_to: '주 소' }, value: '가상시 예시구 샘플로 12' },
      { cell: { table: 1, row: 3, col: 4 }, value: '선임' },
    ])
    expect(lines(r.file).slice(1, 12)).toEqual(['| 성명', '| 홍길동', '| 생년월일', '| 주소', '| 가상시 예시구 샘플로 12', '| 소속', '| 직위', '| 선임', '| 재직기간', '| {{입사일}} ~ 현재', '| 용도'])
    const cell = paraWith(section(r.file), '홍길동')
    expect(cell).toMatch(new RegExp(`^<hp:p id="\\d+" paraPrIDRef="${FORM.cellPara}" [^>]*><hp:run charPrIDRef="0"><hp:t>홍길동</hp:t></hp:run></hp:p>$`))
    const below = doc1(table([[{ text: '비고', width: 9000 }], [{ text: '', width: 9000 }]]))
    expect(lines(editHwpx(below, [{ cell: { next_to: '비고', direction: 'below' }, value: '없음' }]).file)).toEqual(['| 비고', '| 없음'])
  })

  test('a cell whose paragraph has an empty run, or white space only, reads as the value', () => {
    const run = (raw: string) => `<hp:p id="7" paraPrIDRef="${FORM.cellPara}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">${raw}</hp:p>`
    const d = doc1(table([[{ text: 'A', width: 5000 }, { raw: run('<hp:run charPrIDRef="0"/>'), width: 5000 }, { raw: run('<hp:run charPrIDRef="0"><hp:t>   </hp:t></hp:run><hp:run charPrIDRef="0"><hp:t> </hp:t></hp:run>'), width: 5000 }]]))
    const r = editHwpx(d, [{ cell: { table: 1, row: 1, col: 2 }, value: '둘' }, { cell: { table: 1, row: 1, col: 3 }, value: '셋' }])
    const s = section(r.file)
    expect(s).toContain('<hp:run charPrIDRef="0"><hp:t>둘</hp:t></hp:run>')
    expect(s).toContain('<hp:run charPrIDRef="0"><hp:t>셋</hp:t></hp:run><hp:run charPrIDRef="0"><hp:t></hp:t></hp:run>')
    expect(lines(r.file)).toEqual(['| A', '| 둘', '| 셋'])
  })

  test('refused: a cell with text, a label that is not there or is there twice, a cell that does not exist or is inside a merged one', () => {
    const d = employmentForm()
    expect(refusal(d, [{ cell: { next_to: '재직기간' }, value: 'x' }])).toContain('is not empty (it reads "{{입사일}} ~ 현재")')
    expect(refusal(d, [{ cell: { next_to: '전화번호' }, value: 'x' }])).toContain('no table cell reads "전화번호"')
    expect(refusal(d, [{ cell: { next_to: '생년' }, value: 'x' }])).toContain('next_to must be the cell\'s whole text')
    expect(refusal(d, [{ cell: { next_to: '생년월일' }, value: 'x' }, { cell: { table: 1, row: 1, col: 4 }, value: 'y' }])).toContain('changes the same text')
    expect(refusal(d, [{ cell: { table: 1, row: 2, col: 3 }, value: 'x' }])).toContain('part of a merged cell that starts at row 2 column 2')
    expect(refusal(d, [{ cell: { table: 2, row: 1, col: 1 }, value: 'x' }])).toContain('there is no table 2 (the document has 1)')
    expect(refusal(d, [{ cell: { next_to: '직위', direction: 'below' }, value: 'x' }])).toContain('there is no cell below "직위"')
    const two = doc1(table([[{ text: '성명', width: 5000 }, { text: '', width: 5000 }], [{ text: '성명', width: 5000 }, { text: '', width: 5000 }]]))
    expect(refusal(two, [{ cell: { next_to: '성명' }, value: 'x' }])).toContain('2 cells read "성명"')
    expect(lines(editHwpx(two, [{ cell: { next_to: '성명', occurrence: 2 }, value: '보증인' }]).file)).toEqual(['| 성명', '| 성명', '| 보증인'])
  })
})

describe('rows added to a table', () => {
  test('copies of a row with new text go after it; the rows below, the row count, the height and the cell zones follow', () => {
    const before = purchaseForm()
    const r = editHwpx(before, [{ add_rows: { table_with: '품명', after_row: 3, rows: [['A4 파일', '20공', '5', '3,000', '15,000'], ['볼펜', '검정 0.5', '24', '500']] } }])
    expect(lines(r.file).slice(2)).toEqual(['| 품명', '| 규격', '| 수량', '| 단가', '| 금액', '| 복사용지', '| A4 80g', '| 10', '| 25,000', '| 250,000',
      '| 토너', '| 검정', '| 2', '| 89,000', '| 178,000', '| A4 파일', '| 20공', '| 5', '| 3,000', '| 15,000', '| 볼펜', '| 검정 0.5', '| 24', '| 500',
      '| 합계', '| 428,000', '| 위와 같이 구매를 요청합니다.'])
    const s = section(r.file)
    expect(s).toContain('rowCnt="6" colCnt="5"')
    expect(s).toContain('height="14400" heightRelTo="ABSOLUTE"')
    expect(s).toContain('<hp:cellzone startRowAddr="0" startColAddr="0" endRowAddr="0" endColAddr="4" borderFillIDRef="4"/><hp:cellzone startRowAddr="5" startColAddr="0" endRowAddr="5" endColAddr="4" borderFillIDRef="3"/>')
    const rows = s.split('<hp:tr>').slice(1).map((tr) => [...tr.matchAll(/rowAddr="(\d+)"/g)].map((m) => Number(m[1])))
    expect(rows).toEqual([[0, 0, 0, 0, 0], [1, 1, 1, 1, 1], [2, 2, 2, 2, 2], [3, 3, 3, 3, 3], [4, 4, 4, 4, 4], [5, 5]])
    // a new cell: the copied cell's borders, sizes and shapes, a paragraph id no other paragraph has, no layout cache;
    // a value left out leaves an empty run
    const cell = s.slice(s.lastIndexOf('<hp:tc', s.indexOf('A4 파일')), s.indexOf('</hp:tc>', s.indexOf('A4 파일')) + 8)
    expect(cell).toMatch(/^<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="3"><hp:subList [^>]*><hp:p id="\d+" paraPrIDRef="15" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>A4 파일<\/hp:t><\/hp:run><\/hp:p><\/hp:subList><hp:cellAddr colAddr="0" rowAddr="3"\/><hp:cellSpan colSpan="1" rowSpan="1"\/><hp:cellSz width="12000" height="2400"\/><hp:cellMargin [^>]*\/><\/hp:tc>$/)
    expect(s).toContain('<hp:run charPrIDRef="0"><hp:t/></hp:run></hp:p></hp:subList><hp:cellAddr colAddr="4" rowAddr="4"/>')
    const ids = [...s.matchAll(/<hp:p id="(\d+)"/g)].map((m) => m[1])
    expect(new Set(ids).size).toBe(ids.length)
    // the paragraph that holds the table lost its cache; the others kept theirs
    expect(s).toContain('</hp:tbl><hp:t/></hp:run></hp:p>')
    expect(section(before)).toContain('</hp:tbl><hp:t/></hp:run><hp:linesegarray>')
    expect(paraWith(s, '복사용지')).toContain('linesegarray')
    expect(paraWith(s, '위와 같이')).toContain('linesegarray')
    expect(r.report.notes[0]!.where).toBe('table 1, after row 3')
  })

  test('by default after the last row, copying it; a table by its number', () => {
    const d = doc1(table([[{ text: '번호', width: 4000 }, { text: '내용', width: 9000 }], [{ text: '1', width: 4000 }, { text: '첫 안건', width: 9000 }]]))
    const r = editHwpx(d, [{ add_rows: { table: 1, rows: [['2', '둘째 안건'], ['3', '셋째 안건']] } }])
    expect(lines(r.file)).toEqual(['| 번호', '| 내용', '| 1', '| 첫 안건', '| 2', '| 둘째 안건', '| 3', '| 셋째 안건'])
    expect(section(r.file)).toContain('rowCnt="4"')
  })

  test('refused: a merged cell across the place, a row that cannot be copied, too many values, rows twice, no such table', () => {
    const p = purchaseForm()
    const spans = doc1(table([[{ text: '구분', width: 4000, rowSpan: 2 }, { text: 'a', width: 4000 }], [{ text: 'b', width: 4000 }], [{ text: 'c', width: 4000 }, { text: 'd', width: 4000 }]]))
    expect(refusal(spans, [{ add_rows: { table: 1, copy_row: 2, rows: [['x']] } }])).toContain('row 2 of table 1 does not have all of its 2 columns')
    expect(refusal(spans, [{ add_rows: { table: 1, after_row: 1, copy_row: 3, rows: [['x', 'y']] } }])).toContain('a merged cell of table 1 (row 1, column 1) reaches across the place after row 1')
    expect(refusal(spans, [{ add_rows: { table: 1, copy_row: 1, rows: [['x', 'y']] } }])).toContain('has a cell merged with the row below')
    expect(refusal(p, [{ add_rows: { table: 1, after_row: 2, rows: [['1', '2', '3', '4', '5', '6']] } }])).toContain('new row 1 has 6 values, but row 2 of table 1 has 5 cells')
    expect(refusal(p, [{ add_rows: { table: 1, rows: [['a']] } }, { add_rows: { table_with: '품명', rows: [['b']] } }])).toContain('rows are added to table 1 twice')
    expect(refusal(p, [{ add_rows: { table_with: '없는 열', rows: [['a']] } }])).toContain('no table has a cell that reads "없는 열"')
    expect(refusal(p, [{ add_rows: { table: 1, after_row: 9, rows: [['a']] } }])).toContain('has rows 1-4, so after_row 9')
    const field = doc1(table([[{ text: '항목', width: 5000 }], [{ raw: para([], { raw: clickHere('입력') }), width: 5000 }]]))
    expect(refusal(field, [{ add_rows: { table: 1, rows: [['x']] } }])).toContain('row 2 of table 1 cannot be copied (holds hp:ctrl)')
  })
})

describe('everything not changed stays as it was', () => {
  test('every other part of the zip: the same bytes, compressed bytes, method, order and date', () => {
    const before = employmentForm()
    const r = editHwpx(before, [{ cell: { next_to: '성명' }, value: '홍길동' }])
    const a = readZip(before), b = readZip(r.file)
    expect(b.map((e) => e.name)).toEqual(a.map((e) => e.name))
    for (const [i, e] of a.entries()) {
      expect(b[i]!.raw.method).toBe(e.raw.method)
      expect([b[i]!.time, b[i]!.date]).toEqual([e.time, e.date])
      if (e.name === 'Contents/section0.xml') { expect(Buffer.from(b[i]!.data).equals(Buffer.from(e.data))).toBe(false); continue }
      expect(Buffer.from(b[i]!.raw.body).equals(Buffer.from(e.raw.body)), e.name).toBe(true)
      expect(b[i]!.raw.crc).toBe(e.raw.crc)
    }
    expect(Buffer.from(r.file.subarray(30, 38)).toString()).toBe('mimetype')
  })

  test('in the section: pictures, fields, unknown elements and every untouched paragraph with its layout cache, byte for byte', () => {
    const before = employmentForm()
    const r = editHwpx(before, [{ find: '{{발급일}}', replace: '2026년 11월 3일' }, { cell: { next_to: '용도' }, value: '금융기관 제출용' }])
    const old = section(before), now = section(r.file)
    for (const text of ['<hp:pic ', 'hp:futureThing', 'CLICK_HERE', '재 직 증 명 서', '위 사람은', '{{대표자}}', '문서번호']) expect(paraWith(now, text)).toBe(paraWith(old, text))
    expect([...now.matchAll(/<hp:linesegarray>/g)].length).toBe([...old.matchAll(/<hp:linesegarray>/g)].length - 2)
    expect(hwpxParts(r.file).get('BinData/image1.png')).toBe(hwpxParts(before).get('BinData/image1.png'))
  })

  test('a byte order mark and the XML declaration of a section stay', () => {
    const d = hwpxDoc([para('{{a}}')])
    const parts = readZip(d).map((e) => e.name === 'Contents/section0.xml' ? { ...e, raw: undefined, data: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(e.data)]) } : e)
    const r = editHwpx(writeZip(parts), [{ find: '{{a}}', replace: 'b' }])
    const s = readZip(r.file).find((e) => e.name === 'Contents/section0.xml')!.data
    expect([...s.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(Buffer.from(s.subarray(3, 3 + XML_DECL.length)).toString()).toBe(XML_DECL)
  })

  test('a second section is changed on its own; the first stays byte for byte', () => {
    const d = hwpxDoc([para('첫 구역'), para('둘째 구역 {{x}}')])
    const r = editHwpx(d, [{ find: '{{x}}', replace: '값' }])
    expect(section(r.file, 0)).toBe(section(d, 0))
    expect(lines(r.file)).toEqual(['| 첫 구역', '| 둘째 구역 값'])
  })
})

describe('an untrusted document', () => {
  const ok = () => hwpxDoc([para('본문 {{x}}')])
  const withPart = (name: string, data: Uint8Array | string) => hwpxDoc([para('본문 {{x}}')], { extra: { [name]: data } })
  const doc = (body: string, o: Parameters<typeof hwpxDoc>[1] = {}) => hwpxDoc([para('본문 {{x}}') + body], o)
  const change: HwpChange[] = [{ find: '{{x}}', replace: 'y' }]
  const cases: [string, () => Uint8Array, string][] = [
    ['scripts', () => withPart('Scripts/headerScripts', 'function OnDocument_Open() {}'), 'it contains scripts (Scripts/)'],
    ['an OLE object in BinData', () => withPart('BinData/BIN0001.ole', 'x'), 'embedded OLE object'],
    ['compound-file bytes anywhere', () => withPart('Custom/thing.bin', Uint8Array.from(Buffer.from('d0cf11e0a1b11ae1000000', 'hex'))), 'is an embedded compound file'],
    ['hp:ole in a section', () => doc('<hp:p id="9" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:ole binaryItemIDRef="x"/></hp:run></hp:p>'), 'contains an embedded OLE object'],
    ['a program by name', () => withPart('BinData/setup.exe', 'abc'), 'is a program or a script'],
    ['a program by its bytes', () => withPart('BinData/image9.png', Uint8Array.from(Buffer.from('4d5a900003000000', 'hex'))), 'is a program or a script'],
    ['a digital signature', () => withPart('META-INF/signatures.xml', XML_DECL + '<s/>'), 'digitally signed'],
    ['encryption', () => writeZip(readZip(ok()).map((e) => e.name === 'META-INF/manifest.xml' ? { name: e.name, data: enc(XML_DECL + '<odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><odf:file-entry><odf:encryption-data/></odf:file-entry></odf:manifest>') } : e)), 'encrypted'],
    ['a DTD', () => withPart('Custom/x.xml', '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>'), 'a DTD'],
    ['comments', () => doc('<!-- hidden -->'), 'comments'],
    ['a link to a local file', () => doc(para([], { raw: '<hp:run charPrIDRef="0"><hp:ctrl><hp:fieldBegin id="5" type="HYPERLINK" name="" editable="0" dirty="0" zorder="-1" fieldid="1"><hp:parameters cnt="1" name=""><hp:stringParam name="Command">file\\:///C\\:/Windows/System32/calc.exe;1;0;0;</hp:stringParam></hp:parameters></hp:fieldBegin></hp:ctrl></hp:run>' })), 'outside the document'],
    ['a link to a network share', () => doc(para([], { raw: '<hp:run charPrIDRef="0"><hp:ctrl><hp:fieldBegin id="5" type="HYPERLINK" name="" editable="0" dirty="0" zorder="-1" fieldid="1"><hp:parameters cnt="1" name=""><hp:stringParam name="Path">\\\\server\\share\\a.hwpx</hp:stringParam></hp:parameters></hp:fieldBegin></hp:ctrl></hp:run>' })), 'outside the document'],
    ['a path in an attribute', () => doc(para([], { raw: '<hp:run charPrIDRef="0"><hp:video fileIDRef="C:\\movies\\a.avi"/></hp:run>' })), 'outside the document'],
    ['a linked document', () => hwpxDoc([para('본문 {{x}}')], { head: formHeaderXml().replace('<hh:linkinfo path=""', '<hh:linkinfo path="..\\other.hwp"') }), 'linked to another document'],
    ['a picture linked from outside', () => hwpxDoc([para('본문 {{x}}')], { manifest: '<opf:item id="i" href="https://example.com/a.png" media-type="image/png" isEmbeded="0"/>' }), 'links a file outside the document'],
    ['a manifest path out of the package', () => hwpxDoc([para('본문 {{x}}')], { manifest: '<opf:item id="i" href="../../x.png" media-type="image/png" isEmbeded="1"/>' }), 'links a file outside the document'],
    ['a Hangul prefix bound to another namespace', () => doc('<hp:p xmlns:hp="urn:other" id="1"/>'), 'bound to another namespace'],
    ['no mimetype', () => writeZip(readZip(ok()).filter((e) => e.name !== 'mimetype')), 'not a Hangul document'],
    ['a part twice', () => { const e = readZip(ok()); return writeZip([...e, { ...e.find((x) => x.name === 'settings.xml')!, name: 'SETTINGS.xml' }]) }, 'is there twice'],
    ['a .hwp', () => fs.readFileSync(path.join(import.meta.dir, '../fixtures/hwp/agreement.hwp')), 'it is a .hwp file; open it in Hangul and save it as .hwpx first'],
    ['not a zip', () => enc('<hs:sec/>'), 'it is not a .hwpx file'],
    ['a zip that expands too far', () => withPart('BinData/big.bmp', new Uint8Array(11 * 1024 * 1024)), 'too large'],
    ['a malformed section', () => fs.readFileSync(path.join(import.meta.dir, '../fixtures/hwp/malformed-xml.hwpx')), 'not well-formed XML'],
  ]
  for (const [name, make, why] of cases) {
    test(`refused: ${name}`, () => {
      const msg = refusal(make(), change)
      expect(msg).toContain(why)
      expect(msg).toMatch(/nothing was saved|Nothing was saved/)
    })
  }

  test('kept: a web link, a picture, an unknown element and an unknown part pass through as they were', () => {
    const link = para([], { raw: '<hp:run charPrIDRef="0"><hp:ctrl><hp:fieldBegin id="5" type="HYPERLINK" name="" editable="0" dirty="0" zorder="-1" fieldid="1"><hp:parameters cnt="2" name=""><hp:stringParam name="Command">https\\://example.com/a;1;0;0;</hp:stringParam><hp:stringParam name="Path">mailto:help@example.com</hp:stringParam></hp:parameters></hp:fieldBegin></hp:ctrl></hp:run><hp:run charPrIDRef="0"><hp:t>누리집</hp:t></hp:run>' })
    const d = doc(link + '<hp:p id="8" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp10:newThing xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" a="1"><hp:t>안쪽 글</hp:t></hp10:newThing></hp:run></hp:p>',
      { extra: { 'Custom/extension.dat': Uint8Array.from([1, 2, 3, 4]) } })
    const r = editHwpx(d, change)
    expect(section(r.file)).toContain(link)
    expect(section(r.file)).toContain('<hp10:newThing xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" a="1"><hp:t>안쪽 글</hp:t></hp10:newThing>')
    expect([...readZip(r.file).find((e) => e.name === 'Custom/extension.dat')!.data]).toEqual([1, 2, 3, 4])
    // text inside an element we do not know is read, but not changed
    expect(refusal(d, [{ find: '안쪽 글', replace: 'x' }])).toContain('runs across text inside a field or object')
  })

  test('a document whose text the editor reads differently from hwp.ts is refused before any change', () => {
    // hwp.ts takes a ">" in an attribute for the end of the tag; the editor does not: the two would place text differently
    const d = doc(para([], { raw: '<hp:run charPrIDRef="0"><hp:t note="a>b">글</hp:t></hp:run>' }))
    expect(refusal(d, change)).toContain('its text could not be mapped exactly')
  })
})

describe('the read-back', () => {
  test('the server finds a file that does not read as the old one with the reported edits', () => {
    const before = employmentForm()
    const changes: HwpChange[] = [{ find: '{{대표자}}', replace: '김예시' }]
    const r = editHwpx(before, changes)
    const old = lines(before), got = lines(r.file)
    expect(hwpEditMismatch(changes, old, got, r.report)).toBeNull()
    // another paragraph changed as well
    expect(hwpEditMismatch(changes, old, got.map((l) => l.replace('위 사람은', '위 사람이')), r.report)).toContain('expected "| 위 사람은')
    // the report hides a change it made
    expect(hwpEditMismatch(changes, old, got, { ...r.report, lineEdits: [] })).toContain('expected')
    // the worker wrote other text and reported it as it is: the file reads as reported, but not as asked
    const wrong = { ...r.report, lineEdits: r.report.lineEdits.map((e) => ({ ...e, insert: e.insert.map((l) => l.replace('김예시', '이예시')) })) }
    expect(hwpEditMismatch(changes, old, got.map((l) => l.replace('김예시', '이예시')), wrong)).toBe('change 1: the paragraph does not read as its old text with the replacement')
    // the report places the change in another paragraph than the one that holds the text
    const moved = { ...r.report, lineEdits: [{ at: 0, remove: 1, insert: ['| 김예시'], changes: [0] }] }
    expect(hwpEditMismatch(changes, old, ['| 김예시', ...old.slice(1)], moved)).toBe('change 1: the paragraph does not read as its old text with the replacement')
    // the report removes and puts back every line, with another text changed on the way
    const all = { ...r.report, lineEdits: [{ at: 0, remove: old.length, insert: got.map((l) => l.replace('위 사람은', '위 사람이')), changes: [0] }] }
    expect(hwpEditMismatch(changes, old, got.map((l) => l.replace('위 사람은', '위 사람이')), all)).toBe('change 1: the paragraph does not read as its old text with the replacement')
    // an edit that names no change, and a change no edit shows
    expect(hwpEditMismatch(changes, old, got, { ...r.report, lineEdits: r.report.lineEdits.map((e) => ({ ...e, changes: [] })) })).toContain('does not name the changes')
    const two: HwpChange[] = [...changes, { find: '위 사람은', replace: '위 사람은' }]
    expect(hwpEditMismatch(two, old, got, r.report)).toBe('change 2: it does not show in the document')
  })

  test('a filled cell or added rows put in exactly their text and remove nothing', () => {
    const before = purchaseForm()
    const changes: HwpChange[] = [{ add_rows: { table: 1, after_row: 3, rows: [['볼펜', '검정', '1', '500', '500']] } }]
    const r = editHwpx(before, changes)
    const old = lines(before), got = lines(r.file)
    expect(hwpEditMismatch(changes, old, got, r.report)).toBeNull()
    const extra = { ...r.report, lineEdits: r.report.lineEdits.map((e) => ({ ...e, insert: [...e.insert, '| 덤'] })) }
    const gotExtra = applyLineEdits(old, extra.lineEdits)!
    expect(hwpEditMismatch(changes, old, gotExtra, extra)).toBe('change 1: its new text does not read back')
  })

  test('the zip directories: the same parts, each the same bytes but the changed sections', () => {
    const before = employmentForm()
    const r = editHwpx(before, [{ cell: { next_to: '성명' }, value: '홍길동' }])
    expect(hwpxPartsMismatch(before, r.file)).toBeNull()
    const parts = readZip(r.file)
    expect(hwpxPartsMismatch(before, writeZip([...parts, { name: 'BinData/BIN0002.ole', data: enc('x') }]))).toBe('the new file does not have the same parts as the old one')
    expect(hwpxPartsMismatch(before, writeZip(parts.map((e) => e.name === 'Contents/header.xml' ? { name: e.name, data: enc(Buffer.from(e.data).toString() + ' ') } : e)))).toBe('Contents/header.xml is not the same as before')
  })

  test('the output path: one rule for the tool and the confirmation card', () => {
    expect(hwpOutputPath('users/a/양식', 'a.hwpx')).toBe('users/a/양식.hwpx')
    expect(hwpOutputPath('users/a/양식.HWPX', 'a.hwpx')).toBe('users/a/양식.HWPX')
    expect(hwpOutputPath('skills/a.hwpx/', 'a.hwpx')).toBe('skills/a.hwpx')
    expect(hwpOutputPath('users/a/folder/', 'a.hwpx')).toBe('users/a/folder.hwpx')
    // a .hwp's result is a .hwp; an output in the other format is kept as given, and the tool refuses it
    expect(hwpOutputPath('users/a/양식', 'forms/a.HWP')).toBe('users/a/양식.hwp')
    expect(hwpOutputPath('users/a/양식.hwpx', 'forms/a.hwp')).toBe('users/a/양식.hwpx')
  })
})

describe('found in review', () => {
  test('an attribute name inside another attribute\'s value is never the one changed', () => {
    const d = doc1(table([[{ text: '항목', width: 5000 }], [{ text: '첫째', width: 5000 }]]).replace('<hp:cellAddr colAddr="0" rowAddr="1"/>', '<hp:cellAddr x=\' rowAddr="1"\' colAddr="0" rowAddr="1"/>')
      .replace('<hp:tbl id=', '<hp:tbl y=\' rowCnt="2"\' id='))
    const r = editHwpx(d, [{ add_rows: { table: 1, after_row: 1, copy_row: 1, rows: [['둘째']] } }])
    const s = section(r.file)
    expect(s).toContain('<hp:tbl y=\' rowCnt="2"\' id=')
    expect(s).toContain('rowCnt="3"')
    expect(s).toContain('<hp:cellAddr x=\' rowAddr="1"\' colAddr="0" rowAddr="2"/>')
    expect(lines(r.file)).toEqual(['| 항목', '| 둘째', '| 첫째'])
  })

  test('a click-here field in an empty cell gets the value inside it, whatever its runs', () => {
    const begin = '<hp:ctrl><hp:fieldBegin id="1801" type="CLICK_HERE" name="성명" editable="1" dirty="0" zorder="-1" fieldid="1"><hp:parameters cnt="1" name=""><hp:stringParam name="Direction">이름을 쓰세요</hp:stringParam></hp:parameters></hp:fieldBegin></hp:ctrl>'
    const end = '<hp:ctrl><hp:fieldEnd beginIDRef="1801" fieldid="1"/></hp:ctrl>'
    const cell = (raw: string) => ({ raw: `<hp:p id="7" paraPrIDRef="${FORM.cellPara}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">${raw}</hp:p>`, width: 5000 })
    const d = doc1(table([[{ text: '성명', width: 5000 }, cell(`<hp:run charPrIDRef="0">${begin}${end}</hp:run>`)],
      [{ text: '부서', width: 5000 }, cell(`<hp:run charPrIDRef="0"><hp:t/></hp:run><hp:run charPrIDRef="0">${begin}</hp:run><hp:run charPrIDRef="0">${end}</hp:run>`)]]))
    const s = section(editHwpx(d, [{ cell: { next_to: '성명' }, value: '홍길동' }, { cell: { next_to: '부서' }, value: '총무팀' }]).file)
    expect(s).toContain(`<hp:run charPrIDRef="0">${begin}<hp:t>홍길동</hp:t>${end}</hp:run>`)
    expect(s).toContain(`<hp:run charPrIDRef="0"><hp:t/></hp:run><hp:run charPrIDRef="0">${begin}<hp:t>총무팀</hp:t></hp:run><hp:run charPrIDRef="0">${end}</hp:run>`)
  })

  test('rows added to a table and to a table inside its last cell, in either order, read inner rows first (stage 3 review)', () => {
    const inner = table([[{ text: '내부1', width: 3000 }]], { id: 1500000009 })
    const d = doc1(table([[{ text: '머리', width: 4000 }, { text: '값', width: 4000 }], [{ text: '표안표', width: 4000 }, { raw: inner, width: 4000 }]]) + para('본문'))
    const outer: HwpChange = { add_rows: { table: 1, copy_row: 1, rows: [['새', '줄']] } }
    const nested: HwpChange = { add_rows: { table: 2, rows: [['내부2']] } }
    for (const changes of [[outer, nested], [nested, outer]]) {
      expect(lines(editHwpx(d, changes).file)).toEqual(['| 머리', '| 값', '| 표안표', '| 내부1', '| 내부2', '| 새', '| 줄', '| 본문'])
    }
  })

  test('a cell that holds a table or a picture is not an empty cell', () => {
    // the cell's paragraph holds a table of one empty cell: every paragraph in it is empty, yet it is not an empty cell
    const d = doc1(table([[{ text: '비고', width: 5000 }, { raw: table([[{ text: '', width: 3000 }]], { id: 1500000009 }), width: 8000 }]]))
    expect(refusal(d, [{ cell: { next_to: '비고' }, value: 'x' }])).toContain('holds a table or an object')
    const pic = doc1(table([[{ text: '서명', width: 5000 }, { raw: picture(), width: 8000 }]]), { extra: { 'BinData/image1.png': PNG_1PX }, manifest: PICTURE_ITEM })
    expect(refusal(pic, [{ cell: { next_to: '서명' }, value: 'x' }])).toContain('holds a picture')
  })

  test('a part that reads as XML is checked whatever its name; the manifest may only name parts that are there', () => {
    const d = hwpxDoc([para('본문 {{x}}')], { extra: { 'Contents/section1.dat': XML_DECL + '<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"><hp:ole/></hs:sec>' }, manifest: '<opf:item id="s1" href="Contents/section1.dat" media-type="application/xml"/>' })
    expect(refusal(d, [{ find: '{{x}}', replace: 'y' }])).toContain('Contents/section1.dat contains an embedded OLE object')
    const missing = hwpxDoc([para('본문 {{x}}')], { manifest: '<opf:item id="i" href="BinData/없음.png" media-type="image/png" isEmbeded="1"/>' })
    expect(refusal(missing, [{ find: '{{x}}', replace: 'y' }])).toContain('it names a part that is not in the file')
    // the preview text may start like XML: it is plain text
    expect(() => editHwpx(hwpxDoc([para('<공지> {{x}}')], { preview: '<공지> {{x}}' }), [{ find: '{{x}}', replace: 'y' }])).not.toThrow()
  })

  test('references out of the document anywhere in a value, links that are not web or mail addresses, markup in attributes', () => {
    const link = (command: string) => hwpxDoc([para('본문 {{x}}') + para([], { raw: `<hp:run charPrIDRef="0"><hp:ctrl><hp:fieldBegin id="5" type="HYPERLINK" name="" editable="0" dirty="0" zorder="-1" fieldid="1"><hp:parameters cnt="1" name=""><hp:stringParam name="Command">${command}</hp:stringParam></hp:parameters></hp:fieldBegin></hp:ctrl></hp:run>` })])
    expect(refusal(link('..\\..\\AppData\\evil.exe;1;0;0;'), [{ find: '{{x}}', replace: 'y' }])).toContain('not a web or mail address')
    expect(refusal(link('%TEMP%\\evil.exe;1;0;0;'), [{ find: '{{x}}', replace: 'y' }])).toContain('not a web or mail address')
    expect(refusal(link('\u200bfile\\:///C\\:/x.exe;1;0;0;'), [{ find: '{{x}}', replace: 'y' }])).toContain('outside the document')
    expect(() => editHwpx(link('https\\://example.com/a?b=c;1;0;0;'), [{ find: '{{x}}', replace: 'y' }])).not.toThrow()
    const video = hwpxDoc([para('본문 {{x}}') + para([], { raw: '<hp:run charPrIDRef="0"><hp:video videotype="Web" tag="&lt;iframe src=&quot;https://example.com/v&quot;&gt;&lt;/iframe&gt;"/></hp:run>' })])
    expect(refusal(video, [{ find: '{{x}}', replace: 'y' }])).toContain('holds markup in tag')
    const deep = hwpxDoc([para('본문 {{x}}') + para([], { raw: '<hp:run charPrIDRef="0"><hp:video tag="see file:///C:/a.hta"/></hp:run>' })])
    expect(refusal(deep, [{ find: '{{x}}', replace: 'y' }])).toContain('outside the document')
  })

  test('a long character reference keeps the offsets right', () => {
    const d = doc1(para([], { raw: `<hp:run charPrIDRef="0"><hp:t>앞&#${'0'.repeat(41)}65;뒤 {{x}}</hp:t></hp:run>` }))
    const r = editHwpx(d, [{ find: '{{x}}', replace: '값' }])
    expect(section(r.file)).toContain(`<hp:t>앞&#${'0'.repeat(41)}65;뒤 값</hp:t>`)
  })

  test('bytes after a part\'s compressed data are refused, not copied along', () => {
    const d = hwpxDoc([para('본문 {{x}}')])
    const parts = readZip(d).map((e) => e.name === 'settings.xml' ? { ...e, raw: { ...e.raw, body: Buffer.concat([Buffer.from(e.raw.body), Buffer.from('HIDDEN')]) } } : e)
    expect(refusal(writeZip(parts), [{ find: '{{x}}', replace: 'y' }])).toContain('has bytes after its compressed data')
  })
})

describe('through the office worker', () => {
  test('the worker changes the document and frames the report; a refusal comes back as the editor\'s message', async () => {
    const changes: HwpChange[] = [{ cell: { next_to: '성명' }, value: '홍길동' }]
    const form = employmentForm()
    const out = decodeHwpEditResult(await officeWorkerWrite(HWPX_EDIT_MODE, encodeHwpEditRequest(changes, form)))
    expect(Buffer.from(out.file).equals(Buffer.from(editHwpx(form, changes).file))).toBe(true)
    expect(out.report.notes[0]!.after).toBe('홍길동')
    await expect(officeWorkerWrite(HWPX_EDIT_MODE, encodeHwpEditRequest([{ find: '없음', replace: 'x' }], employmentForm()))).rejects.toThrow('"없음" is not in the document')
    await expect(officeWorkerWrite(HWPX_EDIT_MODE, new Uint8Array([0, 0, 0, 9, 1]))).rejects.toThrow('damaged request')
  })

  test('the checks again in a fresh worker: a changed file passes, one with scripts does not', async () => {
    const r = editHwpx(employmentForm(), [{ cell: { next_to: '성명' }, value: '홍길동' }])
    expect(Buffer.from(await officeWorkerWrite(HWPX_VERIFY_MODE, r.file)).toString()).toBe('ok')
    const scripts = hwpxDoc([para('본문')], { extra: { 'Scripts/headerScripts': 'x' } })
    await expect(officeWorkerWrite(HWPX_VERIFY_MODE, scripts)).rejects.toThrow('it contains scripts')
  })
})

// Hangul-saved samples (e.g. python-hwpx's examples, Apache-2.0): not in the repository; MYCEL_HWPX_SAMPLES=<folder>
const SAMPLES = process.env.MYCEL_HWPX_SAMPLES
describe.skipIf(!SAMPLES)('Hangul-saved documents (MYCEL_HWPX_SAMPLES)', () => {
  test('a word of each is replaced; the text model agrees with hwp.ts and every other part stays', () => {
    const files = fs.readdirSync(SAMPLES!).filter((f) => f.endsWith('.hwpx'))
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) {
      const b = new Uint8Array(fs.readFileSync(path.join(SAMPLES!, f)))
      const word = hwpxText(b).split(/\s+/).find((w) => w.length >= 2 && !/[{}]/.test(w))
      if (!word) continue
      const r = editHwpx(b, [{ find: word, replace: `${word}*`, occurrence: 1 }])
      const a = readZip(b), c = readZip(r.file)
      for (const [i, e] of a.entries()) if (!/section\d+\.xml$/.test(e.name)) expect(Buffer.from(c[i]!.raw.body).equals(Buffer.from(e.raw.body)), `${f} ${e.name}`).toBe(true)
      expect(lines(r.file).join('\n'), f).toContain(`${word}*`)
    }
  })
})
if (!SAMPLES) test('Hangul-saved samples not given (MYCEL_HWPX_SAMPLES): skipped', () => { console.log('skipped: set MYCEL_HWPX_SAMPLES to a folder of Hangul-saved .hwpx files') })
