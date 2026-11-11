// The rooms store (store/rooms.ts): the pure state changes for the room.* events, and handleEvent against a fake REST
// server where an event needs one (leaving a room closes it). Threads: a reply goes to its open thread, and to the
// timeline only when sent to the room too; summaries and reactions change in place; nobody's reading but mine.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { uuidv7, type Me } from '@mycel/shared/api'
import { setNavigator } from '../../src/lib/nav'
import { mergeMessages, placeKey, toggledReactions, withAiRun, withMessage, withReactions, withReadState, withThreadSummary, withUpdatedMessage, useRooms, type RoomsData } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import { readUpTo, roomBadge, roomUnread, totalUnread } from '../../src/lib/rooms'
import { at, BEN, CY, ME, message, room } from './rooms-fixtures'

const data = (o: Partial<RoomsData> = {}): RoomsData => ({ rooms: [], openRoomId: null, timeline: null, threadViews: {}, ...o })
const tl = (roomId: string, messages: ReturnType<typeof message>[] = []) => ({ roomId, messages, nextCursor: null, loading: false, error: null })
type View = { roomId: string; rootId: string; root: ReturnType<typeof message> | null; replies: ReturnType<typeof message>[] }
/** threads on screen, each shown by one panel unless said */
const views = (...list: (View & { holders?: number })[]): RoomsData['threadViews'] => Object.fromEntries(list.map((v) => [placeKey(v.roomId, v.rootId), { nextCursor: null, loading: false, error: null, holders: 1, ...v }]))
const viewOf = (d: Pick<RoomsData, 'threadViews'>, roomId: string, rootId: string) => d.threadViews[placeKey(roomId, rootId)]

describe('a new message', () => {
  test('is added to the open room once, by id, in room order', () => {
    const r = room()
    const m1 = message({ roomId: r.id, seq: 1 })
    const m2 = message({ roomId: r.id, seq: 2 })
    let d = data({ rooms: [r], openRoomId: r.id, timeline: tl(r.id, [m1]) })
    d = withMessage(d, r.id, m2, ME.id)
    d = withMessage(d, r.id, m2, ME.id) // the same event again (a replay, or my send's own answer)
    expect(d.timeline!.messages.map((m) => m.seq)).toEqual([1, 2])
    expect(mergeMessages([m2], [m1]).map((m) => m.seq)).toEqual([1, 2])
  })

  test('a message carries no read count: nobody is told who has read what', () => {
    const m = message({ roomId: room().id, seq: 1 })
    expect(m).not.toHaveProperty('unread')
  })

  test('moves its room to the top with the message as the last line', () => {
    const quiet = room({ name: 'acme-ops', activityAt: at(-30) })
    const busy = room({ name: 'acme-sales', activityAt: at(-10) })
    const m = message({ roomId: quiet.id, seq: 4, body: 'line one\nline two' })
    const d = withMessage(data({ rooms: [busy, quiet] }), quiet.id, m, ME.id)
    expect(d.rooms.map((r) => r.name)).toEqual(['acme-ops', 'acme-sales'])
    expect(d.rooms[0]!.lastMessage).toMatchObject({ id: m.id, seq: 4, excerpt: 'line one\nline two', author: BEN })
    expect(d.rooms[0]!.lastSeq).toBe(4)
    expect(d.rooms[0]!.activityAt).toBe(m.createdAt)
  })

  test("counts as unread only when it is another member's and the room is not on screen", () => {
    const r = room()
    const other = message({ roomId: r.id, seq: 1 })
    const mine = message({ roomId: r.id, seq: 2, author: ME })
    // another member's message in a room that is not open: one more
    let d = withMessage(data({ rooms: [r] }), r.id, other, ME.id)
    expect(d.rooms[0]!.unreadCount).toBe(1)
    // the same message again counts nothing again
    d = withMessage(d, r.id, other, ME.id)
    expect(d.rooms[0]!.unreadCount).toBe(1)
    // my own message (from another window) never counts, and sending read everything before it
    d = withMessage(d, r.id, mine, ME.id)
    expect(d.rooms[0]).toMatchObject({ unreadCount: 0, lastReadSeq: 2 })
    d = withMessage(d, r.id, message({ roomId: r.id, seq: 3 }), ME.id)
    expect(d.rooms[0]!.unreadCount).toBe(1)
    // the room on screen: nothing counts (the screen marks it read)
    const open = withMessage(data({ rooms: [r], openRoomId: r.id }), r.id, other, ME.id)
    expect(open.rooms[0]!.unreadCount).toBe(0)
  })

  test('mentioning me marks the room "mentioned"; a deleted message counts nothing', () => {
    const r = room()
    const d = withMessage(data({ rooms: [r] }), r.id, message({ roomId: r.id, seq: 1, mentions: [ME.id] }), ME.id)
    expect(d.rooms[0]).toMatchObject({ unreadCount: 1, mentioned: true })
    const gone = withMessage(data({ rooms: [r] }), r.id, message({ roomId: r.id, seq: 1, deletedAt: at(2) }), ME.id)
    expect(gone.rooms[0]!.unreadCount).toBe(0)
  })

  test("@트리나's private answer to my question counts for me, as the server counts it (it is sent to me only)", () => {
    // I asked in this room and went to another one: the sidebar and the dock badge said 0, a reload 1
    const r = room({ lastSeq: 1, lastReadSeq: 1 })
    const answer = message({ roomId: r.id, seq: 2, authorKind: 'ai', author: null, askedBy: ME, visibility: 'private' })
    const d = withMessage(data({ rooms: [r] }), r.id, answer, ME.id)
    expect(d.rooms[0]).toMatchObject({ unreadCount: 1, mentioned: false, lastSeq: 2, lastMessage: { id: answer.id } })
    // the room on screen: nothing (the screen reads it)
    expect(withMessage(data({ rooms: [r], openRoomId: r.id }), r.id, answer, ME.id).rooms[0]!.unreadCount).toBe(0)
    // shared to the room from my phone: the server read the room up to it first (room.read before the message)
    const shared = { ...answer, seq: 3, visibility: 'room' as const }
    let other = withReadState(data({ rooms: [r] }), r.id, { lastReadSeq: 3, unreadCount: 0, mentioned: false })
    other = withMessage(other, r.id, shared, ME.id)
    expect(other.rooms[0]).toMatchObject({ unreadCount: 0, lastReadSeq: 3, lastSeq: 3, lastMessage: { id: answer.id } })
  })

  test('the badge stops at 999 like the server', () => {
    const r = room({ unreadCount: 999, lastSeq: 999 })
    const d = withMessage(data({ rooms: [r] }), r.id, message({ roomId: r.id, seq: 1000 }), ME.id)
    expect(d.rooms[0]!.unreadCount).toBe(999)
  })
})

