// A conversation's "⋯" and hidden conversations (docs/DECISIONS.md "대화 숨기기"; components/rooms/RoomMenu.tsx):
// - the menu by kind: 알림 설정, 링크 복사, then a group chat's 대화방 나가기, a DM's 대화 숨기기, a team room's and the
//   everyone room's 숨기기, a hidden room's 다시 보이기; 알림 설정 opens the room's levels; hiding is sent, shown at once
//   and put back when the server refuses;
// - hidden rooms stay out of the sidebar's five, "더 보기" and its pill, the 대화 tab's count, the one count n and the
//   room sound; the conversations page lists them under "숨긴 대화 N" with 다시 보이기;
// - a sidebar row's "⋯" and its right-click; a long press on a row of the 대화 list opens the menu with the room's name
//   on top (a sheet on a phone), and the finger lifting opens no room.
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { type Me, type Room } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { BottomTabs } from '../../src/components/BottomTabs'
import { RoomMenu, roomMenuActions, roomLink } from '../../src/components/rooms/RoomMenu'
import { hiddenUnread, SidebarRooms } from '../../src/components/rooms/SidebarRooms'
import { shownInLists, roomWantsMe, totalUnread } from '../../src/lib/rooms'
import { attentionCount } from '../../src/lib/sessionMarkers'
import { shouldRing } from '../../src/lib/roomSound'
import RoomsPage from '../../src/pages/Rooms'
import { useRooms, withHidden } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import { FakeEvent, installDom, mount, removeDom, type FakeElement } from './dom-host'
import { BEN, CY, ME, message, room } from './rooms-fixtures'

setDefaultTimeout(30_000)
const ko = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('ko', k, p)
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })
const me = { user: { id: ME.id, username: ME.id, name: ME.name, email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} }, groups: [],
  team: { name: 'Acme', defaultLocale: 'ko' }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: false } } as unknown as Me

