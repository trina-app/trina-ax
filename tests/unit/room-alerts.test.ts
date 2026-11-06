// The one rule for room alerts (shared/src/api/room-alerts.ts, docs/DECISIONS.md "대화방 알림 설정"): the server's room
// notices, the pushes and the web app's sound all use these functions. Levels × room kinds × mentions × threads, and
// quiet hours across midnight, on weekends and in the team's time zone.
import { expect, test } from 'bun:test'
import { inQuietHours, QuietHours, QUIET_HOURS_DEFAULT, roomAlert, roomLevel, zonedClock, type RoomAlertInput } from '../../shared/src/api/room-alerts'

test('a room\'s level: its own when set, else my default for its kind', () => {
  const kinds = ['dm', 'group', 'team', 'all', 'some-later-kind'] as const
  const want: Record<string, Record<string, string>> = {
    direct: { dm: 'all', group: 'all', team: 'mentions', all: 'mentions', 'some-later-kind': 'all' },
    all: { dm: 'all', group: 'all', team: 'all', all: 'all', 'some-later-kind': 'all' },
    none: { dm: 'off', group: 'off', team: 'off', all: 'off', 'some-later-kind': 'off' },
  }
  for (const def of ['direct', 'all', 'none'] as const) for (const k of kinds) expect({ def, k, level: roomLevel(k, null, def) as string }).toEqual({ def, k, level: want[def]![k]! })
  // a room's own level wins over every default, 'none' included
  for (const def of ['direct', 'all', 'none'] as const) for (const own of ['all', 'mentions', 'off'] as const) for (const k of kinds) expect(roomLevel(k, own, def)).toBe(own)
  // an older server (no default known): today's behaviour
  expect(roomLevel('team', null, undefined)).toBe('mentions')
  expect(roomLevel('dm', undefined, null)).toBe('all')
})

test('what a message is to me: mentions and followed threads count at every level but off; the rest only at all', () => {
  const base: RoomAlertInput = { level: 'all', mentioned: false, reply: false, alsoInRoom: false, following: false, threadReplies: true }
  const at = (o: Partial<RoomAlertInput>) => roomAlert({ ...base, ...o })
  // a message of the timeline
  expect(at({ level: 'all' })).toBe('message')
  expect(at({ level: 'mentions' })).toBeNull()
  expect(at({ level: 'off' })).toBeNull()
  // a mention
  expect(at({ level: 'all', mentioned: true })).toBe('mention')
  expect(at({ level: 'mentions', mentioned: true })).toBe('mention')
  expect(at({ level: 'off', mentioned: true })).toBeNull()
  // a reply that stays in its thread: only for its followers (and the people it mentions), whatever the level
  expect(at({ level: 'all', reply: true })).toBeNull()
  expect(at({ level: 'all', reply: true, following: true })).toBe('message')
  expect(at({ level: 'mentions', reply: true, following: true })).toBe('message')
  expect(at({ level: 'off', reply: true, following: true })).toBeNull()
  expect(at({ level: 'mentions', reply: true, mentioned: true })).toBe('mention')
  // my thread-replies switch off: a followed reply is quiet, a mention in it is not
  expect(at({ level: 'all', reply: true, following: true, threadReplies: false })).toBeNull()
  expect(at({ level: 'mentions', reply: true, following: true, threadReplies: false, mentioned: true })).toBe('mention')
  // a reply sent to the room too counts as a message of the room for everyone else
  expect(at({ level: 'all', reply: true, alsoInRoom: true })).toBe('message')
  expect(at({ level: 'mentions', reply: true, alsoInRoom: true })).toBeNull()
  expect(at({ level: 'all', reply: true, alsoInRoom: true, following: true, threadReplies: false })).toBe('message')
})

