// The computer's sidebar (768 px and wider; docs/DECISIONS.md "Desktop sidebar: rooms first"), rendered and pressed:
// - its order: the team's name, one labeled row each (트리나에게 묻기, 검색, 프로젝트, 예약 작업, 알림함, 파일, 팀 스킬; no
//   관리자 row), then one scroll: 대화 (the five latest rooms and the room on screen, "더 보기 (N)" with what is unread behind it;
//   opened, the top rows stay and the rest follow by kind, docs/DECISIONS.md "Conversations by kind under Show more") and
//   트리나 기록 (the five latest and the chat on screen, "모두 보기" with what needs me behind it);
// - the rows: their words and where they go, the shortcut hints, the Inbox's count on its row (in words for a screen reader);
// - both groups fold, remembered in this browser;
// - "답변 필요" and the new-answer dot come from the chat list itself (Chat.waiting / Chat.unseen), with no request per
//   chat; the dot stays away from the chat on screen;
// - the team menu on top (docs/DECISIONS.md "The team menu"): for owners and admins a button that opens the team, its
//   address, "팀원 초대" and 관리자, by mouse and by keyboard; a member's header is not a button;
// - the phone's drawer keeps its own layout (the AI's history only);
// - a chat row's "…": "상단에 고정" / "고정 해제" for every row, rename, "프로젝트로 옮기기…" ("프로젝트 바꾸기…" in a
//   project) and delete for a chat of my own, the move dialog of the chat's title menu; a shared chat never offers the
//   move;
// - pinned chats (docs/DECISIONS.md "Pinned chats"): first, the most recently pinned first, a pin before the title; at
//   most ten above the five latest on a computer, all of them first in "모두 보기" and in the phone's drawer.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { PRODUCT } from '@mycel/shared'
import { PRODUCT_NAMED_AFTER_AI, type Chat, type Me, type WelcomeProgress } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import Sidebar from '../../src/components/Sidebar'
import { TeamInviteDialog } from '../../src/components/TeamMenu'
import { INVITE_STEP_STATE } from '../../src/components/onboarding/GoalCard'
import { useUi } from '../../src/store/ui'
import { useAiAccess } from '../../src/store/aiAccess'
import { useChats } from '../../src/store/chats'
import { useInbox } from '../../src/store/inbox'
import { useRooms } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import { useSessionMarkers } from '../../src/store/sessionMarkers'
import { useWelcome } from '../../src/store/welcome'
import { TOOLTIP_DELAY_MS } from '../../src/components/Tooltip'
import { FakeElement, FakeEvent, installDom, mount, removeDom } from './dom-host'
import { BEN, CY, room } from './rooms-fixtures'

const ko = (k: Parameters<typeof translate>[1], p?: Parameters<typeof translate>[2]) => translate('ko', k, p)
const aiName = PRODUCT_NAMED_AFTER_AI ? ko('rooms.aiName') : PRODUCT.shortName
const me = (role: 'owner' | 'admin' | 'member'): Me =>
  ({
    user: { id: 'mina', username: 'mina', name: '김민아님', title: null, email: null, role, locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} },
    groups: [], team: { name: '에이크미 마케팅본부', defaultLocale: 'ko', chatTrashRetentionDays: 14 }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
    server: { version: '0', dev: false, deployment: 'hosted' },
  }) as unknown as Me
const chat = (n: number, o: Partial<Chat> = {}): Chat => ({
  id: `01900000-0000-7000-8000-0000000001${String(n).padStart(2, '0')}`, projectId: null, title: `채팅 ${n}`, engine: 'claude-code', model: null,
  createdAt: '2026-11-01T00:00:00.000Z', updatedAt: `2026-11-01T00:${String(n).padStart(2, '0')}:00.000Z`, deletedAt: null, runState: 'idle', ...o,
})
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })

let wide = true
let inboxCount = 0
const calls: string[] = []
/** more answers by "METHOD path", for one test (the rest is a 404) */
let routes: Record<string, (init?: RequestInit) => Response> = {}
const realFetch = globalThis.fetch
const localeBefore = useLocaleStore.getState().locale
const sessionBefore = useSession.getState().status
const roomsBefore = useRooms.getState()
const chatsBefore = { chats: useChats.getState().chats, chatsLoaded: useChats.getState().chatsLoaded, chatsCursor: useChats.getState().chatsCursor, requests: useChats.getState().requests }
const inboxBefore = useInbox.getState().unread
// the setup row (onboarding/SetupRow.tsx, in the sidebar and the drawer) reads these: put them back as they were
const welcomeBefore = (({ loaded, progress }) => ({ loaded, progress }))(useWelcome.getState())
const aiAccessBefore = (({ loaded, usable, action, requested, trial, sending, failed }) => ({ loaded, usable, action, requested, trial, sending, failed }))(useAiAccess.getState())
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  ;(globalThis as Record<string, unknown>).matchMedia = (q: string) => ({ matches: wide ? q === '(min-width: 768px)' : q === '(max-width: 767.98px)', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    const key = `${init?.method ?? 'GET'} ${url.split('?')[0]}`
    if (key === 'GET /api/notifications') return json({ items: [], nextCursor: null, unreadCount: inboxCount })
    if (routes[key]) return routes[key](init)
    return json({ error: { code: 'not_found', message: key } }, 404)
  }) as unknown as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: localeBefore })
  useSession.setState({ status: sessionBefore })
})
beforeEach(() => {
  wide = true
  calls.length = 0
  routes = {}
  localStorage.clear()
  useSession.setState({ status: { kind: 'signed-in', me: me('member') } } as never)
  useChats.setState({ chats: Array.from({ length: 8 }, (_, i) => chat(i + 1)), chatsLoaded: true, chatsCursor: null, requests: {} })
  useRooms.setState({ rooms: [room({ name: 'acme-design', unreadCount: 2 }), room({ kind: 'dm', name: null, unreadCount: 0 })], loaded: true, failed: null })
})
afterEach(() => {
  // reset first: it drops a read still on its way
  useWelcome.getState().reset()
  useWelcome.setState(welcomeBefore)
  useAiAccess.getState().reset()
  useAiAccess.setState(aiAccessBefore)
  useRooms.setState(roomsBefore, true)
  useChats.setState(chatsBefore)
  useInbox.setState({ unread: inboxBefore })
  inboxCount = 0
})

const render = (path = '/') => mount(<MemoryRouter initialEntries={[path]}><Sidebar /></MemoryRouter>)
const order = (m: Awaited<ReturnType<typeof render>>) =>
  ['sidebar-team', 'new-chat', 'nav-search', 'nav-projects', 'nav-scheduled', 'nav-inbox', 'nav-files', 'nav-skills', 'sidebar-rooms', 'recents-toggle'].map((id) => {
    const el = m.find(id)
    return el ? m.html().indexOf(`data-testid="${id}"`) : -1
  })

