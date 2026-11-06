// The phone's navigation (below 768 px; docs/DECISIONS.md "Phone navigation: four tabs"), rendered and pressed:
// - lib/tabs.ts: which tab an address belongs to, the tab the app opens on (START_TAB, one constant), the page names the
//   top bar shows, the AI's one name;
// - the tab bar: 트리나 · 대화 · 파일 · 나 in that order, the tab on screen marked, one count per kind of thing (unread room
//   messages on 대화, unread Inbox notices on 나), none at 0;
// - the top bar: ☰ only on the 트리나 tab's Home, ⊕ (a new conversation) only on 대화, no bar on 파일 or in a chat or a
//   room, ‹ and the page's name below a tab;
// - ‹ goes back in the history when the entry before is the app's own and otherwise replaces this entry with the tab's
//   list, never pushes (the phone's own back would loop between the two);
// - the 나 list starts with 알림함 (with the count) and, for admins, 관리자; its own 알림 row is left out there;
// - Home's latest AI chats: three, newest first, never a chat only made for a draft's attachments.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { act, type ReactNode } from 'react'
import { Link, MemoryRouter, Route, Routes, useLocation, useNavigationType, type InitialEntry } from 'react-router-dom'
import { PRODUCT } from '@mycel/shared'
import { PRODUCT_NAMED_AFTER_AI, type Chat, type Me } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { BottomTabs } from '../../src/components/BottomTabs'
import { PhoneTopBar } from '../../src/components/PhoneTopBar'
import SettingsDialog from '../../src/components/settings/SettingsDialog'
import { useBackLink } from '../../src/lib/back'
import { aiName, hidesTabs, landingPath, pageTitleKey, START_TAB, TAB_ROOT, tabOf } from '../../src/lib/tabs'
import { RecentChats } from '../../src/pages/Home'
import { useAiAccess } from '../../src/store/aiAccess'
import { useChats } from '../../src/store/chats'
import { useInbox } from '../../src/store/inbox'
import { useRooms } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import { useWelcome } from '../../src/store/welcome'
import { useUi } from '../../src/store/ui'
import { FakeEvent, installDom, mount, removeDom, type FakeElement } from './dom-host'
import { room } from './rooms-fixtures'

const ko = (k: Parameters<typeof translate>[1], p?: Parameters<typeof translate>[2]) => translate('ko', k, p)
const me = (role: 'owner' | 'admin' | 'member'): Me =>
  ({
    user: { id: 'mina', username: 'mina', name: '김민아님', title: null, email: null, role, locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} },
    groups: [], team: { name: 'Acme', defaultLocale: 'ko', chatTrashRetentionDays: 14 }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
    server: { version: '0', dev: false, deployment: 'hosted' },
  }) as unknown as Me
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })

const realFetch = globalThis.fetch
const localeBefore = useLocaleStore.getState().locale
const sessionBefore = useSession.getState().status
const roomsBefore = useRooms.getState()
const chatsBefore = { chats: useChats.getState().chats, requests: useChats.getState().requests }
const inboxBefore = useInbox.getState().unread
// the setup row (onboarding/SetupRow.tsx, in the sidebar and the drawer) reads these: put them back as they were
const welcomeBefore = (({ loaded, progress }) => ({ loaded, progress }))(useWelcome.getState())
const aiAccessBefore = (({ loaded, usable, action, requested, trial, sending, failed }) => ({ loaded, usable, action, requested, trial, sending, failed }))(useAiAccess.getState())
const drawerBefore = useUi.getState().drawerOpen
const historyBefore = Object.getOwnPropertyDescriptor(globalThis, 'history')
let inboxCount = 0
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  useSession.setState({ status: { kind: 'signed-in', me: me('member') } } as never)
  ;(globalThis as Record<string, unknown>).matchMedia = (q: string) => ({ matches: q === '(max-width: 767.98px)', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
    if (key === 'GET /api/notifications') return json({ items: [], nextCursor: null, unreadCount: inboxCount })
    if (key === 'GET /api/me/credentials') return json({ allowed: false, items: [] })
    return json({ error: { code: 'not_found', message: key } }, 404)
  }) as unknown as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
  delete (globalThis as Record<string, unknown>).matchMedia
  removeDom()
  useLocaleStore.setState({ locale: localeBefore })
  useSession.setState({ status: sessionBefore })
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
  useUi.setState({ drawerOpen: drawerBefore })
  inboxCount = 0
  if (historyBefore) Object.defineProperty(globalThis, 'history', historyBefore)
  else delete (globalThis as Record<string, unknown>).history
})

