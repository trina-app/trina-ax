// The schedule card's "Schedule:" line (server/src/tools/schedules.ts scheduleWhen): a one-time task's day in the
// person's words, never the stored "2026-11-10", and never shifted by the server's time zone (QA TC-092).
import { expect, test } from 'bun:test'
import { scheduleCard, scheduleWhen } from '../../server/src/tools/schedules'

const once = { repeat: 'once' as const, time: '16:39', date: '2026-11-10' }

test('a one-time day in the five languages, not the stored form', () => {
  expect(scheduleWhen(once, 'en')).toContain('Nov 10, 2026')
  for (const L of ['en', 'ko', 'id', 'ja', 'es'] as const) {
    const when = scheduleWhen(once, L)
    expect(when, L).not.toContain('2026-11-10')
    expect(when, L).toContain('16:39')
    expect(when, L).toContain('2026')
  }
})

test('the first and last day of a year stay the same day', () => {
  expect(scheduleWhen({ ...once, date: '2026-01-01' }, 'en')).toContain('Jan 1, 2026')
  expect(scheduleWhen({ ...once, date: '2026-12-31' }, 'en')).toContain('Dec 31, 2026')
})

test('the card shows the day in words', () => {
  const c = scheduleCard({ title: 'Check CI', prompt: 'Remind me to check CI.', ...once }, [], 'en')
  expect(c.question).toContain('Nov 10, 2026')
  expect(c.question).not.toContain('2026-11-10')
})