describe('a computer', () => {
  test("its icon buttons (the history's filter, a new conversation's +, a chat's \"…\") say what they do in the tooltip, not in the browser's title", async () => {
    const plain = globalThis.matchMedia
    // a mouse: tooltips may show
    ;(globalThis as Record<string, unknown>).matchMedia = (q: string) => ({ ...plain(q), matches: q === '(any-pointer: fine)' || plain(q).matches })
    const m = await render()
    const pointer = (el: unknown, type: string) => (el as { dispatchEvent: (e: unknown) => void }).dispatchEvent(Object.assign(new FakeEvent(type, { bubbles: true }), { pointerType: 'mouse', relatedTarget: null }))
    const tip = () => document.body.querySelector('[role="tooltip"]')?.textContent ?? null
    try {
      const more = m.get('recents-list').querySelector(`button[aria-label="${ko('chat.menu')}"]`)!
      for (const [b, words] of [[m.get('recents-filter'), ko('sidebar.filter')], [m.get('rooms-new-dm'), ko('rooms.newChat')], [more, ko('chat.menu')]] as const) {
        expect(b.getAttribute('title')).toBeNull()
        pointer(b, 'pointerover')
        await m.settle(TOOLTIP_DELAY_MS + 50)
        expect(tip()).toBe(words)
        pointer(b, 'pointerout')
        await m.settle(10)
        expect(tip()).toBeNull()
      }
    } finally {
      await m.unmount()
      ;(globalThis as Record<string, unknown>).matchMedia = plain
    }
  })

  test('in order: the team, one row each (a new chat, search, projects, scheduled, inbox, files, team skills), the rooms, then the AI chats', async () => {
    const m = await render()
    try {
      expect(m.get('sidebar-team').textContent).toBe('에이크미 마케팅본부')
      const at = order(m)
      expect(at.every((x) => x >= 0)).toBe(true)
      expect([...at].sort((a, b) => a - b)).toEqual(at)
      expect(m.get('recents-toggle').textContent).toBe(ko('sidebar.aiChats', { name: aiName }))
      // people and the AI never share a word: 대화 for the rooms, "트리나에게 묻기" and "트리나 기록" for the AI
      expect(m.get('rooms-toggle').textContent).toBe(ko('rooms.title'))
      expect(ko('rooms.title')).toBe('대화')
      expect(m.get('new-chat').textContent?.trim()).toStartWith(ko('sidebar.askAi', { name: aiName }))
      for (const id of ['nav-rows', 'rooms-toggle', 'recents-toggle', 'ai-chats-all']) expect(m.get(id).textContent).not.toMatch(/채팅/)
      // one scroll holds both sections (nothing pinned)
      const scroll = m.get('sidebar-scroll')
      expect(scroll.querySelector('[data-testid="sidebar-rooms"]')).not.toBeNull()
      expect(scroll.querySelector('[data-testid="recents-toggle"]')).not.toBeNull()
      expect(m.find('sidebar-ai-pane')).toBeNull()
      // the product's name is not the sidebar's title any more
      expect(m.get('sidebar-team').textContent).not.toContain(PRODUCT.displayName)
    } finally {
      await m.unmount()
    }
  })

  test('one labeled row each, in the old order; no Admin row (it is in the team menu); the shortcut hints', async () => {
    for (const role of ['member', 'admin', 'owner'] as const) {
      useSession.setState({ status: { kind: 'signed-in', me: me(role) } } as never)
      const m = await render()
      try {
        const rows = m.get('nav-rows')
        expect(rows.querySelectorAll('button').map((b) => b.getAttribute('data-testid'))).toEqual(['new-chat', 'nav-search'])
        expect(m.get('new-chat').querySelector('span')?.textContent).toBe(ko('sidebar.askAi', { name: aiName }))
        // its icon is the mark that asks the AI (the room header's ✦, rooms/AiFace.tsx AiMark): Trina's star drawn 18 in
        // the 16 px slot where the product is named after its AI, else the sparkle at 16; never the orange speech bubble
        const mark = m.get('new-chat').querySelector('svg')!
        expect(mark.hasAttribute('data-trina-star')).toBe(PRODUCT_NAMED_AFTER_AI)
        expect(mark.getAttribute('width')).toBe(PRODUCT_NAMED_AFTER_AI ? '18' : '16')
        expect(mark.className).toBe(PRODUCT_NAMED_AFTER_AI ? 'shrink-0 -m-px' : 'lucide lucide-sparkles shrink-0')
        expect(m.get('new-chat').outerHTML).not.toMatch(/message-square-plus|text-accent-text/)
        expect(m.get('new-chat').querySelector('kbd')?.textContent).toMatch(/^(⇧⌘O|Ctrl\+Shift\+O)$/)
        expect(m.get('nav-search').textContent?.trim()).toStartWith(ko('sidebar.search'))
        expect(m.get('nav-search').querySelector('kbd')?.textContent).toMatch(/^(⌘K|Ctrl\+K)$/)
        const links = rows.querySelectorAll('a')
        // Connectors last: the apps the AI uses with the person's own accounts (pages/Connectors.tsx); the Inbox opens
        // its own page, Activity (pages/Activity.tsx)
        expect(links.map((a) => a.getAttribute('href'))).toEqual(['/projects', '/scheduled', '/activity', '/files', '/skills', '/connectors'])
        expect(links.map((a) => a.textContent?.trim())).toEqual([ko('sidebar.projects'), ko('sidebar.scheduled'), ko('inbox.title'), ko('sidebar.files'), ko('sidebar.skills'), ko('integrations.title')])
        expect(m.find('nav-admin')).toBeNull()
        // no icon row and no tooltips any more: each row says its name
        expect(m.find('nav-icons')).toBeNull()
        expect(m.find('nav-tip')).toBeNull()
      } finally {
        await m.unmount()
      }
    }
  })

  test('the Inbox count is on its row, in words for a screen reader; team skills has no count of its own', async () => {
    inboxCount = 3
    const m = await render()
    try {
      await m.until(() => m.find('inbox-unread'), 'the Inbox count')
      const count = m.get('inbox-unread').querySelectorAll('span')
      expect(count.map((x) => [x.getAttribute('aria-hidden'), x.textContent])).toEqual([['true', '3'], [null, ko('notifications.unread', { count: 3 })]])
      expect(m.get('nav-inbox').textContent?.trim()).toStartWith(ko('inbox.title'))
      expect(m.find('skills-pending')).toBeNull()
      expect(calls.some((c) => c.includes('/api/skills/overview'))).toBe(false)
    } finally {
      await m.unmount()
    }
  })

  test('대화: strictly the five latest and the room on screen; "더 보기 (N)" says what is unread behind it and opens the rest in place, remembered', async () => {
    const long = '신제품 출시 태스크포스 (마케팅·디자인·영업·콘텐츠전략파트 합동) 2026 상반기'
    const list = [room({ name: long }), ...Array.from({ length: 59 }, (_, i) => room({ name: `팀 ${i + 1}` }))]
    list[2] = { ...list[2]!, unreadCount: 4 }
    list[7] = { ...list[7]!, unreadCount: 2 }
    list[20] = { ...list[20]!, threadsUnread: 1 }
    list[30] = { ...list[30]!, mentioned: true, unreadCount: 1 }
    list[40] = { ...list[40]!, muted: true, unreadCount: 9 }
    useRooms.setState({ rooms: list, loaded: true, failed: null })
    const names = (m: Awaited<ReturnType<typeof render>>) => m.get('sidebar-rooms-list').querySelectorAll('[data-testid="sidebar-room"]').map((a) => a.getAttribute('href'))
    // the room on screen (the 51st) is the sixth; unread rooms further down stay behind "더 보기", counted there
    let m = await render(`/rooms/${list[50]!.id}`)
    try {
      expect(names(m)).toEqual([0, 1, 2, 3, 4, 50].map((i) => `/rooms/${list[i]!.id}`))
      expect(m.get('rooms-more').querySelector('span')?.textContent).toBe(ko('sidebar.showMore', { n: 54 }))
      expect(m.get('rooms-more').getAttribute('aria-expanded')).toBe('false')
      // 2 + 1 (a followed reply) + 1, not the muted room's 9; "@" for the mention; a screen reader hears it in words
      const pill = m.get('rooms-more-unread')
      expect(pill.querySelector('[aria-hidden]')?.textContent).toBe(`@ ${ko('sidebar.moreUnread', { n: '4' })}`)
      expect(pill.querySelectorAll('span')[1]?.textContent).toBe(`${ko('rooms.unread', { n: 4 })}, ${ko('rooms.mentionedYou')}`)
      expect(pill.getAttribute('data-muted')).toBeNull()
      expect(m.html()).toContain(`title="${long}"`)
      await m.click('rooms-more')
      expect(names(m).length).toBe(60)
      expect(m.get('rooms-more').textContent).toBe(ko('common.less'))
      expect(m.find('rooms-more-unread')).toBeNull()
      expect(localStorage.getItem('mycel.sidebar.roomsAll')).toBe('yes')
    } finally {
      await m.unmount()
    }
    // a reload keeps it open; "접기" closes it again (no room on screen: five)
    m = await render()
    try {
      expect(names(m).length).toBe(60)
      await m.click('rooms-more')
      expect(names(m)).toEqual([0, 1, 2, 3, 4].map((i) => `/rooms/${list[i]!.id}`))
      expect(m.get('rooms-more').querySelector('span')?.textContent).toBe(ko('sidebar.showMore', { n: 55 }))
      expect(localStorage.getItem('mycel.sidebar.roomsAll')).toBe('no')
    } finally {
      await m.unmount()
    }
  })

  test('"더 보기" with only muted rooms unread behind it: their count, grey; nothing unread there: no pill', async () => {
    const list = Array.from({ length: 8 }, (_, i) => room({ name: `팀 ${i + 1}` }))
    list[6] = { ...list[6]!, muted: true, unreadCount: 120 }
    useRooms.setState({ rooms: list, loaded: true, failed: null })
    let m = await render()
    try {
      expect(m.get('rooms-more-unread').getAttribute('data-muted')).toBe('')
      expect(m.get('rooms-more-unread').querySelector('[aria-hidden]')?.textContent).toBe(ko('sidebar.moreUnread', { n: '99+' }))
    } finally {
      await m.unmount()
    }
    useRooms.setState({ rooms: list.map((r) => ({ ...r, unreadCount: 0 })), loaded: true, failed: null })
    m = await render()
    try {
      expect(m.find('rooms-more')).not.toBeNull()
      expect(m.find('rooms-more-unread')).toBeNull()
    } finally {
      await m.unmount()
    }
  })

  test('트리나 기록 opened in full stays so after a reload (this browser)', async () => {
    localStorage.setItem('mycel.sidebar.recentsAll', 'yes')
    const m = await render()
    try {
      expect(m.find('ai-chats-latest')).toBeNull()
      expect(m.get('recents-list').querySelectorAll('a[href^="/c/"]').length).toBe(8)
      expect(m.find('ai-chats-less')).not.toBeNull()
    } finally {
      await m.unmount()
    }
  })

  test('every room in sight: the entry stays, "모든 대화" to the whole conversations page; no rooms, no entry', async () => {
    useRooms.setState({ rooms: [room({ name: '하나' }), room({ name: '둘' }), room({ name: '셋' })], loaded: true, failed: null })
    let m = await render()
    try {
      expect(m.get('sidebar-rooms-list').querySelectorAll('[data-testid="sidebar-room"]').length).toBe(3)
      expect(m.find('rooms-more')).toBeNull()
      expect(m.get('rooms-all').textContent).toBe(ko('sidebar.allRooms'))
      expect(m.get('rooms-all').getAttribute('href')).toBe('/rooms')
    } finally {
      await m.unmount()
    }
    // a remembered "더 보기" changes nothing while nothing is hidden
    localStorage.setItem('mycel.sidebar.roomsAll', 'yes')
    m = await render()
    try {
      expect(m.find('rooms-more')).toBeNull()
      expect(m.find('rooms-all')).not.toBeNull()
    } finally {
      await m.unmount()
    }
    useRooms.setState({ rooms: [], loaded: true, failed: null })
    m = await render()
    try {
      expect(m.find('rooms-all')).toBeNull()
      expect(m.find('rooms-more')).toBeNull()
    } finally {
      await m.unmount()
    }
  })

  describe('"더 보기" opened: the top rows stay, the rest by kind (docs/DECISIONS.md "Conversations by kind under Show more")', () => {
    const DANA = { id: 'dana', name: 'Dana' }, EVE = { id: 'eve', name: 'Eve' }
    // the store's order, latest activity first: the five on top, then a mix of every kind
    const byKind = () => [
      room({ name: '디자인' }), room({ kind: 'dm', name: null, groupId: null, peers: [BEN] }), room({ kind: 'group', name: '주간회의', groupId: null }),
      room({ name: '개발' }), room({ kind: 'dm', name: null, groupId: null, peers: [CY] }),
      room({ kind: 'dm', name: null, groupId: null, peers: [EVE] }), room({ name: '영업' }), room({ kind: 'all', name: null, groupId: null }),
      room({ kind: 'group', name: '점심 모임', groupId: null }), room({ name: '기획' }), room({ kind: 'dm', name: null, groupId: null, peers: [DANA] }),
      room({ kind: 'group', name: '가을 워크숍', groupId: null }),
    ]
    /** the list's items in order: a section's heading as "# words", a room row as its name, another row as its test id */
    const items = (m: Awaited<ReturnType<typeof render>>) =>
      m.get('sidebar-rooms-list').children.map((li) => {
        const id = li.getAttribute('data-testid')
        return id === 'sidebar-rooms-section' ? `# ${li.textContent}` : id === 'sidebar-room-row' ? li.querySelector('span[title]')!.getAttribute('title') : li.children[0]!.getAttribute('data-testid')
      })
    const hrefs = (m: Awaited<ReturnType<typeof render>>) => m.get('sidebar-rooms-list').querySelectorAll('[data-testid="sidebar-room"]').map((a) => a.getAttribute('href'))

    test('the five on top where they were; then 팀 대화방 (전체 first, then by name), 그룹 대화 and 1:1 대화 by latest activity; every room once', async () => {
      const list = byKind()
      useRooms.setState({ rooms: list, loaded: true, failed: null })
      const m = await render()
      try {
        const before = hrefs(m)
        expect(before).toEqual(list.slice(0, 5).map((r) => `/rooms/${r.id}`))
        expect(m.find('sidebar-rooms-section')).toBeNull()
        await m.click('rooms-more')
        expect(hrefs(m).slice(0, 5)).toEqual(before)
        expect(items(m).slice(5)).toEqual([
          `# ${ko('rooms.section.team')}`, ko('rooms.all'), '기획', '영업',
          `# ${ko('rooms.section.group')}`, '점심 모임', '가을 워크숍',
          `# ${ko('rooms.section.dm')}`, 'Eve', 'Dana',
          'rooms-more',
        ])
        expect(m.get('rooms-more').textContent).toBe(ko('common.less'))
        expect(new Set(hrefs(m)).size).toBe(list.length)
        expect(hrefs(m).length).toBe(list.length)
        // quiet labels: headings inside the list's own items, not counted as items and not buttons
        const heads = m.get('sidebar-rooms-list').querySelectorAll('[data-testid="sidebar-rooms-section"]')
        expect(heads.map((h) => [h.localName, h.getAttribute('role'), h.children[0]!.localName, h.querySelectorAll('button, a').length])).toEqual(Array(3).fill(['li', 'presentation', 'h3', 0]))
        expect(heads.map((h) => h.getAttribute('data-section'))).toEqual(['team', 'group', 'dm'])
        expect(heads[0]!.children[0]!.className).toBe('px-3 pt-4 pb-1 text-micro font-medium text-faint')
        // the rows below say their section; the top rows none
        const rows = m.get('sidebar-rooms-list').querySelectorAll('[data-testid="sidebar-room-row"]')
        expect(rows.map((r) => r.getAttribute('data-section'))).toEqual([null, null, null, null, null, 'team', 'team', 'team', 'group', 'group', 'dm', 'dm'])
        // the fold's aria-controls covers the headings too
        expect(m.get('rooms-toggle').getAttribute('aria-controls')).toBe(m.get('sidebar-rooms-list').getAttribute('id'))
        // "접기": as before; the button stays (rooms are behind it), and so does the keyboard
        m.get('rooms-more').focus()
        await m.click('rooms-more')
        expect(hrefs(m)).toEqual(before)
        expect(m.find('sidebar-rooms-section')).toBeNull()
        expect(m.get('rooms-more').ownerDocument!.activeElement).toBe(m.get('rooms-more'))
      } finally {
        await m.unmount()
      }
    })

    test('a kind with no room below the top rows has no heading', async () => {
      // the one group chat is among the five on top
      const list = byKind().filter((r) => r.kind !== 'group' || r.name === '주간회의')
      useRooms.setState({ rooms: list, loaded: true, failed: null })
      localStorage.setItem('mycel.sidebar.roomsAll', 'yes')
      const m = await render()
      try {
        expect(m.get('sidebar-rooms-list').querySelectorAll('[data-testid="sidebar-rooms-section"]').map((h) => h.getAttribute('data-section'))).toEqual(['team', 'dm'])
        expect(m.html()).not.toContain(ko('rooms.section.group'))
      } finally {
        await m.unmount()
      }
    })

    test('the room on screen is not added on top while opened: it is in its own section, active; closed, it is the sixth', async () => {
      const list = byKind()
      const dana = list[10]!
      useRooms.setState({ rooms: list, loaded: true, failed: null })
      localStorage.setItem('mycel.sidebar.roomsAll', 'yes')
      const m = await render(`/rooms/${dana.id}`)
      try {
        expect(hrefs(m).slice(0, 5)).toEqual(list.slice(0, 5).map((r) => `/rooms/${r.id}`))
        expect(hrefs(m).filter((h) => h === `/rooms/${dana.id}`)).toHaveLength(1)
        expect(hrefs(m).length).toBe(list.length)
        const row = m.get('sidebar-rooms-list').querySelector(`[data-testid="sidebar-room"][href="/rooms/${dana.id}"]`)!
        expect(row.getAttribute('aria-current')).toBe('page')
        expect(row.closest('[data-testid="sidebar-room-row"]')!.getAttribute('data-section')).toBe('dm')
        await m.click('rooms-more')
        expect(hrefs(m)).toEqual([...list.slice(0, 5), dana].map((r) => `/rooms/${r.id}`))
        expect(m.get('rooms-more').querySelector('span')?.textContent).toBe(ko('sidebar.showMore', { n: 6 }))
      } finally {
        await m.unmount()
      }
    })

    test('"접기" stays while the only room below the top rows is the one on screen (opened from its section)', async () => {
      const list = byKind().slice(0, 6)
      useRooms.setState({ rooms: list, loaded: true, failed: null })
      // closed, with nothing on screen: "더 보기 (1)"; opened, it is under 1:1 대화
      let m = await render()
      try {
        expect(m.get('rooms-more').querySelector('span')?.textContent).toBe(ko('sidebar.showMore', { n: 1 }))
        await m.click('rooms-more')
        expect(items(m).slice(5)).toEqual([`# ${ko('rooms.section.dm')}`, 'Eve', 'rooms-more'])
      } finally {
        await m.unmount()
      }
      // that room open (its row clicked): still opened, the same rows, "접기" and not "모든 대화"
      m = await render(`/rooms/${list[5]!.id}`)
      try {
        expect(items(m).slice(5)).toEqual([`# ${ko('rooms.section.dm')}`, 'Eve', 'rooms-more'])
        expect(m.get('rooms-more').textContent).toBe(ko('common.less'))
        expect(m.get('rooms-more').getAttribute('aria-expanded')).toBe('true')
        expect(m.find('rooms-all')).toBeNull()
        // closed: it is the sixth, nothing else is behind "더 보기", so the row is "모든 대화" again, and the keyboard that
        // pressed "접기" is on it (not dropped to the page with the button)
        m.get('rooms-more').focus()
        await m.click('rooms-more')
        expect(hrefs(m)).toEqual(list.map((r) => `/rooms/${r.id}`))
        expect(m.find('rooms-more')).toBeNull()
        expect(m.get('rooms-all').textContent).toBe(ko('sidebar.allRooms'))
        expect(m.get('rooms-all').ownerDocument!.activeElement).toBe(m.get('rooms-all'))
      } finally {
        await m.unmount()
      }
    })

    test('rooms I hid stay out of the sections ("모든 대화" leads to them); the hidden room on screen is in its section', async () => {
      const list = byKind()
      list[6] = { ...list[6]!, hidden: true } // 영업
      list[10] = { ...list[10]!, hidden: true } // Dana
      useRooms.setState({ rooms: list, loaded: true, failed: null })
      localStorage.setItem('mycel.sidebar.roomsAll', 'yes')
      let m = await render()
      try {
        expect(items(m).slice(5)).toEqual([
          `# ${ko('rooms.section.team')}`, ko('rooms.all'), '기획', `# ${ko('rooms.section.group')}`, '점심 모임', '가을 워크숍', `# ${ko('rooms.section.dm')}`, 'Eve', 'rooms-more', 'rooms-all',
        ])
      } finally {
        await m.unmount()
      }
      m = await render(`/rooms/${list[10]!.id}`)
      try {
        expect(items(m).slice(5)).toEqual([
          `# ${ko('rooms.section.team')}`, ko('rooms.all'), '기획', `# ${ko('rooms.section.group')}`, '점심 모임', '가을 워크숍', `# ${ko('rooms.section.dm')}`, 'Eve', 'Dana', 'rooms-more', 'rooms-all',
        ])
      } finally {
        await m.unmount()
      }
    })
  })

  test('five AI chats, newest first, then "모두 보기" for the whole history (and "접기" back)', async () => {
    const m = await render()
    try {
      const latest = m.get('ai-chats-latest').querySelectorAll('a[href^="/c/"]')
      expect(latest.map((a) => a.textContent)).toEqual(['채팅 8', '채팅 7', '채팅 6', '채팅 5', '채팅 4'])
      await m.click('ai-chats-all')
      expect(m.find('ai-chats-latest')).toBeNull()
      expect(m.get('recents-list').querySelectorAll('a[href^="/c/"]').length).toBe(8)
      expect(localStorage.getItem('mycel.sidebar.recentsAll')).toBe('yes')
      await m.click('ai-chats-less')
      expect(m.get('ai-chats-latest').querySelectorAll('a[href^="/c/"]').length).toBe(5)
      expect(localStorage.getItem('mycel.sidebar.recentsAll')).toBe('no')
    } finally {
      await m.unmount()
    }
  })

  test('strictly the five latest AI chats and the chat on screen; "모두 보기" says how many hidden ones need me', async () => {
    useChats.setState({ chats: [chat(1, { unseen: true }), chat(2), chat(3), ...Array.from({ length: 5 }, (_, i) => chat(i + 4))] })
    // a row's link is its title and its marker (a "?" pill's mark is hidden from screen readers: its label says it)
    const titles = (m: Awaited<ReturnType<typeof render>>) => m.get('ai-chats-latest').querySelectorAll('a[href^="/c/"]').map((a) => a.textContent?.replace(/\?$/, ''))
    // an unseen answer behind it: the accent dot, "답 필요 1"
    let m = await render()
    try {
      expect(titles(m)).toEqual(['채팅 8', '채팅 7', '채팅 6', '채팅 5', '채팅 4'])
      expect(m.get('ai-chats-needs').textContent).toBe(ko('sidebar.needsYou', { n: 1 }))
      expect(m.get('ai-chats-needs').className).not.toContain('text-warn')
    } finally {
      await m.unmount()
    }
    // the chat on screen is the sixth; a hidden chat whose AI waits for me (the list's word, or a card in this window)
    // turns it to the warn colour
    useChats.setState({ chats: [chat(1, { unseen: true }), chat(2, { waiting: true, runState: 'running' }), chat(3), ...Array.from({ length: 5 }, (_, i) => chat(i + 4))] })
    useChats.setState({ requests: { q: { chatId: chat(3).id } } as never })
    m = await render(`/c/${chat(1).id}`)
    try {
      expect(titles(m)).toEqual(['채팅 8', '채팅 7', '채팅 6', '채팅 5', '채팅 4', '채팅 1'])
      expect(m.get('ai-chats-needs').textContent).toBe(ko('sidebar.needsYou', { n: 2 }))
      expect(m.get('ai-chats-needs').className).toContain('text-warn')
    } finally {
      await m.unmount()
    }
    // nothing needs me behind it, or only an unseen answer in a chat that runs again (its row shows the running dot):
    // "모두 보기" alone
    useChats.setState({ chats: [chat(1, { unseen: true, runState: 'running' }), ...Array.from({ length: 7 }, (_, i) => chat(i + 2))], requests: {} })
    m = await render()
    try {
      expect(m.find('ai-chats-all')).not.toBeNull()
      expect(m.find('ai-chats-needs')).toBeNull()
    } finally {
      await m.unmount()
    }
  })

  test('"모두 보기" stays while all of them fit (the whole history with its filters is behind it); no history, no entry', async () => {
    useChats.setState({ chats: [chat(1), chat(2)] })
    let m = await render()
    try {
      expect(m.get('ai-chats-latest').querySelectorAll('a[href^="/c/"]').length).toBe(2)
      expect(m.get('ai-chats-all').textContent).toBe(ko('rooms.showAll'))
      expect(m.find('ai-chats-needs')).toBeNull()
      await m.click('ai-chats-all')
      expect(m.find('ai-chats-latest')).toBeNull()
      expect(m.get('recents-list').querySelectorAll('a[href^="/c/"]').length).toBe(2)
      await m.click('ai-chats-less')
      expect(m.get('ai-chats-latest').querySelectorAll('a[href^="/c/"]').length).toBe(2)
    } finally {
      await m.unmount()
    }
    useChats.setState({ chats: [] })
    m = await render()
    try {
      expect(m.find('ai-chats-all')).toBeNull()
    } finally {
      await m.unmount()
    }
  })

  test('both groups fold, and stay folded after a reload (this browser)', async () => {
    let m = await render()
    try {
      await m.click('rooms-toggle')
      await m.click('recents-toggle')
      expect(m.get('sidebar-rooms-list').getAttribute('hidden')).not.toBeNull()
      expect(m.get('recents-list').getAttribute('hidden')).not.toBeNull()
      expect(localStorage.getItem('mycel.sidebar.rooms')).toBe('closed')
      expect(localStorage.getItem('mycel.sidebar.recents')).toBe('closed')
    } finally {
      await m.unmount()
    }
    m = await render()
    try {
      expect(m.get('rooms-toggle').getAttribute('aria-expanded')).toBe('false')
      expect(m.get('recents-toggle').getAttribute('aria-expanded')).toBe('false')
      await m.click('recents-toggle')
      expect(localStorage.getItem('mycel.sidebar.recents')).toBe('open')
      expect(m.get('recents-list').getAttribute('hidden')).toBeNull()
    } finally {
      await m.unmount()
    }
  })

  test('one session marker per row, from the list, with no request per chat: "?" > spinner > dot, nothing when idle', async () => {
    useChats.setState({
      chats: [
        chat(1, { runState: 'running', waiting: true }),
        chat(2, { unseen: true }),
        chat(3),
        chat(4, { runState: 'queued', unseen: true }),
        chat(5, { unseen: true, lastOutcome: 'error' }),
      ],
    })
    const m = await render()
    try {
      const rows = m.get('ai-chats-latest').querySelectorAll('li')
      const row = (title: string) => rows.find((r) => r.textContent?.includes(title))!
      const marks = (title: string) => ['marker-ask', 'marker-running', 'marker-new'].flatMap((id) => [...row(title).querySelectorAll(`[data-testid="${id}"]`)])
      // one marker at most per row; its reason names it (and so the link)
      for (const n of [1, 2, 3, 4, 5]) expect(marks(`채팅 ${n}`).length).toBeLessThanOrEqual(1)
      expect(marks('채팅 1')[0]!.getAttribute('data-testid')).toBe('marker-ask')
      expect(marks('채팅 1')[0]!.getAttribute('aria-label')).toBe(ko('marker.card'))
      expect(marks('채팅 2')[0]!.getAttribute('data-testid')).toBe('marker-new')
      expect(marks('채팅 2')[0]!.getAttribute('aria-label')).toBe(ko('marker.new'))
      // a row that needs me ("?" or the dot) reads in ink; a running or idle one stays muted
      expect(row('채팅 2').querySelector('a')!.className).toContain('text-ink')
      expect(row('채팅 5').querySelector('a')!.className).toContain('text-ink')
      expect(row('채팅 4').querySelector('a')!.className).toContain('text-muted')
      expect(row('채팅 3').querySelector('a')!.className).toContain('text-muted')
      expect(marks('채팅 3').length).toBe(0)
      expect(marks('채팅 4')[0]!.getAttribute('data-testid')).toBe('marker-running')
      expect(marks('채팅 4')[0]!.getAttribute('aria-label')).toBe(ko('marker.queued'))
      expect(marks('채팅 5')[0]!.getAttribute('data-reason')).toBe('error')
      expect(marks('채팅 5')[0]!.getAttribute('aria-label')).toBe(ko('marker.error'))
      await m.settle(30)
      expect(calls.filter((c) => /\/api\/chats\/[^/]+\/requests/.test(c))).toEqual([])
    } finally {
      await m.unmount()
    }
  })

  test('the chat on screen in a visible window has no new-answer dot (it is being seen)', async () => {
    const c = chat(2, { unseen: true })
    useChats.setState({ chats: [c] })
    useSessionMarkers.setState({ onScreen: c.id, visible: true })
    const m = await render(`/c/${c.id}`)
    try {
      expect(m.find('marker-new')).toBeNull()
    } finally {
      await m.unmount()
      useSessionMarkers.setState({ onScreen: null })
    }
  })
})