describe('threads', () => {
  test('a reply goes to its open thread, not to the timeline; the room keeps its badge, its last line and its place', () => {
    const r = room({ lastSeq: 1, activityAt: at(-30) })
    const other = room({ activityAt: at(-10) })
    const root = message({ roomId: r.id, seq: 1 })
    const reply = message({ roomId: r.id, seq: 2, threadRootId: root.id })
    let d = data({ rooms: [other, r], openRoomId: r.id, timeline: tl(r.id, [root]), threadViews: views({ roomId: r.id, rootId: root.id, root, replies: [] }) })
    d = withMessage(d, r.id, reply, ME.id)
    expect(d.timeline!.messages.map((m) => m.id)).toEqual([root.id])
    expect(viewOf(d, r.id, root.id)!.replies.map((m) => m.id)).toEqual([reply.id])
    expect(d.rooms.map((x) => x.id)).toEqual([other.id, r.id])
    expect(d.rooms[1]).toMatchObject({ unreadCount: 0, lastSeq: 1, lastMessage: null })
    // a room not on screen: a reply counts nothing there either (a followed thread's count comes from the server)
    const closed = withMessage(data({ rooms: [r] }), r.id, reply, ME.id)
    expect(closed.rooms[0]).toMatchObject({ unreadCount: 0, lastSeq: 1 })
    // sent to the room too: in the timeline as well, counting like a message there
    const loud = message({ roomId: r.id, seq: 3, threadRootId: root.id, alsoInRoom: true })
    const both = withMessage(d, r.id, loud, ME.id)
    expect(both.timeline!.messages.map((m) => m.id)).toEqual([root.id, loud.id])
    expect(viewOf(both, r.id, root.id)!.replies.map((m) => m.id)).toEqual([reply.id, loud.id])
    expect(withMessage(data({ rooms: [r] }), r.id, loud, ME.id).rooms[0]).toMatchObject({ unreadCount: 1, lastMessage: { id: loud.id } })
    // my own reply sent to the room: it does not read the room for me (it was written in the thread)
    const unread = room({ unreadCount: 2, lastSeq: 1, lastReadSeq: 0 })
    const mineLoud = message({ roomId: unread.id, seq: 5, author: ME, threadRootId: root.id, alsoInRoom: true })
    expect(withMessage(data({ rooms: [unread] }), unread.id, mineLoud, ME.id).rooms[0]).toMatchObject({ unreadCount: 2, lastReadSeq: 0, lastSeq: 5 })
    // a reply in another thread: neither here nor there
    const elsewhere = withMessage(d, r.id, message({ roomId: r.id, seq: 4, threadRootId: uuidv7() }), ME.id)
    expect(viewOf(elsewhere, r.id, root.id)!.replies).toHaveLength(1)
    expect(elsewhere.timeline!.messages).toHaveLength(1)
  })

  test('a summary and reactions change in place wherever the message shows; null or none takes them away', () => {
    const r = room()
    const root = message({ roomId: r.id, seq: 1 })
    const reply = message({ roomId: r.id, seq: 2, threadRootId: root.id })
    const start = data({ rooms: [r], openRoomId: r.id, timeline: tl(r.id, [root]), threadViews: views({ roomId: r.id, rootId: root.id, root, replies: [reply] }) })
    const summary = { replyCount: 1, lastReplyAt: reply.createdAt, repliers: [BEN], newReplies: true }
    let d = withThreadSummary(start, r.id, root.id, summary)
    expect(d.timeline!.messages[0]!.thread).toEqual(summary)
    expect(viewOf(d, r.id, root.id)!.root!.thread).toEqual(summary)
    d = withThreadSummary(d, r.id, root.id, null)
    expect(d.timeline!.messages[0]).not.toHaveProperty('thread')
    const chips = [{ emoji: '👍' as const, count: 2, mine: true, users: [ME, BEN] }]
    d = withReactions(d, r.id, reply.id, chips)
    expect(viewOf(d, r.id, root.id)!.replies[0]!.reactions).toEqual(chips)
    d = withReactions(d, r.id, reply.id, [])
    expect(viewOf(d, r.id, root.id)!.replies[0]).not.toHaveProperty('reactions')
    // another room: nothing changes
    expect(withReactions(start, room().id, root.id, chips).timeline!.messages[0]).not.toHaveProperty('reactions')
  })

  test('my reaction at once: on adds me (or a new chip), off takes me out (and the chip with the last one)', () => {
    const list = [{ emoji: '👍' as const, count: 1, mine: false, users: [BEN] }]
    expect(toggledReactions(list, '👍', true, ME)).toEqual([{ emoji: '👍', count: 2, mine: true, users: [BEN, ME] }])
    expect(toggledReactions(list, '🎉', true, ME)).toEqual([...list, { emoji: '🎉', count: 1, mine: true, users: [ME] }])
    expect(toggledReactions([{ emoji: '🎉', count: 1, mine: true, users: [ME] }], '🎉', false, ME)).toEqual([])
    expect(toggledReactions([{ emoji: '👍', count: 2, mine: true, users: [BEN, ME] }], '👍', false, ME)).toEqual([{ emoji: '👍', count: 1, mine: false, users: [BEN] }])
    // nothing to change: the same list
    expect(toggledReactions(list, '👍', false, ME)).toEqual(list)
  })

  test("reading the room keeps the '@' of a followed thread's mention: the server says so, an older one leaves it while a thread has news", () => {
    const r = room({ unreadCount: 1, threadsUnread: 1, mentioned: true })
    expect(withReadState(data({ rooms: [r] }), r.id, { lastReadSeq: 5, unreadCount: 0, mentioned: true }).rooms[0]!.mentioned).toBe(true)
    expect(withReadState(data({ rooms: [r] }), r.id, { lastReadSeq: 5, unreadCount: 0, mentioned: false }).rooms[0]!.mentioned).toBe(false)
    expect(withReadState(data({ rooms: [r] }), r.id, { lastReadSeq: 5, unreadCount: 0 }).rooms[0]!.mentioned).toBe(true)
    expect(withReadState(data({ rooms: [{ ...r, threadsUnread: 0 }] }), r.id, { lastReadSeq: 5, unreadCount: 0 }).rooms[0]!.mentioned).toBe(false)
  })

  test('every thread on screen gets the live changes: the page\'s thread and the one beside a file in the viewer', () => {
    const r = room()
    const a = message({ roomId: r.id, seq: 1 })
    const b = message({ roomId: r.id, seq: 2 })
    const aReply = message({ roomId: r.id, seq: 3, threadRootId: a.id })
    const bReply = message({ roomId: r.id, seq: 4, threadRootId: b.id })
    // the page shows a's thread, the viewer b's; the viewer's own copy of a's thread too (the same thread, two panels)
    const start = data({ rooms: [r], openRoomId: r.id, timeline: tl(r.id, [a, b]), threadViews: views({ roomId: r.id, rootId: a.id, root: a, replies: [aReply], holders: 2 }, { roomId: r.id, rootId: b.id, root: b, replies: [bReply] }) })
    // a new reply: in its own thread only
    const late = message({ roomId: r.id, seq: 5, threadRootId: b.id })
    let d = withMessage(start, r.id, late, ME.id)
    expect(viewOf(d, r.id, b.id)!.replies.map((m) => m.id)).toEqual([bReply.id, late.id])
    expect(viewOf(d, r.id, a.id)!.replies.map((m) => m.id)).toEqual([aReply.id])
    expect(viewOf(d, r.id, a.id)).toBe(viewOf(start, r.id, a.id))
    // an edit of a's reply, a delete of b's root: each where it shows
    d = withUpdatedMessage(d, r.id, { ...aReply, body: 'edited', editedAt: at(9) })
    d = withUpdatedMessage(d, r.id, { ...b, body: '', files: [], deletedAt: at(9) })
    expect(viewOf(d, r.id, a.id)!.replies[0]!.body).toBe('edited')
    expect(viewOf(d, r.id, b.id)!.root!.deletedAt).toBe(at(9))
    expect(d.timeline!.messages[1]!.deletedAt).toBe(at(9))
    // a reaction and a summary: in both threads where their message shows
    const chips = [{ emoji: '👀' as const, count: 1, mine: false, users: [BEN] }]
    d = withReactions(d, r.id, bReply.id, chips)
    expect(viewOf(d, r.id, b.id)!.replies[0]!.reactions).toEqual(chips)
    const summary = { replyCount: 2, lastReplyAt: at(5), repliers: [BEN], newReplies: false }
    d = withThreadSummary(d, r.id, a.id, summary)
    expect(viewOf(d, r.id, a.id)!.root!.thread).toEqual(summary)
    expect(d.timeline!.messages[0]!.thread).toEqual(summary)
    // the count of panels is kept through every change
    expect(viewOf(d, r.id, a.id)!.holders).toBe(2)
    // a change in another room leaves every thread as it was
    const elsewhere = withReactions(d, room().id, bReply.id, [])
    expect(elsewhere.threadViews).toBe(d.threadViews)
  })

  test("each thread's box is its own place (drafts, a refused send coming back)", () => {
    expect(placeKey('r1')).toBe('r1')
    expect(placeKey('r1', null)).toBe('r1')
    expect(placeKey('r1', 't1')).toBe('r1/t1')
  })
})

