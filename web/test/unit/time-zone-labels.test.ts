// The team time zone picker's words (lib/time-zones.ts): city and offset, common zones first, a search, the IANA value kept.
import { expect, test } from 'bun:test'
import { COMMON_ZONES, zoneGroups, zoneLabel } from '../../src/lib/time-zones'

const at = new Date('2026-11-14T00:00:00Z')

test('a label is the city and the UTC offset in the page language, not the IANA name', () => {
  expect(zoneLabel('Asia/Seoul', 'en', at)).toBe('Seoul (UTC+9)')
  expect(zoneLabel('Asia/Seoul', 'ko', at)).toBe('서울 (UTC+9)')
  expect(zoneLabel('Asia/Tokyo', 'ja', at)).toBe('東京 (UTC+9)')
  expect(zoneLabel('America/New_York', 'es', at)).toBe('Nueva York (UTC-5)')
  expect(zoneLabel('Asia/Singapore', 'id', at)).toBe('Singapura (UTC+8)')
  expect(zoneLabel('America/Argentina/Buenos_Aires', 'en', at)).toBe('Buenos Aires (UTC-3)')
  // a zone outside the common list is its IANA city in every language, so Paris and Berlin never read the same
  expect(zoneLabel('Europe/Paris', 'ko', at)).toBe('Paris (UTC+1)')
  expect(zoneLabel('Europe/Berlin', 'ko', at)).toBe('Berlin (UTC+1)')
  expect(zoneLabel('Africa/Abidjan', 'en', at)).toBe('Abidjan (UTC+0)')
  expect(zoneLabel('UTC')).toBe('UTC')
  expect(zoneLabel('Not/AZone')).toBe('Not/AZone')
})

test('the common zones come first, every other zone after, none twice', () => {
  const g = zoneGroups('Asia/Seoul', 'en', '', null)
  expect(g.common.map((c) => c.value)).toEqual(COMMON_ZONES)
  expect(g.other.length).toBeGreaterThan(100)
  const all = [...g.common, ...g.other].map((c) => c.value)
  expect(new Set(all).size).toBe(all.length)
  expect(g.other.some((c) => c.value === 'Africa/Abidjan' && c.label === 'Abidjan (UTC+0)')).toBe(true)
})

test('a saved or browser zone outside the common list is on top; the value stays the IANA name', () => {
  const g = zoneGroups('Asia/Kolkata', 'en', '', 'Europe/Paris')
  expect(g.common.slice(0, 2).map((c) => c.value)).toEqual(['Asia/Kolkata', 'Europe/Paris'])
  expect(g.other.some((c) => c.value === 'Asia/Kolkata' || c.value === 'Europe/Paris')).toBe(false)
  expect(zoneGroups('Moon/Base', 'en', '', null).common[0]).toEqual({ value: 'Moon/Base', label: 'Moon/Base' })
})

test('the search matches the city in the page language, the IANA name and the offset; the current zone stays', () => {
  const values = (q: string, locale = 'en', cur = 'Asia/Seoul') => { const g = zoneGroups(cur, locale, q, null); return [...g.common, ...g.other].map((c) => c.value) }
  expect(values('los angeles')).toContain('America/Los_Angeles')
  expect(values('Ho Chi')).toContain('Asia/Ho_Chi_Minh')
  expect(values('서울', 'ko')).toContain('Asia/Seoul')
  expect(values('asia/kol')).toContain('Asia/Kolkata')
  expect(values('utc+5:30')).toContain('Asia/Kolkata')
  expect(values('zzzz')).toEqual(['Asia/Seoul'])
  expect(zoneGroups('Asia/Seoul', 'en', 'zzzz', null).none).toBe(true)
  expect(zoneGroups('Asia/Seoul', 'en', 'seoul', null).none).toBe(false)
  expect(zoneGroups('Asia/Seoul', 'en', '', null).none).toBe(false)
})
