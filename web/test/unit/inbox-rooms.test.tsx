// The Inbox's conversation rows (docs/DECISIONS.md "알림함의 대화 알림", components/settings/RoomNoticeRow.tsx): the words
// of a row (who, where, why, the first line) for every reason and kind, one row for a run ("민준 외 2명 · 답글 3개"),
// the link to the exact place, the older server's line, and a row the person may no longer read.
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import { InboxNotification, uuidv7, type Me } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { useRooms } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import { Notifications } from '../../src/components/settings/Notifications'
import { isRoomRow, roomNoticeLink, roomRowText, type RoomNotice } from '../../src/components/settings/RoomNoticeRow'
import { installDom, mount, removeDom } from './dom-host'
import { ME, room } from './rooms-fixtures'

setDefaultTimeout(30_000)
const ko = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('ko', k, p)
const en = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('en', k, p)
const ROOM = uuidv7(), ROOT = uuidv7(), MSG = uuidv7()

/** a notice as the server sends it (parsed with the contract, so a change there breaks this) */
const notice = (o: Partial<InboxNotification> & { room?: InboxNotification['room'] } = {}) => InboxNotification.parse({
  id: uuidv7(), eventType: 'room.dm', sourceId: MSG, code: 'room.dm', createdAt: '2026-11-07T01:00:00.000Z', readAt: null, chatId: null, link: 'room', outcome: null, ...o,
})
const row = (r: Partial<RoomNotice['room']>, o: Partial<InboxNotification> = {}) => notice({ ...o, room: { id: ROOM, from: '민준', fromId: 'minjun', kind: 'team', name: '마케팅', reason: 'message', message: MSG, preview: '첫 줄', count: 1, people: 1, at: '2026-11-07T01:00:00.000Z', ...r } }) as RoomNotice

test('who and where, the line and the "@" mark, for every reason and kind', () => {
  // a row of replies in a thread: the newest writer and how many others, the room and the thread, the newest line
  expect(roomRowText(row({ reason: 'reply', thread: ROOT, from: '서연', people: 3, count: 3, preview: '금요일까지 공유할게요' }).room, ko))
    .toEqual({ who: '서연 외 2명', where: '#마케팅 › 스레드', line: '금요일까지 공유할게요', mark: null })
  // a mention, "@전체": the mark, and what it means for a screen reader
  expect(roomRowText(row({ reason: 'mention' }).room, ko)).toMatchObject({ who: '민준', where: '#마케팅', mark: '멘션' })
  expect(roomRowText(row({ reason: 'everyone', kind: 'all', name: null }).room, ko)).toMatchObject({ where: '전체', mark: '@전체' })
  // a DM: "1:1"
  expect(roomRowText(row({ kind: 'dm', name: null, reason: 'mention' }).room, ko)).toMatchObject({ who: '민준', where: '1:1' })
  // a group chat: its name; without one, its title from the rooms list, else the word for it
  expect(roomRowText(row({ kind: 'group', name: '점심 모임' }).room, ko).where).toBe('점심 모임')
  expect(roomRowText(row({ kind: 'group', name: null }).room, ko, '서연, 지호').where).toBe('서연, 지호')
  expect(roomRowText(row({ kind: 'group', name: null }).room, ko).where).toBe('그룹 대화')
  // the AI's answer: its name and one plain line of its Markdown; a person who is gone; a message with only files
  expect(roomRowText(row({ ai: true, from: null, fromId: null, preview: '**요약**: 두 가지' }).room, ko)).toMatchObject({ who: '트리나', line: '요약: 두 가지' })
  expect(roomRowText(row({ from: null, fromId: null }).room, ko).who).toBe(ko('rooms.goneUser'))
  expect(roomRowText(row({ preview: '', files: 2 }).room, ko).line).toBe('파일 2개')
  // the single notice a push opens has no text: no line
  expect(roomRowText(row({ preview: undefined }).room, ko).line).toBe('')
  // English
  expect(roomRowText(row({ reason: 'reply', thread: ROOT, from: 'Mina', people: 2, count: 4 }).room, en)).toMatchObject({ who: 'Mina and 1 more', where: '#마케팅 › Thread' })
  expect(roomRowText(row({ kind: 'dm', name: null }).room, en)).toMatchObject({ where: 'Direct message' })
})

test('a row opens the exact place: the thread or the room, with the message to pick out', () => {
  expect(roomNoticeLink({ id: ROOM, thread: ROOT, message: MSG })).toBe(`/rooms/${ROOM}/t/${ROOT}?m=${MSG}`)
  expect(roomNoticeLink({ id: ROOM, message: MSG })).toBe(`/rooms/${ROOM}?m=${MSG}`)
  expect(roomNoticeLink({ id: ROOM })).toBe(`/rooms/${ROOM}`)
})

