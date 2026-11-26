// Phase P3 of the new navigation (docs/AGENTS/plan/20261112-1839-nav-rail.md): the rules under 활동's and 대화's lists
// beside the rail. 활동's chips sort every notice, the one Activity (lib/activityKinds.ts), unread first; 대화
// lists every room by kind (panels/RoomsByKind.tsx) and draws long lists in budgets.
import { describe, expect, test } from 'bun:test'
import { chipOf, chipOfParam, chipsFor, inChip, isServerChip, unreadFirst } from '../../src/lib/activityKinds'
import { ROOMS_BUDGET, roomsByKind, rowsToDraw } from '../../src/components/panels/RoomsByKind'
import type { Room } from '@mycel/shared/api'

describe('활동: 전체 · DM · 멘션 · 스레드 · 트리나 · 요청', () => {
  test("트리나 is the AI's own work, 요청 what waits for an answer, the rest is under 전체 only", () => {
    expect(chipOf({ code: 'schedule.success' })).toBe('trina')
    expect(chipOf({ code: 'schedule.failure' })).toBe('trina')
    expect(chipOf({ code: 'skill.suggested' })).toBe('requests')
    expect(chipOf({ code: 'connection.reconnect' })).toBe('requests')
    // a team template no longer for me: nothing to do, under 전체 only (QA TC-2980)
    expect(chipOf({ code: 'integration.template_reconnect' })).toBe('requests')
    expect(chipOf({ code: 'integration.template_reconnect', templateLeft: true })).toBeNull()
    expect(chipOf({ code: 'service.request' })).toBe('requests')
    expect(chipOf({ code: 'team.joined' })).toBeNull()
    expect(inChip({ code: 'team.joined' }, 'all')).toBe(true)
    expect(inChip({ code: 'team.joined' }, 'trina')).toBe(false)
  })
  test('요청 is for the owner and admins only (and a member while an ask of theirs is listed)', () => {
    expect(chipsFor(true)).toEqual(['all', 'dms', 'mentions', 'threads', 'trina', 'requests'])
    expect(chipsFor(false)).toEqual(['all', 'dms', 'mentions', 'threads', 'trina'])
    expect(chipsFor(false, [{ code: 'file.access_requested' }])).toEqual(['all', 'dms', 'mentions', 'threads', 'trina', 'requests'])
  })
  test("the conversation chips follow the server's tab rule; Mark all as read only where the server reads the tab", () => {
    const at = (kind: 'team' | 'dm' | 'group', o: object = {}) => ({ id: 'r', kind, reason: 'mention', ...o }) as never
    const mention = { code: 'room.mention', room: at('team') } as const
    const dmMention = { code: 'room.mention', room: at('dm') } as const
    const threadReply = { code: 'room.dm', room: at('team', { reason: 'reply', thread: 'm1' }) } as const
    const chatReply = { code: 'chat.thread_reply', chatThread: { mention: false } as never } as const
    expect(inChip(mention, 'mentions')).toBe(true)
    expect(inChip(mention, 'dms')).toBe(false)
    expect(inChip(dmMention, 'dms')).toBe(true)
    expect(inChip(threadReply, 'threads')).toBe(true)
    expect(inChip(threadReply, 'mentions')).toBe(false)
    expect(inChip(chatReply, 'threads')).toBe(true)
    // the app's own notice is under 전체 and its own chip, never a conversation chip
    expect(inChip({ code: 'schedule.success' }, 'mentions')).toBe(false)
    expect(inChip({ code: 'schedule.success' }, 'trina')).toBe(true)
    expect(inChip(mention, 'trina')).toBe(false)
    expect(['all', 'dms', 'mentions', 'threads'].every((c) => isServerChip(c as never))).toBe(true)
    expect(isServerChip('trina')).toBe(false)
    expect(isServerChip('requests')).toBe(false)
    expect(chipOfParam('mentions')).toBe('mentions')
    expect(chipOfParam('nope')).toBeNull()
    expect(chipOfParam(null)).toBeNull()
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
  test('고정 first, then 채널 (전체 first, by name; named group rooms are private channels among them), then 다이렉트 메시지: 1:1s and unnamed group rooms together by latest activity; a pin is only under 고정', () => {
    // in the store's order, latest activity first: g1 (no name) between dm1 and dm3; p-c a named group room
    const rooms = [room('dm1', 'dm'), room('t-b', 'team'), room('g1', 'group', { name: null }), room('p-c', 'group'), room('all', 'all'), room('t-a', 'team'), room('g2', 'group', { name: '  ' }), room('dm3', 'dm'), room('dm2', 'dm', { pinnedAt: '2026-11-10T00:00:00Z' })]
    const s = roomsByKind(rooms, (r) => r.id, 'ko')
    expect(s.map((x) => [x.key, x.rooms.map((r) => r.id)])).toEqual([
      ['pinned', ['dm2']],
      ['team', ['all', 'p-c', 't-a', 't-b']],
      ['dm', ['dm1', 'g1', 'g2', 'dm3']],
    ])
  })

  test('renaming moves a group room: a name puts it under 채널, clearing it brings it back to 다이렉트 메시지', () => {
    const before = [room('t-a', 'team'), room('g1', 'group', { name: null }), room('dm1', 'dm')]
    const where = (rs: Room[]) => roomsByKind(rs, (r) => r.id, 'ko').find((x) => x.rooms.some((r) => r.id === 'g1'))!.key
    expect(where(before)).toBe('dm')
    const named = before.map((r) => (r.id === 'g1' ? { ...r, name: 'Launch' } : r))
    expect(where(named)).toBe('team')
    expect(where(named.map((r) => (r.id === 'g1' ? { ...r, name: null } : r)))).toBe('dm')
  })

  test('300 rooms: all are listed, 200 drawn first; the room on screen is always drawn', () => {
    const many = Array.from({ length: 300 }, (_, i) => room(`d${i}`, 'dm'))
    expect(roomsByKind(many, (r) => r.id, 'ko')[0]!.rooms).toHaveLength(300)
    expect(rowsToDraw(ROOMS_BUDGET, -1)).toBe(200)
    expect(rowsToDraw(ROOMS_BUDGET, 250)).toBe(251)
  })
})
