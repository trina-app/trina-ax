// The file panel's small rules (2026-11-06 e2e polish): a Markdown file's YAML front matter becomes a quiet name /
// description block instead of one bold line (lib/markdown.ts splitFrontMatter, components/FilePanel.tsx); a CSV
// preview right-aligns its number columns (lib/preview.ts numberColumns); a file panel stays on the page it was
// opened on, the Files page, or the chat a new-chat page's first message opens (lib/sidePanel.ts keepsFilePanel,
// components/Layout.tsx). How they look is checked in the browser.
import { describe, expect, test } from 'bun:test'
import { splitFrontMatter } from '../../src/lib/markdown'
import { numberColumns } from '../../src/lib/preview'
import { keepsFilePanel } from '../../src/lib/sidePanel'

describe('front matter of a Markdown file', () => {
  test('a SKILL.md: name and description, the page after the block', () => {
    const r = splitFrontMatter('---\nname: weekly-report\ndescription: Writes the weekly report.\n---\n# Weekly report\n\nSteps.')
    expect(r).toEqual({ name: 'weekly-report', description: 'Writes the weekly report.', body: '# Weekly report\n\nSteps.' })
  })

  test('quoted, folded and continued values; other keys and lists are left out', () => {
    const text = [
      '﻿---',
      'name: "주간 보고"',
      'description: >-',
      '  매주 월요일 보고서를',
      '  만들어요.',
      'allowed-tools:',
      '- Read',
      '# a comment',
      '---',
      'Body',
    ].join('\r\n')
    expect(splitFrontMatter(text)).toEqual({ name: '주간 보고', description: '매주 월요일 보고서를 만들어요.', body: 'Body' })
    expect(splitFrontMatter("---\ndescription: 'it''s here'\n---\n").description).toBe("it's here")
  })

  test('a block without name or description: hidden, nothing to show', () => {
    expect(splitFrontMatter('---\ntitle: Notes\n---\nText')).toEqual({ name: undefined, description: undefined, body: 'Text' })
  })

  test('no front matter, an unclosed block or a rule before prose: the text comes back whole', () => {
    for (const text of ['# Title\n\nText', '---\nname: x\nno end', '---\nSome intro paragraph.\n---\nMore', 'Text\n---\nname: x\n---']) {
      expect(splitFrontMatter(text)).toEqual({ body: text })
    }
  })
})

describe('number columns of a CSV preview', () => {
  test('columns whose cells under the header are all numbers or amounts; not dates or words', () => {
    const rows = [
      ['월', '제품', '매출(만원)', '건수', '비율', '메모'],
      ['2026-07', '베이직', '1,200', '14', '12.5%', ''],
      ['2026-08', '프로', '₩3,100', '-9', '7%', '메모'],
      ['2026-09', '프로', '980', '', '+0.5%', ''],
    ]
    expect([...numberColumns(rows)].sort()).toEqual([2, 3, 4])
  })

  test('a header alone or an empty column is not a number column', () => {
    expect(numberColumns([['a', 'b']]).size).toBe(0)
    expect(numberColumns([['a', 'b'], ['x', ''], ['y']]).size).toBe(0)
  })
})

describe('where a file panel stays', () => {
  test('moving to the Files page keeps it', () => {
    expect(keepsFilePanel('/c/abc', '/files')).toBe(true)
    expect(keepsFilePanel('/files/view', '/files')).toBe(true)
  })

  test('a new-chat page becoming its chat keeps it', () => {
    expect(keepsFilePanel('/', '/c/new-chat')).toBe(true)
    expect(keepsFilePanel('/projects/p1', '/c/new-chat')).toBe(true)
  })

  test('a new chat, another chat or another page closes it', () => {
    expect(keepsFilePanel('/c/abc', '/')).toBe(false)
    expect(keepsFilePanel('/c/abc', '/c/other')).toBe(false)
    expect(keepsFilePanel('/files', '/')).toBe(false)
    expect(keepsFilePanel('/rooms/r1', '/rooms/r2')).toBe(false)
    expect(keepsFilePanel('/files', '/scheduled')).toBe(false)
  })
})
