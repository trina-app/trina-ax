// edit_hwp's .hwp editor (server/src/files/hwp-edit.ts) and its compound-file layer (server/src/files/cfb.ts): each
// change kind, the records each one rewrites and nothing else, controls and character shapes next to an edit, the
// layout cache, compressed and uncompressed documents, the extended record size, the mini-stream boundary, every
// refusal, untrusted documents, the read-back and the office worker. Documents are made up here (tests/lib/hwp.ts);
// Hangul-saved samples are read only when MYCEL_HWP_SAMPLES names a folder of them.
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { cfbMismatch, readCfb, writeCfb } from '../../server/src/files/cfb'
import { officeWorkerWrite } from '../../server/src/files/extract'
import { hwpText } from '../../server/src/files/hwp'
import { editHwp, hwpEditModel, HWP_EDIT_LIMITS } from '../../server/src/files/hwp-edit'
import { NativeHwpEngine, localHwpAssets } from '../../server/src/files/hwp-engine'
import {
  decodeHwpEditResult, encodeHwpEditRequest, HWP_EDIT_MODE, HWP_VERIFY_MODE, hwpEditMismatch, hwpPartsMismatch, hwpxReadLines, type HwpChange,
} from '../../server/src/files/hwpx-check'
import { ToolError } from '../../server/src/policy/errors'
import {
  autoNumber, bookmark, br, CHAR, chid, defaultScript, fieldBegin, fieldEnd, hwpDoc, hwpEmploymentForm, hwpPurchaseForm, hwpStreams, hyphen, linkDoc,
  nbsp, para, paragraphs, rec, sectionDef, sectionRecords, SHAPE, tab, table, TAG, textOf, type Rec,
} from '../lib/hwp'

setDefaultTimeout(60_000)

const lines = (b: Uint8Array) => hwpxReadLines(hwpText(b))
const refusal = (doc: Uint8Array, changes: HwpChange[]): string => {
  try { editHwp(doc, changes) } catch (e) { expect(e).toBeInstanceOf(ToolError); return (e as Error).message }
  throw new Error('not refused')
}
/** a document of one section: the section definition, then these paragraphs */
const doc1 = (...paras: Buffer[]) => hwpDoc([Buffer.concat([para([[0, sectionDef()]]), ...paras])])
const key = (r: Rec) => `${r.tag}/${r.level}/${r.ext ? 'x' : ''}${r.data.toString('hex')}`
/** the records only one of two sections has (a multiset difference, in order) */
function recordDiff(a: Rec[], b: Rec[]) {
  const count = (l: Rec[]) => { const m = new Map<string, number>(); for (const r of l) m.set(key(r), (m.get(key(r)) ?? 0) + 1); return m }
  const ca = count(a), cb = count(b)
  const only = (l: Rec[], mine: Map<string, number>, other: Map<string, number>) => l.filter((r) => { const k = key(r); const left = (mine.get(k) ?? 0) - (other.get(k) ?? 0); if (left > 0) { mine.set(k, mine.get(k)! - 1); return true } return false })
  return { removed: only(a, new Map(ca), cb), added: only(b, new Map(cb), ca) }
}
const paraWith = (b: Uint8Array, text: string, n = 0) => paragraphs(b, n).find((p) => p.text?.includes(text))!