test('an edit or delete replaces the message, the quotes of it and the last line', () => {
  const r = room()
  const m1 = message({ roomId: r.id, seq: 1, body: 'first' })
  const reply = message({ roomId: r.id, seq: 2, author: ME, replyTo: { id: m1.id, author: BEN, excerpt: 'first', fileCount: 0, deleted: false } })
  const start = data({ rooms: [{ ...r, lastMessage: { id: m1.id, seq: 1, author: BEN, excerpt: 'first', fileCount: 0, deleted: false, createdAt: m1.createdAt } }], openRoomId: r.id, timeline: tl(r.id, [m1, reply]), threadViews: views({ roomId: r.id, rootId: m1.id, root: m1, replies: [] }) })
  const d = withUpdatedMessage(start, r.id, { ...m1, body: '', deletedAt: at(5) })
  expect(d.timeline!.messages[0]!.deletedAt).toBe(at(5))
  expect(viewOf(d, r.id, m1.id)!.root!.deletedAt).toBe(at(5))
  expect(d.timeline!.messages[1]!.replyTo).toMatchObject({ id: m1.id, deleted: true, excerpt: '' })
  expect(d.rooms[0]!.lastMessage).toMatchObject({ deleted: true, excerpt: '' })
})

describe('handleEvent', () => {
  const realFetch = globalThis.fetch
  let calls: string[] = []
  let routes: Record<string, unknown> = {}
  beforeEach(() => {
    calls = []
    routes = {}
    useRooms.getState().reset()
    useSession.setState({ status: { kind: 'signed-in', me: { user: { id: ME.id, name: ME.name } } as unknown as Me } })
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://team.localhost').pathname
      calls.push(`${init?.method ?? 'GET'} ${path}`)
      const body = routes[path]
      return body === undefined ? new Response(JSON.stringify({ error: { code: 'not_found', message: 'gone' } }), { status: 404 }) : new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    // later files (in Linux CI's file order) expect no half-made session: this one has no session id
    useSession.setState({ status: { kind: 'loading' } })
    useRooms.getState().reset()
  })
  const tick = () => new Promise((r) => setTimeout(r, 0))

  test("a message from another member raises the badge of a room that is not open; the open room's does not move", () => {
    const a = room({ name: 'acme-a' })
    const b = room({ name: 'acme-b' })
    useRooms.setState({ rooms: [a, b], loaded: true, openRoomId: b.id, timeline: tl(b.id) })
    useRooms.getState().handleEvent({ type: 'room.message', seq: 1, at: Date.now(), data: { roomId: a.id, message: message({ roomId: a.id, seq: 1 }) } })
    useRooms.getState().handleEvent({ type: 'room.message', seq: 2, at: Date.now(), data: { roomId: b.id, message: message({ roomId: b.id, seq: 1 }) } })
    const s = useRooms.getState()
    expect(s.rooms.find((r) => r.id === a.id)!.unreadCount).toBe(1)
    expect(s.rooms.find((r) => r.id === b.id)!.unreadCount).toBe(0)
    expect(s.timeline!.messages).toHaveLength(1)
  })

  test('my own read in another window: my position and badge as the event says, nothing asked', async () => {
    const r = room({ unreadCount: 3, lastSeq: 3 })
    useRooms.setState({ rooms: [r], loaded: true })
    useRooms.getState().handleEvent({ type: 'room.read', seq: 1, at: Date.now(), data: { roomId: r.id, lastReadSeq: 3, unreadCount: 0 } })
    await tick()
    expect(calls).toEqual([])
    expect(useRooms.getState().rooms[0]).toMatchObject({ unreadCount: 0, lastReadSeq: 3 })
  })

  test('a thread: opening reads its root and replies; a summary event and reading it update the root and the room', async () => {
    const r = room({ threadsUnread: 1 })
    const root = message({ roomId: r.id, seq: 1, thread: { replyCount: 1, lastReplyAt: at(2), repliers: [BEN], newReplies: true } })
    const reply = message({ roomId: r.id, seq: 2, threadRootId: root.id })
    useRooms.setState({ rooms: [r], loaded: true, openRoomId: r.id, timeline: tl(r.id, [root]) })
    routes[`/api/rooms/${r.id}/messages/${root.id}/thread`] = { root, items: [reply], nextCursor: null }
    routes[`/api/rooms/${r.id}/messages/${root.id}/thread/read`] = { lastReadSeq: 2, room: { ...r, threadsUnread: 0 } }
    useRooms.getState().openThread(r.id, root.id)
    expect(viewOf(useRooms.getState(), r.id, root.id)).toMatchObject({ rootId: root.id, root: { id: root.id }, loading: true, holders: 1 })
    await tick()
    expect(viewOf(useRooms.getState(), r.id, root.id)!.replies.map((m) => m.id)).toEqual([reply.id])
    await useRooms.getState().markThreadRead(r.id, root.id, 2)
    // asked once per position
    await useRooms.getState().markThreadRead(r.id, root.id, 2)
    expect(calls.filter((c) => c.endsWith('/thread/read'))).toHaveLength(1)
    expect(useRooms.getState().rooms[0]!.threadsUnread).toBe(0)
    expect(useRooms.getState().timeline!.messages[0]!.thread!.newReplies).toBe(false)
    expect(viewOf(useRooms.getState(), r.id, root.id)!.root!.thread!.newReplies).toBe(false)
    useRooms.getState().handleEvent({ type: 'room.thread', seq: 3, at: Date.now(), data: { roomId: r.id, rootId: root.id, thread: { replyCount: 2, lastReplyAt: at(3), repliers: [CY, BEN], newReplies: true } } })
    expect(useRooms.getState().timeline!.messages[0]!.thread).toMatchObject({ replyCount: 2, newReplies: true })
    useRooms.getState().closeThread(r.id, root.id)
    expect(useRooms.getState().threadViews).toEqual({})
  })

  test('a thread open in two panels: closing one keeps it, the last one takes it away; a read still on its way is dropped', async () => {
    const r = room()
    const root = message({ roomId: r.id, seq: 1 })
    const reply = message({ roomId: r.id, seq: 2, threadRootId: root.id })
    useRooms.setState({ rooms: [r], loaded: true, openRoomId: r.id, timeline: tl(r.id, [root]) })
    routes[`/api/rooms/${r.id}/messages/${root.id}/thread`] = { root, items: [reply], nextCursor: null }
    // the page's thread, then the viewer's beside a file of it: read once
    useRooms.getState().openThread(r.id, root.id)
    useRooms.getState().openThread(r.id, root.id)
    await tick()
    expect(calls.filter((c) => c.endsWith('/thread'))).toHaveLength(1)
    expect(viewOf(useRooms.getState(), r.id, root.id)).toMatchObject({ holders: 2, replies: [{ id: reply.id }] })
    // a live reply reaches it while either panel shows it
    useRooms.getState().closeThread(r.id, root.id)
    const live = message({ roomId: r.id, seq: 3, threadRootId: root.id })
    useRooms.getState().handleEvent({ type: 'room.message', seq: 1, at: Date.now(), data: { roomId: r.id, message: live } })
    expect(viewOf(useRooms.getState(), r.id, root.id)).toMatchObject({ holders: 1 })
    expect(viewOf(useRooms.getState(), r.id, root.id)!.replies.map((m) => m.id)).toEqual([reply.id, live.id])
    // the room page leaving does not take away the thread a panel still shows
    useRooms.getState().close(r.id)
    expect(viewOf(useRooms.getState(), r.id, root.id)).toBeDefined()
    useRooms.getState().closeThread(r.id, root.id)
    expect(useRooms.getState().threadViews).toEqual({})
    // opened again and closed before its read came back: the answer finds nothing to fill
    useRooms.getState().openThread(r.id, root.id)
    useRooms.getState().closeThread(r.id, root.id)
    await tick()
    expect(useRooms.getState().threadViews).toEqual({})
  })

  test('a reconnect reads every thread on screen again; a member leaving reads the room\'s threads again', async () => {
    const r = room()
    const a = message({ roomId: r.id, seq: 1 })
    const b = message({ roomId: r.id, seq: 2 })
    useRooms.setState({ rooms: [r], loaded: true, openRoomId: r.id, timeline: tl(r.id, [a, b]), threadViews: views({ roomId: r.id, rootId: a.id, root: a, replies: [] }, { roomId: r.id, rootId: b.id, root: b, replies: [] }) })
    routes['/api/rooms'] = { items: [r] }
    routes[`/api/rooms/${r.id}/messages`] = { items: [a, b], nextCursor: null }
    routes[`/api/rooms/${r.id}/messages/${a.id}/thread`] = { root: a, items: [message({ roomId: r.id, seq: 3, threadRootId: a.id })], nextCursor: null }
    routes[`/api/rooms/${r.id}/messages/${b.id}/thread`] = { root: b, items: [], nextCursor: null }
    await useRooms.getState().resync()
    expect(calls).toContain(`GET /api/rooms/${r.id}/messages/${a.id}/thread`)
    expect(calls).toContain(`GET /api/rooms/${r.id}/messages/${b.id}/thread`)
    expect(viewOf(useRooms.getState(), r.id, a.id)!.replies).toHaveLength(1)
    calls = []
    useRooms.getState().handleEvent({ type: 'room.updated', seq: 1, at: Date.now(), data: { roomId: r.id, change: 'members', room: r } })
    await tick()
    expect(calls.filter((c) => c.endsWith('/thread')).sort()).toEqual([`GET /api/rooms/${r.id}/messages/${a.id}/thread`, `GET /api/rooms/${r.id}/messages/${b.id}/thread`].sort())
  })

  test("the room page's right side: the Trina side chat per room, gone when the page leaves the room", () => {
    const r = room()
    useRooms.setState({ rooms: [r], loaded: true, openRoomId: r.id, timeline: tl(r.id) })
    useRooms.getState().setSide(r.id, 'trina')
    expect(useRooms.getState().side).toEqual({ [r.id]: 'trina' })
    useRooms.getState().setSide(r.id, null)
    expect(useRooms.getState().side).toEqual({})
    useRooms.getState().setSide(r.id, 'trina')
    useRooms.getState().close(r.id)
    expect(useRooms.getState().side).toEqual({})
  })

  test('a reaction shows at once and the server answer wins; refused, it goes back as it was', async () => {
    const r = room()
    const m = message({ roomId: r.id, seq: 1 })
    useRooms.setState({ rooms: [r], loaded: true, openRoomId: r.id, timeline: tl(r.id, [m]) })
    routes[`/api/rooms/${r.id}/messages/${m.id}/reactions`] = { reactions: [{ emoji: '👍', count: 2, mine: true, users: [BEN, ME] }] }
    const p = useRooms.getState().react(r.id, m.id, '👍', true)
    expect(useRooms.getState().timeline!.messages[0]!.reactions).toEqual([{ emoji: '👍', count: 1, mine: true, users: [ME] }])
    await p
    expect(useRooms.getState().timeline!.messages[0]!.reactions![0]).toMatchObject({ count: 2, mine: true })
    delete routes[`/api/rooms/${r.id}/messages/${m.id}/reactions`]
    await useRooms.getState().react(r.id, m.id, '🎉', true)
    expect(useRooms.getState().timeline!.messages[0]!.reactions!.map((x) => x.emoji)).toEqual(['👍'])
    // room.reactions from someone else
    useRooms.getState().handleEvent({ type: 'room.reactions', seq: 2, at: Date.now(), data: { roomId: r.id, messageId: m.id, reactions: [] } })
    expect(useRooms.getState().timeline!.messages[0]).not.toHaveProperty('reactions')
  })

  test('removed: the room leaves the list and the open room closes', () => {
    const went: string[] = []
    setNavigator((to) => went.push(to))
    const r = room()
    useRooms.setState({ rooms: [r], loaded: true, openRoomId: r.id, timeline: tl(r.id), threadViews: views({ roomId: r.id, rootId: uuidv7(), root: null, replies: [] }) })
    useRooms.getState().handleEvent({ type: 'room.updated', seq: 1, at: Date.now(), data: { roomId: r.id, change: 'removed', room: null } })
    const s = useRooms.getState()
    expect(s.rooms).toEqual([])
    expect(s.timeline).toBeNull()
    expect(s.threadViews).toEqual({})
    expect(s.openRoomId).toBeNull()
    expect(went).toEqual(['/rooms'])
    setNavigator(null)
  })

  test('added: a new room appears in its place by activity', () => {
    const old = room({ name: 'acme-old', activityAt: at(-30) })
    useRooms.setState({ rooms: [old], loaded: true })
    const dm = room({ kind: 'dm', name: null, groupId: null, memberCount: 2, peers: [BEN], activityAt: at(0) })
    useRooms.getState().handleEvent({ type: 'room.updated', seq: 1, at: Date.now(), data: { roomId: dm.id, change: 'added', room: dm } })
    expect(useRooms.getState().rooms.map((r) => r.id)).toEqual([dm.id, old.id])
  })

  test('a send the server refuses (the AI still busy) goes back to the message box; a lost connection stays a bubble to retry', async () => {
    const r = room()
    useRooms.setState({ rooms: [r], loaded: true })
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { code: 'conflict', message: 'still answering', params: { reason: 'room_ai_busy' } } }), { status: 409, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    useRooms.getState().send(r.id, { body: '@Trina again', mentions: [BEN.id], files: [] })
    await new Promise((res) => setTimeout(res, 20))
    expect(useRooms.getState().pending[r.id]).toBeUndefined()
    expect(useRooms.getState().returned[r.id]).toMatchObject({ body: '@Trina again', mentions: [BEN.id] })
    useRooms.getState().takeReturned(r.id)
    expect(useRooms.getState().returned[r.id]).toBeUndefined()
    globalThis.fetch = (async () => { throw new TypeError('Failed to fetch') }) as unknown as typeof fetch
    useRooms.getState().send(r.id, { body: 'offline', mentions: [], files: [] })
    await new Promise((res) => setTimeout(res, 20))
    expect(useRooms.getState().pending[r.id]).toMatchObject([{ body: 'offline', state: 'failed' }])
    expect(useRooms.getState().returned[r.id]).toBeUndefined()
    // a thread's refused reply goes back to that thread's box
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { code: 'conflict', message: 'still answering' } }), { status: 409, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    const root = uuidv7()
    useRooms.getState().send(r.id, { body: 'in the thread', mentions: [], files: [], threadRootId: root, alsoInRoom: true })
    await new Promise((res) => setTimeout(res, 20))
    expect(useRooms.getState().returned[placeKey(r.id, root)]).toMatchObject({ body: 'in the thread', threadRootId: root, alsoInRoom: true })
  })

  test('a message for a room this window does not know yet reads that room', async () => {
    useRooms.setState({ rooms: [], loaded: true })
    const r = room({ unreadCount: 1, lastSeq: 1 })
    routes[`/api/rooms/${r.id}`] = r
    useRooms.getState().handleEvent({ type: 'room.message', seq: 1, at: Date.now(), data: { roomId: r.id, message: message({ roomId: r.id, seq: 1 }) } })
    await tick()
    expect(calls).toEqual([`GET /api/rooms/${r.id}`])
    expect(useRooms.getState().rooms[0]).toMatchObject({ id: r.id, unreadCount: 1 })
  })

  test('what I read on my phone or in another window reaches this one: the count, the "@", a followed thread, the 대화 tab total', () => {
    const root = uuidv7()
    const a = room({ name: 'acme-a', unreadCount: 2, mentioned: true, lastSeq: 4, lastReadSeq: 2, threadsUnread: 1, nextThreadId: root })
    const b = room({ name: 'acme-b', unreadCount: 1, lastSeq: 1 })
    useRooms.setState({ rooms: [a, b], loaded: true })
    const get = () => useRooms.getState().rooms.find((r) => r.id === a.id)!
    expect(totalUnread(useRooms.getState().rooms)).toBe(4)
    // the room read there: its messages; the "@" stays while the followed thread that mentions me has news (the server says so)
    useRooms.getState().handleEvent({ type: 'room.read', seq: 1, at: Date.now(), data: { roomId: a.id, lastReadSeq: 4, unreadCount: 0, mentioned: true } })
    expect(get()).toMatchObject({ unreadCount: 0, lastReadSeq: 4, mentioned: true, threadsUnread: 1 })
    expect(roomBadge(get())).toBe('@')
    expect(totalUnread(useRooms.getState().rooms)).toBe(2)
    // then the thread read there: my room as the server sees it now, and the thread's summary
    useRooms.getState().handleEvent({ type: 'room.updated', seq: 2, at: Date.now(), data: { roomId: a.id, change: 'updated', room: { ...get(), threadsUnread: 0, nextThreadId: null, mentioned: false } } })
    useRooms.getState().handleEvent({ type: 'room.thread', seq: 3, at: Date.now(), data: { roomId: a.id, rootId: root, thread: { replyCount: 1, lastReplyAt: at(3), repliers: [BEN], newReplies: false } } })
    expect(get()).toMatchObject({ unreadCount: 0, threadsUnread: 0, mentioned: false })
    expect(roomUnread(get())).toBe(0)
    expect(totalUnread(useRooms.getState().rooms)).toBe(1)
    // the other room is untouched
    expect(useRooms.getState().rooms.find((r) => r.id === b.id)!.unreadCount).toBe(1)
  })

  test('my place is the newest message I can see (others\' private previews are not mine): read to it elsewhere, nothing is left; an older read never moves it back', async () => {
    const r = room({ unreadCount: 1, lastSeq: 5, lastReadSeq: 3 })
    useRooms.setState({ rooms: [r], loaded: true, openRoomId: r.id, timeline: tl(r.id) })
    // (the server holds a read to the newest message the person can see: 5, though the room's own counter is past it)
    useRooms.getState().handleEvent({ type: 'room.read', seq: 1, at: Date.now(), data: { roomId: r.id, lastReadSeq: 5, unreadCount: 0, mentioned: false } })
    useRooms.getState().handleEvent({ type: 'room.read', seq: 2, at: Date.now(), data: { roomId: r.id, lastReadSeq: 4, unreadCount: 0, mentioned: false } })
    expect(useRooms.getState().rooms[0]).toMatchObject({ lastReadSeq: 5, unreadCount: 0 })
    // leaving the room: nothing unread here, so the server is not asked again
    useRooms.getState().close(r.id)
    await tick()
    expect(calls).toEqual([])
  })

  test('back after a lost connection: the rooms come from the server again, and a badge read elsewhere meanwhile goes', async () => {
    const a = room({ name: 'acme-a', unreadCount: 3, mentioned: true, lastSeq: 9, lastReadSeq: 6, threadsUnread: 1 })
    useRooms.setState({ rooms: [a], loaded: true })
    routes['/api/rooms'] = { items: [{ ...a, unreadCount: 0, mentioned: false, lastReadSeq: 9, threadsUnread: 0 }] }
    await useRooms.getState().resync()
    expect(calls).toEqual(['GET /api/rooms'])
    expect(useRooms.getState().rooms[0]).toMatchObject({ unreadCount: 0, mentioned: false, lastReadSeq: 9, threadsUnread: 0 })
    expect(totalUnread(useRooms.getState().rooms)).toBe(0)
  })
})

