// Admin Home's line for a release waiting for this server's turn in its staged roll-out (src/lib/updateTurn.ts): the
// window the turn falls in, or the next one, by the day it starts in the team's zone.
import { describe, expect, test } from 'bun:test'
import { turnWhen } from '../../src/lib/updateTurn'

const NOW = new Date('2026-11-04T05:00:00Z') // 14:00 in Seoul, 2026-11-04
const day = (iso: string) => new Date(`${iso}T00:00:00Z`)

describe('turnWhen', () => {
  test('a turn before tonight\'s window: that window; after it: the next one; further: the date', () => {
    // 03:00-05:00 Seoul. Turn at 20:00 Seoul today: the window tomorrow at dawn
    expect(turnWhen('2026-11-04T11:00:00Z', '03:00-05:00', 'Asia/Seoul', NOW)).toEqual({ day: 'tomorrow', date: day('2026-11-05') })
    // turn at 02:00 Seoul tomorrow: that dawn's window, tomorrow
    expect(turnWhen('2026-11-04T17:00:00Z', '03:00-05:00', 'Asia/Seoul', NOW)).toEqual({ day: 'tomorrow', date: day('2026-11-05') })
    // turn inside the window (03:30 Seoul on the 6th): that window, two days on
    expect(turnWhen('2026-11-05T18:30:00Z', '03:00-05:00', 'Asia/Seoul', NOW)).toEqual({ day: 'date', date: day('2026-11-06') })
    // turn at 10:00 Seoul on the 6th, after that day's window: the 7th
    expect(turnWhen('2026-11-06T01:00:00Z', '03:00-05:00', 'Asia/Seoul', NOW)).toEqual({ day: 'date', date: day('2026-11-07') })
    // an evening window today, the turn this afternoon at 16:00: tonight
    expect(turnWhen('2026-11-04T07:00:00Z', '22:00-23:00', 'Asia/Seoul', NOW)).toEqual({ day: 'today', date: day('2026-11-04') })
  })
  test('a window over midnight: a turn after midnight inside it belongs to the window that started the evening before', () => {
    // 23:00-01:00 Seoul; turn at 00:30 Seoul on the 6th: the window of the 5th
    expect(turnWhen('2026-11-05T15:30:00Z', '23:00-01:00', 'Asia/Seoul', NOW)).toEqual({ day: 'tomorrow', date: day('2026-11-05') })
    // turn at 01:30 on the 6th (after it): the window of the 6th
    expect(turnWhen('2026-11-05T16:30:00Z', '23:00-01:00', 'Asia/Seoul', NOW)).toEqual({ day: 'date', date: day('2026-11-06') })
  })
  test('the team\'s zone decides the day, not the browser\'s', () => {
    // 2026-11-05T01:00Z is 10:00 on the 5th in Seoul (after 03:00-05:00: the 6th) and 20:00 on the 4th in New York (before
    // the 5th's 03:00: the 5th)
    expect(turnWhen('2026-11-05T01:00:00Z', '03:00-05:00', 'Asia/Seoul', NOW)?.date).toEqual(day('2026-11-06'))
    expect(turnWhen('2026-11-05T01:00:00Z', '03:00-05:00', 'America/New_York', NOW)).toEqual({ day: 'tomorrow', date: day('2026-11-05') })
  })
  test('what cannot be read says nothing', () => {
    expect(turnWhen('soon', '03:00-05:00', 'Asia/Seoul', NOW)).toBeNull()
    expect(turnWhen('2026-11-05T01:00:00Z', '3am', 'Asia/Seoul', NOW)).toBeNull()
    expect(turnWhen('2026-11-05T01:00:00Z', '04:00-04:00', 'Asia/Seoul', NOW)).toBeNull()
    expect(turnWhen('2026-11-05T01:00:00Z', '03:00-05:00', 'Not/AZone', NOW)).toBeNull()
  })
})