describe('the hairline at the top of the scroll', () => {
  for (const phone of [false, true]) {
    test(`${phone ? 'the phone drawer' : 'a computer'}: none at the top, shown while scrolled, gone back at the top; the 1 px stays`, async () => {
      wide = !phone
      const m = await render()
      try {
        const box = m.get('sidebar-scroll')
        const line = () => [box.getAttribute('data-scrolled'), /\bborder-line\b/.test(box.className), /\bborder-transparent\b/.test(box.className), /\bborder-t\b/.test(box.className)]
        expect(line()).toEqual([null, false, true, true])
        Object.assign(box, { scrollTop: 120 })
        await act(async () => { box.dispatchEvent(new FakeEvent('scroll')) })
        expect(line()).toEqual(['', true, false, true])
        Object.assign(box, { scrollTop: 0 })
        await act(async () => { box.dispatchEvent(new FakeEvent('scroll')) })
        expect(line()).toEqual([null, false, true, true])
      } finally {
        await m.unmount()
      }
    })
  }
})

describe('the phone drawer keeps its own layout', () => {
  test('the AI history only: no team name, icons or rooms; all its chats; its own rows', async () => {
    wide = false
    const m = await render()
    try {
      expect(m.find('nav-rows')).toBeNull()
      expect(m.find('sidebar-rooms')).toBeNull()
      expect(m.find('ai-chats-all')).toBeNull()
      expect(m.get('recents-list').querySelectorAll('a[href^="/c/"]').length).toBe(8)
      expect(m.get('recents-toggle').textContent).toBe(ko('sidebar.aiChats', { name: aiName }))
      expect(m.get('nav-skills').getAttribute('href')).toBe('/skills')
      expect(m.get('nav-connectors').getAttribute('href')).toBe('/connectors')
      // Activity (the Inbox) is the 나 tab's on a phone, not a drawer row
      expect(m.find('nav-inbox')).toBeNull()
      expect(m.get('nav-trash').getAttribute('href')).toBe('/trash')
    } finally {
      await m.unmount()
    }
  })
})