describe('find and replace', () => {
  test('a placeholder in a body paragraph: only its header, text and layout cache change; its character shapes stay', () => {
    const before = hwpEmploymentForm()
    const r = editHwp(before, [{ find: '{{대표자}}', replace: '김예시' }])
    const p = paraWith(r.file, '김예시')
    expect(p.text).toBe('주식회사 가나다상사  대표이사 김예시 (인)<13>')
    expect(p.shapes).toEqual([[0, CHAR.bold], [10, 0]])
    expect(p.header).toMatchObject({ chars: 25, lines: 0, shapes: 2, mask: 0, last: false })
    expect(p.lines).toBe(0)
    const d = recordDiff(sectionRecords(before), sectionRecords(r.file))
    expect(d.removed.map((x) => x.tag).sort()).toEqual([TAG.PARA_HEADER, TAG.PARA_TEXT, TAG.PARA_LINE_SEG])
    expect(d.added.map((x) => x.tag).sort()).toEqual([TAG.PARA_HEADER, TAG.PARA_TEXT])
    expect(lines(r.file)).toContain('| 주식회사 가나다상사 대표이사 김예시 (인)')
    expect(r.report.notes).toEqual([{ change: 0, where: 'a paragraph', before: '주식회사 가나다상사  대표이사 {{대표자}} (인)', after: '주식회사 가나다상사  대표이사 김예시 (인)' }])
    expect(r.report.placeholders).toEqual(['{{입사일}}', '{{발급일}}'])
  })

  test('text in one run of a paragraph with several shapes takes that run\'s shape; the runs after it move', () => {
    const r = editHwp(hwpEmploymentForm(), [{ find: '{{발급일}}', replace: '2026년 11월 3일' }, { find: '가나다상사', replace: '라마바물산 서울지점' }])
    expect(paraWith(r.file, '발급일').text).toBe('발급일: 2026년 11월 3일<13>')
    expect(paraWith(r.file, '발급일').shapes).toEqual([[0, 0], [5, CHAR.bold]])
    const q = paraWith(r.file, '라마바물산')
    expect(q.text).toBe('주식회사 라마바물산 서울지점  대표이사 {{대표자}} (인)<13>')
    expect(q.shapes).toEqual([[0, CHAR.bold], [15, 0]])
    // a run emptied by the change goes, and two neighbours of one shape become one run
    const d = doc1(para([[0, '가나'], [CHAR.bold, '다라'], [0, '마바']]))
    const e = editHwp(d, [{ find: '다라', replace: '' }])
    expect(paraWith(e.file, '가나').shapes).toEqual([[0, 0]])
    expect(paraWith(e.file, '가나').header.shapes).toBe(1)
    const f = editHwp(d, [{ find: '가나', replace: '' }])
    expect(paraWith(f.file, '다라').shapes).toEqual([[0, CHAR.bold], [2, 0]])
  })

  test('controls next to the text stay as they were: inside a click-here field, before an automatic number', () => {
    const d = doc1(para([[0, ['앞 ', fieldBegin(), '누름틀 안 글', fieldEnd(), ' 뒤', autoNumber(), ' 끝']]]))
    const before = paraWith(d, '앞')
    const r = editHwp(d, [{ find: '누름틀 안 글', replace: '박예시 (내선 1234)' }, { find: ' 뒤', replace: ' 뒤쪽' }])
    const p = paraWith(r.file, '앞')
    expect(p.text).toBe('앞 <3>박예시 (내선 1234)<4> 뒤쪽<18> 끝<13>')
    expect(p.header.mask).toBe(before.header.mask)
    // the controls' own WCHARs (code, id, data, code) are the same bytes
    const ctrls = (b: Uint8Array) => { const t = sectionRecords(b).find((x) => x.tag === TAG.PARA_TEXT && textOf(x).startsWith('앞'))!; const out: string[] = []; for (let k = 0; k < t.data.length; k += 2) { const c = t.data.readUInt16LE(k); if (c < 32 && c !== 13) { out.push(t.data.subarray(k, k + 16).toString('hex')); k += 14 } } return out }
    expect(ctrls(r.file)).toEqual(ctrls(d))
    expect(lines(r.file)).toEqual(['| 앞 박예시 (내선 1234) 뒤쪽 끝'])
  })

  test('refused, with the reason: across a field, a control, a tab, a line break, a space mark or two shapes; range tags; unknown records', () => {
    const d = doc1(
      para([[0, ['앞 ', fieldBegin(), '안 글', fieldEnd(), ' 뒤', autoNumber(), ' 끝']]]),
      para([[0, ['성명', tab(), '홍길동']]]),
      para([[0, ['첫 줄', br(), '둘째 줄']]]),
      para([[0, ['가', nbsp(), '나', hyphen(), '다']]]),
      para([[0, '서명란 '], [CHAR.bold, '(인)']]),
      para('형광펜 칠한 글', { ranges: [[0, 3, 0x01000001]] }),
      para('모르는 레코드가 딸린 문단', { extra: [rec(120, 1, Buffer.from('x'))] }),
    )
    expect(refusal(d, [{ find: '앞 안', replace: 'x' }])).toBe('change 1: "앞 안" runs across a field, which a change cannot keep; change the text on each side of it separately. Nothing was saved.')
    expect(refusal(d, [{ find: '뒤 끝', replace: 'x' }])).toContain('runs across an automatic number')
    expect(refusal(d, [{ find: '성명\t홍길동', replace: 'x' }])).toContain('runs across a tab')
    expect(refusal(d, [{ find: '첫 줄\n둘째', replace: 'x' }])).toContain('runs across a line break')
    expect(refusal(d, [{ find: '가나', replace: 'x' }])).toContain('runs across a non-breaking space')
    expect(refusal(d, [{ find: '나다', replace: 'x' }])).toContain('runs across a hyphen mark')
    expect(refusal(d, [{ find: '서명란 (인)', replace: 'x' }])).toContain('has more than one formatting (character shapes 0 and 1)')
    expect(refusal(d, [{ find: '형광펜', replace: 'x' }])).toContain('has highlighting or tracked changes (range tags)')
    expect(refusal(d, [{ find: '모르는', replace: 'x' }])).toContain('cannot be changed here (it holds a record this editor does not know (tag 120))')
    expect(refusal(d, [{ find: '없는 글', replace: 'x' }])).toBe('change 1: "없는 글" is not in the document. Nothing was saved.')
    expect(refusal(d, [{ find: '첫 줄', replace: 'x' }, { find: '줄', replace: 'y', occurrence: 1 }])).toContain('changes the same text as change 1')
  })

  test('counts that do not agree in the paragraph a change touches: refused; the same paragraph elsewhere passes untouched', () => {
    // the header says 3 characters, the text has 4 (with its end)
    const bad = para('어긋난').toString('hex').replace(/^(.{8})04000000/, '$103000000')
    const d = doc1(Buffer.from(bad, 'hex'), para('{{x}} 다른 문단'))
    expect(refusal(d, [{ find: '어긋난', replace: 'x' }])).toContain('cannot be changed here (its character count does not match its text)')
    const r = editHwp(d, [{ find: '{{x}}', replace: '값' }])
    expect(sectionRecords(r.file).some((x) => x.data.toString('hex') === Buffer.from(bad, 'hex').subarray(4, 28).toString('hex'))).toBe(true)
  })

  test('a line break in the new text: Hangul\'s line break character, the control mask says so, two lines read back', () => {
    const r = editHwp(doc1(para('주소: {{주소}}')), [{ find: '{{주소}}', replace: '가상시 예시구\n샘플로 12' }])
    const p = paraWith(r.file, '주소')
    expect(p.text).toBe('주소: 가상시 예시구<10>샘플로 12<13>')
    expect(p.header.mask).toBe(1 << 10)
    expect(lines(r.file)).toEqual(['| 주소: 가상시 예시구', '| 샘플로 12'])
  })

  test('occurrence picks one match in reading order, all replaces every one; more than one without either is refused', () => {
    const d = doc1(para('{{이름}} 귀하'), table([[{ text: '{{이름}}', width: 9000 }]]), para('담당: {{이름}}'))
    expect(refusal(d, [{ find: '{{이름}}', replace: '홍길동' }])).toContain('appears 3 times')
    expect(lines(editHwp(d, [{ find: '{{이름}}', replace: '홍길동', occurrence: 2 }]).file)).toEqual(['| {{이름}} 귀하', '| 홍길동', '| 담당: {{이름}}'])
    expect(lines(editHwp(d, [{ find: '{{이름}}', replace: '홍길동', all: true }]).file)).toEqual(['| 홍길동 귀하', '| 홍길동', '| 담당: 홍길동'])
  })

  test('a heading paragraph stays a heading (its paragraph shape is the outline level)', () => {
    const r = editHwp(doc1(para('1. 개요 {{제목}}', { paraShape: SHAPE.h1 }), para('본문')), [{ find: '{{제목}}', replace: '사업 계획' }])
    expect(lines(r.file)).toEqual(['# 1. 개요 사업 계획', '| 본문'])
    expect(paraWith(r.file, '개요').header.paraShape).toBe(SHAPE.h1)
  })
})

