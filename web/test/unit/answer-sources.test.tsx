// "참고한 파일" under an answer (src/components/chat/SourcesList.tsx) and opening a file at a place: the list as the
// server sent it (only files the viewer may open, the rest counted), place chips in the viewer's language, "N more"
// after 20 files; preview links with &page / &sheet / &slide; the sheet tab and cells to open.
import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { fileShareUrl, locFromQuery, locQuery, type Locale, type MessageSources } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import SourcesList, { SOURCES_SHOWN } from '../../src/components/chat/SourcesList'
import { classifyLink } from '../../src/lib/markdown'
import { rangeCellIds, startSheetIndex } from '../../src/lib/sheetPreview'

const setLocale = (l: Locale) => Object.assign(useLocaleStore.getInitialState(), { locale: l })
const before = useLocaleStore.getInitialState().locale
afterEach(() => setLocale(before))
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')

const LIST: MessageSources = {
  files: [
    { path: 'finance/매출보고서.pdf', name: '매출보고서.pdf', locs: [{ kind: 'page', page: 12 }, { kind: 'page', page: 14 }], via: ['read', 'search'] },
    { path: 'finance/2026 예산.xlsx', name: '2026 예산.xlsx', locs: [{ kind: 'sheet', sheet: '매출', range: 'A1:F40' }], via: ['search'] },
    { path: 'shared/제품소개.pptx', name: '제품소개.pptx', locs: [{ kind: 'slide', slide: 3 }], via: ['read'], subagent: true },
    { path: 'shared/환불.docx', name: '환불.docx', locs: [{ kind: 'heading', heading: '환불 정책' }], via: ['grep'] },
  ],
  unavailable: 2,
}
const render = (s: MessageSources, open = true) => renderToStaticMarkup(<SourcesList chatId="c" messageId="m" count={s.files.length + s.unavailable} defaultOpen={open} initial={s} />)

describe('the list under an answer', () => {
  test('collapsed: only the count', () => {
    setLocale('ko')
    const html = render(LIST, false)
    expect(html).toContain(esc(translate('ko', 'sources.title', { n: 6 })))
    expect(html).toContain('참고한 파일 6개')
    expect(html).not.toContain('매출보고서')
  })
  test('open (ko): names, place chips, how they were seen, the files the viewer cannot open as a number', () => {
    setLocale('ko')
    const html = render(LIST)
    expect(html).toContain('AI가 이 답변을 쓰며 열어 본 파일이에요.')
    for (const s of ['매출보고서.pdf', '12쪽', '14쪽', esc("시트 '매출' A1:F40"), '슬라이드 3', '§ 환불 정책', '검색 결과로만 봄', '하위 작업이 읽음', '볼 수 없는 파일 2개']) expect(html).toContain(s)
    // "only search results" is for files the AI did not read: the PDF it read says nothing
    expect(html.split('data-testid="answer-source"').find((x) => x.includes('매출보고서.pdf'))).not.toContain('검색 결과로만 봄')
  })
  test('five languages: every chip and note translated', () => {
    for (const l of ['en', 'id', 'ja', 'es'] as const) {
      setLocale(l)
      const html = render(LIST)
      for (const [k, p] of [['sources.page', { page: 12 }], ['sources.slide', { slide: 3 }], ['sources.sheetRange', { sheet: '매출', range: 'A1:F40' }], ['sources.unavailable', { n: 2 }], ['sources.caption', undefined]] as const) {
        expect(html, `${l} ${k}`).toContain(esc(translate(l, k, p)))
      }
    }
  })
  test(`more than ${SOURCES_SHOWN} files: the rest behind "N more"`, () => {
    setLocale('ko')
    const many: MessageSources = { files: Array.from({ length: 25 }, (_, i) => ({ path: `shared/f${i}.md`, name: `f${i}.md`, locs: [], via: ['read'] as ('read')[] })), unavailable: 0 }
    const html = render(many)
    expect(html.match(/data-testid="answer-source"/g)).toHaveLength(SOURCES_SHOWN)
    expect(html).toContain('5개 더 보기')
  })
  test('no files at all: nothing under the answer', () => {
    expect(renderToStaticMarkup(<SourcesList chatId="c" messageId="m" count={0} />)).toBe('')
  })
})

describe('links to a place', () => {
  const O = 'https://team.example'
  test('the AI\'s links open the preview at the page, sheet or slide', () => {
    expect(classifyLink(`${O}${fileShareUrl('finance/매출보고서.pdf', 'preview', { kind: 'page', page: 12 })}`, O)).toEqual({ kind: 'team-file', path: 'finance/매출보고서.pdf', at: { kind: 'page', page: 12 } })
    expect(classifyLink(fileShareUrl('a/b (최종).xlsx', 'preview', { kind: 'sheet', sheet: '매출 & 비용', range: 'B2:C9' }), O)).toEqual({ kind: 'team-file', path: 'a/b (최종).xlsx', at: { kind: 'sheet', sheet: '매출 & 비용', range: 'B2:C9' } })
    expect(classifyLink('/files/view?path=s%2Fdeck.pptx&slide=3', O)).toEqual({ kind: 'team-file', path: 's/deck.pptx', at: { kind: 'slide', slide: 3 } })
    // a section has no place in a preview: the link is the file's
    expect(locQuery({ kind: 'heading', heading: 'x' })).toBe('')
    expect(classifyLink('/files/view?path=s%2Fa.docx', O)).toEqual({ kind: 'team-file', path: 's/a.docx' })
  })
  test('malformed places are ignored, never guessed', () => {
    for (const q of ['page=0', 'page=-3', 'page=abc', 'slide=1e3', 'page=99999999']) expect(locFromQuery(new URLSearchParams(q)), q).toBeNull()
    expect(locFromQuery(new URLSearchParams('sheet=S&range=javascript:1'))).toEqual({ kind: 'sheet', sheet: 'S' })
    expect(locFromQuery(new URLSearchParams(`sheet=${'x'.repeat(300)}`))).toBeNull()
  })
})

describe('opening a sheet at its range', () => {
  test('the named tab, else the first visible one', () => {
    const meta = [{ name: 'Secret', hidden: true }, { name: '요약', hidden: false }, { name: '매출', hidden: false }]
    expect(startSheetIndex(meta, '매출')).toBe(2)
    expect(startSheetIndex(meta, '없는 시트')).toBe(1)
    expect(startSheetIndex(meta)).toBe(1)
  })
  test('the cells of the range, as the table\'s cell ids', () => {
    expect(rangeCellIds('A1:B2')).toEqual(['sjs-A1', 'sjs-B1', 'sjs-A2', 'sjs-B2'])
    expect(rangeCellIds('Z9')).toEqual(['sjs-Z9'])
    expect(rangeCellIds('Y1:AB1')).toEqual(['sjs-Y1', 'sjs-Z1', 'sjs-AA1', 'sjs-AB1'])
    expect(rangeCellIds('A1:XFD1048576')).toHaveLength(2000)
    expect(rangeCellIds('"><img>')).toEqual([])
  })
})
