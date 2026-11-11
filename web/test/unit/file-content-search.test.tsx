// The Files search's results (src/components/FileContentSearch.tsx FileContentList): the exact-line matches, grouped
// by file, under the scope line. A word that no line has says "nothing found" (QA TC-061). The knowledge graph's
// document rows were removed (docs/DECISIONS.md, 2026-11-11): an answer that still carries `documents` (an older
// server) shows only its lines.
import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { FileContentHits, Locale } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { FileContentList } from '../../src/components/FileContentSearch'
import { closeSidePanel, getSidePanel } from '../../src/lib/sidePanel'
import { installDom, mount, removeDom } from './dom-host'

const setLocale = (l: Locale) => Object.assign(useLocaleStore.getInitialState(), { locale: l })
const before = useLocaleStore.getInitialState().locale
afterEach(() => setLocale(before))
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')

const none = { truncated: false, timedOut: false, indexing: 0, notQueued: 0, retryLater: 0, longSkipped: 0 }
const LINES: FileContentHits['items'] = [
  { path: 'shared/notes/pricing.md', name: 'pricing.md', line: 2, snippet: 'Refund policy: 14 days' },
  { path: 'shared/notes/pricing.md', name: 'pricing.md', line: 7, snippet: 'see refund policy' },
]
const render = (res: FileContentHits, q = 'refund policy') => renderToStaticMarkup(<FileContentList res={res} query={q} folderLabel="shared" />)

describe('line matches', () => {
  test('the scope line, then each file with its lines; the whole query is marked', () => {
    setLocale('ko')
    const html = render({ items: LINES, ...none })
    expect(html.startsWith('<p class="px-2 pb-2 text-xs text-faint">')).toBe(true)
    expect(html).toContain(esc(translate('ko', 'files.search.scope', { q: 'refund policy', folder: 'shared' })))
    expect(html.match(/data-testid="content-hit-file"/g)).toHaveLength(1)
    expect(html.match(/data-testid="content-hit"/g)).toHaveLength(2)
    expect(html).toContain('<mark class="rounded-sm bg-accent-soft px-0.5 text-inherit">Refund policy</mark>')
    // markup in a line stays text
    expect(render({ items: [{ path: 'x.md', name: 'x.md', line: 1, snippet: '<img src=x onerror=alert(1)> refund policy' }], ...none })).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  test('an older server\'s document rows are not shown: the lines only', () => {
    setLocale('ko')
    const old = { items: LINES, ...none, documents: [{ path: 'finance/report.pdf', name: 'report.pdf', loc: { kind: 'page', page: 12 }, snippet: 'refund policy' }] } as FileContentHits
    const html = render(old)
    expect(html).toBe(render({ items: LINES, ...none }))
    expect(html).not.toContain('report.pdf')
  })

  test('a word no line has: "nothing found" in every language; a note about the search still shows', () => {
    for (const l of ['en', 'ko', 'id', 'ja', 'es'] as const) {
      setLocale(l)
      expect(render({ items: [], ...none }, 'zzqx'), l).toContain(esc(translate(l, 'files.search.none')))
    }
    setLocale('ko')
    const indexing = render({ items: [], ...none, indexing: 2 })
    expect(indexing).toContain(esc(translate('ko', 'files.search.indexing', { n: 2 })))
    expect(indexing).not.toContain(esc(translate('ko', 'files.search.none')))
  })
})

test('a click on a line opens its file', async () => {
  setLocale('en')
  installDom()
  // the side panel is a store other mounted screens listen to: opened and closed only while the test's DOM is there
  closeSidePanel()
  const m = await mount(<FileContentList res={{ items: LINES, ...none }} query="refund" folderLabel="shared" />)
  try {
    await m.click('content-hit')
    const p = getSidePanel()
    expect(p).toMatchObject({ kind: 'file', file: { source: 'team', path: 'shared/notes/pricing.md' } })
    expect(p?.kind === 'file' && p.file.source === 'team' && p.file.at).toBeFalsy()
  } finally {
    closeSidePanel()
    await m.unmount()
    removeDom()
  }
})