describe('an empty table cell', () => {
  test('next to a label: an empty paragraph (no PARA_TEXT) gets one with the value, in the cell\'s shape', () => {
    const before = hwpEmploymentForm()
    const r = editHwp(before, [
      { cell: { next_to: '성명' }, value: '홍길동' },
      { cell: { next_to: '주 소' }, value: '가상시 예시구 샘플로 12' },
      { cell: { table: 1, row: 3, col: 4 }, value: '선임' },
    ])
    expect(lines(r.file).slice(1, 12)).toEqual(['| 성명', '| 홍길동', '| 생년월일', '| 주소', '| 가상시 예시구 샘플로 12', '| 소속', '| 직위', '| 선임', '| 재직기간', '| {{입사일}} ~ 현재', '| 용도'])
    const p = paraWith(r.file, '홍길동')
    expect(p).toMatchObject({ level: 2, text: '홍길동<13>', shapes: [[0, 0]], lines: 0 })
    expect(p.header).toMatchObject({ chars: 4, last: true, paraShape: SHAPE.cell, lines: 0 })
    const recs = sectionRecords(r.file)
    const at = recs.findIndex((x) => x.tag === TAG.PARA_TEXT && textOf(x) === '홍길동<13>')
    expect([recs[at - 1]!.tag, recs[at]!.level, recs[at + 1]!.tag]).toEqual([TAG.PARA_HEADER, 3, TAG.PARA_CHAR_SHAPE])
    const below = doc1(table([[{ text: '비고', width: 9000 }], [{ text: '', width: 9000 }]]))
    expect(lines(editHwp(below, [{ cell: { next_to: '비고', direction: 'below' }, value: '없음' }]).file)).toEqual(['| 비고', '| 없음'])
  })

  test('white space in the cell goes; a click-here field in it gets the value inside, after its start', () => {
    const cell = (content: (string | ReturnType<typeof tab>)[]) => ({ paras: para([[0, content]], { level: 2, paraShape: SHAPE.cell, last: true }), width: 5000 })
    const d = doc1(table([[{ text: 'A', width: 5000 }, cell(['   ']), cell([fieldBegin('%clk', 'Clickhere:set:0:', 3), fieldEnd()]), cell([' ', fieldBegin('%clk', 'Clickhere:set:0:', 3), '  ', fieldEnd(), ' '])]]))
    const r = editHwp(d, [{ cell: { table: 1, row: 1, col: 2 }, value: '둘' }, { cell: { table: 1, row: 1, col: 3 }, value: '셋' }, { cell: { table: 1, row: 1, col: 4 }, value: '넷' }])
    const texts = paragraphs(r.file).filter((p) => p.level === 2).map((p) => p.text)
    expect(texts).toEqual(['A<13>', '둘<13>', '<3>셋<4><13>', '<3>넷<4><13>'])
    expect(lines(r.file)).toEqual(['| A', '| 둘', '| 셋', '| 넷'])
  })

  test('refused: a cell with text, an unknown label, a merged cell, a cell with an object or a control, the same cell twice', () => {
    const d = hwpEmploymentForm()
    expect(refusal(d, [{ cell: { next_to: '재직기간' }, value: 'x' }])).toContain('is not empty (it reads "{{입사일}} ~ 현재")')
    expect(refusal(d, [{ cell: { next_to: '전화번호' }, value: 'x' }])).toContain('no table cell reads "전화번호"')
    expect(refusal(d, [{ cell: { table: 1, row: 2, col: 3 }, value: 'x' }])).toContain('part of a merged cell that starts at row 2 column 2')
    expect(refusal(d, [{ cell: { next_to: '생년월일' }, value: 'x' }, { cell: { table: 1, row: 1, col: 4 }, value: 'y' }])).toContain('changes the same text')
    const nested = doc1(table([[{ text: '비고', width: 5000 }, { paras: table([[{ text: '', width: 3000 }]], { level: 2 }), width: 8000 }]]))
    expect(refusal(nested, [{ cell: { next_to: '비고' }, value: 'x' }])).toContain('holds a table or an object')
    const numbered = doc1(table([[{ text: '번호', width: 5000 }, { paras: para([[0, [autoNumber()]]], { level: 2, last: true }), width: 5000 }]]))
    expect(refusal(numbered, [{ cell: { next_to: '번호' }, value: 'x' }])).toContain('holds an automatic number, so it is not an empty cell to fill')
  })
})

