// Activity past its first page (pages/Activity.tsx, #545's review): with nothing loaded to show on a tab it reads the
// older pages by itself, once per choice and at most AUTO_PAGES, and a read again that lands while a page is on its way
// never leaves it waiting (the race: the page's answer dropped, the same cursor back, nothing asked any more). A read
// again is one request that keeps the older rows; after the pages it may read by itself it says "not in the latest N".
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import { InboxNotification, uuidv7, type Me } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { useRooms } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import { notificationsChanged } from '../../src/store/live'
import Activity from '../../src/pages/Activity'
import { installDom, mount, removeDom, type Mounted } from './dom-host'
import { ME } from './rooms-fixtures'

setDefaultTimeout(30_000)
const ko = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('ko', k, p)
const ROOM = uuidv7(), MSG = uuidv7()
const minute = (n: number) => new Date(Date.UTC(2026, 10, 7, 9, 0) - n * 60_000).toISOString()
/** a notice of the app's own (a connection to sign in again), `n` minutes old */
const appNotice = (n: number) => InboxNotification.parse({ id: `app-${String(n).padStart(4, '0')}`, eventType: 'connection.reconnect', sourceId: `s-${n}`, code: 'connection.reconnect', createdAt: minute(n), readAt: null, chatId: null, link: 'connections', outcome: null })
const MENTION = InboxNotification.parse({
  id: uuidv7(), eventType: 'room.mention', sourceId: MSG, code: 'room.mention', createdAt: minute(500), readAt: null, chatId: null, link: 'room', outcome: null,
  room: { id: ROOM, from: '민준', fromId: 'minjun', kind: 'team', name: '마케팅', reason: 'mention', message: MSG, preview: '@Olga 확인 부탁해요', count: 1, people: 1, at: minute(500) },
})

const me = { user: { id: ME.id, username: ME.id, name: ME.name, email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} }, groups: [],
  team: { name: 'Acme', defaultLocale: 'ko' }, session: { id: uuidv7(), client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: false, timeZone: 'Asia/Seoul' } } as unknown as Me
const realFetch = globalThis.fetch
const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })

/** GET /api/notifications as each test answers it: `cursor` null for a read of the newest rows */
let answer: (cursor: string | null, limit: number) => Promise<{ items: InboxNotification[]; nextCursor: string | null }> = async () => ({ items: [], nextCursor: null })
const asked: (string | null)[] = []
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://x')
    if ((init?.method ?? 'GET') === 'GET' && url.pathname === '/api/notifications') {
      const cursor = url.searchParams.get('cursor')
      asked.push(cursor)
      const page = await answer(cursor, Number(url.searchParams.get('limit') ?? 30))
      return json({ ...page, unreadCount: 1, roomUnreadCount: 1 })
    }
    return json({ error: { code: 'not_found', message: url.pathname } }, 404)
  }) as unknown as typeof fetch
})
afterEach(() => {
  asked.length = 0
  useRooms.getState().reset()
  useSession.setState({ status })
})
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale })
})

/** a promise and the way to settle it */
function held<T>() {
  let release!: (v: T) => void
  const promise = new Promise<T>((r) => { release = r })
  return { promise, release }
}
const FIRST = Array.from({ length: 30 }, (_, i) => appNotice(i + 1))

async function openMentions(): Promise<Mounted> {
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  useRooms.setState({ rooms: [], loaded: true })
  return mount(<MemoryRouter initialEntries={['/activity?tab=mentions']}><Activity /></MemoryRouter>)
}
const rows = (m: Mounted) => m.container.ownerDocument!.body.querySelectorAll('[data-testid="notification-room-row"]').length

test('a read again while an older page is on its way, with the same cursor back: the page still goes on, the mention shows', async () => {
  const page = held<{ items: InboxNotification[]; nextCursor: string | null }>()
  answer = async (cursor) => (cursor === null ? { items: FIRST, nextCursor: 'c30' } : page.promise)
  const m = await openMentions()
  try {
    // the first page has no mention: the older page is asked for by itself
    await m.until(() => asked.includes('c30'), 'the older page asked for')
    expect(m.find('activity-not-in-recent')).toBeNull()
    // a new notice elsewhere: a read again lands first, with the same cursor
    await m.settle()
    notificationsChanged.emit()
    await m.until(() => asked.filter((c) => c === null).length === 2, 'the read again')
    await m.settle(50)
    // then the older page: it goes on (the list still ends where it was asked from)
    page.release({ items: [MENTION], nextCursor: null })
    await m.until(() => rows(m) === 1, 'the mention')
    expect(m.find('activity-load-more')).toBeNull()
    expect(m.html()).not.toContain(ko('feed.emptyFiltered'))
  } finally { await m.unmount() }
})

