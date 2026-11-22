// B-W41-3 (I18N-01): a rejected write shows only the localized notice. The raw server reason (English tool or
// policy text) stays in the work steps and the server events. It never shows in the product notice.
import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { FileChangeSummary, Locale } from '@mycel/shared/api'
import { TOP_FOLDER_LABELS } from '@mycel/shared'
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
      expect(html).toContain(esc(translate(locale, 'files.summary.askOwnFolderFiles')))
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
  for (const locale of ['ko', 'en', 'id', 'ja', 'es', 'zh'] as const) {
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

// docs/decisions/20261121-ai-scratch-files.md: a long list keeps its first files; the rest come as a count per folder
describe('file summary: many files', () => {
  test('the header counts every file; the rest of the list is a line with the busiest folders', () => {
    setLocale('en')
    const f: FileChangeSummary = {
      saved: Array.from({ length: 100 }, (_, i) => ({ path: `projects/p/_tools/f${i}.txt`, action: 'create' as const })),
      conflicts: [], rejected: [],
      more: { count: 13081, folders: [{ path: 'projects/p/_tools/icons', count: 13000 }, { path: 'projects/p/_tools/x', count: 81 }] },
    }
    const html = render(f)
    expect(html).toContain(esc(translate('en', 'files.summary.saved', { n: 13181 })))
    expect(html).toContain('data-testid="file-summary-more"')
    expect(html).toContain(esc(translate('en', 'files.summary.more', { n: 13081, folders: 2 })))
    expect((html.match(/<li class="flex items-center gap-2">/g) ?? []).length).toBe(100)
  })
})

// QA TC-7337: the rows showed raw paths (projects/QA284-scratch/notes/note-092.txt) and the overflow read "50 more files
// in 1 folder, for example:" then "Projects › QA284-scratch › notes: 50"
describe('file summary: friendly names, the count first', () => {
  for (const locale of ['ko', 'en', 'id', 'ja', 'es', 'zh'] as const) {
    test(`${locale}: each file by its place in words (path on hover); the rest as a count, then "count · folder" rows`, () => {
      setLocale(locale)
      const f: FileChangeSummary = {
        saved: Array.from({ length: 100 }, (_, i) => ({ path: `projects/QA284-scratch/notes/note-${String(i).padStart(3, '0')}.txt`, action: 'create' as const })),
        conflicts: [], rejected: [],
        more: { count: 50, folders: [{ path: 'projects/QA284-scratch/notes', count: 50 }] },
      }
      const html = render(f)
      const projects = TOP_FOLDER_LABELS.projects[locale]
      expect(html).toContain('title="projects/QA284-scratch/notes/note-092.txt"')
      expect(html).toContain(esc(`${projects} › QA284-scratch › notes › note-092.txt`))
      expect(html).not.toContain('>projects/QA284-scratch/notes/note-092.txt<')
      expect(html).not.toMatch(/for example|예:|misalnya|例：|por ejemplo|例如/)
      const more = esc(translate(locale, 'files.summary.more', { n: 50, folders: 1 }))
      const row = esc(translate(locale, 'files.summary.moreFolder', { n: 50, path: `${projects} › QA284-scratch › notes` }))
      expect(html).toContain(more)
      expect(html).toContain(row)
      expect(html.indexOf(more)).toBeLessThan(html.indexOf(row))
      // the count leads the row
      expect(translate(locale, 'files.summary.moreFolder', { n: 50, path: 'X' }).indexOf('50')).toBeLessThan(translate(locale, 'files.summary.moreFolder', { n: 50, path: 'X' }).indexOf('X'))
    })
  }

  test('past 5 folders: the 5 busiest by name, then how many more', () => {
    setLocale('en')
    const folders = Array.from({ length: 8 }, (_, i) => ({ path: `shared/f${i}`, count: 10 - i }))
    const html = render({ saved: Array.from({ length: 100 }, (_, i) => ({ path: `shared/x${i}.txt`, action: 'create' as const })), conflicts: [], rejected: [], more: { count: 60, folders } })
    expect(html).toContain(esc(translate('en', 'files.summary.moreFolders', { n: 3 })))
    expect(html).not.toContain('f5')
  })
})
