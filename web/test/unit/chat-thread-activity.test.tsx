// A reply in a thread under a shared AI chat's answer is a conversation row (QA: the owner's "@test" in a two-person
// shared chat reached nobody): the one Activity (pages/Activity.tsx, docs/decisions/20261126-one-activity.md) shows it
// with who and the chat, under Mentions while it mentions me and under Threads, and opens the thread
// (/c/<chat>/t/<answer>); the app's own notices are listed beside it.
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import { activityTabHas, InboxNotification, uuidv7, type ActivityTab, type Me } from '@mycel/shared/api'
import { useLocaleStore } from '../../src/i18n'
import { useRooms } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import Activity from '../../src/pages/Activity'
import { installDom, mount, removeDom, type Mounted } from './dom-host'
import { ME } from './rooms-fixtures'

setDefaultTimeout(30_000)
const minute = (n: number) => new Date(Date.now() - n * 60_000).toISOString()
const CHAT = uuidv7(), ROOT = uuidv7(), ROOT2 = uuidv7()
const threadRow = (n: number, rootId: string, mention: boolean) => InboxNotification.parse({
  id: uuidv7(), eventType: 'chat.thread_reply', sourceId: rootId, code: 'chat.thread_reply', createdAt: minute(n), readAt: null, chatId: CHAT, link: 'chat_thread', outcome: null,
  chatThread: { chatId: CHAT, rootId, name: 'dion', byId: 'dion', title: 'Sincere 베이커리 견적서', ...(mention ? { mention: true } : {}) },
})
const appNotice = () => InboxNotification.parse({ id: uuidv7(), eventType: 'connection.reconnect', sourceId: 's-1', code: 'connection.reconnect', createdAt: minute(3), readAt: null, chatId: null, link: 'connections', outcome: null })

const me = { user: { id: ME.id, username: ME.id, name: ME.name, email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} }, groups: [],
  team: { name: 'Acme', defaultLocale: 'ko' }, session: { id: uuidv7(), client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: false, timeZone: 'Asia/Seoul' } } as unknown as Me
const realFetch = globalThis.fetch
const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })
/** the server's rule (notifications/service.ts CHAT_THREAD_ROW): a chat-thread notice is a conversation row */
const conversation = (x: InboxNotification) => !!x.room || x.code === 'chat.thread_reply'

let inbox: InboxNotification[] = []
const sent: { tab: ActivityTab; only?: 'rooms' }[] = []
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    if (method === 'GET' && url.pathname === '/api/notifications') {
      const only = url.searchParams.get('only')
      const items = only === 'rooms' ? inbox.filter(conversation) : only === 'notices' ? inbox.filter((x) => !conversation(x)) : inbox
      const unread = inbox.filter((x) => !x.readAt)
      return json({ items, nextCursor: null, unreadCount: unread.length, roomUnreadCount: unread.filter(conversation).length, noticeUnreadCount: unread.filter((x) => !conversation(x)).length })
    }
    if (method === 'POST' && url.pathname === '/api/notifications/read') {
      const body = JSON.parse(String(init?.body)) as { tab: ActivityTab; only?: 'rooms' }
      sent.push(body)
      let read = 0
      inbox = inbox.map((x) => {
        if (x.readAt || !activityTabHas(x, body.tab) || (body.only === 'rooms' && !conversation(x))) return x
        read++
        return { ...x, readAt: new Date().toISOString() }
      })
      return json({ read })
    }
    return json({ error: { code: 'not_found', message: url.pathname } }, 404)
  }) as unknown as typeof fetch
})
afterEach(() => {
  sent.length = 0
  useRooms.getState().reset()
  useSession.setState({ status })
})
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale })
})

async function open(search: string): Promise<Mounted> {
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  useRooms.setState({ rooms: [], loaded: true })
  const m = await mount(<MemoryRouter initialEntries={[`/activity${search}`]}><Activity /></MemoryRouter>)
  await m.until(() => m.find('notification-item'), 'the rows')
  return m
}
const rows = (m: Mounted) => [...m.container.ownerDocument!.body.querySelectorAll('[data-testid="notification-chat-thread-row"]')] as unknown as HTMLAnchorElement[]

test('the tab rule: a mention under Mentions and Threads, a plain reply under Threads only, never DMs', () => {
  const tabs = (x: InboxNotification) => (['all', 'dms', 'mentions', 'threads'] as const).filter((t) => activityTabHas(x, t))
  expect(tabs(threadRow(1, ROOT, true))).toEqual(['all', 'mentions', 'threads'])
  expect(tabs(threadRow(1, ROOT, false))).toEqual(['all', 'threads'])
  expect(tabs(appNotice())).toEqual(['all'])
})

test('Activity: the mention is a row with who and the chat that opens the thread; the app\'s notice is listed too', async () => {
  inbox = [threadRow(1, ROOT, true), threadRow(2, ROOT2, false), appNotice()]
  const m = await open('')
  try {
    expect(rows(m)).toHaveLength(2)
    const [mention, plain] = rows(m)
    expect(mention!.getAttribute('href')).toBe(`/c/${CHAT}/t/${ROOT}`)
    expect(mention!.textContent).toContain('dion')
    expect(mention!.textContent).toContain('Sincere 베이커리 견적서')
    expect(mention!.textContent).toContain('나를 언급했어요')
    expect(plain!.getAttribute('href')).toBe(`/c/${CHAT}/t/${ROOT2}`)
    expect(m.container.ownerDocument!.body.querySelectorAll('[data-testid="notification-item"]')).toHaveLength(3)
    // both tabs have their dot
    expect(m.find('activity-tab-mentions-unread')).not.toBeNull()
    expect(m.find('activity-tab-threads-unread')).not.toBeNull()
  } finally { await m.unmount() }
})

test('Mentions: only the mention; "Mark all as read" there reads it and leaves the plain reply', async () => {
  inbox = [threadRow(1, ROOT, true), threadRow(2, ROOT2, false), appNotice()]
  const m = await open('?tab=mentions')
  try {
    expect(rows(m).map((a) => a.getAttribute('href'))).toEqual([`/c/${CHAT}/t/${ROOT}`])
    await m.click('activity-mark-all-read')
    await m.until(() => !m.find('activity-tab-mentions-unread'), 'the Mentions dot gone')
    expect(sent).toEqual([{ tab: 'mentions' }])
    expect(inbox.filter((x) => !x.readAt).map((x) => x.chatThread?.rootId ?? x.code)).toEqual([ROOT2, 'connection.reconnect'])
    expect(m.find('activity-tab-threads-unread')).not.toBeNull()
  } finally { await m.unmount() }
})