describe('the AI in a room', () => {
  test('room.ai counts anyone\'s questions; my run shows its steps, a done one goes (its answer is a message), a stopped one stays until closed', () => {
    const r = room()
    const run = { turnId: uuidv7(), roomId: r.id, questionId: uuidv7(), state: 'running' as const, position: 0, steps: [], error: null, createdAt: at(1) }
    const store = useRooms.getState()
    store.reset()
    store.handleEvent({ seq: 1, at: 1, type: 'room.ai', data: { roomId: r.id, answering: 2 } })
    store.handleEvent({ seq: 2, at: 1, type: 'room.ai.run', data: { roomId: r.id, run } })
    store.handleEvent({ seq: 3, at: 1, type: 'room.ai.step', data: { roomId: r.id, turnId: run.turnId, step: { id: 's1', kind: 'tool', label: 'Read · acme/notes.md', status: 'running', startedAt: at(1), endedAt: null } } })
    expect(useRooms.getState().ai[r.id]).toMatchObject({ answering: 2, runs: [{ turnId: run.turnId, steps: [{ id: 's1' }] }] })
    // a step of a run that is not mine is ignored (nobody else's steps ever come; this one is unknown)
    store.handleEvent({ seq: 3, at: 1, type: 'room.ai.step', data: { roomId: r.id, turnId: uuidv7(), step: { id: 's2', kind: 'tool', label: 'x', status: 'ok', startedAt: at(1), endedAt: at(1) } } })
    expect(useRooms.getState().ai[r.id]!.runs).toHaveLength(1)
    expect(withAiRun(useRooms.getState().ai, r.id, { ...run, state: 'done' })[r.id]!.runs).toEqual([])
    store.handleEvent({ seq: 2, at: 1, type: 'room.ai.run', data: { roomId: r.id, run: { ...run, state: 'stopped' } } })
    expect(useRooms.getState().ai[r.id]!.runs[0]).toMatchObject({ state: 'stopped', steps: [{ id: 's1' }] })
    store.dismissAi(r.id, run.turnId)
    expect(useRooms.getState().ai[r.id]!.runs).toEqual([])
    store.reset()
  })

  test("someone else's answer that stayed private: the question says so, and stops saying so once it is posted", () => {
    const r = room()
    const q = message({ roomId: r.id, seq: 1, author: BEN, body: '@Trina budget?' })
    useRooms.setState({ rooms: [r], timeline: tl(r.id, [q]) })
    const store = useRooms.getState()
    store.handleEvent({ seq: 1, at: 1, type: 'room.ai', data: { roomId: r.id, answering: 1 } })
    // the answer stayed Ben's: the server sends the question again, marked (a reload lists it marked too)
    store.handleEvent({ seq: 2, at: 1, type: 'room.message.updated', data: { roomId: r.id, message: { ...q, answeredPrivately: true } } })
    store.handleEvent({ seq: 3, at: 1, type: 'room.ai', data: { roomId: r.id, answering: 0 } })
    expect(useRooms.getState().timeline!.messages[0]).toMatchObject({ id: q.id, answeredPrivately: true })
    expect(useRooms.getState().ai[r.id]).toEqual({ answering: 0, runs: [] })
    // Ben posts it: the answer comes to the room and the question loses the mark
    const posted = message({ roomId: r.id, seq: 3, authorKind: 'ai', author: null, askedBy: BEN, body: 'it is 30', replyTo: { id: q.id, author: BEN, excerpt: q.body, fileCount: 0, deleted: false } })
    store.handleEvent({ seq: 4, at: 1, type: 'room.message', data: { roomId: r.id, message: posted } })
    store.handleEvent({ seq: 5, at: 1, type: 'room.message.updated', data: { roomId: r.id, message: q } })
    expect(useRooms.getState().timeline!.messages.map((m) => [m.id, !!m.answeredPrivately])).toEqual([[q.id, false], [posted.id, false]])
    store.reset()
  })
})

