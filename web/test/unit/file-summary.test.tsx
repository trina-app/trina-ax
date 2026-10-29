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
      expect(html).toContain(esc(translate(locale, 'files.summary.rejectedLine', { path: 'finance/2026/q3.csv' })))
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