describe('the section titles stand out (QA TC-149)', () => {
  // classes of an element, as a set
  const cls = (el: { className: unknown } | null | undefined) => new Set(String(el?.className ?? '').split(/\s+/))
  for (const phone of [false, true]) {
    test(`${phone ? 'the phone drawer' : 'a computer'}: 대화 and 트리나 기록 as large as the rows and bold, in ink; the labels inside and 더 보기 stay small and grey; no line or box`, async () => {
      wide = !phone
      // enough rooms of each kind for "더 보기" and its labels by kind
      if (!phone) useRooms.setState({ rooms: [...Array.from({ length: 6 }, (_, i) => room({ name: `팀 ${i + 1}` })), room({ kind: 'group', name: '주간회의', groupId: null }), room({ kind: 'dm', name: null, groupId: null, peers: [BEN] })], loaded: true, failed: null })
      const m = await render()
      try {
        const titles = phone ? ['recents-toggle'] : ['rooms-toggle', 'recents-toggle']
        const row = m.get('recents-list').querySelector('a[href^="/c/"]')
        // the rows are text-sm (14px; 15px on phones), so the titles are too
        expect(cls(row).has('text-sm')).toBe(true)
        for (const id of titles) {
          const h2 = m.get(id).closest('h2')!
          const c = cls(h2)
          for (const want of ['text-sm', 'font-bold', 'text-ink']) expect(c.has(want)).toBe(true)
          for (const not of ['text-xs', 'text-micro', 'font-semibold', 'text-faint', 'text-muted']) expect(c.has(not)).toBe(false)
          // type only: no border, fill or ring on the title, its button or its row
          for (const el of [h2, m.get(id), h2.parentElement!]) for (const k of cls(el)) expect(k).not.toMatch(/^(border|bg-|ring|shadow|divide)/)
          // the fold arrow is still there
          expect(m.get(id).querySelector('svg')).not.toBeNull()
        }
        if (!phone) {
          // "더 보기" under each list stays small and grey
          for (const id of ['rooms-more', 'ai-chats-all']) for (const want of ['text-xs', 'text-muted']) expect(cls(m.get(id)).has(want)).toBe(true)
          // opened, the labels by kind (팀 채팅방, 1:1 대화…) and by date (오늘…) show; "접기" stays small and grey too
          await m.click('rooms-more')
          await m.click('ai-chats-all')
          expect(m.get('rooms-more').textContent).toBe(ko('common.less'))
          for (const want of ['text-xs', 'text-muted']) expect(cls(m.get('rooms-more')).has(want)).toBe(true)
          expect(m.get('sidebar-rooms-list').querySelectorAll('h3').length).toBeGreaterThan(0)
        }
        // the labels inside the lists (by kind; by date: 오늘, 어제…) stay small and faint, under the titles
        const heads = [...m.get('sidebar-scroll').querySelectorAll('h3')]
        expect(m.get('recents-list').querySelectorAll('h3').length).toBeGreaterThan(0)
        for (const h of heads) for (const want of ['text-micro', 'font-medium', 'text-faint']) expect(cls(h).has(want)).toBe(true)
      } finally {
        await m.unmount()
      }
    })
  }
})

