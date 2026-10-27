import { expect, test } from 'bun:test'
import { localDayRange } from '../../src/lib/format'

test('an inclusive calendar selection includes the final millisecond and excludes next midnight', () => {
  const range = localDayRange('2026-12-30', '2026-12-31')
  expect(range.from).toBe(new Date(2026, 11, 30).toISOString())
  expect(range.to).toBe(new Date(2027, 0, 1).toISOString())
  expect(Date.parse(range.to) - new Date(2026, 11, 31, 23, 59, 59, 999).getTime()).toBe(1)
})

test('daylight-saving calendar days retain 23-hour and 25-hour boundaries', () => {
  const previous = process.env.TZ
  try {
    process.env.TZ = 'America/New_York'
    for (const [date, hours] of [['2026-03-08', 23], ['2026-11-01', 25]] as const) {
      const range = localDayRange(date, date)
      expect((Date.parse(range.to) - Date.parse(range.from)) / 3600_000).toBe(hours)
    }
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous }
})
