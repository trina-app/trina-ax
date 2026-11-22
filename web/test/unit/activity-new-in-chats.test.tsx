// An empty Activity while 대화 counts an unread conversation (QA TC-ask2-9: a guest's DM, 대화 showing 1 and Activity
// saying "no notifications yet"): the empty state points to 대화 in one line (pages/Activity.tsx), and says nothing more
// when nothing is unread there.
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import { uuidv7, type Me } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { useRooms } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import Activity from '../../src/pages/Activity'
import { installDom, mount, removeDom } from './dom-host'
import { ME, room } from './rooms-fixtures'
import { useListCache } from '../../src/store/listCache'

setDefaultTimeout(30_000)
const ko = (k: Parameters<typeof translate>[1]) => translate('ko', k)
const me = { user: { id: ME.id, username: ME.id, name: ME.name, email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} }, groups: [],
  team: { name: 'Acme', defaultLocale: 'ko' }, session: { id: uuidv7(), client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: false, timeZone: 'Asia/Seoul' } } as unknown as Me
const realFetch = globalThis.fetch
const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })

beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://x')
    if ((init?.method ?? 'GET') === 'GET' && url.pathname === '/api/notifications') return json({ items: [], nextCursor: null, unreadCount: 0, roomUnreadCount: 0 })
    return json({ error: { code: 'not_found', message: url.pathname } }, 404)
  }) as unknown as typeof fetch
})
afterEach(() => {
  useListCache.getState().reset()
  useRooms.getState().reset()
  useSession.setState({ status })
})
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale })
})

async function open(rooms: ReturnType<typeof room>[]) {
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  useRooms.setState({ rooms, loaded: true })
  const m = await mount(<MemoryRouter initialEntries={['/activity']}><Activity /></MemoryRouter>)
  await m.until(() => (m.container.textContent ?? '').includes(ko('notifications.empty')), 'the empty state')
  return m
}

test('an unread DM: the empty Activity says the new messages are in 대화, with a link there', async () => {
  const m = await open([room({ kind: 'dm', unreadCount: 1 })])
  try {
    const link = m.get('activity-new-in-chats')
    expect(link.textContent).toBe(ko('feed.newInChats'))
    expect(link.getAttribute('href')).toBe('/rooms')
  } finally {
    await m.unmount()
  }
})

test('nothing unread in 대화 (or only a muted room): the empty state alone', async () => {
  const m = await open([room({ kind: 'dm' }), room({ kind: 'group', unreadCount: 2, muted: true })])
  try {
    expect(m.find('activity-new-in-chats')).toBeNull()
  } finally {
    await m.unmount()
  }
})