describe('the team logo in the header (Admin › Team settings › 팀 로고)', () => {
  const withIcon = (iconVersion: string | null, role: 'owner' | 'member' = 'member') => {
    const m0 = me(role)
    useSession.setState({ status: { kind: 'signed-in', me: { ...m0, team: { ...m0.team, iconVersion } } } } as never)
  }
  for (const role of ['member', 'owner'] as const) {
    test(`a computer (${role}): the logo at its version, 28 px, next to the team name; the phone's product mark is not there`, async () => {
      withIcon('0123456789abcdef', role)
      const m = await render()
      try {
        expect(m.get('sidebar-logo').getAttribute('src')).toBe('/team-icon?v=0123456789abcdef')
        expect(m.get('sidebar-logo').className).toContain('size-7')
        expect(m.get('sidebar-logo').className).toContain('object-cover')
        expect(m.find('sidebar-logo-phone')).toBeNull()
      } finally {
        await m.unmount()
      }
    })
  }
  test('a new version is a new address, so it shows without a reload', async () => {
    withIcon('fedcba9876543210')
    const m = await render()
    try {
      expect(m.get('sidebar-logo').getAttribute('src')).toBe('/team-icon?v=fedcba9876543210')
    } finally {
      await m.unmount()
    }
  })
  test('a computer without a logo: the product mark', async () => {
    withIcon(null)
    const m = await render()
    try {
      expect(m.get('sidebar-logo').getAttribute('src')).toBe('/favicon.svg')
    } finally {
      await m.unmount()
    }
  })
  for (const icon of ['0123456789abcdef', null]) {
    test(`the phone drawer (${icon ? 'a logo' : 'no logo'}): the product mark next to the AI's name, no team logo or name`, async () => {
      wide = false
      withIcon(icon, 'owner')
      const m = await render()
      try {
        expect(m.get('sidebar-logo-phone').getAttribute('src')).toBe('/favicon.svg')
        expect(m.get('sidebar-logo-phone').parentElement?.textContent).toBe(aiName)
        expect(m.find('sidebar-logo')).toBeNull()
        expect(m.find('sidebar-team')).toBeNull()
        expect(m.find('team-menu')).toBeNull()
      } finally {
        await m.unmount()
      }
    })
  }
})

