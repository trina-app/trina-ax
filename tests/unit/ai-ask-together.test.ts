// ask_user's description (server/src/chat/tools.ts): asked "그 견적서 다시 보내줘", the AI asked which quote but guessed
// where it goes (AI scenario CHT-02, 2026-11-17): what is unclear is asked in one question, not guessed.
import { expect, test } from 'bun:test'
import { B_TOOL_DESCRIPTIONS } from '../../server/src/chat/tools'

test('ask_user: more than one unclear thing in one question, not guessed', () => {
  expect(B_TOOL_DESCRIPTIONS.ask_user).toContain('When more than one thing is unclear (which file, and to whom or where), ask about all of them in this one question')
  expect(B_TOOL_DESCRIPTIONS.ask_user).toContain('rather than guessing the rest')
})
