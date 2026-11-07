// The Files search's results (src/components/FileContentSearch.tsx FileContentList): the knowledge graph's document rows
// first (one per document: name, place, a short passage with the query's words marked; a click opens the file at that
// place), then the exact-line matches as before. An answer without `documents` (the documents part off, an older
// server) looks exactly as it did; document rows with no line at all show no second "nothing found".
import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { FileContentHits, Locale } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { FileContentList, queryWords, wordParts } from '../../src/components/FileContentSearch'
import { getSidePanel, setSidePanel } from '../../src/lib/sidePanel'
import { installDom, mount, removeDom } from './dom-host'

const setLocale = (l: Locale) => Object.assign(useLocaleStore.getInitialState(), { locale: l })
const before = useLocaleStore.getInitialState().locale
afterEach(() => { setLocale(before); setSidePanel(null) })
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')

const none = { truncated: false, timedOut: false, indexing: 0, notQueued: 0, retryLater: 0, longSkipped: 0 }
const LINES: FileContentHits['items'] = [
  { path: 'shared/notes/pricing.md', name: 'pricing.md', line: 2, snippet: 'Refund policy: 14 days' },
  { path: 'shared/notes/pricing.md', name: 'pricing.md', line: 7, snippet: 'see refund policy' },
]
const DOCS: NonNullable<FileContentHits['documents']> = [
  { path: 'finance/매출보고서.pdf', name: '매출보고서.pdf', loc: { kind: 'page', page: 12 }, snippet: '…올해 환불 정책은 7일 이내로 정했습니다…' },
  { path: 'finance/2026 예산.xlsx', name: '2026 예산.xlsx', loc: { kind: 'sheet', sheet: '매출', range: 'A1:F40' }, snippet: '환불 충당금 1,200' },
  { path: 'shared/환불.docx', name: '환불.docx', loc: { kind: 'heading', heading: '환불 정책' }, snippet: '정책 요약' },
  { path: 'shared/memo.txt', name: 'memo.txt', loc: null, snippet: 'plain memo' },
]
const render = (res: FileContentHits, q = '환불 정책') => renderToStaticMarkup(<FileContentList res={res} query={q} folderLabel="shared" />)

describe('document rows and line matches', () => {
  test('document rows first, one per document, with the place in the viewer\'s language; then the line matches', () => {
    setLocale('ko')
    const html = render({ items: LINES, documents: DOCS, ...none })
    expect(html.indexOf('data-testid="content-documents"')).toBeLessThan(html.indexOf('data-testid="content-hit-file"'))
    expect(html.match(/data-testid="content-doc"/g)).toHaveLength(4)
    expect(html).toContain(translate('ko', 'files.search.documents'))
    for (const s of ['매출보고서.pdf', '12쪽', esc("시트 '매출' A1:F40"), '§ 환불 정책', 'memo.txt']) expect(html).toContain(s)
    // a document without a place shows none
    expect(html.match(/data-testid="content-doc-place"/g)).toHaveLength(3)
    // the line part as before: the scope line, the file, both lines
    expect(html).toContain(esc(translate('ko', 'files.search.scope', { q: '환불 정책', folder: 'shared' })))
    expect(html.match(/data-testid="content-hit"/g)).toHaveLength(2)
  })

  test('the query\'s words are marked in a passage, each on its own; a line match marks the whole query', () => {
    setLocale('ko')
    const html = render({ items: [{ path: 'a/b.md', name: 'b.md', line: 1, snippet: '환불 정책 그대로' }], documents: DOCS, ...none })
    const mark = (x: string, pad = '') => `<mark class="rounded-sm bg-accent-soft ${pad}text-inherit">${x}</mark>`
    // a passage's marks have no side padding (a word and its particle stay one word); a line's as before
    expect(html).toContain(`<span>…올해 </span>${mark('환불')}<span> </span>${mark('정책')}<span>은 7일`)
    expect(html).toContain(`${mark('환불 정책', 'px-0.5 ')}<span> 그대로</span>`)
    expect(queryWords(' Refund  policy a 의 refund ')).toEqual(['Refund', 'policy', 'refund', '의'])
    expect(wordParts('Refund the POLICY', ['policy', 'refund'])).toEqual([{ text: 'Refund', match: true }, { text: ' the ', match: false }, { text: 'POLICY', match: true }])
    // markup in a passage stays text
    expect(render({ items: [], documents: [{ path: 'x.md', name: 'x.md', loc: null, snippet: '<img src=x onerror=alert(1)> 환불' }], ...none })).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  test('no documents field (the documents part off, an older server): exactly as before, no new label', () => {
    setLocale('ko')
    const html = render({ items: LINES, ...none })
    expect(html).not.toContain('content-documents')
    expect(html).not.toContain(translate('ko', 'files.search.documents'))
    expect(html.startsWith('<p class="px-2 pb-2 text-xs text-faint">')).toBe(true)
    expect(html.match(/data-testid="content-hit"/g)).toHaveLength(2)
    expect(render({ items: LINES, documents: [], ...none })).toBe(html)
  })

  test('document rows and no line: no scope line and no "nothing found"; nothing at all: "nothing found"', () => {
    setLocale('ko')
    const only = render({ items: [], documents: DOCS, ...none })
    expect(only).not.toContain(esc(translate('ko', 'files.search.none')))
    expect(only).not.toContain(esc(translate('ko', 'files.search.scope', { q: '환불 정책', folder: 'shared' })))
    expect(render({ items: [], documents: [], ...none })).toContain(esc(translate('ko', 'files.search.none')))
    // a note about the line search still shows (e.g. office documents being indexed)
    expect(render({ items: [], documents: DOCS, ...none, indexing: 2 })).toContain(esc(translate('ko', 'files.search.indexing', { n: 2 })))
  })

  test('five languages: the one new label', () => {
    for (const l of ['en', 'ko', 'id', 'ja', 'es'] as const) {
      setLocale(l)
      const label = translate(l, 'files.search.documents')
      expect(label, l).not.toBe('files.search.documents')
      expect(render({ items: [], documents: DOCS, ...none }), l).toContain(esc(label))
    }
  })
})

test('a click on a document row opens the file at its place; on a line, the file as before', async () => {
  setLocale('en')
  installDom()
  const m = await mount(<FileContentList res={{ items: LINES, documents: [DOCS[0]!], ...none }} query="환불" folderLabel="shared" />)
  try {
    await m.click('content-doc')
    expect(getSidePanel()).toMatchObject({ kind: 'file', file: { source: 'team', path: 'finance/매출보고서.pdf', name: '매출보고서.pdf', at: { kind: 'page', page: 12 } } })
    await m.click('content-hit')
    const p = getSidePanel()
    expect(p).toMatchObject({ kind: 'file', file: { source: 'team', path: 'shared/notes/pricing.md' } })
    expect(p?.kind === 'file' && p.file.source === 'team' && p.file.at).toBeFalsy()
  } finally {
    await m.unmount()
    removeDom()
  }
})
