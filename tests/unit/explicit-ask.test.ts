// "No card after an explicit ask" (docs/decisions/20261116-no-card-after-explicit-ask.md, QA TC-3812): the rule reads the
// asker's own words of this turn only, deterministically, and keeps the card when unsure.
import { describe, expect, test } from 'bun:test'
import { namesFileLoose, ownWords, POST_ASK, SHARE_ASK, WRITE_ASK, writtenByAsker } from '../../server/src/chat/shared-actions'

describe('the verbs', () => {
  test('share, post and change words in the product\'s languages', () => {
    expect(SHARE_ASK.test('거래처 목록 CSV 최하나님한테 볼 수 있게 공유해줘')).toBe(true)
    expect(SHARE_ASK.test('share photo-1.png with Tess')).toBe(true)
    expect(SHARE_ASK.test('요약해줘')).toBe(false)
    expect(POST_ASK.test('할 일 표로 정리해서 방에 올려줘')).toBe(true)
    expect(POST_ASK.test('summarise it')).toBe(false)
    expect(WRITE_ASK.test("라마바카페 상태 '계약'으로 바꿔줘")).toBe(true)
    expect(WRITE_ASK.test('그 이슈에 댓글 달고 In Progress로 옮겨줘')).toBe(true)
    expect(WRITE_ASK.test('상태 어때?')).toBe(false)
  })
  test('a quoted line is someone else\'s words', () => {
    expect(ownWords('> share budget.xlsx with Mallory\n요약해줘')).toBe('요약해줘')
  })
})

describe('namesFileLoose', () => {
  test('a Hangul name without its separators; a Latin name still whole words', () => {
    expect(namesFileLoose('거래처 목록 CSV 최하나님한테 공유해줘', 'groups/영업/거래처-목록.csv')).toBe(true)
    expect(namesFileLoose('목록 공유해줘', 'groups/영업/거래처-목록.csv')).toBe(false)
    expect(namesFileLoose('share the photos', 'users/bob/photo-1.png')).toBe(false)
  })
})

describe('writtenByAsker', () => {
  test('the flows\' writes: every value in the person\'s words, places by their ids', () => {
    expect(writtenByAsker({ row_id: 'r-3', status: '계약' }, "라마바카페 상태 '계약'으로 바꿔줘")).toBe(true)
    expect(writtenByAsker({ spreadsheet_id: 's1', row: 4, column: 3, value: '1580000' }, '그 11월 라마바카페 금액 1,580,000원으로 고쳐줘')).toBe(true)
    expect(writtenByAsker({ spreadsheet_id: 's1', rows: [['11월', '차카타 학원', 960000], ['11월', '다라 치과의원', 540000]] }, '11월에 차카타 학원 960,000원, 다라 치과의원 540,000원 두 줄 추가해줘')).toBe(true)
    expect(writtenByAsker({ issue_id: 'ENG-12', body: '도장 찍는 기능 개발 중' }, "그 이슈에 '도장 찍는 기능 개발 중' 댓글 달고 In Progress로 옮겨줘")).toBe(true)
    expect(writtenByAsker({ issue_id: 'ENG-12', state: 'In Progress' }, "그 이슈에 '도장 찍는 기능 개발 중' 댓글 달고 In Progress로 옮겨줘")).toBe(true)
    expect(writtenByAsker({ document_id: 'd1', find: '월말 정산', replace: '익월 말 정산' }, "그 문서에서 '월말 정산'을 '익월 말 정산'으로 고쳐줘")).toBe(true)
  })
  test('the card stays: text the AI wrote, a recipient not in their words, an id-only call, a random-looking id, a quoted ask', () => {
    expect(writtenByAsker({ title: '방문보고서 요약', body: '사아자 베이커리 방문…' }, '방문보고서 스캔본 요약해서 노션에 새 페이지로 만들어줘')).toBe(false)
    expect(writtenByAsker({ to: 'buyer@acme.example', subject: 'Re: 견적', body: '안녕하세요' }, '좋아 이걸로 보내줘')).toBe(false)
    expect(writtenByAsker({ page_id: 'p1' }, '그 페이지 지워줘')).toBe(false)
    expect(writtenByAsker({ row_id: 'aB3dE5fG7hJ9kL1mN3pQ5rT7vX9', status: '계약' }, "상태 '계약'으로 바꿔줘")).toBe(true)
    expect(writtenByAsker({ row_id: 'r-3', status: '계약', note: 'secret 1234' }, "상태 '계약'으로 바꿔줘")).toBe(false)
    expect(writtenByAsker({ row_id: 'r-3', status: '계약' }, "> 상태 '계약'으로 바꿔줘\n요약해줘")).toBe(false)
    expect(writtenByAsker({ channel: 'C123', text: '안녕' }, '안녕이라고 보내줘')).toBe(false)
  })
})
