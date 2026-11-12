// When a usage limit can be used again (shared/src/limit-reset.ts): 24-hour time in every language, so the midnight a
// limit ends at never reads as noon ("오전 12:00", "12:00 AM"; QA TC-215). Korean names the hour alone.
import { expect, test } from 'bun:test'
import { limitResetText } from '@mycel/shared'
import { periodEnd } from '../../server/src/admin/budgets'

test('a limit that ends at midnight reads as midnight, in each language and in the team\'s time zone', () => {
  // 2026-11-12 00:00 in Seoul
  const midnight = new Date('2026-11-11T15:00:00Z')
  expect(limitResetText(midnight, 'ko', 'Asia/Seoul')).toBe('11월 12일 0시')
  expect(limitResetText(midnight, 'en', 'Asia/Seoul')).toBe('Nov 12 at 00:00')
  expect(limitResetText(midnight, 'ja', 'Asia/Seoul')).toBe('11月12日 00:00')
  for (const l of ['id', 'es'] as const) expect(limitResetText(midnight, l, 'Asia/Seoul')).toMatch(/12.*00[.:]00/)
  for (const l of ['ko', 'en', 'id', 'ja', 'es'] as const) expect(limitResetText(midnight, l, 'Asia/Seoul')).not.toMatch(/오전|AM|PM|午前|12[.:]00/)
  // the end of a day's and of a month's limit, as the server works it out
  const now = new Date('2026-11-30T05:00:00Z')
  expect(limitResetText(periodEnd('day', now, 'Asia/Seoul'), 'ko', 'Asia/Seoul')).toBe('12월 1일 0시')
  expect(limitResetText(periodEnd('month', now, 'America/New_York'), 'en', 'America/New_York')).toBe('Dec 1 at 00:00')
  // an afternoon hour stays in 24-hour time
  expect(limitResetText(new Date('2026-11-12T05:30:00Z'), 'ko', 'Asia/Seoul')).toBe('11월 12일 14시')
})
