// The day in the team's time zone (lib/format.ts zoneDay): a one-time task's default day in the edit dialog
// (ScheduleEditDialog). Not the UTC day, which in Jakarta is still "yesterday" until 07:00 (QA TC-075).
import { expect, test } from 'bun:test'
import { localDay, zoneDay } from '../../src/lib/format'

test('the day in a time zone, not the UTC day', () => {
  // 2026-11-10 23:30 UTC is already 2026-11-11 in Jakarta (+7) and Seoul (+9), still 2026-11-10 in New York
  const at = new Date('2026-11-10T23:30:00Z')
  expect(zoneDay(at, 'Asia/Jakarta')).toBe('2026-11-11')
  expect(zoneDay(at, 'Asia/Seoul')).toBe('2026-11-11')
  expect(zoneDay(at, 'America/New_York')).toBe('2026-11-10')
  expect(zoneDay(new Date('2026-01-01T00:00:00Z'), 'UTC')).toBe('2026-01-01')
})

test('no zone, or an unknown one: the person\'s own day', () => {
  const now = new Date()
  expect(zoneDay(now, null)).toBe(localDay(now))
  expect(zoneDay(now, 'Not/AZone')).toBe(localDay(now))
})
