// Pinned conversations (docs/DECISIONS.md "Pinned conversations"; components/rooms/RoomMenu.tsx, nav/RoomsList.tsx,
// pages/Rooms.tsx):
// - the order: my pinned rooms first, the most recently pinned first, then the others by latest activity; by kind
//   (docs/DECISIONS.md "Conversations by kind under Show more", the 대화 panel's sections) the pins first in their own
//   kind's section;
// - the phone's 대화 tab (the conversations page): every pin, then the others;
// - a pinned row has the pin after its name; the "⋯" pins (POST) and unpins (DELETE), my other windows follow the
//   server's room.updated; hiding unpins at once, and its undo pins it again.
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { type Me, type Room } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { RoomMenu } from '../../src/components/rooms/RoomMenu'
import { roomSections } from '../../src/components/nav/RoomsList'
import { pinnedFirst, pinnedRooms } from '../../src/lib/rooms'
import RoomsPage from '../../src/pages/Rooms'
import { useRooms, withHidden } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import { useUi } from '../../src/store/ui'
import { installDom, mount, removeDom, type FakeElement } from './dom-host'
import { at, ME, room } from './rooms-fixtures'

setDefaultTimeout(30_000)
const ko = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('ko', k, p)
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })
const me = { user: { id: ME.id, username: ME.id, name: ME.name, email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} }, groups: [],
  team: { name: 'Acme', defaultLocale: 'ko' }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: false } } as unknown as Me

const sent: { key: string; body: unknown }[] = []
const realFetch = globalThis.fetch
const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
let pinClock = Date.parse('2026-11-09T09:00:00.000Z')
/** PUT …/hidden answers 500 */
let refuseHide = false
/** a computer's width (false: a phone's) */
let wide = true
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  ;(globalThis as Record<string, unknown>).matchMedia = (q: string) => ({ matches: wide ? q === '(min-width: 768px)' || q === '(any-pointer: fine)' : q === '(max-width: 767.98px)', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
  // the server's answers: the room as it is in the store, pinned, unpinned, hidden or shown
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    sent.push({ key, body })
    const m = /^(POST|DELETE|PUT) \/api\/rooms\/([^/]+)\/(pin|hidden)$/.exec(key)
    const r = m && useRooms.getState().rooms.find((x) => x.id === m[2])
    if (!m || !r) return json({ error: { code: 'not_found', message: key } }, 404)
    const { pinnedAt: _p, hidden: _h, ...rest } = r
    if (m[3] === 'hidden' && refuseHide) return json({ error: { code: 'internal', message: 'no' } }, 500)
    if (m[3] === 'pin') return json(m[1] === 'POST' ? { ...rest, ...(r.hidden ? { hidden: true } : {}), pinnedAt: new Date((pinClock += 1000)).toISOString() } : { ...rest, ...(r.hidden ? { hidden: true } : {}) })
    return json(body.hidden ? { ...rest, hidden: true } : { ...rest, ...(r.pinnedAt ? { pinnedAt: r.pinnedAt } : {}) })
  }) as unknown as typeof fetch
})
afterEach(() => {
  wide = true
  sent.length = 0
  refuseHide = false
  useRooms.getState().reset()
  useSession.setState({ status })
})
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale })
})

const body = (m: { container: FakeElement }) => m.container.ownerDocument!.body
const menuItems = (m: { container: FakeElement }) => body(m).querySelectorAll('[role="menuitem"]').map((x) => x.textContent)
/** a pin `min` minutes after a fixed moment (bigger: pinned later) */
const pinned = (min: number) => new Date(Date.parse('2026-11-08T09:00:00.000Z') + min * 60_000).toISOString()