/** The markup of a client render (the stores' and the language's current state; a server render reads their first) */
async function rendered(ui: ReactNode): Promise<string> {
  const m = await mount(ui)
  await m.settle(10)
  const html = m.container.innerHTML
  await m.unmount()
  return html
}

/** history.state as React Router's browser history writes it: idx 0 is the document's first entry */
const historyAt = (idx: number) => Object.defineProperty(globalThis, 'history', { configurable: true, writable: true, value: { state: { usr: null, key: 'k', idx } } })

describe('which tab an address belongs to', () => {
  test('the four tabs and their lists', async () => {
    expect(TAB_ROOT).toEqual({ ai: '/', chats: '/rooms', files: '/files', me: '/settings' })
    for (const p of ['/', '/c/abc', '/projects', '/projects/p1', '/scheduled', '/scheduled/s1', '/skills', '/trash']) expect(tabOf(p)).toBe('ai')
    for (const p of ['/rooms', '/rooms/r1']) expect(tabOf(p)).toBe('chats')
    for (const p of ['/files', '/files/view']) expect(tabOf(p)).toBe('files')
    for (const p of ['/settings', '/settings/notifications', '/admin', '/admin/members']) expect(tabOf(p)).toBe('me')
    for (const p of ['/welcome', '/skillsx', '/roomsy', '/nothing']) expect(tabOf(p)).toBeNull()
  })

  test('the bar stays away only inside a room or an AI chat', async () => {
    expect(hidesTabs('/rooms/r1')).toBe(true)
    expect(hidesTabs('/c/abc')).toBe(true)
    for (const p of ['/', '/rooms', '/files', '/settings', '/skills']) expect(hidesTabs(p)).toBe(false)
  })

  test('the app opens on the 트리나 tab (one constant); a computer lands on Home', async () => {
    expect(START_TAB).toBe('ai')
    expect(landingPath(true)).toBe(TAB_ROOT[START_TAB])
    expect(landingPath(true)).toBe('/')
    expect(landingPath(false)).toBe('/')
  })

  test('pages below a tab are named after their list', async () => {
    expect(pageTitleKey('/skills')).toBe('skills.title')
    expect(pageTitleKey('/projects/p1')).toBe('projects.title')
    expect(pageTitleKey('/scheduled')).toBe('settings.schedules')
    expect(pageTitleKey('/trash')).toBe('trash.title')
    expect(pageTitleKey('/admin/members')).toBe('admin.title')
    expect(pageTitleKey('/')).toBeNull()
    expect(pageTitleKey('/rooms')).toBeNull()
  })

  test('the AI has one name: 트리나 in the Trina edition, the product\'s name in the core', async () => {
    expect(aiName(ko)).toBe(PRODUCT_NAMED_AFTER_AI ? '트리나' : PRODUCT.shortName)
  })
})