test('a read again that keeps the older rows keeps their cursor: the page on its way still goes on', async () => {
  const page = held<{ items: InboxNotification[]; nextCursor: string | null }>()
  let reads = 0
  // the read again: one new notice on top, the first page now ends one row earlier (that row is kept after it)
  answer = async (cursor) => {
    if (cursor === null) return ++reads === 1 ? { items: FIRST, nextCursor: 'c30' } : { items: [appNotice(0), ...FIRST.slice(0, 29)], nextCursor: 'c29' }
    return page.promise
  }
  const m = await openMentions()
  try {
    await m.until(() => asked.includes('c30'), 'the older page asked for')
    notificationsChanged.emit()
    await m.until(() => reads === 2, 'the read again')
    await m.settle(50)
    // the end is still c30 (FIRST[29] kept after the new first page): no page from c29
    expect(asked).not.toContain('c29')
    page.release({ items: [MENTION], nextCursor: null })
    await m.until(() => rows(m) === 1, 'the mention')
  } finally { await m.unmount() }
})

test('a read again that moves where the list ends: the page on its way is dropped, the one from the new end is asked for at once; never left waiting', async () => {
  const stale = held<{ items: InboxNotification[]; nextCursor: string | null }>()
  const newer = Array.from({ length: 30 }, (_, i) => appNotice(-(i + 1)))
  let reads = 0
  // the read again: 30 newer notices, none of what was there (nothing to keep after them)
  answer = async (cursor) => {
    if (cursor === null) return ++reads === 1 ? { items: FIRST, nextCursor: 'c30' } : { items: newer, nextCursor: 'c30b' }
    if (cursor === 'c30') return stale.promise
    return { items: [MENTION], nextCursor: null }
  }
  const m = await openMentions()
  try {
    await m.until(() => asked.includes('c30'), 'the older page asked for')
    notificationsChanged.emit()
    // the list now ends elsewhere: the page from there is asked for at once
    await m.until(() => asked.includes('c30b'), 'the page from the new end')
    await m.until(() => rows(m) === 1, 'the mention')
    // the dropped answer lands last and changes nothing
    stale.release({ items: [appNotice(999)], nextCursor: 'c-old' })
    await m.settle(50)
    expect(rows(m)).toBe(1)
    expect(m.html()).not.toContain('app-0999')
    expect(m.find('activity-load-more')).toBeNull()
  } finally { await m.unmount() }
})

test('nothing in the pages it may read by itself: "not in the latest 300" and Load more; a read again is one request and keeps the rows', async () => {
  // only notices of the app's own, page after page
  answer = async (cursor, limit) => {
    const from = cursor === null ? 0 : Number(cursor)
    const items = Array.from({ length: limit }, (_, i) => appNotice(from + i + 1))
    return { items, nextCursor: String(from + limit) }
  }
  const m = await openMentions()
  try {
    await m.until(() => m.find('activity-not-in-recent'), 'the line')
    // the first page and AUTO_PAGES (9) more: 300 rows, then it stops
    expect(asked).toHaveLength(10)
    expect(m.get('activity-not-in-recent').textContent).toBe(ko('feed.notInRecent', { n: 300 }))
    expect(m.find('activity-load-more')).not.toBeNull()
    expect(m.html()).not.toContain(ko('feed.emptyFiltered'))
    // a read again: one request (the newest 100), the 300 rows kept, no new run of pages
    notificationsChanged.emit()
    await m.until(() => asked.length === 11, 'the read again')
    await m.settle(100)
    expect(asked).toHaveLength(11)
    expect(asked.at(-1)).toBeNull()
    expect(m.get('activity-not-in-recent').textContent).toBe(ko('feed.notInRecent', { n: 300 }))
    // Load more by hand: one more page
    await m.click('activity-load-more')
    await m.until(() => asked.length === 12, 'the page asked for by hand')
    await m.until(() => m.get('activity-not-in-recent').textContent === ko('feed.notInRecent', { n: 330 }), 'the line with 330')
  } finally { await m.unmount() }
})
