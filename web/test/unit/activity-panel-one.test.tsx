// The one Activity (docs/decisions/20261126-one-activity.md, 20261127-activity-lean.md): 활동's list beside the rail
// (components/panels/ActivityPanel.tsx) holds every notice, mentions and thread replies with the app's own, newest first;
// its filter line is 전체 · 멘션 · 스레드 and "⋯" (DM · 트리나, 요청 for admins), a filter picked there shows as its own
// chip; a link's ?tab= picks a filter; "Mark all as read" reads the filter's tab on the server and is not offered under
// the client's own filters; the 안 읽음 switch hides read rows and is remembered; rows are "where · when" then "who:
// line" (a 1:1 DM names its person once); a conversation row stays selected once its room drops ?m=.
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { activityTabHas, InboxNotification, uuidv7, type ActivityTab, type Me } from '@mycel/shared/api'
import { useLocaleStore } from '../../src/i18n'
import { useSession } from '../../src/store/session'
import { ActivityPanel, noticePage, NOTICE_STATE_KEY, openNotice } from '../../src/components/panels/ActivityPanel'
import { RAIL_STATE_KEY } from '../../src/lib/rail'
import { UNREADS_ONLY_KEY, useUnreadsOnly } from '../../src/lib/unreadsOnly'
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
  useUnreadsOnly.getState().set(false)
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
    // one line: 전체 · 멘션 · 스레드 and "⋯"; no gear (Settings, and the empty main area)
    expect(chipsOf(m)).toEqual(['all', 'mentions', 'threads', 'more'])
    expect(m.find('activity-panel-settings')).toBeNull()
    // newest first, read and unread together
    expect(rowsOf(m).map((r) => r.getAttribute('data-chip'))).toEqual(['conversation', 'requests', 'trina'])
    const row = rowsOf(m).find((r) => r.getAttribute('data-chip') === 'conversation')!
    expect(row.getAttribute('href')).toBe(`/rooms/${ROOM}?m=${MSG}`)
    expect(row.querySelector('[data-testid="activity-panel-who"]')!.textContent).toBe('민준')
    expect(row.querySelector('[data-testid="activity-panel-line"]')!.textContent).toBe('견적서 확인해 주세요')
    expect(row.querySelector('[data-testid="activity-panel-where"]')!.textContent).toBe('#마케팅')
    // two lines: where (and when) first, then "who: line"
    expect(row.querySelector('[data-testid="activity-panel-text"]')!.textContent).toBe('#마케팅')
    expect(row.querySelector('[data-testid="activity-panel-meta"]')!.textContent).toBe('민준: 견적서 확인해 주세요')
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

test('DM is in "⋯" and still a link\'s ?tab=dms: picked, it shows as its own chip before "⋯"; with nothing in it, it says where plain DMs are', async () => {
  const m = await panel('/activity?tab=dms')
  try {
    await m.until(() => m.find('activity-panel-empty'), 'the empty line')
    expect(m.get('activity-panel-empty').textContent).toContain('대화')
    expect(chipsOf(m)).toEqual(['all', 'mentions', 'threads', 'dms', 'more'])
    expect(m.get('activity-chip-dms').getAttribute('aria-pressed')).toBe('true')
  } finally { await m.unmount() }
})

test('"⋯" holds DM and 트리나 (a member), a pick from it becomes a chip and 전체 brings the list back', async () => {
  const m = await panel('/activity')
  try {
    await m.until(() => rowsOf(m).length === 3, 'three rows')
    await m.click('activity-chip-more')
    await m.until(() => body(m).querySelector('[data-testid="activity-more-trina"]'), 'the menu')
    const items = [...body(m).querySelectorAll('[role="menuitemradio"]')].map((x) => x.getAttribute('data-testid'))
    expect(items).toEqual(['activity-more-dms', 'activity-more-trina'])
    expect(body(m).querySelector('[data-testid="activity-more-trina"]')!.textContent).toContain('트리나가 한 일')
    // something unread under 트리나: "⋯" and the item say so
    expect(m.find('activity-chip-more-dot')).not.toBeNull()
    expect(body(m).querySelector('[data-testid="activity-more-trina-dot"]')).not.toBeNull()
    ;(body(m).querySelector('[data-testid="activity-more-trina"]') as unknown as HTMLElement).click()
    await m.until(() => rowsOf(m).length === 1, 'the scheduled run alone')
    expect(chipsOf(m)).toEqual(['all', 'mentions', 'threads', 'trina', 'more'])
    expect(m.get('activity-chip-trina').getAttribute('aria-pressed')).toBe('true')
    await m.click('activity-chip-all')
    await m.until(() => rowsOf(m).length === 3, 'every row again')
    expect(chipsOf(m)).toEqual(['all', 'mentions', 'threads', 'more'])
  } finally { await m.unmount() }
})

