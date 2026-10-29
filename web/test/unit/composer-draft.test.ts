import { describe, expect, test } from 'bun:test'
import { mergeDraft } from '../../src/lib/composerDraft'
import { translate } from '../../src/i18n'

describe('recovery drafts', () => {
  for (const locale of ['ko', 'en', 'id'] as const) {
    test(`${locale}: prepare, merge verbatim, and do not duplicate repeated requests`, () => {
      const request = translate(locale, 'files.summary.askOwnFolderPrompt', { path: 'shared/guide.md', folder: 'users/alice' })
      expect(request).toContain('shared/guide.md')
      expect(request).toContain('users/alice')
      expect(mergeDraft('', request)).toBe(request)
      const existing = '  Keep this draft.\nAnd this line.  '
      const merged = mergeDraft(existing, request)
      expect(merged).toBe(`${existing}\n\n${request}`)
      expect(mergeDraft(merged, request)).toBe(merged)
      expect(mergeDraft(request, request)).toBe(request)
      expect(mergeDraft(existing, '')).toBe(existing)
      const other = translate(locale, 'files.summary.askOwnFolderPrompt', { path: 'shared/other.md', folder: 'users/alice' })
      expect(mergeDraft(merged, other)).toBe(`${merged}\n\n${other}`)
      // A person can remove the request and prepare it again.
      expect(mergeDraft(existing, request)).toBe(merged)
    })
    test(`${locale}: hidden-path request does not invent a source path`, () => {
      const request = translate(locale, 'files.summary.askOwnFolderHiddenPrompt', { folder: 'users/alice' })
      expect(request).toContain('users/alice')
      expect(request).not.toContain('{path}')
      expect(request).not.toContain('-')
    })
  }
})