describe('rows added to a table', () => {
  test('copies of a row with new text go after it; TABLE, the rows below, the cell zones, the height and the holder\'s cache follow', () => {
    const before = hwpPurchaseForm()
    const r = editHwp(before, [{ add_rows: { table_with: '품명', after_row: 3, rows: [['A4 파일', '20공', '5', '3,000', '15,000'], ['볼펜', '검정 0.5', '24', '500']] } }])
    expect(lines(r.file).slice(2)).toEqual(['| 품명', '| 규격', '| 수량', '| 단가', '| 금액', '| 복사용지', '| A4 80g', '| 10', '| 25,000', '| 250,000',
      '| 토너', '| 검정', '| 2', '| 89,000', '| 178,000', '| A4 파일', '| 20공', '| 5', '| 3,000', '| 15,000', '| 볼펜', '| 검정 0.5', '| 24', '| 500',
      '| 합계', '| 428,000', '| 위와 같이 구매를 요청합니다.'])
    const m = hwpEditModel(r.file).tables[0]!
    expect(m.rowSizes).toEqual([5, 5, 5, 5, 5, 2])
    expect(m.cells.map((c) => c.row)).toEqual([0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 5, 5])
    expect(m.height).toBe(6000 + 2 * 1500)
    const recs = sectionRecords(r.file)
    const tb = recs.find((x) => x.tag === TAG.TABLE)!
    expect(tb.data.readUInt16LE(4)).toBe(6)
    const z = 18 + 2 * 6
    expect([tb.data.readUInt16LE(z), tb.data.readUInt16LE(z + 2)]).toEqual([3, 2])
    expect([0, 1].map((k) => [0, 2, 4, 6, 8].map((f) => tb.data.readUInt16LE(z + 4 + 10 * k + f)))).toEqual([[0, 0, 4, 0, 4], [0, 5, 4, 5, 3]])
    // a new cell: the copied cell's LIST_HEADER with one paragraph and its row; a header with the counts; its text and first shape
    const old = sectionRecords(before)
    const copied = old.filter((x) => x.tag === TAG.LIST_HEADER)[10]!
    const lhs = recs.filter((x) => x.tag === TAG.LIST_HEADER)
    expect(lhs[15]!.data.subarray(12).equals(copied.data.subarray(12))).toBe(true)
    expect([lhs[15]!.data.readUInt16LE(0), lhs[15]!.data.readUInt16LE(8), lhs[15]!.data.readUInt16LE(10)]).toEqual([1, 0, 3])
    const cellParas = paragraphs(r.file).filter((p) => p.level === 2)
    expect(cellParas[15]).toMatchObject({ text: 'A4 파일<13>', shapes: [[0, 0]], lines: 0, header: { chars: 6, last: true, shapes: 1, lines: 0, paraShape: SHAPE.cell } })
    expect(cellParas[24]).toMatchObject({ text: null, header: { chars: 1, last: true } })
    expect(paragraphs(r.file).find((p) => p.text === '<11><13>')!.lines).toBe(0)
    expect(paragraphs(before).find((p) => p.text === '<11><13>')!.lines).toBe(1)
    // the other paragraphs keep their layout caches
    expect(paraWith(r.file, '복사용지').lines).toBe(1)
    expect(paraWith(r.file, '위와 같이').lines).toBe(1)
    expect(r.report.notes[0]!.where).toBe('table 1, after row 3')
  })

  test('by default after the last row, copying it; a table by its number; a bold copied cell keeps its shape', () => {
    const d = doc1(table([[{ text: '번호', width: 4000 }, { text: '내용', width: 9000 }], [{ text: [[CHAR.bold, '1']], width: 4000 }, { text: '첫 안건', width: 9000 }]]))
    const r = editHwp(d, [{ add_rows: { table: 1, rows: [['2', '둘째 안건'], ['3', '셋째 안건']] } }])
    expect(lines(r.file)).toEqual(['| 번호', '| 내용', '| 1', '| 첫 안건', '| 2', '| 둘째 안건', '| 3', '| 셋째 안건'])
    expect(paragraphs(r.file).filter((p) => p.text === '2<13>' || p.text === '3<13>').map((p) => p.shapes)).toEqual([[[0, CHAR.bold]], [[0, CHAR.bold]]])
  })

  test('refused: a merged cell across the place, a row that cannot be copied, too many values, a table record of an unknown shape', () => {
    const spans = doc1(table([[{ text: '구분', width: 4000, rowSpan: 2 }, { text: 'a', width: 4000 }], [{ text: 'b', width: 4000 }], [{ text: 'c', width: 4000 }, { text: 'd', width: 4000 }]]))
    expect(refusal(spans, [{ add_rows: { table: 1, copy_row: 2, rows: [['x']] } }])).toContain('row 2 of table 1 does not have all of its 2 columns')
    expect(refusal(spans, [{ add_rows: { table: 1, after_row: 1, copy_row: 3, rows: [['x', 'y']] } }])).toContain('a merged cell of table 1 (row 1, column 1) reaches across the place after row 1')
    expect(refusal(spans, [{ add_rows: { table: 1, copy_row: 1, rows: [['x', 'y']] } }])).toContain('has a cell merged with the row below')
    expect(refusal(hwpPurchaseForm(), [{ add_rows: { table: 1, after_row: 2, rows: [['1', '2', '3', '4', '5', '6']] } }])).toContain('new row 1 has 6 values, but row 2 of table 1 has 5 cells')
    const field = doc1(table([[{ text: '항목', width: 5000 }], [{ paras: para([[0, [fieldBegin('%clk', 'Clickhere:set:0:', 3), '입력', fieldEnd()]]], { level: 2, last: true }), width: 5000 }]]))
    expect(refusal(field, [{ add_rows: { table: 1, rows: [['x']] } }])).toBe('change 1: row 2 of table 1 cannot be copied (holds a field); copy a row with only text in its cells (copy_row). Nothing was saved.')
    // a TABLE record with more bytes after its zones than this editor knows
    const odd = doc1(table([[{ text: '가', width: 4000 }], [{ text: '나', width: 4000 }]], { tail: Buffer.from('0000', 'hex') }))
    expect(refusal(odd, [{ add_rows: { table: 1, rows: [['x']] } }])).toContain('the table record of table 1 is not one this editor knows')
  })
})

