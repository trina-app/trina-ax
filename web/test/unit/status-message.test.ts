// Status messages in the web app (docs/DECISIONS.md "상태 메시지"; lib/statusMessage.ts, store/statusMessages.ts): the
// dialog's emoji and suggestions are what the server takes, the words of when a status ends (the team's time zone), and
// what shows now (an ended status and one that starts later show nothing).
import { describe, expect, test } from 'bun:test'
import { isStatusEmoji } from '@mycel/shared'
import { StatusClear } from '@mycel/shared/api'
import { CLEAR_CHOICES, dayIn, STATUS_EMOJI, SUGGESTIONS, untilWords } from '../../src/lib/statusMessage'
import { liveStatus } from '../../src/store/statusMessages'
import { translate } from '../../src/i18n'

describe('what the dialog offers', () => {
  test('every emoji of the grid and of the suggestions is one the server takes', () => {
    for (const e of [...STATUS_EMOJI, ...SUGGESTIONS.map((s) => s.emoji)]) expect(isStatusEmoji(e)).toBe(true)
    expect(new Set(STATUS_EMOJI).size).toBe(STATUS_EMOJI.length)
  })
  test('the chips and the suggestions\' choices are the contract\'s', () => {
    for (const c of [...CLEAR_CHOICES, ...SUGGESTIONS.map((s) => s.clear)]) expect(StatusClear.safeParse(c).success).toBe(true)
    expect(CLEAR_CHOICES).toEqual(['30m', '1h', '2h', 'today', 'week', 'dates', 'never'])
    expect(SUGGESTIONS.map((s) => [s.emoji, translate('en', s.text), s.clear])).toEqual([
      ['📅', 'In a meeting', '1h'], ['🎧', 'Focusing', '2h'], ['🍽️', 'At lunch', '1h'], ['🤒', 'Out sick', 'today'], ['🏖️', 'On leave', 'dates'],
    ])
  })
})

describe('when it ends, in words', () => {
  const en = (k: Parameters<typeof translate>[1]) => translate('en', k)
  const ko = (k: Parameters<typeof translate>[1]) => translate('ko', k)
  // 2026-11-10 10:00 in Seoul
  const now = Date.parse('2026-11-10T01:00:00Z')
  test('the end of a day: today, or the day', () => {
    expect(untilWords({ untilDay: '2026-11-10', until: '2026-11-10T15:00:00.000Z' }, 'en', en, 'Asia/Seoul', now)).toBe('end of today')
    expect(untilWords({ untilDay: '2026-11-14', until: '2026-11-14T15:00:00.000Z' }, 'en', en, 'Asia/Seoul', now)).toBe('Nov 14')
    expect(untilWords({ untilDay: '2026-11-14', until: '2026-11-14T15:00:00.000Z' }, 'ko', ko, 'Asia/Seoul', now)).toBe('11월 14일')
  })
  test('a time: the time today, the day and time later; in the team\'s zone', () => {
    expect(untilWords({ until: '2026-11-10T02:00:00.000Z' }, 'en', en, 'Asia/Seoul', now)).toBe('11:00 AM')
    expect(untilWords({ until: '2026-11-10T16:00:00.000Z' }, 'en', en, 'Asia/Seoul', now)).toMatch(/^Nov 11(,| at) 1:00 AM$/)
    expect(untilWords({}, 'en', en, 'Asia/Seoul', now)).toBeNull()
    expect(dayIn(Date.parse('2026-11-10T15:30:00Z'), 'Asia/Seoul')).toBe('2026-11-11')
    expect(dayIn(Date.parse('2026-11-10T15:30:00Z'), 'UTC')).toBe('2026-11-10')
  })
})

describe('what shows now', () => {
  test('an ended status and one that starts later show nothing; the rest show', () => {
    const now = Date.parse('2026-11-10T01:00:00Z')
    expect(liveStatus({ emoji: '📅', text: 'In a meeting', until: '2026-11-10T00:59:59.000Z' }, now)).toBeNull()
    expect(liveStatus({ emoji: '📅', text: 'In a meeting', until: '2026-11-10T01:30:00.000Z' }, now)).not.toBeNull()
    expect(liveStatus({ emoji: '🏖️', text: 'On leave', clear: 'dates', fromDay: '2026-11-12', untilDay: '2026-11-14' }, now)).toBeNull()
    expect(liveStatus({ emoji: '🎧', text: '', clear: 'never' }, now)).not.toBeNull()
    expect(liveStatus(undefined, now)).toBeNull()
  })
})