test('quiet hours: from start up to end, across midnight, all weekend when asked, in the given time zone', () => {
  const at = (iso: string) => Date.parse(iso)
  const night = { on: true, start: '22:00', end: '08:00', weekends: false }
  // 2026-11-04 is a Wednesday. Asia/Seoul is UTC+9 (no daylight saving)
  const seoul = (local: string) => at(`2026-11-04T${local}:00+09:00`)
  expect(inQuietHours(night, 'Asia/Seoul', seoul('21:59'))).toBe(false)
  expect(inQuietHours(night, 'Asia/Seoul', seoul('22:00'))).toBe(true)
  expect(inQuietHours(night, 'Asia/Seoul', seoul('23:59'))).toBe(true)
  expect(inQuietHours(night, 'Asia/Seoul', seoul('00:00'))).toBe(true)
  expect(inQuietHours(night, 'Asia/Seoul', seoul('07:59'))).toBe(true)
  expect(inQuietHours(night, 'Asia/Seoul', seoul('08:00'))).toBe(false)
  expect(inQuietHours(night, 'Asia/Seoul', seoul('12:30'))).toBe(false)
  // a window inside one day
  const lunch = { on: true, start: '12:00', end: '13:30', weekends: false }
  expect(inQuietHours(lunch, 'Asia/Seoul', seoul('11:59'))).toBe(false)
  expect(inQuietHours(lunch, 'Asia/Seoul', seoul('12:00'))).toBe(true)
  expect(inQuietHours(lunch, 'Asia/Seoul', seoul('13:29'))).toBe(true)
  expect(inQuietHours(lunch, 'Asia/Seoul', seoul('13:30'))).toBe(false)
  // off, or nothing set: never quiet
  expect(inQuietHours({ ...night, on: false }, 'Asia/Seoul', seoul('23:00'))).toBe(false)
  expect(inQuietHours(null, 'Asia/Seoul', seoul('23:00'))).toBe(false)
  expect(inQuietHours(QUIET_HOURS_DEFAULT, 'Asia/Seoul', seoul('23:00'))).toBe(false)
  // the same moment is 23:00 in Seoul and 06:00 (same day) in Los Angeles (UTC-8 in November): the team's zone decides
  const moment = seoul('23:00')
  expect(inQuietHours(night, 'Asia/Seoul', moment)).toBe(true)
  expect(inQuietHours(night, 'America/Los_Angeles', moment)).toBe(true)
  expect(inQuietHours(lunch, 'Asia/Seoul', moment)).toBe(false)
  const noonSeoul = seoul('12:15')
  expect(inQuietHours(lunch, 'Asia/Seoul', noonSeoul)).toBe(true)
  expect(inQuietHours(lunch, 'America/Los_Angeles', noonSeoul)).toBe(false) // 19:15 the day before there
  expect(inQuietHours(night, 'America/Los_Angeles', noonSeoul)).toBe(false)
  // across daylight saving: Los Angeles is UTC-7 in July
  expect(zonedClock(at('2026-07-01T05:30:00Z'), 'America/Los_Angeles')).toEqual({ weekday: 2, minute: 22 * 60 + 30 })
  expect(inQuietHours(night, 'America/Los_Angeles', at('2026-07-01T05:30:00Z'))).toBe(true)
  // an unknown zone reads as UTC
  expect(zonedClock(at('2026-11-04T23:10:00Z'), 'Not/AZone')).toEqual({ weekday: 3, minute: 23 * 60 + 10 })
  expect(inQuietHours(night, 'Not/AZone', at('2026-11-04T23:10:00Z'))).toBe(true)
  // weekends: all of Saturday and Sunday in the team's zone (2026-11-07 is a Saturday)
  const weekend = { on: true, start: '22:00', end: '08:00', weekends: true }
  expect(inQuietHours(weekend, 'Asia/Seoul', at('2026-11-07T14:00:00+09:00'))).toBe(true)
  expect(inQuietHours(weekend, 'Asia/Seoul', at('2026-11-08T14:00:00+09:00'))).toBe(true)
  expect(inQuietHours(weekend, 'Asia/Seoul', at('2026-11-06T14:00:00+09:00'))).toBe(false) // Friday afternoon
  expect(inQuietHours(weekend, 'Asia/Seoul', at('2026-11-09T07:00:00+09:00'))).toBe(true) // Monday early: the night window
  expect(inQuietHours(weekend, 'Asia/Seoul', at('2026-11-09T09:00:00+09:00'))).toBe(false)
  expect(inQuietHours(night, 'Asia/Seoul', at('2026-11-07T14:00:00+09:00'))).toBe(false) // without weekends
  // Saturday 01:00 in Seoul is Friday 08:00 in Los Angeles: not the weekend there
  expect(inQuietHours({ ...weekend, start: '20:00', end: '21:00' }, 'America/Los_Angeles', at('2026-11-07T01:00:00+09:00'))).toBe(false)
  expect(inQuietHours({ ...weekend, start: '20:00', end: '21:00' }, 'Asia/Seoul', at('2026-11-07T01:00:00+09:00'))).toBe(true)
})

test('quiet hours as the API takes them: HH:MM, start and end differ, nothing else', () => {
  expect(QuietHours.safeParse({ on: true, start: '22:00', end: '08:00', weekends: false }).success).toBe(true)
  expect(QuietHours.safeParse({ on: true, start: '00:00', end: '23:59', weekends: true }).success).toBe(true)
  for (const bad of [
    { on: true, start: '22:00', end: '22:00', weekends: false },
    { on: true, start: '24:00', end: '08:00', weekends: false },
    { on: true, start: '7:00', end: '08:00', weekends: false },
    { on: true, start: '22:00', end: '08:00', weekends: false, timeZone: 'UTC' },
    { on: true, start: '22:00', end: '08:00' },
  ]) expect(QuietHours.safeParse(bad).success).toBe(false)
})