describe('an event line (a rename, people invited, someone left)', () => {
  test('takes its place in the open room but counts nowhere: no unread, no last line, no move to the top', () => {
    const r = room({ lastSeq: 4, activityAt: at(-30), lastMessage: null })
    const other = room({ activityAt: at(-10) })
    const line = message({ roomId: r.id, seq: 5, body: '', author: BEN, event: { type: 'renamed', name: 'Plan' } })
    let d = withMessage(data({ rooms: [other, r] }), r.id, line, ME.id)
    expect(d.rooms.map((x) => x.id)).toEqual([other.id, r.id])
    expect(d.rooms[1]).toMatchObject({ unreadCount: 0, lastMessage: null, lastSeq: 5, activityAt: at(-30) })
    d = withMessage(data({ rooms: [r], openRoomId: r.id, timeline: tl(r.id) }), r.id, line, ME.id)
    expect(d.timeline!.messages.map((m) => m.id)).toEqual([line.id])
  })
})

describe('a page read while messages come in', () => {
  // a fake server that holds its answer to a page read until the test lets it go; a send answers at once
  const realFetch = globalThis.fetch
  let held: { path: string; release: (body: unknown) => void }[] = []
  let sent: unknown = null
  beforeEach(() => {
    held = []
    sent = null
    useRooms.getState().reset()
    useSession.setState({ status: { kind: 'signed-in', me: { user: { id: ME.id, name: ME.name } } as unknown as Me } })
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://team.localhost').pathname
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
      if (init?.method === 'POST' && path.endsWith('/messages') && sent) return json(sent, 201)
      if ((init?.method ?? 'GET') === 'GET' && (path.endsWith('/messages') || path.endsWith('/thread'))) return new Promise<Response>((res) => held.push({ path, release: (body) => res(json(body)) }))
      return json({ error: { code: 'not_found', message: 'gone' } }, 404)
    }) as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    useSession.setState({ status: { kind: 'loading' } })
    useRooms.getState().reset()
  })
  const tick = () => new Promise((r) => setTimeout(r, 0))
  const seqs = () => useRooms.getState().timeline!.messages.map((m) => m.seq)

  test('a message that arrives while the newest page loads (a room opened from a notification) is still there after', async () => {
    const r = room({ lastSeq: 2 })
    const m1 = message({ roomId: r.id, seq: 1 })
    const m2 = message({ roomId: r.id, seq: 2 })
    const live = message({ roomId: r.id, seq: 3, body: 'just now' })
    useRooms.setState({ rooms: [r], loaded: true, openRoomId: r.id, timeline: { ...tl(r.id), loading: true } })
    const loading = useRooms.getState().loadNewest(r.id)
    await tick()
    expect(held).toHaveLength(1)
    useRooms.getState().handleEvent({ type: 'room.message', seq: 1, at: Date.now(), data: { roomId: r.id, message: live } })
    // the server read its page before the message came
    held[0]!.release({ items: [m1, m2], nextCursor: null })
    await loading
    expect(seqs()).toEqual([1, 2, 3])
    expect(useRooms.getState().timeline!.loading).toBe(false)
  })

  test('my message sent from a search result (a window around an older one) survives the jump back to the newest', async () => {
    const r = room({ lastSeq: 80 })
    const old = message({ roomId: r.id, seq: 5 })
    const newest = message({ roomId: r.id, seq: 80 })
    const mine = message({ roomId: r.id, seq: 81, author: ME, body: 'my answer' })
    sent = mine
    useRooms.setState({ rooms: [r], loaded: true, openRoomId: r.id, timeline: { ...tl(r.id, [old]), newerCursor: 'newer' } })
    useRooms.getState().send(r.id, { body: 'my answer', mentions: [], files: [] })
    await tick()
    await tick()
    // the server took it (no bubble left), while the newest page is still on its way and was read before it
    expect(useRooms.getState().pending[r.id]).toBeUndefined()
    expect(held).toHaveLength(1)
    held[0]!.release({ items: [newest], nextCursor: 'older' })
    await tick()
    await tick()
    const t = useRooms.getState().timeline!
    expect(t.messages.map((m) => m.id)).toEqual([newest.id, mine.id])
    expect(t.newerCursor ?? null).toBeNull()
  })

  // how far the page would read it with every message in sight (pages/Room.tsx tryRead)
  const readNow = (roomId: string) => readUpTo(useRooms.getState().timeline!, useRooms.getState().rooms.find((x) => x.id === roomId)!.lastReadSeq, () => true)

  test('opened from a notification with the first page slow: a live message alone on screen reads nothing (QA TC-155)', async () => {
    const r = room({ lastSeq: 30, lastReadSeq: 0, unreadCount: 30 })
    const backlog = Array.from({ length: 30 }, (_, i) => message({ roomId: r.id, seq: i + 1 }))
    useRooms.setState({ rooms: [r], loaded: true })
    useRooms.getState().open(r.id)
    await tick()
    useRooms.getState().handleEvent({ type: 'room.message', seq: 1, at: Date.now(), data: { roomId: r.id, message: message({ roomId: r.id, seq: 31, body: 'live-001' }) } })
    expect(seqs()).toEqual([31])
    expect(readNow(r.id)).toBe(0)
    held.find((h) => h.path.endsWith('/messages'))!.release({ items: backlog, nextCursor: null })
    await tick()
    await tick()
    expect(readNow(r.id)).toBe(31)
  })

  test('more unread than one page: the newest page reads nothing until the older one is loaded (QA TC-155)', async () => {
    const r = room({ lastSeq: 62, lastReadSeq: 0, unreadCount: 62 })
    const all = Array.from({ length: 62 }, (_, i) => message({ roomId: r.id, seq: i + 1 }))
    useRooms.setState({ rooms: [r], loaded: true })
    useRooms.getState().open(r.id)
    await tick()
    held.find((h) => h.path.endsWith('/messages'))!.release({ items: all.slice(12), nextCursor: 'older' })
    await tick()
    await tick()
    expect(seqs()).toHaveLength(50)
    expect(readNow(r.id)).toBe(0)
    const older = useRooms.getState().loadOlder(r.id)
    await tick()
    held.find((h) => h.path.endsWith('/messages') && h !== held[0])!.release({ items: all.slice(0, 12), nextCursor: null })
    await older
    expect(readNow(r.id)).toBe(62)
  })

  test('an edit made while a page loads shows on that page', async () => {
    const r = room({ lastSeq: 1 })
    const m1 = message({ roomId: r.id, seq: 1, body: 'first' })
    useRooms.setState({ rooms: [r], loaded: true, openRoomId: r.id, timeline: tl(r.id, [m1]) })
    const loading = useRooms.getState().loadNewest(r.id)
    await tick()
    useRooms.getState().handleEvent({ type: 'room.message.updated', seq: 1, at: Date.now(), data: { roomId: r.id, message: { ...m1, body: 'fixed', editedAt: at(1) } } })
    held[0]!.release({ items: [m1], nextCursor: null })
    await loading
    expect(useRooms.getState().timeline!.messages[0]!.body).toBe('fixed')
  })

  test('a window around an older message: an edit meanwhile shows, a new message waits for the newer pages', async () => {
    const r = room({ lastSeq: 80 })
    const old = message({ roomId: r.id, seq: 5, body: 'old' })
    const newest = message({ roomId: r.id, seq: 80 })
    useRooms.setState({ rooms: [r], loaded: true, openRoomId: r.id, timeline: tl(r.id, [newest]) })
    const loading = useRooms.getState().loadAround(r.id, old.id)
    await tick()
    useRooms.getState().handleEvent({ type: 'room.message.updated', seq: 1, at: Date.now(), data: { roomId: r.id, message: { ...old, body: 'old, fixed', editedAt: at(1) } } })
    useRooms.getState().handleEvent({ type: 'room.message', seq: 2, at: Date.now(), data: { roomId: r.id, message: message({ roomId: r.id, seq: 81 }) } })
    held[0]!.release({ items: [old], nextCursor: null, newerCursor: 'newer' })
    await loading
    const t = useRooms.getState().timeline!
    expect(t.messages.map((m) => m.body)).toEqual(['old, fixed'])
    expect(t.newerCursor).toBe('newer')
  })

  test('someone joining or leaving refreshes the newest page in place: older pages and live messages stay', async () => {
    const r = room({ lastSeq: 3 })
    const m1 = message({ roomId: r.id, seq: 1 })
    const m2 = message({ roomId: r.id, seq: 2 })
    const m3 = message({ roomId: r.id, seq: 3, reactions: [{ emoji: '👍', count: 1, mine: false, users: [CY] }] })
    useRooms.setState({ rooms: [r], loaded: true, openRoomId: r.id, timeline: { ...tl(r.id, [m1, m2, m3]), nextCursor: 'older' } })
    useRooms.getState().handleEvent({ type: 'room.updated', seq: 1, at: Date.now(), data: { roomId: r.id, change: 'members', room: { ...r, memberCount: 2 } } })
    await tick()
    expect(useRooms.getState().timeline!.loading).toBe(false)
    const live = message({ roomId: r.id, seq: 4 })
    useRooms.getState().handleEvent({ type: 'room.message', seq: 2, at: Date.now(), data: { roomId: r.id, message: live } })
    // the newest page as the server has it now: one message (its reactions gone with the person who left)
    const { reactions: _gone, ...m3now } = m3
    held.find((h) => h.path.endsWith('/messages'))!.release({ items: [m2, m3now], nextCursor: 'mid' })
    await tick()
    await tick()
    const t = useRooms.getState().timeline!
    expect(t.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4])
    expect(t.messages[2]!.reactions).toBeUndefined()
    expect(t.nextCursor).toBe('older')
  })

  test('a reply that arrives while its thread loads is still there after', async () => {
    const r = room()
    const root = message({ roomId: r.id, seq: 1 })
    const reply = message({ roomId: r.id, seq: 2, threadRootId: root.id })
    const live = message({ roomId: r.id, seq: 3, threadRootId: root.id })
    useRooms.setState({ rooms: [r], loaded: true, openRoomId: r.id, timeline: tl(r.id, [root]) })
    useRooms.getState().openThread(r.id, root.id)
    await tick()
    useRooms.getState().handleEvent({ type: 'room.message', seq: 1, at: Date.now(), data: { roomId: r.id, message: live } })
    held.find((h) => h.path.endsWith('/thread'))!.release({ root, items: [reply], nextCursor: null })
    await tick()
    await tick()
    expect(viewOf(useRooms.getState(), r.id, root.id)!.replies.map((m) => m.seq)).toEqual([2, 3])
  })
})
