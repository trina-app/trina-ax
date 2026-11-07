// The computer's sidebar (768 px and wider; docs/DECISIONS.md "Desktop sidebar: rooms first"), rendered and pressed:
// - its order: the team's name, one labeled row each (트리나에게 묻기, 검색, 프로젝트, 예약 작업, 알림함, 파일, 팀 스킬; 관리자
//   only for owners and admins), then one scroll: 대화 (the five latest rooms and the room on screen, "더 보기 (N)" with what is unread behind it) and
//   트리나 기록 (the five latest and the chat on screen, "모두 보기" with what needs me behind it);
// - the rows: their words and where they go, the shortcut hints, the Inbox's count on its row (in words for a screen reader);
// - both groups fold, remembered in this browser;
// - "답변 필요" and the new-answer dot come from the chat list itself (Chat.waiting / Chat.unseen), with no request per
//   chat; the dot stays away from the chat on screen;
// - the phone's drawer keeps its own layout (the AI's history only).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { PRODUCT } from '@mycel/shared'
import { PRODUCT_NAMED_AFTER_AI, type Chat, type Me } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import Sidebar from '../../src/components/Sidebar'
import { useAiAccess } from '../../src/store/aiAccess'
import { useChats } from '../../src/store/chats'
import { useInbox } from '../../src/store/inbox'
import { useRooms } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import { useSessionMarkers } from '../../src/store/sessionMarkers'
import { useWelcome } from '../../src/store/welcome'
import { TOOLTIP_DELAY_MS } from '../../src/components/Tooltip'
import { FakeEvent, installDom, mount, removeDom } from './dom-host'
import { room } from './rooms-fixtures'

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

  test('one labeled row each, in the old order; Admin only for owners and admins; the shortcut hints', async () => {
    for (const [role, admin] of [['member', false], ['admin', true], ['owner', true]] as const) {
      useSession.setState({ status: { kind: 'signed-in', me: me(role) } } as never)
      const m = await render()
      try {
        const rows = m.get('nav-rows')
        expect(rows.querySelectorAll('button').map((b) => b.getAttribute('data-testid'))).toEqual(['new-chat', 'nav-search'])
        expect(m.get('new-chat').querySelector('span')?.textContent).toBe(ko('sidebar.askAi', { name: aiName }))
        expect(m.get('new-chat').querySelector('kbd')?.textContent).toMatch(/^(⇧⌘O|Ctrl\+Shift\+O)$/)
        expect(m.get('nav-search').textContent?.trim()).toStartWith(ko('sidebar.search'))
        expect(m.get('nav-search').querySelector('kbd')?.textContent).toMatch(/^(⌘K|Ctrl\+K)$/)
        const links = rows.querySelectorAll('a')
        expect(links.map((a) => a.getAttribute('href'))).toEqual(['/projects', '/scheduled', '/settings/notifications', '/files', '/skills', ...(admin ? ['/admin'] : [])])
        expect(links.map((a) => a.textContent?.trim())).toEqual([ko('sidebar.projects'), ko('sidebar.scheduled'), ko('inbox.title'), ko('sidebar.files'), ko('sidebar.skills'), ...(admin ? [ko('sidebar.admin')] : [])])
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
      expect(m.get('nav-trash').getAttribute('href')).toBe('/trash')
    } finally {
      await m.unmount()
    }
  })
})
