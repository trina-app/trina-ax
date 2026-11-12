// The navigation's reusable lists (components/nav/, phase P0b of docs/AGENTS/plan/20261112-1839-nav-rail.md): moved out
// of the sidebar with no change in what it shows (sidebar.test.tsx, room-pins.test.tsx and the e2e suites check that,
// unchanged); here only what is new, that the caps are the caller's:
// - RoomsList: `caps` sets the pins and the latest rooms before "더 보기 (N)"; without it, the sidebar's ten and five;
// - HistoryList: `caps` sets the pins and the latest chats before "모두 보기"; without caps, the whole history (the
//   phone's drawer): no "모두 보기", every row.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { Chat, Me } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { RoomsList, SIDEBAR_ROOM_CAPS, sidebarRows } from '../../src/components/nav/RoomsList'
import { HistoryList, SIDEBAR_HISTORY_CAPS } from '../../src/components/nav/HistoryList'
import { useChatPeek } from '../../src/components/nav/ChatItem'
import { PINS_SHOWN, ROOMS_SHOWN } from '../../src/components/rooms/SidebarRooms'
import { useChats } from '../../src/store/chats'
import { useProjects } from '../../src/store/projects'
import { useRooms } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom } from './dom-host'
import { at, room } from './rooms-fixtures'

const ko = (k: Parameters<typeof translate>[1], p?: Parameters<typeof translate>[2]) => translate('ko', k, p)
const me = {
  user: { id: 'mina', username: 'mina', name: 'Mina', title: null, email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'ko', chatTrashRetentionDays: 14 }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'hosted' },
} as unknown as Me
const chat = (n: number, o: Partial<Chat> = {}): Chat => ({
  id: `01900000-0000-7000-8000-0000000001${String(n).padStart(2, '0')}`, projectId: null, title: `chat ${n}`, engine: 'claude-code', model: null,
  createdAt: '2026-11-01T00:00:00.000Z', updatedAt: `2026-11-01T00:${String(n).padStart(2, '0')}:00.000Z`, deletedAt: null, runState: 'idle', ...o,
})
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })

const realFetch = globalThis.fetch
const localeBefore = useLocaleStore.getState().locale
const sessionBefore = useSession.getState().status
const roomsBefore = useRooms.getState()
const chatsBefore = { chats: useChats.getState().chats, chatsLoaded: useChats.getState().chatsLoaded, chatsCursor: useChats.getState().chatsCursor, requests: useChats.getState().requests }
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  ;(globalThis as Record<string, unknown>).matchMedia = (q: string) => ({ matches: q === '(min-width: 768px)', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => json({ error: { code: 'not_found', message: `${init?.method ?? 'GET'} ${String(input)}` } }, 404)) as unknown as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: localeBefore })
  useSession.setState({ status: sessionBefore })
})
beforeEach(() => {
  localStorage.clear()
  useProjects.getState().reset()
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
})
afterEach(() => {
  useRooms.setState(roomsBefore, true)
  useChats.setState(chatsBefore)
})

describe('RoomsList', () => {
  test("the sidebar's caps are today's: ten pins, five latest", () => {
    expect(SIDEBAR_ROOM_CAPS).toEqual({ pins: PINS_SHOWN, latest: ROOMS_SHOWN })
    const rooms = Array.from({ length: 8 }, (_, i) => room({ name: `r${i}`, activityAt: at(20 - i) }))
    expect(sidebarRows(rooms, null).map((r) => r.name)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4'])
  })

  test('caps from the caller: the pins and the latest rooms before "더 보기 (N)", the room on screen past them', async () => {
    const rooms = [room({ name: 'p1', activityAt: at(1), pinnedAt: at(30) }), room({ name: 'p2', activityAt: at(2), pinnedAt: at(31) }), ...Array.from({ length: 5 }, (_, i) => room({ name: `r${i}`, activityAt: at(20 - i) }))]
    expect(sidebarRows(rooms, rooms[6]!.id, { pins: 1, latest: 2 }).map((r) => r.name)).toEqual(['p2', 'r0', 'r1', 'r4'])
    useRooms.setState({ rooms, loaded: true, failed: null })
    const m = await mount(<MemoryRouter initialEntries={['/']}><RoomsList onNavigate={() => {}} caps={{ pins: 1, latest: 2 }} /></MemoryRouter>)
    try {
      expect(m.container.querySelectorAll('[data-testid="sidebar-room"]').map((a) => a.textContent)).toEqual(['p2', 'r0', 'r1'])
      expect(m.get('rooms-more').textContent).toContain(ko('sidebar.showMore', { n: 4 }))
    } finally {
      await m.unmount()
    }
  })
})

/** the history with the sidebar's peek, as Sidebar.tsx places it */
function History({ caps }: { caps?: typeof SIDEBAR_HISTORY_CAPS }) {
  const peek = useChatPeek()
  return (
    <nav>
      <HistoryList caps={caps} onNavigate={() => {}} peek={peek} />
    </nav>
  )
}
const titles = (m: Awaited<ReturnType<typeof mount>>) => m.get('recents-list').querySelectorAll('a').map((x) => x.textContent)

describe('HistoryList', () => {
  test('caps from the caller: the pins and the latest chats before "모두 보기" (no chat in a project)', async () => {
    useChats.setState({ chats: [...Array.from({ length: 6 }, (_, i) => chat(i + 1)), chat(7, { pinnedAt: '2026-11-02T00:00:00.000Z' }), chat(8, { pinnedAt: '2026-11-03T00:00:00.000Z' })], chatsLoaded: true, chatsCursor: null, requests: {} })
    const m = await mount(<MemoryRouter initialEntries={['/']}><History caps={{ ...SIDEBAR_HISTORY_CAPS, pins: 1, latest: 2 }} /></MemoryRouter>)
    try {
      await m.until(() => titles(m).length > 0, 'the rows')
      expect(titles(m)).toEqual(['chat 8', 'chat 6', 'chat 5'])
      expect(m.find('ai-chats-all')).toBeTruthy()
    } finally {
      await m.unmount()
    }
  })

  test('no caps (the phone\'s drawer): every chat, no "모두 보기"', async () => {
    useChats.setState({ chats: Array.from({ length: 8 }, (_, i) => chat(i + 1)), chatsLoaded: true, chatsCursor: null, requests: {} })
    const m = await mount(<MemoryRouter initialEntries={['/']}><History /></MemoryRouter>)
    try {
      await m.until(() => titles(m).length > 0, 'the rows')
      expect(titles(m)).toHaveLength(8)
      expect(m.find('ai-chats-all')).toBeFalsy()
      expect(m.find('ai-chats-less')).toBeFalsy()
    } finally {
      await m.unmount()
    }
  })
})
