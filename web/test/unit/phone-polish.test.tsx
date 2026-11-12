// QA TC-265 (the 11-11 phone audit): a table cell with a number and a short unit stays on one line; a Mermaid diagram
// follows the app's dark theme.
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { isNumberCell, Markdown, mermaidTheme } from '../../src/components/Markdown'

const render = (text: string) => renderToStaticMarkup(<MemoryRouter><Markdown text={text} /></MemoryRouter>)

describe('number cells', () => {
  test('a number with a Korean, Japanese or Chinese unit is one', () => {
    for (const x of ['1,234,567', '1,234,567,890원', '₩987,654,321', '12,345건', '3.5만 원', '42%', '12 GB', '1,200件', '(1,234)', '2026-11-12'])
      expect([x, isNumberCell(x)]).toEqual([x, true])
  })
  test('words are not', () => {
    for (const x of ['온라인 스토어', '주말 할인 행사 덕분에 늘었어요', '비슷해요', '1 alpha beta', '3 개월 동안 늘었어요', 'alpha'])
      expect([x, isNumberCell(x)]).toEqual([x, false])
  })
  test('the cell stays on one line with tabular digits; a word cell wraps as before', () => {
    const html = render('| 채널 | 매출 |\n|---|---|\n| 온라인 스토어 | 1,234,567,890원 |\n')
    expect(html).toContain('<td class="whitespace-nowrap tabular-nums">1,234,567,890원</td>')
    expect(html).toContain('<td>온라인 스토어</td>')
  })
})

test('Mermaid draws with its dark theme in the dark look, the neutral one otherwise', () => {
  expect(mermaidTheme(true)).toBe('dark')
  expect(mermaidTheme(false)).toBe('neutral')
})
