// share_with_person's "someone else's file" refusal names the button under the answer as the app shows it
// (server/src/chat/share-words.ts SHARE_NO.notOwner; the 2026-11-17 scenario catalog, SHR-02.project): in a shared chat
// the owner's name is left out, and the AI must not quote a button label ("Ask the owner") the app does not show.
import { describe, expect, test } from 'bun:test'
import { SHARE_NO } from '../../server/src/chat/share-words'
import { DICTS } from '../../web/src/i18n'

describe('the "ask the owner" next step', () => {
  test('own chat: the button by its label with the owner\'s name', () => {
    expect(SHARE_NO.notOwner('a.pdf', 'Sora', 'owner')).toContain('an "Ask Sora" button')
  })
  test('shared chat (no name): no quoted label, the button described', () => {
    const t = SHARE_NO.notOwner('a.pdf', null, 'owner')
    expect(t).not.toContain('"Ask the owner"')
    expect(t).toContain("a button that asks the file's owner")
    // the app has no button called "Ask the owner"
    expect(Object.values(DICTS.en)).not.toContain('Ask the owner')
  })
  test('ask an admin stays quoted', () => {
    expect(SHARE_NO.notOwner('a.pdf', null, 'admin')).toContain('an "Ask an admin" button')
  })
})