describe('the tab bar', () => {
  const bar = (path: string) => rendered(<MemoryRouter initialEntries={[path]}><BottomTabs /></MemoryRouter>)
  const tabs = (html: string) => [...html.matchAll(/data-testid="(tab-[a-z]+)"/g)].map((m) => m[1])
  const current = (html: string) => /<a [^>]*aria-current="page"[^>]*data-testid="(tab-[a-z]+)"/.exec(html)?.[1] ?? null

  test('four tabs in order, each to its list', async () => {
    const html = await bar('/')
    expect(tabs(html)).toEqual(['tab-ai', 'tab-chats', 'tab-files', 'tab-me'])
    for (const [id, to] of [['tab-ai', '/'], ['tab-chats', '/rooms'], ['tab-files', '/files'], ['tab-me', '/settings']]) {
      expect(new RegExp(`<a [^>]*data-testid="${id}"[^>]*>`).exec(html)?.[0]).toContain(`href="${to}"`)
    }
    expect(html).toContain(`>${aiName(ko)}</a>`)
  })

  test('the tab on screen is marked', async () => {
    expect(current(await bar('/'))).toBe('tab-ai')
    expect(current(await bar('/skills'))).toBe('tab-ai')
    expect(current(await bar('/rooms'))).toBe('tab-chats')
    expect(current(await bar('/files'))).toBe('tab-files')
    expect(current(await bar('/admin'))).toBe('tab-me')
    expect(current(await bar('/welcome'))).toBeNull()
  })

  test('not inside a room or an AI chat', async () => {
    expect(await bar('/rooms/r1')).toBe('')
    expect(await bar('/c/abc')).toBe('')
  })

  // the stores' current state needs a client render (a server render reads their first state)
  test('one count per kind: unread room messages on 대화 (muted rooms left out), unread Inbox notices on 나', async () => {
    useRooms.setState({ rooms: [room({ unreadCount: 3 }), room({ unreadCount: 2, muted: true }), room({ unreadCount: 120, kind: 'dm' })] })
    inboxCount = 4
    const m = await mount(<MemoryRouter initialEntries={['/']}><BottomTabs /></MemoryRouter>)
    try {
      await m.until(() => m.find('tab-me-unread'), 'the Inbox count')
      expect(m.get('tab-chats-unread').textContent).toBe(`99+${ko('rooms.unread', { n: 123 })}`)
      expect(m.get('tab-me-unread').textContent).toBe(`4${ko('notifications.unread', { count: 4 })}`)
      // no count on 트리나 or 파일
      expect(m.get('tab-ai').textContent).toBe(aiName(ko))
      expect(m.get('tab-files').textContent).toBe(ko('tabs.files'))
    } finally {
      await m.unmount()
    }
  })

  test('a room whose @트리나 waits on me: 대화\'s pill is an amber "?" (its count unchanged, said to a screen reader), the count again after', async () => {
    useRooms.setState({ rooms: [room({ unreadCount: 3 }), room({ unreadCount: 0, aiWaits: true })] })
    const m = await mount(<MemoryRouter initialEntries={['/']}><BottomTabs /></MemoryRouter>)
    try {
      await m.until(() => m.find('tab-chats-unread'), 'the 대화 pill')
      const pill = m.get('tab-chats-unread')
      expect(pill.getAttribute('data-ai-waits')).toBe('')
      expect(pill.className).toContain('bg-warn')
      expect(pill.textContent).toBe(`?${ko('rooms.aiWaits')}, ${ko('rooms.unread', { n: 3 })}`)
      // the wait ends: the same count as before
      useRooms.setState({ rooms: [room({ unreadCount: 3 }), room({ unreadCount: 0 })] })
      await m.until(() => m.find('tab-chats-unread')?.getAttribute('data-ai-waits') === null, 'the count back')
      expect(m.get('tab-chats-unread').textContent).toBe(`3${ko('rooms.unread', { n: 3 })}`)
    } finally {
      await m.unmount()
      useRooms.setState({ rooms: [] })
    }
  })

  test('no count at 0', async () => {
    const m = await mount(<MemoryRouter initialEntries={['/']}><BottomTabs /></MemoryRouter>)
    try {
      await m.settle(30)
      expect(m.find('tab-chats-unread')).toBeNull()
      expect(m.find('tab-me-unread')).toBeNull()
    } finally {
      await m.unmount()
    }
  })
})

/** where the router is now, and how it got there */
let seen: { path: string; type: string; key: string } | null = null
function Where() {
  const l = useLocation()
  seen = { path: l.pathname + l.search, type: useNavigationType(), key: l.key }
  return null
}
const withBar = (entries: InitialEntry[], index = entries.length - 1) => (
  <MemoryRouter initialEntries={entries} initialIndex={index}>
    <PhoneTopBar />
    <Where />
  </MemoryRouter>
)

