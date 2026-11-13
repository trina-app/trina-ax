// Phase P3 of the new navigation (docs/AGENTS/plan/20261112-1839-nav-rail.md): the rules under 활동's and 대화's lists
// beside the rail. 활동's chips sort the notices that are not conversations (lib/activityKinds.ts), unread first; 대화
// lists every room by kind (panels/RoomsByKind.tsx) and draws long lists in budgets.
import { describe, expect, test } from 'bun:test'
import { chipOf, chipsFor, inChip, unreadFirst } from '../../src/lib/activityKinds'
import { ROOMS_BUDGET, roomsByKind, rowsToDraw } from '../../src/components/panels/RoomsByKind'
import type { Room } from '@mycel/shared/api'

describe('활동: 전체 · 트리나 · 요청', () => {
  test("트리나 is the AI's own work, 요청 what waits for an answer, the rest is under 전체 only", () => {
    expect(chipOf({ code: 'schedule.success' })).toBe('trina')
    expect(chipOf({ code: 'schedule.failure' })).toBe('trina')
    expect(chipOf({ code: 'skill.suggested' })).toBe('requests')
    expect(chipOf({ code: 'connection.reconnect' })).toBe('requests')
    expect(chipOf({ code: 'service.request' })).toBe('requests')
    expect(chipOf({ code: 'team.joined' })).toBeNull()
    expect(inChip({ code: 'team.joined' }, 'all')).toBe(true)
    expect(inChip({ code: 'team.joined' }, 'trina')).toBe(false)
  })
  test('요청 is for the owner and admins only', () => {
    expect(chipsFor(true)).toEqual(['all', 'trina', 'requests'])
    expect(chipsFor(false)).toEqual(['all', 'trina'])
  })
  test('unread first, newest first in each part', () => {
    const n = (id: string, at: string, read: boolean) => ({ id, createdAt: at, readAt: read ? at : null })
    const { unread, read } = unreadFirst([n('a', '2026-11-01', true), n('b', '2026-11-03', false), n('c', '2026-11-02', false), n('d', '2026-11-04', true)])
    expect(unread.map((x) => x.id)).toEqual(['b', 'c'])
    expect(read.map((x) => x.id)).toEqual(['d', 'a'])
    // one read while the list is open stays on top
    const kept = unreadFirst([n('a', '2026-11-01', true), n('b', '2026-11-03', true)], (x) => x.id === 'b' || !x.readAt)
    expect(kept.unread.map((x) => x.id)).toEqual(['b'])
  })
})

const room = (id: string, kind: Room['kind'], o: Partial<Room> = {}) => ({ id, kind, name: id, pinnedAt: null, ...o }) as unknown as Room

describe('대화: every room by kind, no cap', () => {
  test('고정 first, then 팀 대화방 (전체 first, by name), 그룹 대화, 1:1 대화; a pin is only under 고정', () => {
    const rooms = [room('dm1', 'dm'), room('t-b', 'team'), room('g1', 'group'), room('all', 'all'), room('t-a', 'team'), room('dm2', 'dm', { pinnedAt: '2026-11-10T00:00:00Z' })]
    const s = roomsByKind(rooms, (r) => r.id, 'ko')
    expect(s.map((x) => [x.key, x.rooms.map((r) => r.id)])).toEqual([
      ['pinned', ['dm2']],
      ['team', ['all', 't-a', 't-b']],
      ['group', ['g1']],
      ['dm', ['dm1']],
    ])
  })
  test('300 rooms: all are listed, 200 drawn first; the room on screen is always drawn', () => {
    const many = Array.from({ length: 300 }, (_, i) => room(`d${i}`, 'dm'))
    expect(roomsByKind(many, (r) => r.id, 'ko')[0]!.rooms).toHaveLength(300)
    expect(rowsToDraw(ROOMS_BUDGET, -1)).toBe(200)
    expect(rowsToDraw(ROOMS_BUDGET, 250)).toBe(251)
  })
})