test('안 읽음: off by default; on, only unread rows (a row read while open stays), remembered; nothing unread: "모두 읽었어요." and "모두 보기"', async () => {
  inbox = [mention(), { ...reconnect(), readAt: minute(1) }, scheduled()]
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  const m = await mount(<MemoryRouter initialEntries={['/activity']}><ActivityPanel /></MemoryRouter>)
  try {
    await m.until(() => rowsOf(m).length === 3, 'every row, the read one too')
    expect(m.get('activity-panel-unreads').getAttribute('aria-pressed')).toBe('false')
    await m.click('activity-panel-unreads')
    await m.until(() => rowsOf(m).length === 2, 'the unread ones')
    expect(m.get('activity-panel-unreads').getAttribute('aria-pressed')).toBe('true')
    expect(localStorage.getItem(UNREADS_ONLY_KEY)).toBe('yes')
    expect(useUnreadsOnly.getState().on).toBe(true)
    // the switch on under 요청, whose one row is read: all caught up, and a way back
    inbox = [mention(), { ...reconnect(), readAt: minute(1) }]
  } finally { await m.unmount() }
  const admin = { ...me, user: { ...me.user, role: 'admin' } } as unknown as Me
  useSession.setState({ status: { kind: 'signed-in', me: admin } } as never)
  const n = await mount(<MemoryRouter initialEntries={['/activity?tab=requests']}><ActivityPanel /></MemoryRouter>)
  try {
    await n.until(() => n.find('activity-panel-empty'), 'the empty line')
    expect(n.get('activity-panel-empty').textContent).toContain('모두 읽었어요.')
    await n.click('activity-panel-show-all')
    await n.until(() => rowsOf(n).length === 1, 'the read request again')
    expect(useUnreadsOnly.getState().on).toBe(false)
    expect(localStorage.getItem(UNREADS_ONLY_KEY)).toBeNull()
  } finally { await n.unmount() }
})

test('안 읽음 on, "Mark all as read" empties the list to "모두 읽었어요." (rows read one by one stay; all at once they go)', async () => {
  useUnreadsOnly.getState().set(true)
  inbox = [mention(), { ...mention(), id: uuidv7(), createdAt: minute(2) }]
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  const m = await mount(<MemoryRouter initialEntries={['/activity']}><ActivityPanel /></MemoryRouter>)
  try {
    await m.until(() => rowsOf(m).length === 2, 'the two unread mentions')
    await m.click('activity-panel-mark-all')
    await m.until(() => m.find('activity-panel-empty'), 'the empty line')
    expect(rowsOf(m).length).toBe(0)
    expect(m.get('activity-panel-empty').textContent).toContain('모두 읽었어요.')
    expect(sent).toEqual([{ tab: 'all' }])
  } finally { await m.unmount() }
})

test('a 1:1 DM names its person once, on the first line; a shared chat\'s notice keeps the chat\'s title', async () => {
  const dm = InboxNotification.parse({
    id: uuidv7(), eventType: 'room.mention', sourceId: uuidv7(), code: 'room.mention', createdAt: minute(1), readAt: null, chatId: null, link: 'room', outcome: null,
    room: { id: uuidv7(), kind: 'dm', name: null, from: '서연', fromId: 'seoyeon', message: uuidv7(), preview: '파일 확인했어요', count: 1, people: 1, at: minute(1), reason: 'mention' },
  })
  const shared = InboxNotification.parse({ id: uuidv7(), eventType: 'chat.shared', sourceId: 's-3', code: 'chat.shared', createdAt: minute(5), readAt: minute(4), chatId: uuidv7(), link: 'chat', outcome: null, chatShared: { name: '수진', title: '3분기 예산안' } })
  inbox = [dm, shared]
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  const m = await mount(<MemoryRouter initialEntries={['/activity']}><ActivityPanel /></MemoryRouter>)
  try {
    await m.until(() => rowsOf(m).length === 2, 'the two rows')
    const [first, second] = rowsOf(m)
    expect(first!.querySelector('[data-testid="activity-panel-text"]')!.textContent).toBe('서연')
    expect(first!.querySelector('[data-testid="activity-panel-meta"]')!.textContent).toBe('파일 확인했어요')
    expect(first!.textContent!.split('서연').length - 1).toBe(1)
    expect(second!.querySelector('[data-testid="activity-panel-chat"]')!.textContent).toBe('3분기 예산안')
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

test('a chat thread row names who once: who before the line, the chat under it, the line names neither (QA after #634)', async () => {
  const chat = uuidv7(), root = uuidv7()
  const thread = (mention: boolean) => InboxNotification.parse({
    id: uuidv7(), eventType: 'chat.thread_reply', sourceId: root, code: 'chat.thread_reply', createdAt: minute(2), readAt: null, chatId: chat, link: 'chat_thread', outcome: null,
    chatThread: { chatId: chat, rootId: root, name: 'QA Member', byId: 'qa', title: '견적서', ...(mention ? { mention: true } : {}) },
  })
  inbox = [thread(false), thread(true)]
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  const m = await mount(<MemoryRouter initialEntries={['/activity']}><ActivityPanel /></MemoryRouter>)
  try {
    await m.until(() => rowsOf(m).length === 2, 'the two thread rows')
    for (const row of rowsOf(m)) {
      expect(row.querySelector('[data-testid="activity-panel-who"]')!.textContent).toBe('QA Member')
      expect(row.querySelector('[data-testid="activity-panel-where"]')!.textContent).toBe('견적서')
      expect(row.textContent!.split('QA Member').length - 1).toBe(1)
    }
    expect(rowsOf(m).map((r) => r.querySelector('[data-testid="activity-panel-line"]')!.textContent).sort()).toEqual(['스레드에 답글을 달았어요.', '스레드에서 나를 언급했어요.'])
  } finally { await m.unmount() }
})
