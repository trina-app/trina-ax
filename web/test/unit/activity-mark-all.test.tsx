// Activity's "Mark all as read" (pages/Activity.tsx, QA TC-457): shown only while the open tab has something unread,
// one call for the tab (POST /api/notifications/read, with only=rooms on the conversations' page), the tab's rows and
// dots read at once, the other tabs' left as they are.
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
const roomRow = (n: number, code: 'room.dm' | 'room.mention', room: Record<string, unknown>) => InboxNotification.parse({
  id: uuidv7(), eventType: code, sourceId: uuidv7(), code, createdAt: minute(n), readAt: null, chatId: null, link: 'room', outcome: null,
  room: { id: uuidv7(), from: '민준', fromId: 'minjun', message: uuidv7(), preview: `line ${n}`, count: 1, people: 1, at: minute(n), ...room },
})
const fresh = () => [
  roomRow(1, 'room.mention', { kind: 'team', name: '마케팅', reason: 'mention' }),
  roomRow(2, 'room.dm', { kind: 'dm', name: null, reason: 'reply', thread: uuidv7() }),
  InboxNotification.parse({ id: uuidv7(), eventType: 'connection.reconnect', sourceId: 's-1', code: 'connection.reconnect', createdAt: minute(3), readAt: null, chatId: null, link: 'connections', outcome: null }),
]

const me = { user: { id: ME.id, username: ME.id, name: ME.name, email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} }, groups: [],
  team: { name: 'Acme', defaultLocale: 'ko' }, session: { id: uuidv7(), client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: false, timeZone: 'Asia/Seoul' } } as unknown as Me
const realFetch = globalThis.fetch
const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })

/** the server's inbox, as the fake server keeps it, and what "Mark all as read" was sent */
let inbox: InboxNotification[] = []
const sent: { tab: ActivityTab; only?: 'rooms' }[] = []
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    if (method === 'GET' && url.pathname === '/api/notifications') {
      const items = url.searchParams.get('only') === 'rooms' ? inbox.filter((x) => x.room) : inbox
      const unread = inbox.filter((x) => !x.readAt)
      return json({ items, nextCursor: null, unreadCount: unread.length, roomUnreadCount: unread.filter((x) => x.room).length })
    }
    if (method === 'POST' && url.pathname === '/api/notifications/read') {
      const body = JSON.parse(String(init?.body)) as { tab: ActivityTab; only?: 'rooms' }
      sent.push(body)
      let read = 0
      inbox = inbox.map((x) => {
        if (x.readAt || !activityTabHas(x, body.tab) || (body.only === 'rooms' && !x.room)) return x
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
const unreadRows = (m: Mounted) => m.container.ownerDocument!.body.querySelectorAll('[data-unread]').length

test('Mentions: one call for the tab; its row and dot read at once, the DM\'s and the app\'s notice stay; gone when nothing is left', async () => {
  inbox = fresh()
  const m = await open('?tab=mentions')
  try {
    expect(m.find('activity-tab-mentions-unread')).not.toBeNull()
    await m.click('activity-mark-all-read')
    await m.until(() => !m.find('activity-tab-mentions-unread'), 'the Mentions dot gone')
    expect(sent).toEqual([{ tab: 'mentions' }])
    expect(m.find('activity-mark-all-read')).toBeNull()
    // the other tabs keep theirs
    expect(m.find('activity-tab-all-unread')).not.toBeNull()
    expect(m.find('activity-tab-threads-unread')).not.toBeNull()
    expect(inbox.filter((x) => !x.readAt)).toHaveLength(2)
  } finally { await m.unmount() }
})

test('All: every unread notice, the app\'s own too; no button once all is read', async () => {
  inbox = fresh()
  const m = await open('')
  try {
    expect(unreadRows(m)).toBe(3)
    await m.click('activity-mark-all-read')
    await m.until(() => unreadRows(m) === 0, 'every row read')
    expect(sent).toEqual([{ tab: 'all' }])
    expect(m.find('activity-mark-all-read')).toBeNull()
    for (const tab of ['all', 'dms', 'mentions', 'threads']) expect(m.find(`activity-tab-${tab}-unread`)).toBeNull()
    expect(inbox.every((x) => x.readAt)).toBe(true)
  } finally { await m.unmount() }
})

test('the conversations\' page (from 대화) marks its rows only', async () => {
  inbox = fresh()
  const m = await open('?in=chats')
  try {
    await m.click('activity-mark-all-read')
    await m.until(() => sent.length === 1, 'the call')
    expect(sent).toEqual([{ tab: 'all', only: 'rooms' }])
    await m.until(() => !m.find('activity-mark-all-read'), 'the button gone')
    // the app's own notice is not on this page and stays unread
    expect(inbox.filter((x) => !x.readAt).map((x) => x.code)).toEqual(['connection.reconnect'])
  } finally { await m.unmount() }
})

test('nothing unread in the tab: no button', async () => {
  inbox = fresh().map((x) => (x.code === 'room.mention' ? { ...x, readAt: minute(0) } : x))
  const m = await open('?tab=mentions')
  try {
    await m.settle(50)
    expect(m.find('activity-mark-all-read')).toBeNull()
  } finally { await m.unmount() }
})
