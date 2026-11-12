// The Files search's results (src/components/FileContentSearch.tsx FileContentList): the exact-line matches, grouped
// by file, under the scope line. A word that no line has says "nothing found" (QA TC-061). The knowledge graph's
// document rows were removed (docs/DECISIONS.md, 2026-11-11): an answer that still carries `documents` (an older
// server) shows only its lines.
import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { FileContentHits, FileEntry, Locale } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { useState } from 'react'
import { FileContentList, FileNameList, FileNameResults } from '../../src/components/FileContentSearch'
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

// QA TC-260: files and folders whose name holds the words come first ("로고" finds 로고.png), then the lines
describe('names first', () => {
  const entry = (p: string, type: 'file' | 'folder' = 'file'): FileEntry => ({ name: p.slice(p.lastIndexOf('/') + 1), path: p, type, size: type === 'file' ? 10 : null, mtime: '2026-11-11T00:00:00.000Z', mime: null, access: 'read' })
  const NAMES = [entry('shared/brand/로고 모음', 'folder'), entry('shared/brand/로고.png'), entry('견적서.pdf')]
  const names = (items: FileEntry[], q = '로고', truncated = false, onFolder = (_: string) => {}) =>
    renderToStaticMarkup(<FileNameList items={items} truncated={truncated} query={q} onFolder={onFolder} />)

  test('each file and folder in the order the server gave (folders first), the name marked, its folder beside it', () => {
    setLocale('ko')
    const html = names(NAMES)
    expect(html).toContain(esc(translate('ko', 'files.search.names', { q: '로고' })))
    expect(html.match(/data-testid="name-hit"/g)).toHaveLength(3)
    expect(html.indexOf('title="shared/brand/로고 모음"')).toBeLessThan(html.indexOf('title="shared/brand/로고.png"'))
    expect(html).toContain('<mark class="rounded-sm bg-accent-soft px-0.5 text-inherit">로고</mark><span>.png</span>')
    expect(html).toContain('title="shared/brand/로고.png"')
    // a file in the team folder itself has no folder line
    expect(html).not.toContain('title="견적서.pdf"')
    expect(names(NAMES, '로고', true)).toContain(esc(translate('ko', 'files.search.namesTruncated', { n: 3 })))
  })

  test('no name matches: nothing (the lines below say "nothing found")', () => {
    expect(names([])).toBe('')
  })

  test('a file opens in the side panel; a folder opens in the list', async () => {
    setLocale('en')
    installDom()
    closeSidePanel()
    const opened: string[] = []
    try {
      const m = await mount(<FileNameList items={[entry('shared/brand/로고.png')]} truncated={false} query="로고" onFolder={(p) => opened.push(p)} />)
      await m.click('name-hit')
      expect(getSidePanel()).toMatchObject({ kind: 'file', file: { source: 'team', path: 'shared/brand/로고.png' } })
      expect(opened).toEqual([])
      closeSidePanel()
      await m.unmount()
      const f = await mount(<FileNameList items={[entry('shared/brand', 'folder')]} truncated={false} query="brand" onFolder={(p) => opened.push(p)} />)
      await f.click('name-hit')
      expect(opened).toEqual(['shared/brand'])
      expect(getSidePanel()).toBeNull()
      await f.unmount()
    } finally {
      closeSidePanel()
      removeDom()
    }
  })

  test('while the answer for new words is on its way, the last names are dimmed, labelled with their own words and not clickable (rev12)', async () => {
    setLocale('en')
    installDom()
    closeSidePanel()
    const realFetch = globalThis.fetch
    const asked: string[] = []
    let release: (() => void) | null = null
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const q = new URL(String(input), 'http://x').searchParams.get('q') ?? ''
      asked.push(q)
      // the second search ("견적") waits until the test lets it go
      if (q === '견적') await new Promise<void>((r) => { release = r })
      const items = q === '로고' ? [entry('shared/brand/로고.png')] : [entry('shared/견적서.pdf')]
      return new Response(JSON.stringify({ items, truncated: false }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    function Box() {
      const [q, setQ] = useState('로고')
      return (<><input data-testid="q" value={q} onChange={(e) => setQ(e.target.value)} /><FileNameResults q={q} path="" onFolder={() => {}} /></>)
    }
    try {
      const m = await mount(<Box />)
      await m.until(() => m.find('name-hit'), 'the 로고 names')
      expect(m.get('name-search').getAttribute('data-stale')).toBeNull()
      await m.type('q', '견적')
      await m.until(() => asked.includes('견적'), 'the 견적 search')
      const old = m.get('name-search')
      expect(old.getAttribute('data-stale')).toBe('true')
      expect(old.getAttribute('class')).toContain('opacity-60')
      // the heading still names the words that found these names, not the new ones
      expect(m.html()).toContain(esc(translate('en', 'files.search.names', { q: '로고' })))
      expect(m.html()).not.toContain(esc(translate('en', 'files.search.names', { q: '견적' })))
      await m.click('name-hit')
      expect(getSidePanel()).toBeNull()
      release!()
      await m.until(() => m.find('name-search')?.getAttribute('data-stale') === null && m.html().includes('견적서.pdf'), 'the 견적 names')
      expect(m.html()).toContain(esc(translate('en', 'files.search.names', { q: '견적' })))
      await m.click('name-hit')
      expect(getSidePanel()).toMatchObject({ kind: 'file', file: { source: 'team', path: 'shared/견적서.pdf' } })
      await m.unmount()
    } finally {
      globalThis.fetch = realFetch
      closeSidePanel()
      removeDom()
    }
  })
})
