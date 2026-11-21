// How the AI addresses the person in Spanish and Indonesian (server/src/chat/prompt.ts ADDRESS_RULE): formally, usted
// and Anda, as the app's own words do (owner decision 3 of the 11-22 demo QA; the AI said tú and kamu, the app usted and
// Anda). Every es/id team gets it, not only the demo. The other languages' answer line stays as it was, and LANGUAGE
// (also used where the AI writes in the person's own voice) names only the language.
import { describe, expect, test } from 'bun:test'
import { ADDRESS_RULE, answerLanguageLine, LANGUAGE } from '../../server/src/chat/prompt'

describe('the formal register for es and id', () => {
  test('es: usted; id: Anda; in the main answer and in a sub-agent report', () => {
    for (const subagent of [false, true]) {
      expect(answerLanguageLine('es', subagent)).toContain('address the user formally as usted (never tú)')
      expect(answerLanguageLine('id', subagent)).toContain('address the user formally as Anda (never kamu or aku)')
    }
    expect(ADDRESS_RULE.es).toContain('When you answer in Spanish')
    expect(ADDRESS_RULE.id).toContain('When you answer in Indonesian')
  })

  test('the other languages get no register line, and LANGUAGE stays the language name only', () => {
    for (const l of ['en', 'ko', 'ja', 'zh'] as const) {
      expect(answerLanguageLine(l)).not.toContain('address the user')
      expect(ADDRESS_RULE[l]).toBeUndefined()
    }
    expect(LANGUAGE.es).toBe('Español')
    expect(LANGUAGE.id).toBe('Indonesian (Bahasa Indonesia)')
  })
})