describe('the order', () => {
  test('pinned first, the most recently pinned first, then the others as they came (by activity)', () => {
    const a = room({ name: 'a', activityAt: at(5) }), b = room({ name: 'b', activityAt: at(4), pinnedAt: pinned(1) })
    const c = room({ name: 'c', activityAt: at(3) }), d = room({ name: 'd', activityAt: at(2), pinnedAt: pinned(2) })
    expect(pinnedRooms([a, b, c, d]).map((r) => r.name)).toEqual(['d', 'b'])
    expect(pinnedFirst([a, b, c, d]).map((r) => r.name)).toEqual(['d', 'b', 'a', 'c'])
    expect(pinnedFirst([a, c]).map((r) => r.name)).toEqual(['a', 'c'])
  })

  test('by kind: the pins first in their own kind\'s section, then 전체, the team rooms by name, group chats and DMs by activity', () => {
    const kinds = ['team', 'dm', 'group', 'all', 'team'] as const
    const pins = [room({ kind: 'dm', name: 'p0', activityAt: at(100), pinnedAt: pinned(0) }), room({ kind: 'group', name: 'p1', activityAt: at(99), pinnedAt: pinned(1) }), room({ name: 'p2', activityAt: at(98), pinnedAt: pinned(2) })]
    const rest = Array.from({ length: 5 }, (_, i) => room({ kind: kinds[i], name: `r${4 - i}`, activityAt: at(50 - i) }))
    const list = [...rest, ...pins].sort((x, y) => y.activityAt.localeCompare(x.activityAt))
    const sections = roomSections(list, (r) => r.name!, 'ko')
    // r4 (team), r3 (dm), r2 (group), r1 (all), r0 (team)
    expect(sections.map((s) => [s.section, s.rooms.map((r) => r.name)])).toEqual([['team', ['p2', 'r1', 'r0', 'r4']], ['group', ['p1', 'r2']], ['dm', ['p0', 'r3']]])
    // every room once
    expect(sections.flatMap((s) => s.rooms).map((r) => r.id).sort()).toEqual(list.map((r) => r.id).sort())
  })

  test('by kind: the team rooms by the title their rows show, compared in the app\'s language with numbers by value; 전체 first even renamed', () => {
    const ALL = room({ kind: 'all', name: null, groupId: null })
    const rs = [room({ name: 'cherry' }), room({ name: 'Banana' }), ALL, room({ name: 'apple' }), room({ name: 'Ápple' })]
    const titleOf = (r: Room) => r.name ?? 'Everyone'
    // localeCompare, not code points (which would put "Banana" before "apple")
    expect(roomSections(rs, titleOf, 'en')[0]!.rooms.map(titleOf)).toEqual(['Everyone', 'apple', 'Ápple', 'Banana', 'cherry'])
    expect(roomSections([room({ name: 'Zeta' }), { ...ALL, name: 'Zzz announcements' }], titleOf, 'en')[0]!.rooms.map(titleOf)).toEqual(['Zzz announcements', 'Zeta'])
    expect(roomSections([], titleOf, 'en')).toEqual([])
    // numbers by their value, not digit by digit: "팀 2" before "팀 10" (and in Korean, Hangul before Latin letters)
    const numbered = ['팀 10', '팀 2', '팀 1', 'Q12 계획', 'Q3 계획'].map((name) => room({ name }))
    expect(roomSections(numbered, titleOf, 'ko')[0]!.rooms.map(titleOf)).toEqual(['팀 1', '팀 2', '팀 10', 'Q3 계획', 'Q12 계획'])
  })

  test('hiding a room takes its pin off at once (withHidden)', () => {
    const a = room({ pinnedAt: pinned(1) })
    const d = { rooms: [a], openRoomId: null, timeline: null, threadViews: {} }
    const h = withHidden(d, a.id, true).rooms[0]!
    expect([h.hidden, 'pinnedAt' in h]).toEqual([true, false])
  })
})

describe('the lists', () => {
  test('the phone\'s 대화 tab: every pin, then the others, the pin after the name; a hidden room is in neither', async () => {
    wide = false
    useSession.setState({ status: { kind: 'signed-in', me } } as never)
    const list = [room({ name: '새 소식', activityAt: at(9) }), room({ name: '고정 A', activityAt: at(1), pinnedAt: pinned(1) }), room({ name: '숨김', activityAt: at(10), hidden: true }),
      room({ name: '오래된 방', activityAt: at(2) }), room({ name: '고정 B', activityAt: at(0), pinnedAt: pinned(2) })]
    useRooms.setState({ rooms: list.sort((x, y) => y.activityAt.localeCompare(x.activityAt)), loaded: true, failed: null })
    const m = await mount(<MemoryRouter initialEntries={['/rooms']}><Routes><Route path="/rooms" element={<RoomsPage />} /></Routes></MemoryRouter>)
    try {
      const rows = body(m).querySelectorAll('[data-testid="rooms-row"]')
      const names = ['고정 B', '고정 A', '새 소식', '오래된 방']
      expect(rows.map((x) => names.find((n) => x.textContent!.startsWith(n)))).toEqual(names)
      expect(rows.map((x) => !!x.querySelector('[data-testid="room-pin-icon"]'))).toEqual([true, true, false, false])
      expect(rows[0]!.querySelector('[data-testid="room-pin-icon"]')!.getAttribute('aria-label')).toBe(ko('chat.pinned'))
    } finally { await m.unmount() }
  })
})