describe('everything not changed stays as it was', () => {
  test('every other stream and the compound file\'s directory: byte for byte (names, tree, CLSIDs, state bits, times)', () => {
    const before = hwpEmploymentForm()
    const r = editHwp(before, [{ cell: { next_to: '성명' }, value: '홍길동' }])
    const a = hwpStreams(before), b = hwpStreams(r.file)
    expect([...b.keys()]).toEqual([...a.keys()])
    for (const [k, v] of a) if (k !== 'BodyText/Section0') expect(b.get(k)!.equals(v), k).toBe(true)
    expect(b.get('BodyText/Section0')!.equals(a.get('BodyText/Section0')!)).toBe(false)
    expect(cfbMismatch(readCfb(before), readCfb(r.file), (p) => p === 'BodyText/Section0')).toBeNull()
    expect(hwpPartsMismatch(before, r.file)).toBeNull()
  })

  test('a second section is changed on its own; the first keeps its compressed bytes', () => {
    const d = hwpDoc([Buffer.concat([para([[0, sectionDef()]]), para('첫 구역')]), Buffer.concat([para([[0, sectionDef()]]), para('둘째 구역 {{x}}')])])
    const r = editHwp(d, [{ find: '{{x}}', replace: '값' }])
    expect(hwpStreams(r.file).get('BodyText/Section0')!.equals(hwpStreams(d).get('BodyText/Section0')!)).toBe(true)
    expect(lines(r.file)).toEqual(['| 첫 구역', '| 둘째 구역 값'])
  })

  test('compressed and uncompressed documents: the changed section is written the way the FileHeader says', () => {
    for (const flags of [0, 1]) {
      const d = hwpEmploymentForm({ flags })
      const r = editHwp(d, [{ find: '{{발급일}}', replace: '2026년 11월 3일' }])
      const s = hwpStreams(r.file).get('BodyText/Section0')!
      expect(hwpStreams(r.file).get('FileHeader')!.readUInt32LE(36)).toBe(flags)
      if (flags) expect(zlib.inflateRawSync(s).readUInt32LE(0) & 0x3ff).toBe(TAG.PARA_HEADER)
      else expect(s.readUInt32LE(0) & 0x3ff).toBe(TAG.PARA_HEADER)
      expect(lines(r.file)).toContain('| 발급일: 2026년 11월 3일')
      expect(hwpEditModel(r.file).compressed).toBe(flags === 1)
    }
  })

  test('the extended record size: a long paragraph is edited, a text grows past 4095 bytes and shrinks below it, an untouched one keeps its form', () => {
    const long = '가'.repeat(3000)
    const c = `{{c}}${'라'.repeat(20)}`
    const d = doc1(para(`${long}{{a}}`), para(`${'나'.repeat(2040)}{{b}}`), para(`${'다'.repeat(2030)}${c}`), para('작은 글', { extText: true }))
    expect(paragraphs(d).slice(1).map((p) => p.textExt)).toEqual([true, false, true, true])
    const r = editHwp(d, [{ find: '{{a}}', replace: '값' }, { find: '{{b}}', replace: '0123456789'.repeat(3) }, { find: c, replace: '' }])
    const ps = paragraphs(r.file)
    expect([ps[1]!.textExt, ps[2]!.textExt, ps[3]!.textExt, ps[4]!.textExt]).toEqual([true, true, false, true])
    expect(ps[2]!.header.chars).toBe(2040 + 30 + 1)
    expect(lines(r.file)).toEqual([`| ${long}값`, `| ${'나'.repeat(2040)}${'0123456789'.repeat(3)}`, `| ${'다'.repeat(2030)}`, '| 작은 글'])
  })

  test('the compound file\'s mini-stream line (4096 bytes): a section that grows past it and one that shrinks below it', () => {
    // uncompressed, so the section's size is its records'
    const sized = (target: number) => {
      for (let n = 1500; n < 2100; n++) {
        const d = hwpDoc([Buffer.concat([para([[0, sectionDef()]]), para(`${'가'.repeat(n)}{{x}}`, { last: true })])], { flags: 0 })
        const size = hwpStreams(d).get('BodyText/Section0')!.length
        if (size >= target - 40 && size <= target) return { d, size }
      }
      throw new Error('no size')
    }
    const small = sized(4095)
    const grown = editHwp(small.d, [{ find: '{{x}}', replace: '0123456789'.repeat(10) }])
    expect(small.size).toBeLessThan(4096)
    expect(hwpStreams(grown.file).get('BodyText/Section0')!.length).toBeGreaterThanOrEqual(4096)
    const big = sized(4096 + 40)
    expect(big.size).toBeGreaterThanOrEqual(4096)
    const shrunk = editHwp(big.d, [{ find: `가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가{{x}}`, replace: '값' }])
    expect(hwpStreams(shrunk.file).get('BodyText/Section0')!.length).toBeLessThan(4096)
    for (const f of [grown.file, shrunk.file]) {
      expect(Buffer.from(readCfb(f).streams.get('BodyText/Section0')!.data).equals(hwpStreams(f).get('BodyText/Section0')!)).toBe(true)
      expect(hwpPartsMismatch(f === grown.file ? small.d : big.d, f)).toBeNull()
    }
  })

  test('unknown records and streams elsewhere pass through; Hangul\'s default scripts, empty or the template, pass', () => {
    const d = hwpEmploymentForm({ extra: { 'Custom/extension.dat': Uint8Array.from([1, 2, 3, 4]) } })
    const r = editHwp(d, [{ find: '{{발급일}}', replace: '오늘' }])
    expect([...hwpStreams(r.file).get('Custom/extension.dat')!]).toEqual([1, 2, 3, 4])
    expect(sectionRecords(r.file).some((x) => x.tag === 120)).toBe(true)
    for (const script of [defaultScript(), defaultScript('', ''), defaultScript('function OnDocument_New()\n{\n}\n')]) {
      const s = hwpEmploymentForm({ extra: { 'Scripts/DefaultJScript': zlib.deflateRawSync(script) } })
      expect(() => editHwp(s, [{ find: '{{발급일}}', replace: '오늘' }])).not.toThrow()
    }
  })
})