test('which notices are rows: a server that says where and why; an older one, or a message I may not read, keeps the line', () => {
  expect(isRoomRow(row({}))).toBe(true)
  expect(isRoomRow(notice({ room: { id: ROOM, from: '민준' } }))).toBe(false)
  expect(isRoomRow(notice({ link: null }))).toBe(false)
  expect(isRoomRow(notice({ eventType: 'schedule.success', code: 'schedule.success', link: null }))).toBe(false)
})

// ---------------- in the Inbox ----------------
const me = { user: { id: ME.id, username: ME.id, name: ME.name, email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} }, groups: [],
  team: { name: 'Acme', defaultLocale: 'ko' }, session: { id: uuidv7(), client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: false, timeZone: 'Asia/Seoul' } } as unknown as Me
const realFetch = globalThis.fetch
const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
const reads: string[] = []
let items: InboxNotification[] = []
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
    if (key === 'GET /api/notifications') return json({ items, nextCursor: null, unreadCount: items.filter((x) => !x.readAt).length })
    const read = /^POST \/api\/notifications\/(.+)\/read$/.exec(key)
    if (read) { reads.push(read[1]!); items = items.map((x) => (x.id === read[1] ? { ...x, readAt: '2026-11-07T02:00:00.000Z' } : x)); return json(items.find((x) => x.id === read[1])) }
    if (key === 'GET /api/notification-preferences') return json({ scheduleSuccess: true, scheduleFailure: true, connectionReconnect: true, skillSuggestions: true })
    if (key === 'GET /api/push') return json({ configured: false, enabled: false, publicKey: null, subscriptionId: null })
    return json({ error: { code: 'not_found', message: key } }, 404)
  }) as unknown as typeof fetch
})
afterEach(() => {
  reads.length = 0
  useRooms.getState().reset()
  useSession.setState({ status })
})
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale })
})

test('the Inbox: a thread row with its count, an unnamed group chat named from the rooms list, the older line with its thread link, and a click that reads', async () => {
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  const chat = room({ kind: 'group', name: null, groupId: null, peers: [{ id: 'seoyeon', name: '서연' }, { id: 'jiho', name: '지호' }], memberCount: 3 })
  useRooms.setState({ rooms: [chat], loaded: true })
  const grouped = row({ reason: 'mention', thread: ROOT, from: '서연', people: 3, count: 3, preview: '금요일까지 공유할게요' })
  const unnamed = row({ id: chat.id, kind: 'group', name: null, reason: 'reply', thread: ROOT, preview: '이름 없는 방' }, { readAt: '2026-11-07T01:30:00.000Z' })
  const older = notice({ code: 'room.mention', eventType: 'room.mention', room: { id: ROOM, from: '하은', thread: ROOT } })
  const gone = notice({ link: null })
  items = [grouped, unnamed, older, gone]
  const m = await mount(<MemoryRouter><Notifications /></MemoryRouter>)
  try {
    await m.until(() => m.find('notification-room-row'), 'the rows')
    const body = m.container.ownerDocument!.body
    const links = body.querySelectorAll('[data-testid="notification-room-row"]')
    expect(links).toHaveLength(2)
    expect(links[0]!.getAttribute('href')).toBe(`/rooms/${ROOM}/t/${ROOT}?m=${MSG}`)
    expect(links[0]!.querySelector('[data-testid="notification-room-who"]')!.textContent).toBe('서연 외 2명')
    expect(links[0]!.querySelector('[data-testid="notification-room-where"]')!.textContent).toContain('#마케팅 › 스레드')
    expect(links[0]!.querySelector('[data-testid="notification-room-line"]')!.textContent).toBe('@멘션: 금요일까지 공유할게요')
    expect(links[0]!.querySelector('[data-testid="notification-room-count"]')!.textContent).toBe(`3${ko('rooms.unread', { n: 3 })}`)
    expect(links[0]!.getAttribute('data-unread')).toBe('')
    expect(links[0]!.innerHTML).toContain('<bdi')
    // read: no count, no mark for a reply
    expect(links[1]!.textContent).toContain('서연, 지호')
    expect(links[1]!.getAttribute('data-unread')).toBeNull()
    expect(links[1]!.querySelector('[data-testid="notification-room-count"]')).toBeNull()
    expect(links[1]!.querySelector('[data-testid="notification-room-line"]')!.textContent).toBe('이름 없는 방')
    // an older server: the line it had, and its link opens the thread; a message I may no longer read: the generic line, no link
    const rows = body.querySelectorAll('[data-testid="notification-item"]')
    expect(rows[2]!.textContent).toContain(ko('notifications.event.room.mentionNamed', { name: '하은' }))
    expect(rows[2]!.querySelector('[data-testid="notification-room-link"]')!.getAttribute('href')).toBe(`/rooms/${ROOM}/t/${ROOT}`)
    expect(rows[3]!.textContent).toContain(ko('notifications.event.room.dm'))
    expect(rows[3]!.querySelector('a')).toBeNull()
    // the click reads the notice
    await m.click(links[0]!)
    await m.until(() => reads.length > 0, 'the read')
    expect(reads).toEqual([grouped.id])
  } finally { await m.unmount() }
})
