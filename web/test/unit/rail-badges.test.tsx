// The new navigation's rail (docs/AGENTS/plan/20261112-1839-nav-rail.md §2.1, phase P1): the marks on its places
// (components/rail/railBadges.ts), when the list panel folds (rail/railPanel.ts), and the rail itself: the five places in
// order with their names, the lit one, a member's logo that is not a button.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { Me } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { BottomTabs } from '../../src/components/BottomTabs'
import { Rail } from '../../src/components/rail/Rail'
import { activityMark, aiMark, chatsMark, projectsMark, unreadRooms } from '../../src/components/rail/railBadges'
import { readChatMentions, resetChatMentions } from '../../src/store/chatMentions'
import { PANEL_ALWAYS_BOTH_PX, panelState } from '../../src/components/rail/railPanel'
import { THREE_MIN } from '../../src/lib/roomColumns'
import { useInbox } from '../../src/store/inbox'
import { useChats } from '../../src/store/chats'
import { useRooms } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom } from './dom-host'
import { room } from './rooms-fixtures'

const ko = (k: Parameters<typeof translate>[1], p?: Parameters<typeof translate>[2]) => translate('ko', k, p)

describe('marks', () => {
  test('트리나: "?" when an AI chat waits on me, a dot for an unseen answer, nothing otherwise', () => {
    expect(aiMark({ chats: 0, chatAsk: false })).toBeNull()
    expect(aiMark({ chats: 2, chatAsk: true })).toEqual({ kind: 'ask' })
    expect(aiMark({ chats: 1, chatAsk: false })).toEqual({ kind: 'dot' })
  })

  test('대화: conversations with something unread (not messages), muted and hidden left out; a dot for mention rows only', () => {
    // the second, a channel at its default (mentions only) with plain messages, is only bold: not counted; nor is the
    // third, read to its end with a followed thread's new replies (they are in 멘션·스레드: QA TC-5363)
    const rooms = [room({ kind: 'group', unreadCount: 12 }), room({ unreadCount: 7 }), room({ unreadCount: 0, threadsUnread: 2 }), room({ unreadCount: 4, muted: true }), room({ unreadCount: 3, hidden: true }), room()]
    expect(unreadRooms(rooms)).toBe(1)
    expect(chatsMark(rooms, 5)).toEqual({ kind: 'count', n: 1 })
    // a hidden room does not mark the rail (it shows nowhere)
    expect(chatsMark([room({ unreadCount: 1, hidden: true })], 0)).toBeNull()
    // a mention row unread in Activity, its room read meanwhile: still a mark on 대화
    expect(chatsMark([room()], 1)).toEqual({ kind: 'dot' })
    expect(chatsMark([room()], 0)).toBeNull()
  })

  test('프로젝트: projects with an unread mention of me or unread messages I did not mute (projects, not messages)', () => {
    const c = (id: string, projectId: string | null, o: object = {}) => ({ id, projectId, ...o })
    expect(projectsMark([], [c('a', 'p1')])).toBeNull()
    // a mention in p1 (the list's count), unread messages in p1 and p2, a muted chat in p3, a chat outside projects
    expect(projectsMark(['p1'], [c('a', 'p1', { unreadCount: 4 }), c('b', 'p2', { unreadCount: 1 }), c('m', 'p3', { unreadCount: 9, muted: true }), c('x', null, { unreadCount: 2 })])).toEqual({ kind: 'count', n: 2 })
    expect(projectsMark(['p1', 'p2'], [])).toEqual({ kind: 'count', n: 2 })
  })

  test('활동: the notices that are not conversation rows', () => {
    expect(activityMark(0)).toBeNull()
    expect(activityMark(3)).toEqual({ kind: 'count', n: 3 })
  })
})

describe('panel', () => {
  test('always from 1052 px; below, folded by a thread or side panel, hidden by the person', () => {
    expect(panelState({ wide: true, crowded: true, hidden: true })).toBe('shown')
    expect(panelState({ wide: false, crowded: false, hidden: false })).toBe('shown')
    expect(panelState({ wide: false, crowded: true, hidden: false })).toBe('folded')
    expect(panelState({ wide: false, crowded: false, hidden: true })).toBe('hidden')
    expect(panelState({ wide: false, crowded: true, hidden: true })).toBe('hidden')
  })
  test('a room with its thread and side chat both open: folded below 1448 px, whatever the person chose; back when one closes', () => {
    // (`both`: the two are open and the window is narrower than PANEL_ALWAYS_BOTH_PX)
    expect(panelState({ wide: true, crowded: true, hidden: false, both: true })).toBe('folded')
    expect(panelState({ wide: true, crowded: true, hidden: true, both: true })).toBe('folded')
    expect(panelState({ wide: false, crowded: true, hidden: false, both: true })).toBe('folded')
    expect(panelState({ wide: false, crowded: true, hidden: true, both: true })).toBe('hidden')
    expect(panelState({ wide: true, crowded: true, hidden: false, both: false })).toBe('shown')
    // the rail at its widest, the list at its widest and the three columns
    expect(PANEL_ALWAYS_BOTH_PX).toBe(88 + 300 + THREE_MIN)
  })
})

