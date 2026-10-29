// Admin > Activity log date filters (QA R2-PERM-14): each date input is optional and both are inclusive calendar days.
// The server reads query.from as "at >= from" and query.to as "at < to" (server/src/admin/audit.ts).
import { expect, test } from 'bun:test'
import { localDayBounds } from '../../src/lib/format'

test('no dates give no bounds', () => {
  expect(localDayBounds('', '')).toEqual({ from: undefined, to: undefined })
})

test('a start date alone starts at local midnight of that day', () => {
  expect(localDayBounds('2026-10-29', '')).toEqual({ from: new Date(2026, 9, 29).toISOString(), to: undefined })
})

test('an end date alone ends at local midnight of the next day', () => {
  expect(localDayBounds('', '2026-12-31')).toEqual({ from: undefined, to: new Date(2027, 0, 1).toISOString() })
})

test('both dates include the whole end day', () => {
  expect(localDayBounds('2026-10-01', '2026-10-29')).toEqual({ from: new Date(2026, 9, 1).toISOString(), to: new Date(2026, 9, 30).toISOString() })
})

test('a daylight-saving day keeps its 25 hours', () => {
  const previous = process.env.TZ
  try {
    process.env.TZ = 'America/New_York'
    const r = localDayBounds('2026-11-01', '2026-11-01')
    expect((Date.parse(r.to!) - Date.parse(r.from!)) / 3600_000).toBe(25)
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous }
})
