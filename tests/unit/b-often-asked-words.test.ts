// The fixed lists of "what my group often asks" (server/src/chat/often-asked-words.ts): the app's own prompts match
// what the web app puts in the box, in every language (a new wording there must come here too, or people's clicks on
// it would count as their questions); a word is read with its Korean ending off, a one-letter stem never stands for a
// word, and a plural is the same word.
import { describe, expect, test } from 'bun:test'
import { en } from '../../web/src/i18n/en'
import { ko } from '../../web/src/i18n/ko'
import { id } from '../../web/src/i18n/id'
import { ja } from '../../web/src/i18n/ja'
import { es } from '../../web/src/i18n/es'
import { APP_PROMPT_KEYS, APP_PROMPTS } from '../../server/src/chat/often-asked-words'
import { readWord, wordsOf } from '../../server/src/chat/often-asked'

describe('the lists', () => {
  test('the app\'s prompts are the web app\'s first lines, in every language', () => {
    for (const [locale, dict] of Object.entries({ en, ko, id, ja, es }))
      expect({ locale, prompts: APP_PROMPTS[locale as keyof typeof APP_PROMPTS] }).toEqual({ locale, prompts: APP_PROMPT_KEYS.map((k) => (dict as Record<string, string>)[k]!.split('\n')[0]!.trim()) })
  })

  test('how a sentence\'s words are read', () => {
    expect(wordsOf('회의록을 요약해 줘')).toEqual(['회의록을', '요약해', '줘'])
    expect(readWord('회의록을')).toEqual({ kind: 'task', unit: { cjk: true, s: '회의록' } })
    expect(readWord('줘').kind).toBe('stop')
    expect(readWord('checklists')).toEqual({ kind: 'task', unit: { cjk: false, s: 'checklist' } })
    expect(readWord('the').kind).toBe('stop')
    expect(readWord('acme')).toEqual({ kind: 'typed', ways: [[{ cjk: false, s: 'acme' }]] })
    // a one-letter stem is no way to read a word: such a word must be typed whole by 3+ people (as its two-letter pieces)
    expect(readWord('김이')).toEqual({ kind: 'typed', ways: [[{ cjk: true, s: '김이' }]] })
    expect(readWord('애크미사').kind).toBe('typed')
  })
})