describe('an untrusted document', () => {
  const form = (o: Parameters<typeof hwpEmploymentForm>[0]) => () => hwpEmploymentForm(o)
  const change: HwpChange[] = [{ find: '{{발급일}}', replace: 'y' }]
  const hlk = (command: string) => doc1(para('본문 {{발급일}}'), para([[0, [fieldBegin('%hlk', command), '누리집', fieldEnd('%hlk')]]]))
  const zipBytes = Uint8Array.from(Buffer.from('504b0304140000000000', 'hex'))
  const cases: [string, () => Uint8Array, string][] = [
    ['password', form({ flags: 1 | 2 }), 'it is password-protected'],
    ['distribution-only (flag)', form({ flags: 1 | 4 }), 'distribution-only document (배포용)'],
    ['distribution-only (ViewText)', form({ extra: { 'ViewText/Section0': 'x' } }), 'distribution-only document (배포용)'],
    ['scripts (flag)', form({ flags: 1 | 8 }), 'it contains scripts (Scripts/)'],
    ['a script of its own', form({ extra: { 'Scripts/DefaultJScript': zlib.deflateRawSync(defaultScript('function OnDocument_Open() { Shell("calc") }')) } }), 'it contains scripts (Scripts/)'],
    ['another script stream', form({ extra: { 'Scripts/Other': 'x' } }), 'it contains scripts (Scripts/)'],
    ['DRM', form({ extra: { 'DocOptions/DrmLicense': 'x' } }), 'DRM-protected'],
    ['a digital signature', form({ extra: { 'DocOptions/DigitalSignature': 'x' } }), 'digitally signed'],
    ['a signature (flag)', form({ flags: 1 | (1 << 7) }), 'digitally signed'],
    ['an XML form template', form({ extra: { 'XMLTemplate/Schema': 'x' } }), 'XML form template'],
    ['privacy protection', form({ flags: 1 | (1 << 13) }), 'privacy-protected'],
    ['change tracking (flag)', form({ flags: 1 | (1 << 14) }), 'it tracks changes (변경 추적)'],
    ['tracked changes (DocInfo)', form({ docInfo: [rec(TAG.TRACK_CHANGE, 0, Buffer.alloc(8))] }), 'it has tracked changes'],
    ['an OLE stream', form({ extra: { 'BinData/BIN0001.OLE': 'x' } }), 'embedded OLE object'],
    ['an OLE object (BIN_DATA storage)', form({ docInfo: [rec(TAG.BIN_DATA, 1, Buffer.from('02000100', 'hex'))] }), 'embedded OLE object'],
    ['a linked picture (BIN_DATA link)', form({ docInfo: [rec(TAG.BIN_DATA, 1, Buffer.from('0000', 'hex'))] }), 'links a picture or file outside the document'],
    ['compound-file bytes in BinData', form({ extra: { 'BinData/BIN0001.png': Buffer.from('d0cf11e0a1b11ae1000000', 'hex') } }), 'embedded compound file'],
    ['compound-file bytes in BinData, deflated', form({ extra: { 'BinData/BIN0001.png': zlib.deflateRawSync(Buffer.concat([Buffer.alloc(4), Buffer.from('d0cf11e0a1b11ae1000000', 'hex')])) } }), 'embedded compound file'],
    ['a program by name', form({ extra: { 'BinData/BIN0001.exe': 'abc' } }), 'is a program or a script'],
    ['a program by its bytes', form({ extra: { 'BinData/BIN0001.png': Buffer.from('4d5a900003000000', 'hex') } }), 'is a program or a script'],
    ['an OLE object in the body', () => doc1(para('본문 {{발급일}}', { extra: [rec(TAG.SHAPE_OLE, 1, Buffer.alloc(20))] })), 'embedded OLE object'],
    ['a video', () => doc1(para('본문 {{발급일}}', { extra: [rec(TAG.VIDEO_DATA, 1, Buffer.alloc(8))] })), 'contains a video'],
    ['a link to a local file', () => hlk('file\\:///C\\:/Windows/System32/calc.exe;1;0;0;'), 'outside the document'],
    ['a link to a network share', () => hlk('\\\\server\\share\\a.hwp;1;0;0;'), 'outside the document'],
    ['a link to a relative path', () => hlk('..\\..\\AppData\\evil.exe;1;0;0;'), 'not a web or mail address'],
    ['a linked document', form({ extra: { 'DocOptions/_LinkDoc': linkDoc('C:\\문서\\앞 문서.hwp') } }), 'linked to another document'],
    ['HWP 3', () => { const d = hwpEmploymentForm(); const c = readCfb(d); const fh = Buffer.from(c.streams.get('FileHeader')!.data); fh[35] = 3; return writeCfb(c, new Map([['FileHeader', fh]])) }, 'it is an HWP 3 document'],
    ['a zip', () => zipBytes, 'it is a zip, not a .hwp'],
    ['not a compound file', () => Buffer.from('HWP Document File'), 'it is not a .hwp file'],
    ['a damaged section', () => { const d = hwpEmploymentForm({ flags: 0 }); const c = readCfb(d); const s = c.streams.get('BodyText/Section0')!.data; return writeCfb(c, new Map([['BodyText/Section0', s.subarray(0, s.length - 3)]])) }, 'is damaged (a record is cut short)'],
    ['a damaged compressed section', () => { const d = hwpEmploymentForm(); const c = readCfb(d); return writeCfb(c, new Map([['BodyText/Section0', Buffer.from('nonsense bytes')]])) }, 'is damaged (it does not expand)'],
    ['a section that expands too far', () => { const d = hwpEmploymentForm(); const c = readCfb(d); return writeCfb(c, new Map([['BodyText/Section0', zlib.deflateRawSync(Buffer.alloc(70 * 1024 * 1024))]])) }, 'expands to more than 64 MB'],
  ]
  for (const [name, make, why] of cases) {
    test(`refused: ${name}`, () => {
      const msg = refusal(make(), change)
      expect(msg).toContain(why)
      expect(msg).toMatch(/nothing was saved|Nothing was saved/)
    })
  }

  test('kept: a web link and a mail link', () => {
    expect(() => editHwp(hlk('https\\://example.com/a?b=c;1;0;0;'), change)).not.toThrow()
    expect(() => editHwp(hlk('mailto:help@example.com;1;0;0;'), change)).not.toThrow()
  })

  test('a document the editor reads differently from hwp.ts is refused before any change', () => {
    // a PARA_TEXT under the character shapes, not under its paragraph: hwp.ts takes it for the paragraph's text
    const odd = Buffer.concat([rec(TAG.PARA_HEADER, 0, Buffer.alloc(24)), rec(TAG.PARA_CHAR_SHAPE, 1, Buffer.alloc(8)), rec(TAG.PARA_TEXT, 2, Buffer.from('숨은 글\r\0', 'utf16le'))])
    expect(refusal(doc1(para('본문 {{발급일}}'), odd), change)).toContain('its text could not be mapped exactly')
  })

  test('the container: damaged chains and trees are refused; SheetJS and this reader must agree', () => {
    const d = hwpEmploymentForm()
    const loop = Buffer.from(d)
    // point the first FAT entry of the directory's chain at itself
    const dir = loop.readUInt32LE(48), fat0 = loop.readUInt32LE(76)
    loop.writeUInt32LE(dir, 512 + fat0 * 512 + dir * 4)
    expect(refusal(loop, change)).toContain('its container is damaged or unusual')
    const v4 = Buffer.from(d); v4.writeUInt16LE(4, 26); v4.writeUInt16LE(12, 30)
    expect(refusal(v4, change)).toContain('only version 3 with 512-byte sectors')
  })
})

