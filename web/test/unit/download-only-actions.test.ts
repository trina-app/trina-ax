// A download-only (quarantined) file has no "Ask AI" / "add to chat" in the file panel, and the panel says why in all
// five languages (QA 2026-10-30: the button was shown, and the AI then refused the file).
import { expect, test } from 'bun:test'
import { chatActionsFor } from '../../src/components/FilePanel'
import { DICTS } from '../../src/i18n'

test('chat actions: team files only, never a missing or download-only file', () => {
  expect(chatActionsFor({ source: 'team' }, null, false)).toBe(true)
  expect(chatActionsFor({ source: 'team' }, { kind: 'unsupported' }, false)).toBe(true)
  expect(chatActionsFor({ source: 'team' }, { kind: 'unsupported' }, true)).toBe(false)
  expect(chatActionsFor({ source: 'team' }, { kind: 'missing' }, false)).toBe(false)
  expect(chatActionsFor({ source: 'local' }, null, false)).toBe(false)
})

test('the download-only reason exists in every language', () => {
  for (const l of ['ko', 'en', 'id', 'ja', 'es'] as const) expect((DICTS[l] as Record<string, string>)['files.askAiDownloadOnly']?.length).toBeGreaterThan(20)
})
