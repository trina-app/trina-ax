// Rooms and Activity changes show at once (lib/optimistic.ts; docs/DECISIONS.md "Optimistic changes: the screen first,
// the server after"): my level for a room, a room's name, my message's text, my read place in a room or a thread
// (store/rooms.ts), and a notice read or "Mark all as read" in Activity (store/inbox.ts). Each is on screen before the
// server answers; a refusal puts it back (with one toast, except the reads made by looking); a read or an event from
// before the change does not undo it.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { InboxNotification, type Me } from '@mycel/shared/api'
import { useLocaleStore } from '../../src/i18n'
import { resetOptimistic } from '../../src/lib/optimistic'
import { keepPendingReads, markAllNoticesRead, markNoticeRead, reloadInboxCount, useInbox } from '../../src/store/inbox'
import { useRooms } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import { useUi } from '../../src/store/ui'
import { at, BEN, ME, message, room } from './rooms-fixtures'

const me = {
  user: { id: ME.id, username: ME.id, name: ME.name, email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'ko', chatTrashRetentionDays: 14 }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'hosted' },
} as unknown as Me
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })
const refused = () => json({ error: { code: 'internal', message: 'Something went wrong.' } }, 500)

/** requests waiting for the test's answer, by "METHOD path" */
const waiting: { key: string; body: unknown; answer: (r: Response) => void }[] = []
const take = (key: string) => {
  const i = waiting.findIndex((w) => w.key === key)
  if (i < 0) throw new Error(`no request ${key}; waiting: ${waiting.map((w) => w.key).join(', ')}`)
  return waiting.splice(i, 1)[0]!
}
const tick = () => new Promise((r) => setTimeout(r, 0))
const toasts = () => (useUi.getState() as unknown as { toasts: { level: string; text: string }[] }).toasts
const tl = (roomId: string, messages: ReturnType<typeof message>[]) => ({ roomId, messages, nextCursor: null, loading: false, error: null })
const listed = (id: string) => useRooms.getState().rooms.find((r) => r.id === id)!

const realFetch = globalThis.fetch
const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
beforeAll(() => {
  useLocaleStore.setState({ locale: 'ko' })
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((answer) => waiting.push({ key: `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`, body: init?.body ? JSON.parse(String(init.body)) : undefined, answer }))) as unknown as typeof fetch
})
afterEach(() => {
  waiting.length = 0
  resetOptimistic()
  useRooms.getState().reset()
  useInbox.setState({ unread: 0, rooms: 0, notices: 0 })
  useUi.setState({ toasts: [] } as never)
})
afterAll(() => {
  globalThis.fetch = realFetch
  useSession.setState({ status })
  useLocaleStore.setState({ locale })
})

test('notification level: the bell shows 끄기 before the answer; a list read meanwhile keeps it; the answer settles it', async () => {
  const r = room({ notify: { own: null, byDefault: 'mentions', level: 'mentions' } })
  useRooms.setState({ rooms: [r], loaded: true })
  const done = useRooms.getState().setNotifyLevel(r.id, 'off')
  expect(listed(r.id)).toMatchObject({ muted: true, notify: { own: 'off', byDefault: 'mentions', level: 'off' } })
  const load = useRooms.getState().loadRooms()
  await tick()
  take('GET /api/rooms').answer(json({ items: [r] }))
  await load
  expect(listed(r.id).notify!.own).toBe('off')
  const sent = take(`PATCH /api/rooms/${r.id}`)
  expect(sent.body).toEqual({ notifyLevel: 'off' })
  sent.answer(json({ ...r, muted: true, notify: { own: 'off', byDefault: 'mentions', level: 'off' } }))
  await done
  expect(listed(r.id)).toMatchObject({ muted: true, notify: { own: 'off', level: 'off' } })
  expect(toasts()).toHaveLength(0)
})

