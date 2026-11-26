// The one Activity (docs/decisions/20261126-one-activity.md): 활동's list beside the rail (components/panels/
// ActivityPanel.tsx) holds every notice, mentions and thread replies with the app's own; its chips are 전체 · DM · 멘션 ·
// 스레드 · 트리나 (요청 for admins); a link's ?tab= picks a chip; "Mark all as read" reads the chip's tab on the server and
// is not offered under the client's own chips; a conversation row stays selected once its room drops ?m=.
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { activityTabHas, InboxNotification, uuidv7, type ActivityTab, type Me } from '@mycel/shared/api'
import { useLocaleStore } from '../../src/i18n'
import { useSession } from '../../src/store/session'
import { ActivityPanel, noticePage, NOTICE_STATE_KEY, openNotice } from '../../src/components/panels/ActivityPanel'
import { RAIL_STATE_KEY } from '../../src/lib/rail'
import { installDom, mount, removeDom, type Mounted } from './dom-host'
import { ME } from './rooms-fixtures'

setDefaultTimeout(30_000)
const minute = (n: number) => new Date(Date.now() - n * 60_000).toISOString()
const ROOM = uuidv7(), MSG = uuidv7()
const mention = () => InboxNotification.parse({
  id: uuidv7(), eventType: 'room.mention', sourceId: uuidv7(), code: 'room.mention', createdAt: minute(1), readAt: null, chatId: null, link: 'room', outcome: null,
  room: { id: ROOM, kind: 'team', name: '마케팅', from: '민준', fromId: 'minjun', message: MSG, preview: '견적서 확인해 주세요', count: 1, people: 1, at: minute(1), reason: 'mention' },
})
const reconnect = () => InboxNotification.parse({ id: uuidv7(), eventType: 'connection.reconnect', sourceId: 's-1', code: 'connection.reconnect', createdAt: minute(3), readAt: null, chatId: null, link: 'connections', outcome: null })
const scheduled = () => InboxNotification.parse({ id: uuidv7(), eventType: 'schedule.success', sourceId: 's-2', code: 'schedule.success', createdAt: minute(4), readAt: null, chatId: null, link: null, outcome: null })

const me = { user: { id: ME.id, username: ME.id, name: ME.name, email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} }, groups: [],
  team: { name: 'Acme', defaultLocale: 'ko' }, session: { id: uuidv7(), client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: false, timeZone: 'Asia/Seoul' } } as unknown as Me
const realFetch = globalThis.fetch
const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })
let inbox: InboxNotification[] = []
const asked: (string | null)[] = []
const sent: { tab: ActivityTab; only?: string }[] = []
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    if (method === 'GET' && url.pathname === '/api/notifications') {
      asked.push(url.searchParams.get('only'))
      const unread = inbox.filter((x) => !x.readAt).length
      return json({ items: inbox, nextCursor: null, unreadCount: unread, roomUnreadCount: 1, noticeUnreadCount: unread - 1 })
    }
    if (method === 'POST' && url.pathname === '/api/notifications/read') {
      const body = JSON.parse(String(init?.body)) as { tab: ActivityTab; only?: string }
      sent.push(body)
      let read = 0
      inbox = inbox.map((x) => (x.readAt || !activityTabHas(x, body.tab) ? x : (read++, { ...x, readAt: new Date().toISOString() })))
      return json({ read })
    }
    return json({ error: { code: 'not_found', message: url.pathname } }, 404)
  }) as unknown as typeof fetch
})
afterEach(() => {
  useSession.setState({ status })
  sessionStorage.clear()
  asked.length = 0
  sent.length = 0
})
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale })
})

const body = (m: Mounted) => m.container.ownerDocument!.body
const rowsOf = (m: Mounted) => [...body(m).querySelectorAll('[data-testid="activity-panel-row"]')]
const chipsOf = (m: Mounted) => [...m.get('activity-panel-chips').querySelectorAll('button')].map((c) => String(c.getAttribute('data-testid')).replace('activity-chip-', ''))
async function panel(entry: string) {
  inbox = [mention(), reconnect(), scheduled()]
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  const m = await mount(<MemoryRouter initialEntries={[entry]}><ActivityPanel /></MemoryRouter>)
  await m.until(() => asked.length > 0 && !m.find('panel-scroll')?.querySelector('[role="status"]'), 'the list read')
  return m
}