const me = (role: 'owner' | 'member') => ({
  user: { id: 'mina', username: 'mina', name: 'Mina', title: null, email: null, role, locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'ko', chatTrashRetentionDays: 14 }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'hosted' },
}) as unknown as Me
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })

describe('Rail', () => {
  const realFetch = globalThis.fetch
  const localeBefore = useLocaleStore.getState().locale
  const sessionBefore = useSession.getState().status
  const roomsBefore = useRooms.getState()
  beforeAll(() => {
    installDom()
    useLocaleStore.setState({ locale: 'ko' })
    ;(globalThis as Record<string, unknown>).matchMedia = (q: string) => ({ matches: q === '(min-width: 768px)', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      String(input).includes('/api/notifications') ? json({ items: [], nextCursor: null, unreadCount: 5, roomUnreadCount: 2 }) : json({ error: { code: 'not_found', message: String(input) } }, 404)) as unknown as typeof fetch
  })
  afterAll(() => {
    globalThis.fetch = realFetch
    removeDom()
    useLocaleStore.setState({ locale: localeBefore })
    useSession.setState({ status: sessionBefore })
  })
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })
  afterEach(() => {
    useRooms.setState(roomsBefore, true)
    useInbox.setState({ unread: 0, rooms: 0 })
  })

  const draw = async (role: 'owner' | 'member', path: string) => {
    useSession.setState({ status: { kind: 'signed-in', me: me(role) } } as never)
    useRooms.setState({ rooms: [room({ kind: 'group', unreadCount: 3 }), room({ unreadCount: 6 }), room({ unreadCount: 1, mentioned: true }), room({ unreadCount: 9, muted: true })], loaded: true, failed: null })
    const m = await mount(<MemoryRouter initialEntries={[path]}><Rail showList={false} /></MemoryRouter>)
    // the notices' count arrives from GET /api/notifications
    await m.until(() => m.find('rail-activity-mark'), 'the notices counted')
    return m
  }

  test('ja labels in full on up to two lines, never an ellipsis (プロジ…, アクテ…: QA 2026-11-22 F15)', async () => {
    useLocaleStore.setState({ locale: 'ja' })
    const m = await draw('owner', '/rooms')
    try {
      const labels = m.container.querySelectorAll('[data-testid="rail-label"]')
      expect(labels.length).toBe(5)
      expect(labels.map((l) => l.textContent)).toContain(translate('ja', 'projects.title'))
      expect(labels.map((l) => l.textContent)).toContain(translate('ja', 'inbox.title'))
      for (const l of labels) {
        expect(l.getAttribute('class')).toContain('line-clamp-2')
        expect(l.getAttribute('class')).not.toContain('truncate')
      }
    } finally {
      await m.unmount()
      useLocaleStore.setState({ locale: 'ko' })
    }
  })

  test('five places in the phone tabs\' order, each with its name; the page\'s place lit; 대화 and 활동 counted once each', async () => {
    const m = await draw('owner', '/rooms')
    try {
      // Tab stops in order: the logo, the five places, my photo
      const stops = m.container.querySelectorAll('[data-rail-stop]')
      expect(stops.map((a) => a.getAttribute('data-testid'))).toEqual(['team-menu', 'rail-ai', 'rail-chats', 'rail-projects', 'rail-files', 'rail-activity', 'account-menu'])
      const names = ['트리나', ko('tabs.chats'), ko('projects.title'), ko('sidebar.files'), ko('inbox.title')]
      stops.slice(1, 6).forEach((a, i) => expect(a.textContent).toContain(names[i]!))
      expect(m.get('rail-chats').getAttribute('aria-current')).toBe('page')
      expect(m.get('rail-ai').getAttribute('aria-current')).toBeNull()
      // two conversations unread (the muted one left out), not 13 messages
      expect(m.get('rail-chats-mark').getAttribute('data-n')).toBe('2')
      // 5 notices, 2 of them conversation rows: 3 on 활동
      expect(m.get('rail-activity-mark').getAttribute('data-n')).toBe('3')
      expect(m.container.querySelector('[data-testid="rail-files-mark"]')).toBeNull()
      expect(m.container.querySelector('[data-testid="rail-projects-mark"]')).toBeNull()
      // owners and admins: the logo opens the team menu
      expect(m.get('team-menu').tagName.toLowerCase()).toBe('button')
    } finally {
      await m.unmount()
    }
  })

  test('the phone\'s 대화 tab shows the rail\'s number for the same rooms (one rule: conversations, not messages)', async () => {
    const rail = await draw('member', '/files')
    const tabs = await mount(<MemoryRouter initialEntries={['/files']}><BottomTabs /></MemoryRouter>)
    try {
      await tabs.until(() => tabs.find('tab-chats-unread'), 'the 대화 tab counted')
      const n = rail.get('rail-chats-mark').getAttribute('data-n')
      expect(n).toBe('2')
      expect(tabs.get('tab-chats-unread').textContent).toBe(`${n}${ko('rail.unreadRooms', { n: 2 })}`)
    } finally {
      await tabs.unmount()
      await rail.unmount()
    }
  })

  // the owner 11-22: a team project's row showed "1" and the rail's 프로젝트 nothing ("모바일도 잘 생각해줘")
  test('프로젝트 on the rail and the phone tab: the projects with an unread thread mention of me; opening the chat clears both', async () => {
    const chatsBefore = useChats.getState()
    const mention = { id: 'n1', eventType: 'chat.thread_reply', sourceId: 'root1', code: 'chat.thread_reply', createdAt: '2026-11-22T00:00:00.000Z', readAt: null, outcome: null, chatId: 'c1', link: 'chat_thread', chatThread: { chatId: 'c1', rootId: 'root1', name: 'Bora', title: 'Launch plan', mention: true } }
    let read = false
    const fetchBefore = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input)
      if (u.includes('/api/notifications/n1/read') && init?.method === 'POST') { read = true; return json({ ok: true }) }
      if (u.includes('/api/notifications')) return json({ items: read ? [] : [mention], nextCursor: null, unreadCount: read ? 0 : 1, roomUnreadCount: 0 })
      return json({ error: { code: 'not_found', message: u } }, 404)
    }) as unknown as typeof fetch
    resetChatMentions()
    useChats.setState({ chats: [{ id: 'c1', title: 'Launch plan', projectId: 'p1', runState: 'idle', updatedAt: '2026-11-22T00:00:00.000Z' }], chatsLoaded: true } as never)
    const rail = await draw('member', '/files')
    const tabs = await mount(<MemoryRouter initialEntries={['/files']}><BottomTabs /></MemoryRouter>)
    try {
      await rail.until(() => rail.find('rail-projects-mark'), 'the 프로젝트 mark')
      expect(rail.get('rail-projects-mark').getAttribute('data-n')).toBe('1')
      expect(rail.get('rail-projects-mark-words').textContent).toBe(`, ${ko('rail.unreadProjects', { n: 1 })}`)
      await tabs.until(() => tabs.find('tab-projects-unread'), 'the 프로젝트 tab counted')
      expect(tabs.get('tab-projects-unread').textContent).toBe(`1${ko('rail.unreadProjects', { n: 1 })}`)
      // the chat opened (pages/Chat.tsx): both marks go, without a reload
      await readChatMentions('c1')
      expect(read).toBe(true)
      await rail.until(() => !rail.find('rail-projects-mark'), 'the 프로젝트 mark cleared')
      await tabs.until(() => !tabs.find('tab-projects-unread'), 'the 프로젝트 tab cleared')
    } finally {
      await tabs.unmount()
      await rail.unmount()
      globalThis.fetch = fetchBefore
      resetChatMentions()
      useChats.setState(chatsBefore, true)
    }
  })

  // UX review S2: the waiting chat may sit far down the list; 트리나's "?" opens it, from another place only (no loop)
  test('트리나 with "?" from another place opens the first waiting chat; lit, it opens its start', async () => {
    const chatsBefore = useChats.getState()
    const c = (id: string, o: object = {}) => ({ id, title: id, projectId: null, runState: 'idle', updatedAt: '2026-11-13T00:00:00.000Z', ...o })
    useChats.setState({ chats: [c('seen'), c('asks', { waiting: true }), c('asks2', { waiting: true })], chatsLoaded: true } as never)
    try {
      for (const [path, href] of [['/rooms', '/c/asks'], ['/files', '/c/asks'], ['/', '/'], ['/c/asks', '/']] as const) {
        const m = await draw('owner', path)
        try {
          expect(m.get('rail-ai-mark').getAttribute('data-mark')).toBe('ask')
          expect(m.get('rail-ai').getAttribute('href')).toBe(href)
        } finally {
          await m.unmount()
        }
      }
    } finally {
      useChats.setState(chatsBefore, true)
    }
  })

  // the owner 2026-11-18: a member's logo opens the team menu too (다른 팀으로 전환), with no admin item in it
  test("a member's logo is the team menu's button (closed); Admin is nowhere on the rail", async () => {
    const m = await draw('member', '/files')
    try {
      expect(m.get('team-menu').tagName.toLowerCase()).toBe('button')
      expect(m.get('team-menu').textContent).toContain('Acme')
      expect(m.find('team-dropdown')).toBeNull()
      expect(m.get('rail-files').getAttribute('aria-current')).toBe('page')
      expect(m.container.textContent).not.toContain(ko('sidebar.admin'))
    } finally {
      await m.unmount()
    }
  })
})
