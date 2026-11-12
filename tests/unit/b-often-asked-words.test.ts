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
import { holds, readWord, saidOf, wordsOf } from '../../server/src/chat/often-asked'

describe('the lists', () => {
  test('the app\'s prompts are the web app\'s first lines, in every language', () => {
    for (const [locale, dict] of Object.entries({ en, ko, id, ja, es }))
      expect({ locale, prompts: APP_PROMPTS[locale as keyof typeof APP_PROMPTS] }).toEqual({ locale, prompts: APP_PROMPT_KEYS.map((k) => (dict as Record<string, string>)[k]!.split('\n')[0]!.trim()) })
  })

  test('how a sentence\'s words are read', () => {
    expect(wordsOf('회의록을 요약해 줘')).toEqual(['회의록을', '요약해', '줘'])
    expect(readWord('회의록을')).toEqual({ kind: 'topic', forms: [{ cjk: true, s: '회의록을' }, { cjk: true, s: '회의록' }] })
    expect(readWord('요약해').kind).toBe('generic')
    expect(readWord('줘').kind).toBe('stop')
    expect(readWord('the').kind).toBe('stop')
    expect(readWord('summarize').kind).toBe('generic')
    // nouns are topics, never free: "report", "resume", "meeting" must come from the people
    for (const w of ['report', 'resume', 'interview', 'meeting', 'acme']) expect({ w, kind: readWord(w).kind }).toEqual({ w, kind: 'topic' })
    // a one-letter stem is no form: such a word must be typed whole
    expect(readWord('김이')).toEqual({ kind: 'topic', forms: [{ cjk: true, s: '김이' }] })
  })

  test('a typed word holds a sentence word only as it is, its plural, or a longer word of theirs (never shorter)', () => {
    const said = (t: string) => saidOf(t)
    expect(holds(said('weekly reporting please'), { cjk: false, s: 'report' })).toBe(true)
    expect(holds(said('reports'), { cjk: false, s: 'report' })).toBe(true)
    expect(holds(said("will you write it"), { cjk: false, s: 'williams' })).toBe(false)
    expect(holds(said('sales contract'), { cjk: false, s: 'salesforce' })).toBe(false)
    expect(holds(said('회의록 좀 요약'), { cjk: true, s: '회의록' })).toBe(true)
    expect(holds(said('삼성 성전 전자'), { cjk: true, s: '삼성전자' })).toBe(false)
  })
})
