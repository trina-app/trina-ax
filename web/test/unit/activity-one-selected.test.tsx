// 활동's list beside the rail (components/panels/ActivityPanel.tsx): at most one notice is selected, the one opened. Two
// notices can lead to one page ("민준 joined 'Acme'" and "지아 joined 'Acme'" both open that project): the row lit is the
// one the person opened (the history entry names it), never every row whose page is on screen; a page reached without a
// name lights a row only when exactly one leads there; a page opened from elsewhere lights none.
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import { InboxNotification, uuidv7, type Me } from '@mycel/shared/api'
import { useLocaleStore } from '../../src/i18n'
import { useSession } from '../../src/store/session'
import { ActivityPanel, NOTICE_STATE_KEY, noticeTarget, openNotice } from '../../src/components/panels/ActivityPanel'
import { ACTIVITY_OPENED_KEY } from '../../src/lib/localData'
import { RAIL_STATE_KEY } from '../../src/lib/rail'
import { installDom, mount, removeDom, type Mounted } from './dom-host'
import { ME } from './rooms-fixtures'

setDefaultTimeout(30_000)
const PROJECT = uuidv7()
const minute = (n: number) => new Date(Date.now() - n * 60_000).toISOString()
const joined = (id: string, name: string, n: number, readAt: string | null = null) => InboxNotification.parse({
  id, eventType: 'project.joined', sourceId: uuidv7(), code: 'project.joined', createdAt: minute(n), readAt, chatId: null, link: null, outcome: null,
  projectJoined: { name, project: { id: PROJECT, name: 'Acme' } },
})
const A = '019a5f00-0000-7000-8000-00000000000a', B = '019a5f00-0000-7000-8000-00000000000b'
const items = [joined(A, '민준', 5), joined(B, '지아', 9)]
const page = `/projects/${PROJECT}`

describe('openNotice', () => {
  test('the notice the entry names, not every notice that leads to the page', () => {
    expect(openNotice(items, { pathname: page, search: '', state: { [RAIL_STATE_KEY]: 'activity', [NOTICE_STATE_KEY]: B }, lit: 'activity' })).toBe(B)
  })
  test('no name: none when two lead to the page, the one when only one does', () => {
    expect(openNotice(items, { pathname: page, search: '', state: { [RAIL_STATE_KEY]: 'activity' }, lit: 'activity' })).toBeNull()
    expect(openNotice(items.slice(0, 1), { pathname: page, search: '', lit: 'activity' })).toBe(A)
  })
  test('kept for this page (the rail\'s 활동 reopening it) names it; on another page it names nothing', () => {
    expect(openNotice(items, { pathname: page, search: '', lit: 'activity' }, { here: page, id: B })).toBe(B)
    expect(openNotice(items, { pathname: '/projects/other', search: '', lit: 'activity' }, { here: page, id: B })).toBeNull()
  })
  test('a page opened from elsewhere (another place lit) selects none; a name that leads elsewhere selects none', () => {
    expect(openNotice(items, { pathname: page, search: '', state: { [NOTICE_STATE_KEY]: A }, lit: 'projects' })).toBeNull()
    expect(openNotice(items, { pathname: '/c/x', search: '', state: { [RAIL_STATE_KEY]: 'activity', [NOTICE_STATE_KEY]: A }, lit: 'activity' })).toBeNull()
  })
  test('a notice\'s own view: the ?n= one', () => {
    expect(openNotice(items, { pathname: '/activity', search: `?n=${A}`, lit: 'activity' })).toBe(A)
  })
})

const me = { user: { id: ME.id, username: ME.id, name: ME.name, email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} }, groups: [],
  team: { name: 'Acme', defaultLocale: 'ko' }, session: { id: uuidv7(), client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: false, timeZone: 'Asia/Seoul' } } as unknown as Me
const realFetch = globalThis.fetch
const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })
let inbox: InboxNotification[] = []
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    if (method === 'GET' && url.pathname === '/api/notifications') {
      const unread = inbox.filter((x) => !x.readAt).length
      return json({ items: inbox, nextCursor: null, unreadCount: unread, roomUnreadCount: 0, noticeUnreadCount: unread })
    }
    const read = /^\/api\/notifications\/([^/]+)\/read$/.exec(url.pathname)
    if (method === 'POST' && read) return json(inbox.find((x) => x.id === read[1]))
    return json({ error: { code: 'not_found', message: url.pathname } }, 404)
  }) as unknown as typeof fetch
})
afterEach(() => {
  useSession.setState({ status })
  sessionStorage.clear()
})
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale })
})

const rowsOf = (m: Mounted) => [...m.container.ownerDocument!.body.querySelectorAll('[data-testid="activity-panel-row"]')]
const boldOf = (m: Mounted) => rowsOf(m).map((r) => r.querySelector('[data-testid="activity-panel-text"]')!.getAttribute('class')!.includes('font-semibold'))
const selectedOf = (m: Mounted) => rowsOf(m).map((r) => r.getAttribute('aria-current') === 'page')
/** the panel with the entry `at` on screen (the fake DOM's clicks do not follow a router link, so the entry a row's link
 * opens, noticeTarget, is given as the router's entry) */
async function panelAt(at: { pathname: string; state?: unknown }) {
  inbox = [joined(A, '민준', 5, minute(1)), joined(B, '지아', 9, minute(1))]
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  const m = await mount(<MemoryRouter initialEntries={[at]}><ActivityPanel /></MemoryRouter>)
  await m.until(() => rowsOf(m).length === 2, 'the two rows')
  return m
}

test('the project opened with 활동 lit but no notice named: neither row selected, neither bold (both read)', async () => {
  const m = await panelAt({ pathname: page, state: { [RAIL_STATE_KEY]: 'activity' } })
  try {
    await m.until(() => rowsOf(m).length === 2, 'the rows')
    expect(selectedOf(m)).toEqual([false, false])
    expect(boldOf(m)).toEqual([false, false])
  } finally {
    m.unmount()
  }
})

test('two notices to one project, open one: only that row is selected, and only it is semibold', async () => {
  const target = noticeTarget(joined(B, '지아', 9))
  expect(target).toEqual({ to: page, state: { [RAIL_STATE_KEY]: 'activity', [NOTICE_STATE_KEY]: B } })
  const m = await panelAt({ pathname: target.to, state: target.state })
  try {
    await m.until(() => selectedOf(m)[1], 'the opened row selected')
    expect(selectedOf(m)).toEqual([false, true])
    expect(boldOf(m)).toEqual([false, true])
  } finally {
    m.unmount()
  }
})

test('after a reload, the rail\'s 활동 reopening the project (no notice named) keeps the one opened: this tab kept it', async () => {
  sessionStorage.setItem(ACTIVITY_OPENED_KEY, JSON.stringify({ here: page, id: A }))
  const m = await panelAt({ pathname: page, state: { [RAIL_STATE_KEY]: 'activity' } })
  try {
    await m.until(() => selectedOf(m)[0], 'the kept row selected')
    expect(selectedOf(m)).toEqual([true, false])
  } finally {
    m.unmount()
  }
})

test('activity lit on another page forgets the kept notice', async () => {
  sessionStorage.setItem(ACTIVITY_OPENED_KEY, JSON.stringify({ here: page, id: A }))
  const m = await panelAt({ pathname: '/projects/other', state: { [RAIL_STATE_KEY]: 'activity' } })
  try {
    expect(selectedOf(m)).toEqual([false, false])
    expect(sessionStorage.getItem(ACTIVITY_OPENED_KEY)).toBeNull()
  } finally {
    m.unmount()
  }
})