describe('the menu', () => {
  test('상단에 고정 first: POST, the row has the server\'s pin; 고정 해제: DELETE', async () => {
    useSession.setState({ status: { kind: 'signed-in', me } } as never)
    const r = room({ kind: 'dm', name: null, groupId: null })
    useRooms.setState({ rooms: [r], loaded: true })
    const Menu = () => <RoomMenu room={useRooms((s) => s.rooms[0]!)} />
    const m = await mount(<MemoryRouter><Menu /></MemoryRouter>)
    try {
      await m.click('room-menu')
      expect(menuItems(m)[0]).toBe(ko('chat.pin'))
      await m.click('room-menu-pin')
      await m.until(() => !!useRooms.getState().rooms[0]!.pinnedAt, 'the server\'s pin')
      expect(sent.map((s) => s.key)).toEqual([`POST /api/rooms/${r.id}/pin`])
      await m.click('room-menu')
      expect(menuItems(m)[0]).toBe(ko('chat.unpin'))
      await m.click('room-menu-unpin')
      await m.until(() => !useRooms.getState().rooms[0]!.pinnedAt, 'unpinned')
      expect(sent.map((s) => s.key)).toEqual([`POST /api/rooms/${r.id}/pin`, `DELETE /api/rooms/${r.id}/pin`])
    } finally { await m.unmount() }
  })

  test('hiding a pinned room unpins it; the toast\'s undo shows it and pins it again', async () => {
    useSession.setState({ status: { kind: 'signed-in', me } } as never)
    const r = room({ kind: 'team', pinnedAt: pinned(1) })
    useRooms.setState({ rooms: [r], loaded: true })
    const Menu = () => <RoomMenu room={useRooms((s) => s.rooms[0]!)} />
    const m = await mount(<MemoryRouter><Menu /></MemoryRouter>)
    try {
      await m.click('room-menu')
      await m.click('room-menu-hide')
      await m.until(() => sent.length === 1, 'the PUT')
      expect(useRooms.getState().rooms[0]!.pinnedAt).toBeUndefined()
      // the hidden room's menu: no pin, 다시 보이기 at the end
      await m.click('room-menu')
      expect(menuItems(m)).toEqual([ko('rooms.menu.notify'), ko('rooms.menu.copyLink'), ko('rooms.menu.show')])
      const toast = useUi.getState().toasts.at(-1)!
      toast.action!.run()
      await m.until(() => sent.length === 3, 'shown and pinned again')
      expect(sent.map((s) => s.key)).toEqual([`PUT /api/rooms/${r.id}/hidden`, `PUT /api/rooms/${r.id}/hidden`, `POST /api/rooms/${r.id}/pin`])
      await m.until(() => !!useRooms.getState().rooms[0]!.pinnedAt && !useRooms.getState().rooms[0]!.hidden, 'pinned again')
    } finally { await m.unmount() }
  })

  test('a refused hide puts the room back as it was, its pin too', async () => {
    const r = room({ kind: 'dm', name: null, groupId: null, pinnedAt: pinned(4) })
    useRooms.setState({ rooms: [r], loaded: true })
    refuseHide = true
    await expect(useRooms.getState().setHidden(r.id, true)).rejects.toBeTruthy()
    const back = useRooms.getState().rooms[0]!
    expect([back.hidden, back.pinnedAt]).toEqual([undefined, pinned(4)])
  })

  test('my other window: the server\'s room.updated brings the pin', () => {
    const r = room()
    useRooms.setState({ rooms: [r], loaded: true })
    const at1 = pinned(3)
    useRooms.getState().handleEvent({ type: 'room.updated', data: { roomId: r.id, change: 'updated', room: { ...r, pinnedAt: at1 } } } as never)
    expect(useRooms.getState().rooms[0]!.pinnedAt).toBe(at1)
  })
})