let refuse = false
const sent: { key: string; body: unknown }[] = []
const realFetch = globalThis.fetch
const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
let wide = true
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  ;(globalThis as Record<string, unknown>).matchMedia = (q: string) => ({ matches: wide ? q === '(min-width: 768px)' || q === '(any-pointer: fine)' : q === '(max-width: 767.98px)', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    sent.push({ key, body })
    const hide = /^PUT \/api\/rooms\/(.+)\/hidden$/.exec(key)
    if (hide) {
      if (refuse) return json({ error: { code: 'forbidden', message: 'no' } }, 403)
      const r = useRooms.getState().rooms.find((x) => x.id === hide[1])!
      const { hidden: _h, ...rest } = r
      return json(body.hidden ? { ...rest, hidden: true } : rest)
    }
    return json({ error: { code: 'not_found', message: key } }, 404)
  }) as unknown as typeof fetch
})
afterEach(() => {
  sent.length = 0
  refuse = false
  wide = true
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
const at = (min: number) => new Date(Date.parse('2026-11-07T09:00:00.000Z') - min * 60_000).toISOString()

describe('the menu by kind', () => {
  test('a group chat leaves, a DM and a team or everyone room hide, a hidden one shows again; 알림 설정 and 링크 복사 first', () => {
    expect(roomMenuActions({ kind: 'group' })).toEqual(['notify', 'copyLink', 'leave'])
    expect(roomMenuActions({ kind: 'dm' })).toEqual(['notify', 'copyLink', 'hide'])
    expect(roomMenuActions({ kind: 'team' })).toEqual(['notify', 'copyLink', 'hide'])
    expect(roomMenuActions({ kind: 'all' })).toEqual(['notify', 'copyLink', 'hide'])
    expect(roomMenuActions({ kind: 'dm', hidden: true })).toEqual(['notify', 'copyLink', 'show'])
    // a group chat is left, never hidden, even if a server marked one
    expect(roomMenuActions({ kind: 'group', hidden: true })).toEqual(['notify', 'copyLink', 'leave'])
    expect(roomLink('019a5f00-0000-7000-8000-00000000a001', 'https://acme.trina.app')).toBe('https://acme.trina.app/rooms/019a5f00-0000-7000-8000-00000000a001')
  })

  test('rendered: its words per kind, "더 보기" as its tooltip; 알림 설정 opens the levels; 숨기기 is sent and shown at once', async () => {
    useSession.setState({ status: { kind: 'signed-in', me } } as never)
    const rs = [room({ kind: 'group', name: 'Plan', canRename: true, groupId: null }), room({ kind: 'dm', name: null, peers: [BEN], groupId: null }), room({ kind: 'team' }), room({ kind: 'all', name: null, groupId: null })]
    useRooms.setState({ rooms: rs, loaded: true })
    const Menu = ({ id }: { id: string }) => <RoomMenu room={useRooms((s) => s.rooms.find((r) => r.id === id)!)} />
    const words = [ko('rooms.menu.notify'), ko('rooms.menu.copyLink')]
    const want = [[...words, ko('rooms.info.leave')], [...words, ko('rooms.menu.hideDm')], [...words, ko('rooms.menu.hide')], [...words, ko('rooms.menu.hide')]]
    for (const [i, r] of rs.entries()) {
      const m = await mount(<MemoryRouter><Menu id={r.id} /></MemoryRouter>)
      try {
        expect(m.get('room-menu').getAttribute('aria-label')).toBe(ko('rooms.menu.label'))
        await m.click('room-menu')
        expect(menuItems(m)).toEqual(want[i]!)
        if (r.kind === 'team') {
          // 알림 설정: the room's own four levels
          await m.click('room-menu-notify')
          await m.until(() => body(m).querySelectorAll('[role="menuitemradio"]').length === 4, 'the levels')
          expect(body(m).querySelectorAll('[role="menuitemradio"]').map((x) => x.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false', 'false'])
        }
        if (r.kind === 'dm') {
          await m.click('room-menu-hide')
          // shown at once, then the server's copy
          expect(useRooms.getState().rooms.find((x) => x.id === r.id)!.hidden).toBe(true)
          await m.until(() => sent.some((s) => s.key === `PUT /api/rooms/${r.id}/hidden`), 'the PUT')
          expect(sent.find((s) => s.key === `PUT /api/rooms/${r.id}/hidden`)!.body).toEqual({ hidden: true })
          // the same menu now offers it back
          await m.click('room-menu')
          expect(menuItems(m)).toEqual([...words, ko('rooms.menu.show')])
        }
      } finally { await m.unmount() }
    }
  })

  test('a refused hide is put back', async () => {
    useSession.setState({ status: { kind: 'signed-in', me } } as never)
    const r = room({ kind: 'team' })
    useRooms.setState({ rooms: [r], loaded: true })
    refuse = true
    await expect(useRooms.getState().setHidden(r.id, true)).rejects.toBeTruthy()
    expect(useRooms.getState().rooms[0]!.hidden).toBeUndefined()
  })

  test('withHidden marks or clears one room, nothing else', () => {
    const a = room(), b = room()
    const d = { rooms: [a, b], openRoomId: null, timeline: null, threadView: null }
    const hidden = withHidden(d, a.id, true)
    expect(hidden.rooms.map((r) => !!r.hidden)).toEqual([true, false])
    expect('hidden' in withHidden(hidden, a.id, false).rooms[0]!).toBe(false)
    expect(withHidden(d, a.id, false)).toEqual(d)
  })
})

describe('hidden rooms count nowhere', () => {
  const hiddenDm = room({ kind: 'dm', name: null, peers: [CY], unreadCount: 4, mentioned: true, hidden: true, aiWaits: true, notify: { own: null, byDefault: 'all', level: 'all' } })
  const shown = room({ kind: 'dm', name: null, peers: [BEN], unreadCount: 2, notify: { own: null, byDefault: 'all', level: 'all' } })

  test('the 대화 tab, the one count n, a room that wants me, the sound', () => {
    expect(totalUnread([hiddenDm, shown])).toBe(2)
    expect(roomWantsMe(hiddenDm)).toBe(false)
    expect(roomWantsMe(shown)).toBe(true)
    expect(attentionCount([], [hiddenDm, shown]).n).toBe(1)
    expect(hiddenUnread([shown, hiddenDm].filter((r) => !r.hidden))).toEqual({ n: 2, mentioned: false, muted: false })
    expect(shownInLists([hiddenDm, shown]).map((r) => r.id)).toEqual([shown.id])
    // the room on screen stays in the lists, hidden or not
    expect(shownInLists([hiddenDm, shown], hiddenDm.id)).toHaveLength(2)
    const msg = message({ roomId: hiddenDm.id, seq: 9, author: CY })
    expect(shouldRing({ roomId: hiddenDm.id, room: hiddenDm, message: msg, meId: ME.id, replay: false, seen: false, viewing: null })).toBe(false)
    expect(shouldRing({ roomId: shown.id, room: shown, message: { ...msg, roomId: shown.id }, meId: ME.id, replay: false, seen: false, viewing: null })).toBe(true)
  })

  test('the 대화 tab on a phone: its count and its "?" leave the hidden room out', async () => {
    wide = false
    useRooms.setState({ rooms: [hiddenDm, shown], loaded: true })
    const m = await mount(<MemoryRouter initialEntries={['/rooms']}><BottomTabs /></MemoryRouter>)
    try {
      expect(m.get('tab-chats-unread').getAttribute('data-ai-waits')).toBeNull()
      expect(m.get('tab-chats-unread').textContent).toContain('2')
    } finally { await m.unmount() }
  })

  test('the sidebar: not in the five, not in "더 보기" or its pill; "모든 대화" leads to them, also below an opened list', async () => {
    useSession.setState({ status: { kind: 'signed-in', me } } as never)
    // seven shown rooms (two behind "더 보기", nothing unread) and one hidden with the newest message and unread mentions
    const list: Room[] = [room({ kind: 'dm', name: null, peers: [CY], hidden: true, unreadCount: 5, mentioned: true, activityAt: at(0) }),
      ...Array.from({ length: 7 }, (_, i) => room({ name: `방 ${i + 1}`, activityAt: at(i + 1) }))]
    useRooms.setState({ rooms: list, loaded: true, failed: null })
    try { localStorage.removeItem('mycel.sidebar.roomsAll') } catch { /* none */ }
    const m = await mount(<MemoryRouter initialEntries={['/']}><SidebarRooms onNavigate={() => {}} /></MemoryRouter>)
    try {
      expect(body(m).querySelectorAll('[data-testid="sidebar-room"]').map((x) => x.textContent)).toEqual(['방 1', '방 2', '방 3', '방 4', '방 5'])
      expect(m.get('rooms-more').textContent).toContain(ko('sidebar.showMore', { n: 2 }))
      expect(m.find('rooms-more-unread')).toBeNull()
      expect(m.find('rooms-all')).toBeNull()
      await m.click('rooms-more')
      expect(body(m).querySelectorAll('[data-testid="sidebar-room"]')).toHaveLength(7)
      // opened: the hidden one is still not here, and the way to it is
      expect(m.get('rooms-all').getAttribute('href')).toBe('/rooms')
      // each row has its "⋯", named after the room; a right-click opens it
      const row = body(m).querySelectorAll('[data-testid="sidebar-room-row"]')[0]!
      expect(row.querySelector('[data-testid="sidebar-room-menu"]')!.getAttribute('aria-label')).toBe(ko('rooms.menu.rowLabel', { name: '방 1' }))
      const e = new FakeEvent('contextmenu', { bubbles: true, cancelable: true })
      await m.settle(0)
      row.querySelector('[data-testid="sidebar-room"]')!.dispatchEvent(e)
      await m.until(() => menuItems(m).length === 3, 'the menu')
      expect(e.defaultPrevented).toBe(true)
      expect(menuItems(m)).toEqual([ko('rooms.menu.notify'), ko('rooms.menu.copyLink'), ko('rooms.menu.hide')])
    } finally {
      await m.unmount()
      try { localStorage.removeItem('mycel.sidebar.roomsAll') } catch { /* none */ }
    }
  })
})

describe('the conversations page', () => {
  const Where = () => <span data-testid="where">{useLocation().pathname}</span>
  const page = () => (
    <MemoryRouter initialEntries={['/rooms']}>
      <Routes>
        <Route path="/rooms" element={<RoomsPage />} />
        <Route path="/rooms/:id" element={<Where />} />
      </Routes>
    </MemoryRouter>
  )

  test('"숨긴 대화 N" at the end, folded; opened: each with 다시 보이기, which is sent and brings the row back', async () => {
    useSession.setState({ status: { kind: 'signed-in', me } } as never)
    const hid = room({ kind: 'dm', name: null, peers: [CY], hidden: true, groupId: null })
    useRooms.setState({ rooms: [room({ name: '디자인' }), hid], loaded: true, failed: null })
    try { localStorage.removeItem('mycel.rooms.hiddenOpen') } catch { /* none */ }
    const m = await mount(page())
    try {
      expect(body(m).querySelectorAll('[data-testid="rooms-row"]')).toHaveLength(1)
      expect(m.get('rooms-hidden-toggle').textContent).toBe(ko('rooms.hidden.title', { n: 1 }))
      expect(m.get('rooms-hidden-toggle').getAttribute('aria-expanded')).toBe('false')
      expect(m.find('rooms-hidden-row')).toBeNull()
      await m.click('rooms-hidden-toggle')
      expect(m.get('rooms-hidden-row').textContent).toContain(CY.name)
      expect(m.get('rooms-hidden-show').getAttribute('aria-label')).toBe(ko('rooms.menu.showName', { name: CY.name }))
      await m.click('rooms-hidden-show')
      await m.until(() => sent.some((s) => s.key === `PUT /api/rooms/${hid.id}/hidden`), 'the PUT')
      expect(sent.find((s) => s.key === `PUT /api/rooms/${hid.id}/hidden`)!.body).toEqual({ hidden: false })
      await m.until(() => body(m).querySelectorAll('[data-testid="rooms-row"]').length === 2, 'the row back')
      expect(m.find('rooms-hidden')).toBeNull()
    } finally {
      await m.unmount()
      try { localStorage.removeItem('mycel.rooms.hiddenOpen') } catch { /* none */ }
    }
  })

  test('a phone: a long press on a row opens its menu with the room\'s name on top; the finger lifting opens no room', async () => {
    wide = false
    useSession.setState({ status: { kind: 'signed-in', me } } as never)
    useRooms.setState({ rooms: [room({ name: '개발팀' })], loaded: true, failed: null })
    const m = await mount(page())
    try {
      const row = m.get('rooms-row')
      const press = (type: string) => row.dispatchEvent(Object.assign(new FakeEvent(type, { bubbles: true, cancelable: true }), { pointerType: 'touch', clientX: 20, clientY: 20 }))
      await m.settle(0)
      press('pointerdown')
      await m.settle(600)
      press('pointerup')
      await m.until(() => menuItems(m).length === 3, 'the sheet')
      expect(menuItems(m)).toEqual([ko('rooms.menu.notify'), ko('rooms.menu.copyLink'), ko('rooms.menu.hide')])
      expect(m.get('menu-sheet-title').textContent).toBe('개발팀')
      // the click that follows the finger lifting is no tap on the row
      await m.click(row)
      expect(m.find('where')).toBeNull()
    } finally { await m.unmount() }
  })
})