describe('the read-back', () => {
  test('the server finds another stream changed, a stream added, and a wrong text', () => {
    const before = hwpEmploymentForm()
    const changes: HwpChange[] = [{ find: '{{대표자}}', replace: '김예시' }]
    const r = editHwp(before, changes)
    const c = readCfb(r.file)
    const docInfo = writeCfb(c, new Map([['DocInfo', Buffer.concat([c.streams.get('DocInfo')!.data, Buffer.from([0])])]]))
    expect(hwpPartsMismatch(before, docInfo)).toBe('DocInfo is not the same as before')
    const added = hwpEmploymentForm({ extra: { 'BinData/BIN0002.png': 'x' } })
    expect(hwpPartsMismatch(before, added)).toMatch(/directory/)
    expect(hwpPartsMismatch(before, Buffer.from('not a file'))).toContain('a compound file could not be read')
    const old = lines(before), got = lines(r.file)
    expect(hwpEditMismatch(changes, old, got, r.report)).toBeNull()
    expect(hwpEditMismatch(changes, old, got.map((l) => l.replace('위 사람은', '위 사람이')), r.report)).toContain('expected "| 위 사람은')
  })
})

describe('found in review', () => {
  const change: HwpChange[] = [{ find: '{{발급일}}', replace: 'y' }]

  test('a part named like Hangul\'s but in other case is refused: Hangul opens it, the checks would not', () => {
    const linked = (o: Parameters<typeof hwpEmploymentForm>[0]) => hwpEmploymentForm({ docInfo: [rec(TAG.BIN_DATA, 1, Buffer.from('0000', 'hex'))], ...o })
    expect(refusal(linked({ rename: { DocInfo: 'DOCINFO' } }), change)).toContain('a part is named "DOCINFO", which Hangul reads as its "DocInfo"')
    const script = zlib.deflateRawSync(defaultScript('function OnDocument_Open() { Shell("calc") }'))
    expect(refusal(hwpEmploymentForm({ extra: { 'Scripts/DefaultJScript': script }, rename: { 'Scripts/DefaultJScript': 'Scripts/DEFAULTJSCRIPT' } }), change)).toContain('"DEFAULTJSCRIPT", which Hangul reads as its "DefaultJScript"')
    expect(refusal(hwpEmploymentForm({ extra: { 'DocOptions/_LinkDoc': linkDoc('C:\\앞 문서.hwp') }, rename: { 'DocOptions/_LinkDoc': 'DocOptions/_LINKDOC' } }), change)).toContain('"_LINKDOC", which Hangul reads as its "_LinkDoc"')
    const hidden = Buffer.concat([para([[0, sectionDef()]]), para('본문', { extra: [rec(TAG.SHAPE_OLE, 1, Buffer.alloc(20))] })])
    expect(refusal(hwpEmploymentForm({ extra: { 'BodyText/SECTION1': zlib.deflateRawSync(hidden) } }), change)).toContain('"SECTION1", which Hangul reads as its "SectionN"')
  })

  test('rows added to a table and to a table inside its last cell, in either order: each table gets its own rows', () => {
    const inner = table([[{ text: '내부1', width: 3000 }]], { level: 2 })
    const d = doc1(table([[{ text: '머리', width: 4000 }, { text: '값', width: 4000 }], [{ text: '표안표', width: 4000 }, { paras: inner, width: 4000 }]]), para('본문', { last: true }))
    const outer: HwpChange = { add_rows: { table: 1, copy_row: 1, rows: [['새', '줄']] } }
    const nested: HwpChange = { add_rows: { table: 2, rows: [['내부2']] } }
    for (const changes of [[outer, nested], [nested, outer]]) {
      const r = editHwp(d, changes)
      const m = hwpEditModel(r.file)
      expect(m.tables.map((t) => [t.bad, t.rowSizes, t.cells.map((c) => c.text)])).toEqual([[null, [2, 2, 2], ['머리', '값', '표안표', '', '새', '줄']], [null, [1, 1], ['내부1', '내부2']]])
      expect(lines(r.file)).toEqual(['| 머리', '| 값', '| 표안표', '| 내부1', '| 내부2', '| 새', '| 줄', '| 본문'])
    }
  })

  test('characters outside the BMP (an emoji, a CJK Extension B hanja) are two UTF-16 code units, as hwp.ts reads them', () => {
    const r = editHwp(hwpEmploymentForm(), [{ find: '{{발급일}}', replace: '홍길동 😀' }, { cell: { next_to: '성명' }, value: '𠀀씨' }])
    expect(paraWith(r.file, '홍길동').text).toBe('발급일: 홍길동 😀<13>')
    expect(paraWith(r.file, '홍길동').header.chars).toBe(5 + 6 + 1)
    expect(paraWith(r.file, '씨').text).toBe('𠀀씨<13>')
    expect(lines(r.file)).toContain('| 𠀀씨')
  })

  test('rows after a row with no cells of its own (every cell above reaches into it)', () => {
    const d = doc1(table([[{ text: '가', width: 4000, rowSpan: 2 }, { text: '나', width: 4000, rowSpan: 2 }], [], [{ text: '다', width: 4000 }, { text: '라', width: 4000 }]]))
    expect(hwpEditModel(d).tables[0]!.rowSizes).toEqual([2, 0, 2])
    const r = editHwp(d, [{ add_rows: { table: 1, after_row: 2, copy_row: 3, rows: [['마', '바']] } }])
    expect(lines(r.file)).toEqual(['| 가', '| 나', '| 마', '| 바', '| 다', '| 라'])
    expect(hwpEditModel(r.file).tables[0]).toMatchObject({ bad: null, rowSizes: [2, 0, 2, 2] })
  })

  test('an OLE object kept as a storage in BinData is refused; so is a name with a character a compound file forbids', () => {
    expect(refusal(hwpEmploymentForm({ extra: { 'BinData/BIN0001.OLE/CONTENTS': 'x' } }), change)).toContain('embedded OLE object (BinData/BIN0001.OLE)')
    const d = Buffer.from(hwpEmploymentForm())
    const at = d.indexOf(Buffer.from('PrvText', 'utf16le'))
    Buffer.from('!', 'utf16le').copy(d, at + 6)
    expect(refusal(d, change)).toContain('a directory entry has a name with / \\ : or !')
  })

  test('a document with more paragraphs than the limit is refused before it is changed', () => {
    const was = HWP_EDIT_LIMITS.paragraphs
    HWP_EDIT_LIMITS.paragraphs = 5
    try { expect(refusal(hwpEmploymentForm(), change)).toContain('it has more than 5 paragraphs, too many to change here') } finally { HWP_EDIT_LIMITS.paragraphs = was }
    expect(() => editHwp(hwpEmploymentForm(), change)).not.toThrow()
  })
})

