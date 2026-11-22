// How a room's page lays out a thread and the ✦ side chat together (lib/roomColumns.ts;
// docs/decisions/20261117-thread-plus-trina.md): by the width of the page's own row.
import { expect, test } from 'bun:test'
import { THREAD_PANEL } from '../../src/lib/panelWidth'
import { PAIR_MIN, PANEL_MIN, ROOM_MIN, roomColumns, roomSqueezed, THREE_MIN } from '../../src/lib/roomColumns'

test('the minimums are the single panel\'s: the room 420, a panel 320', () => {
  expect([ROOM_MIN, PANEL_MIN]).toEqual([THREAD_PANEL.otherMin, THREAD_PANEL.min])
  expect([THREE_MIN, PAIR_MIN]).toEqual([1060, 640])
})

test('three columns from 1060, the two over the room from 640, one at a time below', () => {
  // 1440 and 1280 with the list folded, a 1512 window with the list
  for (const row of [1368, 1208, 1152, 1060]) expect(roomColumns(row)).toBe('three')
  // 1024, the desktop app's smallest window, a 768 window
  for (const row of [1059, 952, 828, 696, 640]) expect(roomColumns(row)).toBe('pair')
  // a phone, a small window with a file preview beside the page
  for (const row of [639, 508, 390, 1]) expect(roomColumns(row)).toBe('one')
})

test('not measured (a test without layout): as a wide row', () => {
  expect(roomColumns(null)).toBe('three')
  expect(roomColumns(0)).toBe('three')
})

test('one panel alone: a sheet over the room when the row leaves the room under 420 beside it (QA TC-r2b-06)', () => {
  // 1440 with the list and a 660 px file preview beside the page: 1440 - 72 - 288 - 660 = 420 (the room was one character)
  for (const row of [420, 600, 739]) expect(roomSqueezed(row)).toBe(true)
  // 740 holds the room's 420 and a 320 panel; wider rows keep the column beside the room
  for (const row of [740, 1080, 1368]) expect(roomSqueezed(row)).toBe(false)
  expect(roomSqueezed(null)).toBe(false)
  expect(roomSqueezed(0)).toBe(false)
})