test('every notice in one list: the mention with who, the line and where, beside the app\'s own; asked without only', async () => {
  const m = await panel('/activity')
  try {
    await m.until(() => rowsOf(m).length === 3, 'three rows')
    expect(asked.every((x) => x === null)).toBe(true)
    expect(chipsOf(m)).toEqual(['all', 'dms', 'mentions', 'threads', 'trina'])
    const row = rowsOf(m).find((r) => r.getAttribute('data-chip') === 'conversation')!
    expect(row.getAttribute('href')).toBe(`/rooms/${ROOM}?m=${MSG}`)
    expect(row.querySelector('[data-testid="activity-panel-who"]')!.textContent).toBe('민준')
    expect(row.querySelector('[data-testid="activity-panel-line"]')!.textContent).toBe('견적서 확인해 주세요')
    expect(row.querySelector('[data-testid="activity-panel-where"]')!.textContent).toBe('#마케팅')
    // no line to 대화's 멘션·스레드 any more
    expect(m.find('activity-panel-to-chats')).toBeNull()
    expect(m.find('activity-panel-mark-all')).not.toBeNull()
  } finally { await m.unmount() }
})

test('?tab=mentions picks 멘션: only the mention; Mark all as read reads that tab on the server alone', async () => {
  const m = await panel('/activity?tab=mentions')
  try {
    await m.until(() => rowsOf(m).length === 1, 'the mention alone')
    expect(m.get('activity-chip-mentions').getAttribute('aria-pressed')).toBe('true')
    await m.click('activity-panel-mark-all')
    await m.until(() => sent.length === 1, 'the call')
    expect(sent).toEqual([{ tab: 'mentions' }])
    // the app's own notices stay unread
    expect(inbox.filter((x) => !x.readAt).map((x) => x.code)).toEqual(['connection.reconnect', 'schedule.success'])
  } finally { await m.unmount() }
})

function Where() {
  const { pathname, search } = useLocation()
  return <output data-testid="where">{`${pathname}${search}`}</output>
}

test('a chip picked on /activity writes the address (so Back finds it, not the chip the link named)', async () => {
  inbox = [mention(), reconnect(), scheduled()]
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  const m = await mount(<MemoryRouter initialEntries={['/activity?tab=mentions']}><ActivityPanel /><Where /></MemoryRouter>)
  try {
    await m.until(() => rowsOf(m).length === 1, 'the mention alone')
    await m.click('activity-chip-threads')
    await m.until(() => m.get('where').textContent === '/activity?tab=threads', 'the address follows the chip')
    expect(m.get('activity-chip-threads').getAttribute('aria-pressed')).toBe('true')
    await m.click('activity-chip-all')
    await m.until(() => m.get('where').textContent === '/activity', '전체 drops tab')
  } finally { await m.unmount() }
})

test('트리나 is the client\'s own chip: its rows, and no Mark all as read (the server cannot read it alone)', async () => {
  const m = await panel('/activity?tab=trina')
  try {
    await m.until(() => rowsOf(m).length === 1, 'the scheduled run alone')
    expect(m.find('activity-panel-mark-all')).toBeNull()
  } finally { await m.unmount() }
})

test('DM with nothing in it says where plain DMs are', async () => {
  const m = await panel('/activity?tab=dms')
  try {
    await m.until(() => m.find('activity-panel-empty'), 'the empty line')
    expect(m.get('activity-panel-empty').textContent).toContain('대화')
  } finally { await m.unmount() }
})

describe('a conversation row stays selected', () => {
  test('noticePage drops a room\'s ?m= only', () => {
    expect(noticePage(`/rooms/r1?m=5`)).toBe('/rooms/r1')
    expect(noticePage(`/rooms/r1/t/m1?m=6&x=1`)).toBe('/rooms/r1/t/m1?x=1')
    expect(noticePage('/files?path=a')).toBe('/files?path=a')
  })
  test('the room opened from its row, its ?m= dropped since: the row is still the one open', () => {
    const item = mention()
    expect(openNotice([item], { pathname: `/rooms/${ROOM}`, search: '', state: { [RAIL_STATE_KEY]: 'activity', [NOTICE_STATE_KEY]: item.id }, lit: 'activity' })).toBe(item.id)
    expect(openNotice([item], { pathname: `/rooms/${ROOM}`, search: '', state: null, lit: 'activity' })).toBe(item.id)
    expect(openNotice([item], { pathname: `/rooms/${ROOM}`, search: '', state: null, lit: 'chats' })).toBeNull()
  })
})
