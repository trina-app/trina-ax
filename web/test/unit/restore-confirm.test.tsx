// A version comes back without a confirm since docs/decisions/20261123-do-then-undo.md (the toast's Undo restores the
// newest before it): the chat's line and the toast in Korean with the right particles (QA TC-b3s-17).
import { expect, test } from 'bun:test'
import { translate } from '../../src/i18n'

test('the Korean lines read with the right particles after a page title, a file name and a number', () => {
  expect(translate('ko', 'chat.event.restored', { actor: '박준호', file: '연말 행사 안내', n: 2 })).toBe('박준호님이 연말 행사 안내를 버전 2로 되돌렸어요')
  expect(translate('ko', 'chat.event.restored', { actor: '박준호', file: '주간 실적.xlsx', n: 3 })).toBe('박준호님이 주간 실적.xlsx를 버전 3으로 되돌렸어요')
  expect(translate('ko', 'chatFile.restored', { n: 2 })).toStartWith('버전 2를 ')
  expect(translate('ko', 'chatFile.restored', { n: 3 })).toStartWith('버전 3을 ')
})
