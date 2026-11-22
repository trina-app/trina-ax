// One tile per file under an answer (QA rerun E: one file as three identical tiles after the AI attached it again on
// each change).
import { expect, test } from 'bun:test'
import { uniqueTiles } from '../../src/components/chat/Messages'

const a = (id: string, name: string, size = 10, kind = 'spreadsheet') => ({ id, name, size, kind })

test('the same file once, the newest kept; different files all shown', () => {
  expect(uniqueTiles([a('1', '실적.xlsx'), a('1', '실적.xlsx'), a('1', '실적.xlsx')]).map((x) => x.id)).toEqual(['1'])
  expect(uniqueTiles([a('1', '실적.xlsx'), a('2', '실적.xlsx'), a('3', '실적.xlsx')]).map((x) => x.id)).toEqual(['3'])
  expect(uniqueTiles([a('1', '실적.xlsx', 10), a('2', '실적.xlsx', 20), a('3', '요약.pdf', 10, 'pdf')]).map((x) => x.id)).toEqual(['1', '2', '3'])
})