describe('through the office worker', () => {
  test('the worker changes the document and frames the report; a refusal comes back as the editor\'s message', async () => {
    const changes: HwpChange[] = [{ cell: { next_to: '성명' }, value: '홍길동' }]
    const form = hwpEmploymentForm()
    const out = decodeHwpEditResult(await officeWorkerWrite(HWP_EDIT_MODE, encodeHwpEditRequest(changes, form)))
    expect(Buffer.from(out.file).equals(Buffer.from(editHwp(form, changes).file))).toBe(true)
    expect(out.report.notes[0]!.after).toBe('홍길동')
    await expect(officeWorkerWrite(HWP_EDIT_MODE, encodeHwpEditRequest([{ find: '없음', replace: 'x' }], form))).rejects.toThrow('"없음" is not in the document')
    await expect(officeWorkerWrite(HWP_EDIT_MODE, new Uint8Array([0, 0, 0, 9, 1]))).rejects.toThrow('the .hwp editor got a damaged request')
  })

  test('the checks again in a fresh worker: a changed file passes, one with a script does not', async () => {
    const r = editHwp(hwpEmploymentForm(), [{ cell: { next_to: '성명' }, value: '홍길동' }])
    expect(Buffer.from(await officeWorkerWrite(HWP_VERIFY_MODE, r.file)).toString()).toBe('ok')
    await expect(officeWorkerWrite(HWP_VERIFY_MODE, hwpEmploymentForm({ flags: 1 | 8 }))).rejects.toThrow('it contains scripts')
  })
})

// Hangul-saved samples (hwplib's samples, Apache-2.0; statutory forms from law.go.kr): not in the repository;
// MYCEL_HWP_SAMPLES=<folder>, searched recursively for .hwp files.
const SAMPLES = process.env.MYCEL_HWP_SAMPLES
const RHWP = fs.existsSync(localHwpAssets().bin)
const sampleFiles = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? sampleFiles(path.join(dir, e.name)) : /\.hwp$/i.test(e.name) ? [path.join(dir, e.name)] : [])
/** refusals a Hangul-saved sample may meet: what it holds, not a fault of the editor */
const SAMPLE_REFUSALS = /distribution-only|OLE object|links a picture|contains a video|tracks changes|tracked changes|password|scripts|runs across|cannot be changed here/
describe.skipIf(!SAMPLES)('Hangul-saved documents (MYCEL_HWP_SAMPLES)', () => {
  test('a word of each is replaced: every other stream stays, the text reads back; or a refusal that says why', async () => {
    const files = sampleFiles(SAMPLES!)
    expect(files.length).toBeGreaterThan(0)
    let changed = 0
    const engine = RHWP ? new NativeHwpEngine() : null
    for (const f of files) {
      const b = new Uint8Array(fs.readFileSync(f))
      let text: string
      try { text = hwpText(b) } catch { continue }
      const word = text.split(/\s+/).find((w) => w.length >= 2 && !/[{}#]/.test(w))
      if (!word) continue
      let r: ReturnType<typeof editHwp>
      try { r = editHwp(b, [{ find: word, replace: `${word}*`, occurrence: 1 }]) } catch (e) { expect(String((e as Error).message), f).toMatch(SAMPLE_REFUSALS); continue }
      changed++
      expect(hwpPartsMismatch(b, r.file), f).toBeNull()
      expect(lines(r.file).join('\n'), f).toContain(`${word}*`)
      if (engine) {
        try {
          const page = await engine.render(Buffer.from(r.file), 'hwp', 1)
          expect(page.bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
        } catch (e) {
          // the renderer refuses some originals too (fonts, unsupported controls): the changed file must not do worse
          await expect(engine.render(Buffer.from(b), 'hwp', 1), `${f}: ${(e as Error).message}`).rejects.toThrow()
        }
      }
    }
    expect(changed).toBeGreaterThan(0)
  })
})
if (!SAMPLES) test('Hangul-saved samples not given (MYCEL_HWP_SAMPLES): skipped', () => { console.log('skipped: set MYCEL_HWP_SAMPLES to a folder of Hangul-saved .hwp files') })