describe('the team menu on top', () => {
  const as = (role: 'owner' | 'admin' | 'member', address?: string) => {
    const m0 = me(role)
    useSession.setState({ status: { kind: 'signed-in', me: { ...m0, team: { ...m0.team, ...(address ? { address } : {}) } } } } as never)
  }
  const key = (el: FakeElement, k: string) => act(async () => { el.dispatchEvent(new FakeEvent('keydown', { bubbles: true, cancelable: true, key: k })) })
  let path = ''
  const Where = () => { path = useLocation().pathname; return null }
  const renderWithDialog = () => mount(<MemoryRouter initialEntries={['/files']}><Sidebar /><TeamInviteDialog /><Where /></MemoryRouter>)

  test('a member: the team\'s logo and name, 16 px semibold, not a button (no menu, no ▾)', async () => {
    as('member', 'https://acme.trina.app')
    const m = await render()
    try {
      expect(m.get('team-header').tagName).toBe('DIV')
      expect(m.get('sidebar-team').textContent).toBe('에이크미 마케팅본부')
      expect(m.get('sidebar-team').className).toContain('text-base')
      expect(m.get('sidebar-team').className).toContain('font-semibold')
      expect(m.get('sidebar-team').className).toContain('truncate')
      expect(m.find('team-menu')).toBeNull()
      expect(m.get('team-header').querySelector('button, a, svg')).toBeNull()
    } finally {
      await m.unmount()
    }
  })

  for (const role of ['owner', 'admin'] as const) {
    test(`${role}: a button with ▾ opens the menu: the team with its address, then 팀원 초대 and 관리자, nothing personal`, async () => {
      as(role, 'https://acme.trina.app')
      const m = await renderWithDialog()
      try {
        const button = m.get('team-menu')
        expect(button.tagName).toBe('BUTTON')
        expect(button.getAttribute('aria-haspopup')).toBe('menu')
        expect(button.getAttribute('aria-expanded')).toBe('false')
        expect(button.textContent).toBe('에이크미 마케팅본부')
        expect(button.querySelector('svg')).not.toBeNull()
        expect(m.find('team-dropdown')).toBeNull()
        await m.click(button)
        const menu = m.get('team-dropdown')
        expect(button.getAttribute('aria-expanded')).toBe('true')
        expect(menu.getAttribute('role')).toBe('menu')
        expect(menu.getAttribute('aria-label')).toBe('에이크미 마케팅본부')
        expect(m.get('team-menu-name').textContent).toBe('에이크미 마케팅본부')
        expect(m.get('team-menu-address').textContent).toBe('acme.trina.app')
        const items = menu.querySelectorAll('[role="menuitem"]')
        expect(items.map((x) => [x.getAttribute('data-testid'), x.textContent?.trim()])).toEqual([['team-menu-invite', ko('teamMenu.invite')], ['team-menu-admin', ko('sidebar.admin')]])
        expect(document.activeElement).toBe(items[0] as never)
        // the person's own things stay in the profile menu at the bottom
        for (const id of ['account-settings', 'logout', 'account-away', 'account-trash']) expect(menu.querySelector(`[data-testid="${id}"]`)).toBeNull()
        // 관리자 opens Admin and closes the menu
        await m.click('team-menu-admin')
        expect(path).toBe('/admin')
        expect(m.find('team-dropdown')).toBeNull()
      } finally {
        await m.unmount()
      }
    })
  }

  test('no team address known: the menu names the team only', async () => {
    as('owner')
    const m = await render()
    try {
      await m.click('team-menu')
      expect(m.get('team-menu-name').textContent).toBe('에이크미 마케팅본부')
      expect(m.find('team-menu-address')).toBeNull()
    } finally {
      await m.unmount()
    }
  })

  test('the keyboard: the first item has focus, arrows wrap, Home and End; Esc closes it only and gives the keyboard back', async () => {
    as('owner')
    const closed: boolean[] = []
    const onKey = (e: { key?: string }) => { if (e.key === 'Escape') closed.push(true) }
    window.addEventListener('keydown', onKey as never)
    const m = await render()
    try {
      const button = m.get('team-menu')
      await m.click(button)
      const [invite, admin] = [m.get('team-menu-invite'), m.get('team-menu-admin')]
      expect(document.activeElement).toBe(invite as never)
      await key(invite, 'ArrowDown')
      expect(document.activeElement).toBe(admin as never)
      await key(admin, 'ArrowDown')
      expect(document.activeElement).toBe(invite as never)
      await key(invite, 'ArrowUp')
      expect(document.activeElement).toBe(admin as never)
      await key(admin, 'Home')
      expect(document.activeElement).toBe(invite as never)
      await key(invite, 'End')
      expect(document.activeElement).toBe(admin as never)
      await key(admin, 'Escape')
      expect(m.find('team-dropdown')).toBeNull()
      expect(document.activeElement).toBe(button as never)
      expect(button.getAttribute('aria-expanded')).toBe('false')
      expect(closed).toEqual([])
      // Tab closes it too, and the keyboard moves on from the button as usual
      await m.click(button)
      await key(m.get('team-menu-invite'), 'Tab')
      expect(m.find('team-dropdown')).toBeNull()
    } finally {
      window.removeEventListener('keydown', onKey as never)
      await m.unmount()
    }
  })

  test('팀원 초대 opens the invite dialog (the team link\'s message), titled 팀원 초대; closing it gives the keyboard back to the team button', async () => {
    as('admin')
    const m = await renderWithDialog()
    try {
      await m.click('team-menu')
      await m.click('team-menu-invite')
      expect(m.find('team-dropdown')).toBeNull()
      await m.until(() => m.find('invite-step'), 'the invite step')
      const dialog = document.body.querySelector('[role="dialog"]')!
      expect(dialog.querySelector('h2')?.textContent).toBe(ko('teamMenu.invite'))
      // one heading: the dialog's own (InviteStep's title is left out)
      expect(dialog.querySelectorAll('h2').length).toBe(1)
      expect(path).toBe('/files')
      await m.click('invite-step-done')
      expect(m.find('invite-step')).toBeNull()
      expect(document.activeElement).toBe(m.get('team-menu') as never)
    } finally {
      await m.unmount()
    }
  })

  test('the invite dialog closes on a page change (a link in it, ⇧⌘O): it never stays over another page', async () => {
    as('owner')
    let go: ((to: string) => void) | null = null
    const Nav = () => { const n = useNavigate(); go = n; return null }
    const m = await mount(<MemoryRouter initialEntries={['/files']}><Sidebar /><TeamInviteDialog /><Where /><Nav /></MemoryRouter>)
    try {
      await m.click('team-menu')
      await m.click('team-menu-invite')
      await m.until(() => m.find('invite-step'), 'the invite step')
      await act(async () => go!('/skills'))
      expect(path).toBe('/skills')
      expect(m.find('invite-step')).toBeNull()
    } finally {
      await m.unmount()
    }
  })

  describe('while the owner\'s welcome steps are unfinished', () => {
    const unfinished = {
      startedAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', teamType: 'marketing',
      steps: { profile: 'done', result: null, invite: null }, resultChatId: null, inviteShownAt: null, site: null, dismissedAt: null, finishedAt: null,
    } as unknown as WelcomeProgress
    let state: unknown = null
    const Here = () => { const l = useLocation(); path = l.pathname; state = l.state; return null }
    test('the owner: 팀원 초대 opens the steps\' own invite step, not a second invite dialog', async () => {
      as('owner')
      const m = await mount(<MemoryRouter initialEntries={['/files']}><Sidebar /><TeamInviteDialog /><Here /></MemoryRouter>)
      try {
        useWelcome.setState({ loaded: true, progress: unfinished })
        await m.click('team-menu')
        await m.click('team-menu-invite')
        expect(path).toBe('/welcome')
        expect(state).toEqual(INVITE_STEP_STATE)
        await m.settle(50)
        expect(m.find('invite-step')).toBeNull()
      } finally {
        await m.unmount()
      }
    })
    test('an admin who is not the owner: the invite dialog (the steps are the owner\'s; /welcome would send them Home)', async () => {
      as('admin')
      const m = await mount(<MemoryRouter initialEntries={['/files']}><Sidebar /><TeamInviteDialog /><Here /></MemoryRouter>)
      try {
        useWelcome.setState({ loaded: true, progress: unfinished })
        await m.click('team-menu')
        await m.click('team-menu-invite')
        await m.until(() => m.find('invite-step'), 'the invite dialog')
        expect(path).toBe('/files')
      } finally {
        await m.unmount()
      }
    })
  })
})

