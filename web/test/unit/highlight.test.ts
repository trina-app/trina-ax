import { describe, expect, test } from 'bun:test'
import { highlightParts } from '../../src/lib/highlight'

describe('highlightParts', () => {
  test('marks each match in any case', () => {
    expect(highlightParts('Budget and BUDGET', 'budget')).toEqual([
      { text: 'Budget', match: true }, { text: ' and ', match: false }, { text: 'BUDGET', match: true },
    ])
  })
  test('Korean query, also when typed in NFD', () => {
    expect(highlightParts('올해 예산 계획', '예산'.normalize('NFD'))).toEqual([
      { text: '올해 ', match: false }, { text: '예산', match: true }, { text: ' 계획', match: false },
    ])
  })
  test('no match and an empty query give the plain text', () => {
    expect(highlightParts('abc', 'x')).toEqual([{ text: 'abc', match: false }])
    expect(highlightParts('abc', ' ')).toEqual([{ text: 'abc', match: false }])
  })
  test('markup in the text stays text', () => {
    expect(highlightParts('<b>x</b>', 'x')).toEqual([{ text: '<b>', match: false }, { text: 'x', match: true }, { text: '</b>', match: false }])
  })
})