describe('the top bar', () => {
  const html = (path: string) => rendered(withBar([path]))

  test('트리나 (Home): ☰ for the AI\'s history and the AI\'s name; no new-chat icon, no product name', async () => {
    const h = await html('/')
    expect(h).toContain('data-testid="menu-open"')
    expect(h).toContain(`aria-label="${ko('sidebar.open')}"`)
    expect(h).toMatch(new RegExp(`data-testid="topbar-title">${aiName(ko)}<`))
    expect(h).not.toContain('topbar-new')
    expect(h).not.toContain('topbar-back')
    if (PRODUCT_NAMED_AFTER_AI) expect(h).not.toContain(PRODUCT.displayName)
  })

  test('대화: its name and ⊕ a new conversation; no ☰', async () => {
    const h = await html('/rooms')
    expect(h).toContain('data-testid="topbar-new-dm"')
    expect(h).toMatch(new RegExp(`data-testid="topbar-title">${ko('tabs.chats')}<`))
    expect(h).not.toContain('menu-open')
  })

  test('파일, a room and an AI chat: no bar (their own header is the bar)', async () => {
    for (const p of ['/files', '/rooms/r1', '/c/abc']) expect(await html(p)).toBe('')
  })

  test('a page below a tab: ‹ and its name, for the eye only (the page has its heading); no ☰', async () => {
    for (const [p, key] of [['/skills', 'skills.title'], ['/projects', 'projects.title'], ['/scheduled/s1', 'settings.schedules'], ['/trash', 'trash.title'], ['/admin/members', 'admin.title']] as const) {
      const h = await html(p)
      expect(h).toContain('data-testid="topbar-back"')
      expect(h).toContain(`aria-label="${ko('tabs.back')}"`)
      expect(h).toMatch(new RegExp(`aria-hidden="true"[^>]*data-testid="topbar-title">${ko(key)}<`))
      expect(h).not.toContain('menu-open')
    }
  })

  test('a project\'s new chat (/?project=) has ‹ back to the project instead of ☰', async () => {
    const h = await html('/?project=p1')
    expect(h).toContain('topbar-back')
    expect(h).not.toContain('menu-open')
  })

  test('the buttons are 44 px', async () => {
    for (const p of ['/', '/rooms', '/skills']) {
      for (const m of (await html(p)).matchAll(/<button [^>]*class="([^"]*)"/g)) expect(m[1]).toContain('size-11')
    }
  })
})

describe('‹ never pushes', () => {
  test('with the app\'s own entry before it: back in the history (the tab bar and the phone\'s back agree)', async () => {
    historyAt(1)
    const m = await mount(withBar(['/', '/skills']))
    try {
      expect(seen!.path).toBe('/skills')
      await m.click('topbar-back')
      expect(seen).toMatchObject({ path: '/', type: 'POP' })
    } finally {
      await m.unmount()
    }
  })

  test('opened from outside (the first entry): the tab\'s list in place of this entry', async () => {
    historyAt(0)
    const m = await mount(withBar(['/admin/members']))
    try {
      await m.click('topbar-back')
      expect(seen).toMatchObject({ path: '/settings', type: 'REPLACE' })
    } finally {
      await m.unmount()
    }
  })

  test('no history state at all (an older WebView): the list, replaced', async () => {
    const m = await mount(withBar(['/skills']))
    try {
      await m.click('topbar-back')
      expect(seen).toMatchObject({ path: '/', type: 'REPLACE' })
    } finally {
      await m.unmount()
    }
  })

  // the ‹ of a room and of an AI chat: a link to the list (replace) that goes back instead when it can
  function Back({ to }: { to: string }) {
    const backLink = useBackLink()
    return <Link to={to} replace onClick={backLink} data-testid="back-link">‹</Link>
  }
  const press = async (el: FakeElement, init: { button?: number; metaKey?: boolean } = {}) => {
    const ev = new FakeEvent('click', { bubbles: true, cancelable: true })
    Object.assign(ev, { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }, init)
    await act(async () => void el.dispatchEvent(ev))
    return ev
  }
  const roomPage = (entries: InitialEntry[]) => (
    <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
      <Routes>
        <Route path="*" element={<><Back to="/rooms" /><Where /></>} />
      </Routes>
    </MemoryRouter>
  )

  test('a room\'s ‹ after the list: back (the list again, no new entry)', async () => {
    historyAt(1)
    const m = await mount(roomPage(['/rooms', '/rooms/r1']))
    try {
      const ev = await press(m.get('back-link'))
      expect(ev.defaultPrevented).toBe(true)
      expect(seen).toMatchObject({ path: '/rooms', type: 'POP' })
    } finally {
      await m.unmount()
    }
  })

  test('a room opened from a notice: the list replaces the room', async () => {
    historyAt(0)
    const m = await mount(roomPage(['/rooms/r1']))
    try {
      await press(m.get('back-link'))
      expect(seen).toMatchObject({ path: '/rooms', type: 'REPLACE' })
    } finally {
      await m.unmount()
    }
  })

  test('a modified click (a new tab) is left to the browser', async () => {
    historyAt(1)
    const m = await mount(roomPage(['/rooms', '/rooms/r1']))
    try {
      await press(m.get('back-link'), { metaKey: true })
      expect(seen!.path).toBe('/rooms/r1')
    } finally {
      await m.unmount()
    }
  })
})