test('notification level that fails: the old level comes back with one toast, and nothing rejects', async () => {
  const r = room({ notify: { own: 'all', byDefault: 'mentions', level: 'all' } })
  useRooms.setState({ rooms: [r], loaded: true })
  const done = useRooms.getState().setNotifyLevel(r.id, null)
  expect(listed(r.id).notify).toEqual({ own: null, byDefault: 'mentions', level: 'mentions' })
  await tick()
  take(`PATCH /api/rooms/${r.id}`).answer(refused())
  await done
  expect(listed(r.id).notify).toEqual({ own: 'all', byDefault: 'mentions', level: 'all' })
  expect(listed(r.id).muted).toBe(false)
  expect(toasts()).toHaveLength(1)
  expect(toasts()[0]!.level).toBe('error')
})

test('rename: the new name shows at once (trimmed); a room.updated from before it does not bring the old one back', async () => {
  const r = room({ kind: 'group', name: 'Old plan', canRename: true })
  useRooms.setState({ rooms: [r], loaded: true })
  const done = useRooms.getState().rename(r.id, '  Launch plan ')
  expect(listed(r.id).name).toBe('Launch plan')
  useRooms.getState().handleEvent({ type: 'room.updated', seq: 1, at: Date.now(), data: { roomId: r.id, change: 'settings', room: r } } as never)
  expect(listed(r.id).name).toBe('Launch plan')
  await tick()
  const sent = take(`PATCH /api/rooms/${r.id}`)
  expect(sent.body).toEqual({ name: 'Launch plan' })
  sent.answer(json({ ...r, name: 'Launch plan' }))
  await done
  expect(listed(r.id).name).toBe('Launch plan')
})

test('rename that fails: the old name comes back with one toast', async () => {
  const r = room({ kind: 'group', name: 'Old plan', canRename: true })
  useRooms.setState({ rooms: [r], loaded: true })
  const done = useRooms.getState().rename(r.id, '')
  expect(listed(r.id).name).toBeNull()
  await tick()
  take(`PATCH /api/rooms/${r.id}`).answer(refused())
  await done
  expect(listed(r.id).name).toBe('Old plan')
  expect(toasts()).toHaveLength(1)
})

test('edit my message: the new text shows at once, marked edited; an older room.message.updated is ignored meanwhile', async () => {
  const r = room()
  const m = message({ roomId: r.id, seq: 1, author: ME, body: 'helo team' })
  useRooms.setState({ rooms: [r], loaded: true, openRoomId: r.id, timeline: tl(r.id, [m]) })
  const done = useRooms.getState().edit(r.id, m.id, 'hello team', [])
  const shown = () => useRooms.getState().timeline!.messages[0]!
  expect(shown().body).toBe('hello team')
  expect(shown().editedAt).toBeTruthy()
  useRooms.getState().handleEvent({ type: 'room.message.updated', seq: 1, at: Date.now(), data: { roomId: r.id, message: m } } as never)
  expect(shown().body).toBe('hello team')
  await tick()
  take(`PATCH /api/rooms/${r.id}/messages/${m.id}`).answer(json({ ...m, body: 'hello team', editedAt: at(5) }))
  expect(await done).toBe(true)
  expect(shown()).toMatchObject({ body: 'hello team', editedAt: at(5) })
  expect(toasts()).toHaveLength(0)
})

test('edit that fails: the old text comes back with one toast, and the caller hears false (to open the box again)', async () => {
  const r = room()
  const m = message({ roomId: r.id, seq: 1, author: ME, body: 'helo team' })
  useRooms.setState({ rooms: [r], loaded: true, openRoomId: r.id, timeline: tl(r.id, [m]) })
  const done = useRooms.getState().edit(r.id, m.id, 'hello @Ben', [BEN.id])
  expect(useRooms.getState().timeline!.messages[0]!.mentions).toEqual([BEN.id])
  await tick()
  take(`PATCH /api/rooms/${r.id}/messages/${m.id}`).answer(refused())
  expect(await done).toBe(false)
  expect(useRooms.getState().timeline!.messages[0]).toMatchObject({ body: 'helo team', mentions: [], editedAt: null })
  expect(toasts()).toHaveLength(1)
})