describe('a chat row\'s "…"', () => {
  const P = '01900000-0000-7000-8000-000000000301'
  const project = { id: P, name: 'Acme launch', folderPath: 'shared/acme-launch', instructions: '', createdBy: null, createdAt: '2026-11-01T00:00:00.000Z', canEdit: true }
  const shared = (by: string, canDelete: boolean) => ({ by: { id: by, name: by === 'mina' ? '김민아님' : 'Bob' }, audience: 3, answering: null, mine: true, canDelete })
  /** the row of the chat with this title, its "…" opened: the items as [test id, words] (null: the row has no "…") */
  async function items(m: Awaited<ReturnType<typeof render>>, title: string) {
    const row = m.get('recents-list').querySelectorAll('li').find((li) => li.textContent?.includes(title))!
    const more = row.querySelector(`button[aria-label="${ko('chat.menu')}"]`)
    if (!more) return null
    await m.click(more)
    const out = row.querySelectorAll('[role="menuitem"]').map((e) => [e.getAttribute('data-testid'), e.textContent?.trim()])
    await m.click(more)
    return out
  }

  test('a chat of my own: pin, rename, "프로젝트로 옮기기…" ("프로젝트 바꾸기…" in a project), delete; a shared chat: never the move', async () => {
    useChats.setState({ chats: [chat(1), chat(2, { projectId: P }), chat(3, { projectId: P, shared: shared('mina', true) }), chat(4, { projectId: P, shared: shared('bob', true) }), chat(5, { projectId: P, shared: shared('bob', false), pinnedAt: '2026-11-02T00:00:00.000Z' })] })
    const m = await render()
    const pin = ['chat-row-pin', ko('chat.pin')]
    const link = ['chat-row-copy-link', ko('rooms.menu.copyLink')]
    try {
      expect(await items(m, '채팅 1')).toEqual([pin, link, ['chat-row-rename', ko('chat.rename')], ['chat-row-move', ko('chat.project.add')], ['chat-row-delete', ko('common.delete')]])
      expect(await items(m, '채팅 2')).toEqual([pin, link, ['chat-row-rename', ko('chat.rename')], ['chat-row-move', ko('chat.project.change')], ['chat-row-delete', ko('common.delete')]])
      // shared project chats stay in their project: mine to rename and delete, an editor's to delete; a pin for anyone
      expect(await items(m, '채팅 3')).toEqual([pin, link, ['chat-row-rename', ko('chat.rename')], ['chat-row-delete', ko('common.delete')]])
      expect(await items(m, '채팅 4')).toEqual([pin, link, ['chat-row-delete', ko('common.delete')]])
      expect(await items(m, '채팅 5')).toEqual([['chat-row-unpin', ko('chat.unpin')], link])
    } finally {
      await m.unmount()
    }
  })

  test('링크 복사: the chat\'s address alone on this origin; the toast says who can open it (the project\'s people, or only me)', async () => {
    useChats.setState({ chats: [chat(1), chat(3, { projectId: P, shared: shared('bob', false) })] })
    const copied: string[] = []
    const g = globalThis as Record<string, unknown>
    const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    const hadLocation = 'location' in g
    const loc = g.location
    g.location = { origin: 'https://team.acme.example', pathname: '/', search: '' }
    Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { ...globalThis.navigator, clipboard: { writeText: async (x: string) => void copied.push(x) } } })
    const m = await render()
    try {
      for (const [title, n, text] of [['채팅 1', 1, ko('chat.linkCopiedPrivate')], ['채팅 3', 3, ko('chat.linkCopiedShared', { n: 3 })]] as const) {
        const row = m.get('recents-list').querySelectorAll('li').find((li) => li.textContent?.includes(title))!
        await m.click(row.querySelector(`button[aria-label="${ko('chat.menu')}"]`)!)
        await m.click(row.querySelector('[data-testid="chat-row-copy-link"]')!)
        await m.until(() => copied.length === (n === 1 ? 1 : 2), 'the copy')
        expect(copied.at(-1)).toBe(`https://team.acme.example/c/${chat(n).id}`)
        expect(useUi.getState().toasts.at(-1)?.text).toBe(text)
      }
      expect(ko('chat.linkCopiedShared', { n: 3 })).toBe('링크를 복사했어요 · 멤버 3명이 열 수 있어요')
      await m.settle(1600)
    } finally {
      if (nav) Object.defineProperty(globalThis, 'navigator', nav)
      if (hadLocation) g.location = loc
      else delete g.location
      await m.unmount()
    }
  })

  test('Esc closes the menu only, and the keyboard is back on "…"', async () => {
    useChats.setState({ chats: [chat(1)] })
    const closed: boolean[] = []
    const onKey = (e: { key?: string }) => { if (e.key === 'Escape') closed.push(true) }
    window.addEventListener('keydown', onKey as never)
    const m = await render()
    try {
      const row = m.get('recents-list').querySelector('li')!
      const more = row.querySelector(`button[aria-label="${ko('chat.menu')}"]`)!
      await m.click(more)
      const item = m.get('chat-row-move')
      item.focus()
      await act(async () => { item.dispatchEvent(new FakeEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' })) })
      expect(m.find('chat-row-move')).toBeNull()
      expect(document.activeElement).toBe(more as never)
      // not on to the page's own Esc (Layout: the phone's drawer, the side panel)
      expect(closed).toEqual([])
    } finally {
      window.removeEventListener('keydown', onKey as never)
      await m.unmount()
    }
  })

  test('the rooms\' row menu: a right-click on the row opens it; on a touch screen a long press does, with the chat\'s title on top, and the finger lifting opens no chat', async () => {
    useChats.setState({ chats: [chat(1)] })
    let path = ''
    const Where = () => { path = useLocation().pathname; return null }
    const m = await mount(<MemoryRouter initialEntries={['/']}><Sidebar /><Where /></MemoryRouter>)
    try {
      const row = m.get('recents-list').querySelector('li')!
      const link = row.querySelector('a')!
      const shown = () => row.querySelectorAll('[role="menuitem"]').length
      await m.settle(0)
      const e = new FakeEvent('contextmenu', { bubbles: true, cancelable: true })
      link.dispatchEvent(e)
      await m.until(() => shown() === 5, 'the menu')
      expect(e.defaultPrevented).toBe(true)
      await m.click(row.querySelector(`button[aria-label="${ko('chat.menu')}"]`)!)
      expect(shown()).toBe(0)
      const press = (type: string) => link.dispatchEvent(Object.assign(new FakeEvent(type, { bubbles: true, cancelable: true }), { pointerType: 'touch', clientX: 20, clientY: 20 }))
      press('pointerdown')
      await m.settle(600)
      press('pointerup')
      await m.until(() => shown() === 5, 'the sheet')
      expect(m.get('menu-sheet-title').textContent).toBe('채팅 1')
      // the click that follows the finger lifting is no tap on the row
      await m.click(link)
      expect(path).toBe('/')
      // the link holds no text a long press could start selecting on a touch screen
      expect(link.getAttribute('class')).toContain('pointer-coarse:select-none')
      // the "···" shows on a phone: a long press on it opens the menu, and the click of the finger lifting does not close it
      const more = row.querySelector(`button[aria-label="${ko('chat.menu')}"]`)!
      // a later click on it closes it as usual
      await m.settle(850)
      await m.click(more)
      expect(shown()).toBe(0)
      const hold = (type: string) => more.dispatchEvent(Object.assign(new FakeEvent(type, { bubbles: true, cancelable: true }), { pointerType: 'touch', clientX: 20, clientY: 20 }))
      hold('pointerdown')
      await m.settle(600)
      hold('pointerup')
      await m.until(() => shown() === 5, 'the sheet again')
      await m.click(more)
      expect(shown()).toBe(5)
    } finally {
      await m.unmount()
    }
  })

  test('the move opens the title menu\'s dialog; a save moves the chat and the list has it', async () => {
    const id = chat(1).id
    const sent: unknown[] = []
    routes = {
      'GET /api/projects': () => json({ items: [project] }),
      [`PATCH /api/chats/${id}`]: (init) => {
        const body = JSON.parse(String(init?.body)) as { projectId: string | null }
        sent.push(body)
        return json({ ...chat(1), projectId: body.projectId })
      },
    }
    useChats.setState({ chats: [chat(1)] })
    const m = await render()
    try {
      const row = m.get('recents-list').querySelector('li')!
      await m.click(row.querySelector(`button[aria-label="${ko('chat.menu')}"]`)!)
      await m.click('chat-row-move')
      // the menu closed; the dialog is in <body>, with the projects I can see
      expect(m.find('chat-row-move')).toBeNull()
      const choices = await m.until(() => (m.find('chat-project-choices')?.textContent?.includes('Acme launch') ? m.get('chat-project-choices') : null), 'the projects')
      const radio = choices.querySelectorAll('input').find((r) => r.parentNode?.textContent?.includes('Acme launch'))!
      // a click on a radio checks it (past React's value tracker, as a browser does), then React hears the click
      await act(async () => {
        Object.getOwnPropertyDescriptor(FakeElement.prototype, 'checked')!.set!.call(radio, true)
        radio.dispatchEvent(new FakeEvent('click', { bubbles: true, cancelable: true }))
      })
      await m.click('chat-project-save')
      await m.until(() => useChats.getState().chats.find((c) => c.id === id)?.projectId === P, 'the chat in the project')
      expect(sent).toEqual([{ projectId: P }])
      expect(useUi.getState().toasts.at(-1)?.text).toBe(ko('chat.project.moved', { name: 'Acme launch' }))
      await m.until(() => !m.find('chat-project-choices'), 'the dialog to close')
    } finally {
      await m.unmount()
    }
  })
})

describe('pinned chats', () => {
  const at = (n: number) => `2026-11-02T00:${String(n).padStart(2, '0')}:00.000Z`
  const links = (el: { querySelectorAll: (s: string) => { map: <T>(f: (a: { textContent?: string | null; closest: (s: string) => { getAttribute: (n: string) => string | null } | null }) => T) => T[] } }) =>
    el.querySelectorAll('a[href^="/c/"]').map((a) => a.textContent)
  const pinned = (m: Awaited<ReturnType<typeof render>>) => m.get('recents-list').querySelectorAll('li[data-pinned]').map((li) => li.textContent)

  test('a computer: my pins first, the most recently pinned first, at most ten, then the five latest of the others; "모두 보기" has every pin first', async () => {
    // chats 1–12 pinned (chat 3 the most recently), 13–20 not
    useChats.setState({ chats: Array.from({ length: 20 }, (_, i) => chat(i + 1, i < 12 ? { pinnedAt: at(i === 2 ? 59 : 12 - i) } : {})) })
    const m = await render()
    try {
      const shown = links(m.get('ai-chats-latest') as never)
      expect(shown.slice(0, 10)).toEqual(['채팅 3', '채팅 1', '채팅 2', '채팅 4', '채팅 5', '채팅 6', '채팅 7', '채팅 8', '채팅 9', '채팅 10'])
      expect(shown.slice(10)).toEqual(['채팅 20', '채팅 19', '채팅 18', '채팅 17', '채팅 16'])
      expect(pinned(m)).toHaveLength(10)
      // the pin before the title, named for a screen reader; none on the others
      const first = m.get('ai-chats-latest').querySelectorAll('li')[0]!
      expect(first.querySelector('[data-testid="chat-pin-icon"]')?.getAttribute('aria-label')).toBe(ko('chat.pinned'))
      expect(m.get('ai-chats-latest').querySelectorAll('li')[10]!.querySelector('[data-testid="chat-pin-icon"]')).toBeNull()
      // the whole history: all twelve pins first, without a header, then the rest by date
      await m.click('ai-chats-all')
      expect(links(m.get('ai-chats-pinned') as never)).toEqual(['채팅 3', '채팅 1', '채팅 2', '채팅 4', '채팅 5', '채팅 6', '채팅 7', '채팅 8', '채팅 9', '채팅 10', '채팅 11', '채팅 12'])
      expect(m.get('ai-chats-pinned').querySelector('h3')).toBeNull()
      expect(links(m.get('recents-list') as never).slice(12)).toEqual(['채팅 20', '채팅 19', '채팅 18', '채팅 17', '채팅 16', '채팅 15', '채팅 14', '채팅 13'])
    } finally {
      await m.unmount()
    }
  })

  test('the phone drawer: every pin first', async () => {
    wide = false
    useChats.setState({ chats: [chat(1, { pinnedAt: at(1) }), chat(2), chat(3, { pinnedAt: at(2) }), chat(4)] })
    const m = await render()
    try {
      expect(links(m.get('recents-list') as never)).toEqual(['채팅 3', '채팅 1', '채팅 4', '채팅 2'])
      expect(pinned(m)).toEqual(['채팅 3', '채팅 1'])
    } finally {
      await m.unmount()
    }
  })

  test('"상단에 고정" pins the chat and its row goes to the top; "고정 해제" puts it back', async () => {
    const id = chat(2).id
    const sent: string[] = []
    routes = {
      [`POST /api/chats/${id}/pin`]: () => (sent.push('pin'), json({ ...chat(2), pinnedAt: at(30) })),
      [`DELETE /api/chats/${id}/pin`]: () => (sent.push('unpin'), json(chat(2))),
    }
    useChats.setState({ chats: Array.from({ length: 8 }, (_, i) => chat(i + 1)) })
    const m = await render()
    const rowOf = (title: string) => m.get('recents-list').querySelectorAll('li').find((li) => li.textContent?.includes(title))!
    try {
      // chat 2 is not among the five latest
      expect(links(m.get('ai-chats-latest') as never)).not.toContain('채팅 2')
      await m.click('ai-chats-all')
      await m.click(rowOf('채팅 2').querySelector(`button[aria-label="${ko('chat.menu')}"]`)!)
      await m.click('chat-row-pin')
      await m.until(() => (pinned(m).length === 1 ? true : null), 'the pinned row')
      expect(links(m.get('recents-list') as never)[0]).toBe('채팅 2')
      expect(rowOf('채팅 2').querySelector('[data-testid="chat-pin-icon"]')).not.toBeNull()
      await m.click(rowOf('채팅 2').querySelector(`button[aria-label="${ko('chat.menu')}"]`)!)
      await m.click('chat-row-unpin')
      await m.until(() => (pinned(m).length === 0 ? true : null), 'no pinned row')
      expect(links(m.get('recents-list') as never).at(-1)).toBe('채팅 1')
      expect(sent).toEqual(['pin', 'unpin'])
    } finally {
      await m.unmount()
    }
  })
})
