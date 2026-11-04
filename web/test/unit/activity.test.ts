// Admin > Activity log (lib/activity.ts): the filters kept in the address, the date presets as the API's [from, to)
// bounds, a path search for the server, the search over loaded rows, and the list grouped by day with repeats folded.
import { describe, expect, test } from 'bun:test'
import type { AuditEntry } from '@mycel/shared/api'
import { dayLabel, filtersActive, groupActivity, inSentence, matchesQuery, NO_FILTERS, pathQuery, rangeBounds, readFilters, RUN_GAP_MS, writeFilters } from '../../src/lib/activity'
import { localDayBounds } from '../../src/lib/format'

const entry = (id: string, at: Date, o: Partial<AuditEntry> = {}): AuditEntry => ({ id, source: 'auth', at: at.toISOString(), actor: { id: 'bob', name: 'Bob' }, action: 'auth.login', target: 'bob', turnId: null, detail: { ip: '10.0.0.7' }, ...o })

describe('filters in the address', () => {
  test('only what differs from the defaults is written, and it reads back the same', () => {
    expect(writeFilters(NO_FILTERS).toString()).toBe('')
    const f = { kind: 'auth', who: 'bob', q: 'finance/2026', range: 'custom', from: '2026-11-01', to: '2026-11-03' } as const
    expect(readFilters(writeFilters(f))).toEqual(f)
    expect(filtersActive(f)).toBe(true)
    expect(filtersActive(NO_FILTERS)).toBe(false)
  })
  test('anything unknown or malformed falls back to the default', () => {
    expect(readFilters(new URLSearchParams('kind=nope&range=year&from=yesterday&to=2026-13'))).toEqual({ ...NO_FILTERS, to: '' })
    // custom days are only kept with the custom range
    expect(writeFilters({ ...NO_FILTERS, range: '7d', from: '2026-11-01' }).toString()).toBe('range=7d')
  })
})

describe('time presets', () => {
  const now = new Date(2026, 10, 4, 15, 30)
  test('any time has no bounds; today, 7 and 30 days start at local midnight and have no end', () => {
    expect(rangeBounds({ range: 'any', from: '', to: '' }, now)).toEqual({})
    expect(rangeBounds({ range: 'today', from: '', to: '' }, now)).toEqual({ from: new Date(2026, 10, 4).toISOString(), to: undefined })
    expect(rangeBounds({ range: '7d', from: '', to: '' }, now)).toEqual({ from: new Date(2026, 9, 29).toISOString(), to: undefined })
    expect(rangeBounds({ range: '30d', from: '', to: '' }, now)).toEqual({ from: new Date(2026, 9, 6).toISOString(), to: undefined })
  })
  test('a custom range includes both days, as the old two date fields did', () => {
    expect(rangeBounds({ range: 'custom', from: '2026-10-01', to: '2026-10-29' }, now)).toEqual(localDayBounds('2026-10-01', '2026-10-29'))
  })
})

describe('search', () => {
  test('a folder path goes to the server; words and odd input do not', () => {
    expect(pathQuery('finance/2026')).toBe('finance/2026')
    expect(pathQuery('/skills/')).toBe('skills')
    expect(pathQuery('signed in')).toBeUndefined()
    expect(pathQuery('bob')).toBeUndefined()
    expect(pathQuery('a/../b')).toBeUndefined()
  })
  test('every word must match the person, the action in words, the item or the AI tool summary', () => {
    const e = entry('1', new Date(), { source: 'tool', action: 'read', target: null, detail: { summary: 'read hr/salaries.xlsx -> denied', ok: 0 } })
    expect(matchesQuery(e, 'bob salaries', 'read')).toBe(true)
    expect(matchesQuery(e, 'DENIED', 'read')).toBe(true)
    expect(matchesQuery(e, 'olga', 'read')).toBe(false)
    expect(matchesQuery(e, '  ', 'read')).toBe(true)
  })
  test('an action reads on after a name, acronyms and other scripts unchanged', () => {
    expect(inSentence('Signed in')).toBe('signed in')
    expect(inSentence('AI save to team skills declined')).toBe('AI save to team skills declined')
    expect(inSentence('로그인')).toBe('로그인')
  })
})

describe('grouped by day', () => {
  const now = new Date(2026, 10, 4, 12, 0)
  const min = 60_000
  test('repeats close together fold into one run; another person, another IP or a long gap does not', () => {
    const t = now.getTime()
    const items = [
      entry('a', new Date(t)),
      entry('b', new Date(t - 2 * min)),
      entry('c', new Date(t - 4 * min)),
      entry('d', new Date(t - 6 * min), { actor: { id: 'olga', name: 'Olga' }, target: 'olga' }),
      entry('e', new Date(t - 8 * min)),
      entry('f', new Date(t - 9 * min), { detail: { ip: '10.0.0.9' } }),
      entry('g', new Date(t - 9 * min - RUN_GAP_MS - min), { detail: { ip: '10.0.0.9' } }),
    ]
    const [day] = groupActivity(items)
    expect(day!.runs.map((r) => r.entries.map((e) => e.id).join(''))).toEqual(['abc', 'd', 'e', 'f', 'g'])
  })
  test('a new day starts a new group, and a run never crosses midnight', () => {
    const late = new Date(2026, 10, 4, 0, 5)
    const early = new Date(2026, 10, 3, 23, 58)
    const days = groupActivity([entry('a', late), entry('b', early)])
    expect(days.map((d) => d.day)).toEqual(['2026-11-04', '2026-11-03'])
  })
  test('days read Today, Yesterday, then the date (with the year only when it is another year)', () => {
    const words = { today: 'Today', yesterday: 'Yesterday' }
    expect(dayLabel('2026-11-04', 'en-US', words, now)).toBe('Today')
    expect(dayLabel('2026-11-03', 'en-US', words, now)).toBe('Yesterday')
    expect(dayLabel('2026-11-01', 'en-US', words, now)).toBe('Sun, Nov 1')
    expect(dayLabel('2025-12-31', 'en-US', words, now)).toContain('2025')
  })
})