test('mark a room read: the badge goes at once; a list read from before keeps it gone; the answer settles it', async () => {
  const r = room({ lastSeq: 4, unreadCount: 3, lastReadSeq: 1, mentioned: true })
  useRooms.setState({ rooms: [r], loaded: true })
  const done = useRooms.getState().markRead(r.id, 4)
  expect(listed(r.id)).toMatchObject({ unreadCount: 0, lastReadSeq: 4, mentioned: false })
  const load = useRooms.getState().loadRooms()
  await tick()
  take('GET /api/rooms').answer(json({ items: [r] }))
  await load
  expect(listed(r.id)).toMatchObject({ unreadCount: 0, lastReadSeq: 4 })
  take(`POST /api/rooms/${r.id}/read`).answer(json({ lastReadSeq: 4, unreadCount: 0, mentioned: false }))
  await done
  expect(listed(r.id)).toMatchObject({ unreadCount: 0, lastReadSeq: 4, mentioned: false })
})

test('mark a room read that fails: the badge comes back without a toast (looking at it is not a tap); the same place is not asked again at once', async () => {
  const r = room({ lastSeq: 4, unreadCount: 3, lastReadSeq: 1 })
  useRooms.setState({ rooms: [r], loaded: true })
  const done = useRooms.getState().markRead(r.id, 4)
  expect(listed(r.id).unreadCount).toBe(0)
  await tick()
  take(`POST /api/rooms/${r.id}/read`).answer(refused())
  await done
  expect(listed(r.id)).toMatchObject({ unreadCount: 3, lastReadSeq: 1 })
  expect(toasts()).toHaveLength(0)
  // the room is read again for what came meanwhile
  await tick()
  take(`GET /api/rooms/${r.id}`)
  // the screen asks for the same place again (the badge came back): not sent, or it would repeat while the server says no
  void useRooms.getState().markRead(r.id, 4)
  await tick()
  expect(waiting.some((w) => w.key === `POST /api/rooms/${r.id}/read`)).toBe(false)
  expect(listed(r.id).unreadCount).toBe(3)
  // a newer message read: asked
  useRooms.setState((s) => ({ rooms: s.rooms.map((x) => ({ ...x, lastSeq: 5, unreadCount: 4 })) }))
  void useRooms.getState().markRead(r.id, 5)
  await tick()
  expect(waiting.some((w) => w.key === `POST /api/rooms/${r.id}/read`)).toBe(true)
})

test('mark a thread read: its news mark and the room count go at once; a failure puts both back', async () => {
  const r = room({ threadsUnread: 2, nextThreadId: null })
  const root = message({ roomId: r.id, seq: 1, thread: { replyCount: 1, lastReplyAt: at(2), repliers: [BEN], newReplies: true } })
  useRooms.setState({ rooms: [r], loaded: true, openRoomId: r.id, timeline: tl(r.id, [root]) })
  const done = useRooms.getState().markThreadRead(r.id, root.id, 2)
  expect(useRooms.getState().timeline!.messages[0]!.thread!.newReplies).toBe(false)
  expect(listed(r.id).threadsUnread).toBe(1)
  await tick()
  take(`POST /api/rooms/${r.id}/messages/${root.id}/thread/read`).answer(refused())
  await done
  expect(useRooms.getState().timeline!.messages[0]!.thread!.newReplies).toBe(true)
  expect(listed(r.id).threadsUnread).toBe(2)
  expect(toasts()).toHaveLength(0)
})

test('two reads of one thread on their way, both refused: the news mark and the count come back as before the first', async () => {
  const r = room({ threadsUnread: 1 })
  const root = message({ roomId: r.id, seq: 1, thread: { replyCount: 2, lastReplyAt: at(3), repliers: [BEN], newReplies: true } })
  useRooms.setState({ rooms: [r], loaded: true, openRoomId: r.id, timeline: tl(r.id, [root]) })
  const first = useRooms.getState().markThreadRead(r.id, root.id, 2)
  const second = useRooms.getState().markThreadRead(r.id, root.id, 3)
  expect(listed(r.id).threadsUnread).toBe(0)
  await tick()
  take(`POST /api/rooms/${r.id}/messages/${root.id}/thread/read`).answer(refused())
  await tick()
  await tick()
  take(`POST /api/rooms/${r.id}/messages/${root.id}/thread/read`).answer(refused())
  await Promise.all([first, second])
  expect(useRooms.getState().timeline!.messages[0]!.thread!.newReplies).toBe(true)
  expect(listed(r.id).threadsUnread).toBe(1)
})

