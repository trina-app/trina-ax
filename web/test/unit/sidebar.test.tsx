// The computer's sidebar (768 px and wider; docs/DECISIONS.md "Desktop sidebar: rooms first"), rendered and pressed:
// - its order: the team's name, one row for a new chat and search, one row of icons (Admin only for owners and admins),
//   then one scroll: 대화 (the five latest rooms and the room on screen, "더 보기 (N)" with what is unread behind it) and
//   트리나 기록 (the five latest and the chat on screen, "모두 보기" with what needs me behind it);
// - the icons: links named by their label (the Inbox's with its count, so a screen reader says it), with a tooltip;
// - both groups fold, remembered in this browser;
// - "답변 필요" and the new-answer dot come from the chat list itself (Chat.waiting / Chat.unseen), with no request per
//   chat; the dot stays away from the chat on screen;
// - the phone's drawer keeps its own layout (the AI's history only).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import { PRODUCT } from '@mycel/shared'
import { PRODUCT_NAMED_AFTER_AI, type Chat, type Me } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import Sidebar from '../../src/components/Sidebar'
import { useChats } from '../../src/store/chats'
import { useInbox } from '../../src/store/inbox'
import { useRooms } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom } from './dom-host'
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
  useRooms.setState(roomsBefore, true)
  useChats.setState(chatsBefore)
  useInbox.setState({ unread: inboxBefore })
  inboxCount = 0
})

const render = (path = '/') => mount(<MemoryRouter initialEntries={[path]}><Sidebar /></MemoryRouter>)
const order = (m: Awaited<ReturnType<typeof render>>) =>
  ['sidebar-team', 'new-chat', 'nav-search', 'nav-icons', 'sidebar-rooms', 'recents-toggle'].map((id) => {
    const el = m.find(id)
    return el ? m.html().indexOf(`data-testid="${id}"`) : -1
  })

describe('a computer', () => {
  test('in order: the team, a new chat and search, the icons, every room, then the AI chats', async () => {
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
      for (const id of ['new-chat', 'nav-search', 'nav-icons', 'rooms-toggle', 'recents-toggle', 'ai-chats-all']) expect(m.get(id).textContent).not.toMatch(/채팅/)
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

  test('the icons: files, projects, scheduled, team skills, inbox; Admin only for owners and admins', async () => {
    for (const [role, admin] of [['member', false], ['admin', true], ['owner', true]] as const) {
      useSession.setState({ status: { kind: 'signed-in', me: me(role) } } as never)
      const m = await render()
      try {
        const links = m.get('nav-icons').querySelectorAll('a')
        expect(links.map((a) => a.getAttribute('aria-label'))).toEqual([ko('sidebar.files'), ko('sidebar.projects'), ko('sidebar.scheduled'), ko('sidebar.skills'), ko('inbox.title'), ...(admin ? [ko('sidebar.admin')] : [])])
        expect(links.map((a) => a.getAttribute('href'))).toEqual(['/files', '/projects', '/scheduled', '/skills', '/settings/notifications', ...(admin ? ['/admin'] : [])])
        // a tooltip with the same words in each, for the eye (on hover and on keyboard focus)
        expect(links.map((a) => a.querySelector('[data-testid="nav-tip"]')?.textContent ?? null)).toEqual(links.map((a) => a.getAttribute('aria-label')))
        expect(m.get('nav-search').getAttribute('aria-label')).toStartWith(ko('sidebar.search'))
      } finally {
        await m.unmount()
      }
    }
  })

  test('the Inbox count is on the bell and in its name; team skills has no count of its own', async () => {
    inboxCount = 3
    const m = await render()
    try {
      await m.until(() => m.find('inbox-unread'), 'the Inbox count')
      expect(m.get('inbox-unread').textContent).toBe('3')
      expect(m.get('nav-inbox').getAttribute('aria-label')).toBe(`${ko('inbox.title')}, ${ko('notifications.unread', { count: 3 })}`)
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

  test('no "더 보기" while every room is in sight', async () => {
    useRooms.setState({ rooms: [room({ name: '하나' }), room({ name: '둘' }), room({ name: '셋' })], loaded: true, failed: null })
    const m = await render()
    try {
      expect(m.get('sidebar-rooms-list').querySelectorAll('[data-testid="sidebar-room"]').length).toBe(3)
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
    const titles = (m: Awaited<ReturnType<typeof render>>) => m.get('ai-chats-latest').querySelectorAll('a[href^="/c/"]').map((a) => a.textContent?.replace(ko('chat.needsAnswer'), ''))
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
    // nothing needs me behind it: "모두 보기" alone
    useChats.setState({ chats: Array.from({ length: 8 }, (_, i) => chat(i + 1)), requests: {} })
    m = await render()
    try {
      expect(m.find('ai-chats-all')).not.toBeNull()
      expect(m.find('ai-chats-needs')).toBeNull()
    } finally {
      await m.unmount()
    }
  })

  test('no "모두 보기" while all of them fit', async () => {
    useChats.setState({ chats: [chat(1), chat(2)] })
    const m = await render()
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

  test('"답변 필요" and the new-answer dot come from the list, with no request per chat', async () => {
    useChats.setState({ chats: [chat(1, { runState: 'running', waiting: true }), chat(2, { unseen: true }), chat(3)] })
    const m = await render()
    try {
      const rows = m.get('ai-chats-latest').querySelectorAll('li')
      const row = (title: string) => rows.find((r) => r.textContent?.includes(title))!
      expect(row('채팅 1').querySelector('[data-testid="needs-answer"]')?.textContent).toBe(ko('chat.needsAnswer'))
      expect(row('채팅 2').querySelector('[data-testid="new-answer-dot"]')?.getAttribute('aria-label')).toBe(ko('sidebar.newAnswer'))
      expect(row('채팅 3').querySelector('[data-testid="new-answer-dot"]')).toBeNull()
      await m.settle(30)
      expect(calls.filter((c) => /\/api\/chats\/[^/]+\/requests/.test(c))).toEqual([])
    } finally {
      await m.unmount()
    }
  })

  test('the chat on screen has no new-answer dot (it is being seen)', async () => {
    const c = chat(2, { unseen: true })
    useChats.setState({ chats: [c] })
    const m = await render(`/c/${c.id}`)
    try {
      expect(m.find('new-answer-dot')).toBeNull()
    } finally {
      await m.unmount()
    }
  })
})

describe('the phone drawer keeps its own layout', () => {
  test('the AI history only: no team name, icons or rooms; all its chats; its own rows', async () => {
    wide = false
    const m = await render()
    try {
      expect(m.find('nav-icons')).toBeNull()
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