describe('the 나 tab\'s list on a phone', () => {
  const dialog = () => mount(<MemoryRouter initialEntries={['/settings']}><Routes><Route path="/settings/:tab?" element={<SettingsDialog onClose={() => {}} />} /></Routes></MemoryRouter>)

  test('알림함 first, with the unread count; its 알림 row is left out there', async () => {
    useSession.setState({ status: { kind: 'signed-in', me: me('member') } } as never)
    inboxCount = 7
    const m = await dialog()
    try {
      const inbox = m.get('settings-inbox')
      expect(inbox.getAttribute('href')).toBe('/settings/notifications')
      expect(inbox.textContent).toContain(ko('inbox.title'))
      await m.until(() => m.find('settings-inbox-unread'), 'the inbox count')
      expect(m.get('settings-inbox-unread').textContent).toContain('7')
      // a member: no 관리자 row
      expect(m.find('settings-admin')).toBeNull()
      const own = m.get('settings-menu').querySelectorAll('a[href="/settings/notifications"]').filter((a) => a !== inbox)
      expect(own.length).toBe(1)
      expect(own[0]!.getAttribute('class')).toContain('max-md:hidden')
    } finally {
      await m.unmount()
    }
  })

  test('관리자 right below 알림함 for owners and admins', async () => {
    for (const role of ['owner', 'admin'] as const) {
      useSession.setState({ status: { kind: 'signed-in', me: me(role) } } as never)
      const m = await dialog()
      try {
        const top = m.get('settings-phone-top')
        const links = top.querySelectorAll('a').map((a) => a.getAttribute('data-testid'))
        expect(links).toEqual(['settings-inbox', 'settings-admin'])
        expect(m.get('settings-admin').getAttribute('href')).toBe('/admin')
        expect(m.find('settings-inbox-unread')).toBeNull()
      } finally {
        await m.unmount()
      }
    }
  })
})

describe('Home\'s latest AI chats on a phone', () => {
  const chat = (n: number, o: Partial<Chat> = {}): Chat => ({
    id: `01900000-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`, projectId: null, title: `채팅 ${n}`, engine: 'claude-code', model: null,
    createdAt: '2026-11-01T00:00:00.000Z', updatedAt: `2026-11-0${n}T00:00:00.000Z`, deletedAt: null, runState: 'idle', ...o,
  })
  /** the rendered rows (a client render: the chats store's current state) */
  const render = () => rendered(<MemoryRouter><RecentChats /></MemoryRouter>)

  test('three, newest first, each opening its chat', async () => {
    useChats.setState({ chats: [chat(1), chat(4), chat(2), chat(3)] })
    const html = await render()
    const rows = [...html.matchAll(/<a [^>]*data-testid="home-recent"[^>]*>/g)].map((m) => m[0])
    expect(rows.length).toBe(3)
    expect(rows[0]).toContain(`href="/c/${chat(4).id}"`)
    expect([...html.matchAll(/채팅 (\d)/g)].map((m) => m[1])).toEqual(['4', '3', '2'])
    expect(html).toContain(`>${ko('sidebar.aiChats', { name: aiName(ko) })}</h2>`)
  })

  test('a chat only made for a draft\'s attachments is not one; nothing at all without a chat', async () => {
    const draft = chat(5, { title: '', createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z' })
    useChats.setState({ chats: [draft] })
    expect(await render()).not.toContain('home-recents')
    useChats.setState({ chats: [draft, chat(1)] })
    expect([...(await render()).matchAll(/data-testid="home-recent"/g)].length).toBe(1)
  })

  test('a chat whose AI waits for me says so: its "?" at the row\'s end, named by the reason (session markers)', async () => {
    const c = chat(2)
    useChats.setState({ chats: [c], requests: { r1: { turnId: 't', chatId: c.id, messageId: 'm', request: {} } } as never })
    const html = await render()
    expect(html).toContain(`aria-label="${ko('marker.card')}"`)
    expect(html).toContain('data-testid="marker-ask"')
  })
})