const notice = (o: Partial<InboxNotification> = {}) => InboxNotification.parse({
  id: '01900000-0000-7000-8000-0000000000d1', eventType: 'team.joined', sourceId: 'acme', code: 'team.joined', createdAt: at(0), readAt: null, chatId: null, link: null, ...o,
})

test('Activity: a notice read shows read at once with the counts one lower; a read of the rows meanwhile keeps its mark', async () => {
  useInbox.setState({ unread: 3, rooms: 1, notices: 2 })
  const item = notice()
  const shown: (string | null)[] = []
  const done = markNoticeRead(item, (readAt) => shown.push(readAt))
  expect(shown).toHaveLength(1)
  expect(shown[0]).toBeTruthy()
  expect(useInbox.getState()).toEqual({ unread: 2, rooms: 1, notices: 1 })
  // a list read from before the tap: the row keeps the read mark on screen
  expect(keepPendingReads([item], [{ ...item, readAt: shown[0]! }])[0]!.readAt).toBe(shown[0]!)
  await tick()
  take(`POST /api/notifications/${item.id}/read`).answer(json({ ...item, readAt: at(3) }))
  const r = await done
  expect(r.ok).toBe(true)
  expect(shown).toHaveLength(1)
  // not pending any more: a read decides again
  expect(keepPendingReads([item], [{ ...item, readAt: shown[0]! }])[0]!.readAt).toBeNull()
  // the counts are read again after
  expect(waiting.some((w) => w.key === 'GET /api/notifications')).toBe(true)
})

test('Activity: a notice read that fails comes back unread, with the counts and one toast', async () => {
  useInbox.setState({ unread: 3, rooms: 1, notices: 2 })
  const item = notice()
  const shown: (string | null)[] = []
  const done = markNoticeRead(item, (readAt) => shown.push(readAt))
  await tick()
  take(`POST /api/notifications/${item.id}/read`).answer(refused())
  const r = await done
  expect(r.ok).toBe(false)
  expect(shown.at(-1)).toBeNull()
  expect(useInbox.getState()).toEqual({ unread: 3, rooms: 1, notices: 2 })
  expect(toasts()).toHaveLength(1)
})

test('Activity: a count read that lands while a read is on its way writes nothing; the read after does', async () => {
  useInbox.setState({ unread: 3, rooms: 1, notices: 2 })
  const item = notice()
  const done = markNoticeRead(item, () => {})
  // another place reads the count meanwhile; the server answers it from before the read
  reloadInboxCount()
  await tick()
  take('GET /api/notifications').answer(json({ items: [], nextCursor: null, unreadCount: 3, roomUnreadCount: 1, noticeUnreadCount: 2 }))
  await tick()
  expect(useInbox.getState()).toEqual({ unread: 2, rooms: 1, notices: 1 })
  take(`POST /api/notifications/${item.id}/read`).answer(json({ ...item, readAt: at(3) }))
  await done
  take('GET /api/notifications').answer(json({ items: [], nextCursor: null, unreadCount: 2, roomUnreadCount: 1, noticeUnreadCount: 1 }))
  await tick()
  expect(useInbox.getState()).toEqual({ unread: 2, rooms: 1, notices: 1 })
})

test('Activity: Mark all as read empties the count at once; a failure puts the rows back with one toast', async () => {
  useInbox.setState({ unread: 5, rooms: 2, notices: 3 })
  const shown: (string | null)[] = []
  const done = markAllNoticesRead('all', 'notices', (readAt) => shown.push(readAt))
  expect(shown[0]).toBeTruthy()
  expect(useInbox.getState()).toEqual({ unread: 2, rooms: 2, notices: 0 })
  await tick()
  const sent = take('POST /api/notifications/read')
  expect(sent.body).toEqual({ tab: 'all', only: 'notices' })
  sent.answer(refused())
  const r = await done
  expect(r.ok).toBe(false)
  expect(shown.at(-1)).toBeNull()
  expect(toasts()).toHaveLength(1)
  // the counts are read again (they are the server's)
  expect(waiting.some((w) => w.key === 'GET /api/notifications')).toBe(true)
})
