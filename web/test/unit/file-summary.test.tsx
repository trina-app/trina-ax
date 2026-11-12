// B-W41-3 (I18N-01): a rejected write shows only the localized notice. The raw server reason (English tool or
// policy text) stays in the work steps and the server events. It never shows in the product notice.
import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { FileChangeSummary, Locale } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import FileSummary from '../../src/components/chat/FileSummary'

const RAW = 'path is read-only for this user'
const files = (path: string): FileChangeSummary => ({ saved: [], conflicts: [], rejected: [{ path, reason: RAW }] })
const render = (f: FileChangeSummary) => renderToStaticMarkup(<FileSummary files={f} onAskOwnFolder={() => {}} defaultOpen />)
// React escapes text: compare with the same escaping
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')
// Server rendering reads the store's initial state, not the current state: set the language there
const setLocale = (l: Locale) => Object.assign(useLocaleStore.getInitialState(), { locale: l })
const before = useLocaleStore.getInitialState().locale

afterEach(() => setLocale(before))

describe('file summary: rejected write notice', () => {
  for (const locale of ['ko', 'en', 'id'] as const) {
    test(`${locale}: localized line, no raw reason`, () => {
      setLocale(locale)
      const html = render(files('finance/2026/q3.csv'))
      // the place in words (no raw path), the path on hover
      expect(html).toContain(esc(translate(locale, 'files.summary.rejectedLine', { path: 'finance › 2026 › q3.csv' })))
      expect(html).toContain('title="finance/2026/q3.csv"')
      expect(html).toContain(esc(translate(locale, 'files.summary.askOwnFolder')))
      expect(html).not.toContain(RAW)
    })

    test(`${locale}: hidden path, localized line, no raw reason`, () => {
      setLocale(locale)
      const html = render(files(''))
      expect(html).toContain(esc(translate(locale, 'files.summary.rejectedHidden')))
      expect(html).not.toContain(RAW)
    })
  }
})

describe('file summary: moved files (QA TC-018)', () => {
  for (const locale of ['ko', 'en', 'id', 'ja', 'es'] as const) {
    test(`${locale}: a moved file says it moved; a new one and a changed one say so`, () => {
      setLocale(locale)
      const html = render({ saved: [{ path: 'shared/2026/a.md', action: 'create', moved: true }, { path: 'shared/2026/b.md', action: 'create' }, { path: 'shared/c.md', action: 'update' }], conflicts: [], rejected: [] })
      expect(html).toContain(esc(translate(locale, 'files.summary.saved', { n: 3 })))
      const labels = [...html.matchAll(/<span class="w-14[^"]*">([^<]*)<\/span>/g)].map((m) => m[1])
      expect(labels).toEqual([translate(locale, 'files.summary.moved'), translate(locale, 'files.summary.created'), translate(locale, 'files.summary.updated')].map(esc))
      expect(new Set(labels).size).toBe(3)
    })
  }
})
