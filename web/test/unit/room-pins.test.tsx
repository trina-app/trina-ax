// Pinned conversations (docs/DECISIONS.md "Pinned conversations"; components/rooms/RoomMenu.tsx, SidebarRooms.tsx,
// pages/Rooms.tsx):
// - the order: my pinned rooms first, the most recently pinned first, then the others by latest activity; the sidebar
//   shows at most ten pins above the five latest of the others (and the room on screen), "더 보기" the rest;
// - the conversations page (and the phone's 대화 tab): the AI's row first, then every pin, then the others;
// - a pinned row has the pin after its name; the "⋯" pins (POST) and unpins (DELETE), my other windows follow the
//   server's room.updated; hiding unpins at once, and its undo pins it again.
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { type Me, type Room } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { RoomMenu } from '../../src/components/rooms/RoomMenu'
import { PINS_SHOWN, ROOMS_SHOWN, SidebarRooms, sidebarRows } from '../../src/components/rooms/SidebarRooms'
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
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  ;(globalThis as Record<string, unknown>).matchMedia = (q: string) => ({ matches: q === '(min-width: 768px)' || q === '(any-pointer: fine)', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
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

  test(`the sidebar: at most ${PINS_SHOWN} pins above the ${ROOMS_SHOWN} latest others, the room on screen wherever it is; opened: all`, () => {
    const pins = Array.from({ length: 12 }, (_, i) => room({ name: `p${i}`, activityAt: at(100 - i), pinnedAt: pinned(i) }))
    const rest = Array.from({ length: 7 }, (_, i) => room({ name: `r${i}`, activityAt: at(50 - i) }))
    const list = [...rest, ...pins].sort((x, y) => y.activityAt.localeCompare(x.activityAt))
    const names = (rs: Room[]) => rs.map((r) => r.name)
    // p11 is the most recently pinned: first; p0 and p1, pinned first, wait behind "더 보기"
    expect(names(sidebarRows(list, null))).toEqual(['p11', 'p10', 'p9', 'p8', 'p7', 'p6', 'p5', 'p4', 'p3', 'p2', 'r0', 'r1', 'r2', 'r3', 'r4'])
    // the room on screen stays, in its own part
    expect(names(sidebarRows(list, pins[0]!.id))).toContain('p0')
    expect(names(sidebarRows(list, rest[6]!.id)).slice(-1)).toEqual(['r6'])
    expect(names(sidebarRows(list, null, true))).toEqual([...names([...pins].reverse()), ...names(rest)])
  })

  test('hiding a room takes its pin off at once (withHidden)', () => {
    const a = room({ pinnedAt: pinned(1) })
    const d = { rooms: [a], openRoomId: null, timeline: null, threadView: null }
    const h = withHidden(d, a.id, true).rooms[0]!
    expect([h.hidden, 'pinnedAt' in h]).toEqual([true, false])
  })
})

describe('the lists', () => {
  test('the sidebar: pinned rows first with the pin after the name, "더 보기" counts the rest', async () => {
    useSession.setState({ status: { kind: 'signed-in', me } } as never)
    const list = [room({ name: '최근 1', activityAt: at(9) }), room({ name: '고정 A', activityAt: at(1), pinnedAt: pinned(1) }),
      ...Array.from({ length: 5 }, (_, i) => room({ name: `방 ${i + 1}`, activityAt: at(8 - i) })), room({ name: '고정 B', activityAt: at(0), pinnedAt: pinned(2) })]
    useRooms.setState({ rooms: list.sort((x, y) => y.activityAt.localeCompare(x.activityAt)), loaded: true, failed: null })
    try { localStorage.removeItem('mycel.sidebar.roomsAll') } catch { /* none */ }
    const m = await mount(<MemoryRouter initialEntries={['/']}><SidebarRooms onNavigate={() => {}} /></MemoryRouter>)
    try {
      const rows = () => body(m).querySelectorAll('[data-testid="sidebar-room-row"]')
      expect(rows().map((x) => x.querySelector('[data-testid="sidebar-room"]')!.textContent)).toEqual(['고정 B', '고정 A', '최근 1', '방 1', '방 2', '방 3', '방 4'])
      // the pin on the pinned rows only, named for screen readers
      expect(rows().map((x) => !!x.querySelector('[data-testid="room-pin-icon"]'))).toEqual([true, true, false, false, false, false, false])
      expect(rows()[0]!.querySelector('[data-testid="room-pin-icon"]')!.getAttribute('aria-label')).toBe(ko('chat.pinned'))
      expect(m.get('rooms-more').textContent).toContain(ko('sidebar.showMore', { n: 1 }))
    } finally { await m.unmount() }
  })

  test('the conversations page: the AI\'s row, then every pin, then the others; a hidden room is in neither', async () => {
    useSession.setState({ status: { kind: 'signed-in', me } } as never)
    const list = [room({ name: '새 소식', activityAt: at(9) }), room({ name: '고정 A', activityAt: at(1), pinnedAt: pinned(1) }), room({ name: '숨김', activityAt: at(10), hidden: true }),
      room({ name: '오래된 방', activityAt: at(2) }), room({ name: '고정 B', activityAt: at(0), pinnedAt: pinned(2) })]
    useRooms.setState({ rooms: list.sort((x, y) => y.activityAt.localeCompare(x.activityAt)), loaded: true, failed: null })
    const m = await mount(<MemoryRouter initialEntries={['/rooms']}><Routes><Route path="/rooms" element={<RoomsPage />} /></Routes></MemoryRouter>)
    try {
      // the AI's row is the list's first item, the rooms after it
      const ai = m.get('rooms-ai').parentElement!
      expect(ai.parentElement!.firstChild).toBe(ai)
      const rows = body(m).querySelectorAll('[data-testid="rooms-row"]')
      const names = ['고정 B', '고정 A', '새 소식', '오래된 방']
      expect(rows.map((x) => names.find((n) => x.textContent!.startsWith(n)))).toEqual(names)
      expect(rows.map((x) => !!x.querySelector('[data-testid="room-pin-icon"]'))).toEqual([true, true, false, false])
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
