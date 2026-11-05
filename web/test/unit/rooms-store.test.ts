// The rooms store (store/rooms.ts): the pure state changes for the room.* events, and handleEvent against a fake REST
// server where an event needs one (my own read elsewhere recounts the room; leaving a room closes it).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { uuidv7, type Me } from '@mycel/shared/api'
import { setNavigator } from '../../src/lib/nav'
import { decrementUnread, mergeMessages, withAiRun, withMessage, withRead, withUpdatedMessage, useRooms, type RoomsData } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import { at, BEN, ME, message, room } from './rooms-fixtures'

const data = (o: Partial<RoomsData> = {}): RoomsData => ({ rooms: [], openRoomId: null, thread: null, ...o })

describe('a new message', () => {
  test('is added to the open room once, by id, in room order', () => {
    const r = room()
    const m1 = message({ roomId: r.id, seq: 1 })
    const m2 = message({ roomId: r.id, seq: 2 })
    let d = data({ rooms: [r], openRoomId: r.id, thread: { roomId: r.id, messages: [m1], nextCursor: null, loading: false, error: null } })
    d = withMessage(d, r.id, m2, ME.id)
    d = withMessage(d, r.id, m2, ME.id) // the same event again (a replay, or my send's own answer)
    expect(d.thread!.messages.map((m) => m.seq)).toEqual([1, 2])
    expect(mergeMessages([m2], [m1]).map((m) => m.seq)).toEqual([1, 2])
  })

  test('keeps the lower unread count: the answer to my send can come after a read of it', () => {
    const r = room()
    const sent = message({ roomId: r.id, seq: 3, unread: 1 })
    let d = data({ rooms: [r], openRoomId: r.id, thread: { roomId: r.id, messages: [], nextCursor: null, loading: false, error: null } })
    d = withMessage(d, r.id, sent, ME.id) // the room.message event
    d = withRead(d, r.id, 2, 3) // the other member read it
    d = withMessage(d, r.id, sent, ME.id) // then the POST answer, made before that read
    expect(d.thread!.messages[0]!.unread).toBe(0)
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

  test('mentioning me marks the room "mentioned"; a deleted or private message counts nothing', () => {
    const r = room()
    const d = withMessage(data({ rooms: [r] }), r.id, message({ roomId: r.id, seq: 1, mentions: [ME.id] }), ME.id)
    expect(d.rooms[0]).toMatchObject({ unreadCount: 1, mentioned: true })
    const priv = withMessage(data({ rooms: [r] }), r.id, message({ roomId: r.id, seq: 1, visibility: 'private' }), ME.id)
    expect(priv.rooms[0]!.unreadCount).toBe(0)
  })

  test('the badge stops at 999 like the server', () => {
    const r = room({ unreadCount: 999, lastSeq: 999 })
    const d = withMessage(data({ rooms: [r] }), r.id, message({ roomId: r.id, seq: 1000 }), ME.id)
    expect(d.rooms[0]!.unreadCount).toBe(999)
  })
})

describe('room.read', () => {
  test('each message in fromSeq < seq <= toSeq has one unread fewer, never below 0', () => {
    const r = room()
    const ms = [1, 2, 3, 4].map((seq) => message({ roomId: r.id, seq, unread: seq === 3 ? 0 : 2 }))
    const d = withRead(data({ rooms: [r], openRoomId: r.id, thread: { roomId: r.id, messages: ms, nextCursor: null, loading: false, error: null } }), r.id, 1, 3)
    expect(d.thread!.messages.map((m) => m.unread)).toEqual([2, 1, 0, 2])
  })

  test('another room, or nothing in range: the state stays the same object', () => {
    const r = room()
    const ms = [message({ roomId: r.id, seq: 1, unread: 1 })]
    expect(decrementUnread(ms, 5, 9)).toBe(ms)
    const d = data({ rooms: [r], openRoomId: r.id, thread: { roomId: r.id, messages: ms, nextCursor: null, loading: false, error: null } })
    expect(withRead(d, room().id, 0, 9)).toBe(d)
  })
})

test('an edit or delete replaces the message, the quotes of it and the last line', () => {
  const r = room()
  const m1 = message({ roomId: r.id, seq: 1, body: 'first' })
  const reply = message({ roomId: r.id, seq: 2, author: ME, replyTo: { id: m1.id, author: BEN, excerpt: 'first', fileCount: 0, deleted: false } })
  const start = data({ rooms: [{ ...r, lastMessage: { id: m1.id, seq: 1, author: BEN, excerpt: 'first', fileCount: 0, deleted: false, createdAt: m1.createdAt } }], openRoomId: r.id, thread: { roomId: r.id, messages: [m1, reply], nextCursor: null, loading: false, error: null } })
  const d = withUpdatedMessage(start, r.id, { ...m1, body: '', deletedAt: at(5) })
  expect(d.thread!.messages[0]!.deletedAt).toBe(at(5))
  expect(d.thread!.messages[1]!.replyTo).toMatchObject({ id: m1.id, deleted: true, excerpt: '' })
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
  })
  const tick = () => new Promise((r) => setTimeout(r, 0))

  test("a message from another member raises the badge of a room that is not open; the open room's does not move", () => {
    const a = room({ name: 'acme-a' })
    const b = room({ name: 'acme-b' })
    useRooms.setState({ rooms: [a, b], loaded: true, openRoomId: b.id, thread: { roomId: b.id, messages: [], nextCursor: null, loading: false, error: null } })
    useRooms.getState().handleEvent({ type: 'room.message', seq: 1, at: Date.now(), data: { roomId: a.id, message: message({ roomId: a.id, seq: 1 }) } })
    useRooms.getState().handleEvent({ type: 'room.message', seq: 2, at: Date.now(), data: { roomId: b.id, message: message({ roomId: b.id, seq: 1 }) } })
    const s = useRooms.getState()
    expect(s.rooms.find((r) => r.id === a.id)!.unreadCount).toBe(1)
    expect(s.rooms.find((r) => r.id === b.id)!.unreadCount).toBe(0)
    expect(s.thread!.messages).toHaveLength(1)
  })

  test('my own read in another window recounts the room from the server', async () => {
    const r = room({ unreadCount: 3, lastSeq: 3 })
    useRooms.setState({ rooms: [r], loaded: true })
    routes[`/api/rooms/${r.id}`] = { ...r, unreadCount: 0, lastReadSeq: 3 }
    useRooms.getState().handleEvent({ type: 'room.read', seq: 1, at: Date.now(), data: { roomId: r.id, fromSeq: 0, toSeq: 3, mine: true } })
    await tick()
    expect(calls).toEqual([`GET /api/rooms/${r.id}`])
    expect(useRooms.getState().rooms[0]).toMatchObject({ unreadCount: 0, lastReadSeq: 3 })
  })

  test("another member's read asks nothing", async () => {
    const r = room()
    useRooms.setState({ rooms: [r], loaded: true })
    useRooms.getState().handleEvent({ type: 'room.read', seq: 1, at: Date.now(), data: { roomId: r.id, fromSeq: 0, toSeq: 3, mine: false } })
    await tick()
    expect(calls).toEqual([])
  })

  test('removed: the room leaves the list and the open room closes', () => {
    const went: string[] = []
    setNavigator((to) => went.push(to))
    const r = room()
    useRooms.setState({ rooms: [r], loaded: true, openRoomId: r.id, thread: { roomId: r.id, messages: [], nextCursor: null, loading: false, error: null } })
    useRooms.getState().handleEvent({ type: 'room.updated', seq: 1, at: Date.now(), data: { roomId: r.id, change: 'removed', room: null } })
    const s = useRooms.getState()
    expect(s.rooms).toEqual([])
    expect(s.thread).toBeNull()
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
    useRooms.getState().send(r.id, { body: '@Trina again', mentions: [BEN.id], replyTo: null, files: [] })
    await new Promise((res) => setTimeout(res, 20))
    expect(useRooms.getState().pending[r.id]).toBeUndefined()
    expect(useRooms.getState().returned[r.id]).toMatchObject({ body: '@Trina again', mentions: [BEN.id] })
    useRooms.getState().takeReturned(r.id)
    expect(useRooms.getState().returned[r.id]).toBeUndefined()
    globalThis.fetch = (async () => { throw new TypeError('Failed to fetch') }) as unknown as typeof fetch
    useRooms.getState().send(r.id, { body: 'offline', mentions: [], replyTo: null, files: [] })
    await new Promise((res) => setTimeout(res, 20))
    expect(useRooms.getState().pending[r.id]).toMatchObject([{ body: 'offline', state: 'failed' }])
    expect(useRooms.getState().returned[r.id]).toBeUndefined()
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

  test("someone else's answer that stayed private: one line per question, gone once it is posted", () => {
    const r = room()
    const q = message({ roomId: r.id, seq: 1, author: BEN, body: '@Trina budget?' })
    const store = useRooms.getState()
    store.reset()
    store.handleEvent({ seq: 1, at: 1, type: 'room.ai', data: { roomId: r.id, answering: 1 } })
    store.handleEvent({ seq: 2, at: 1, type: 'room.ai', data: { roomId: r.id, answering: 0, privateAnswer: { questionId: q.id, askedBy: BEN } } })
    store.handleEvent({ seq: 3, at: 1, type: 'room.ai', data: { roomId: r.id, answering: 0, privateAnswer: { questionId: q.id, askedBy: BEN } } })
    expect(useRooms.getState().ai[r.id]).toMatchObject({ answering: 0, privates: [{ questionId: q.id, askedBy: BEN }] })
    // a later count keeps it
    store.handleEvent({ seq: 4, at: 1, type: 'room.ai', data: { roomId: r.id, answering: 1 } })
    expect(useRooms.getState().ai[r.id]!.privates).toHaveLength(1)
    // Ben posts it: the answer comes to the room as a reply to the question, and the line goes
    const posted = message({ roomId: r.id, seq: 3, authorKind: 'ai', author: null, askedBy: BEN, body: 'it is 30', replyTo: { id: q.id, author: BEN, excerpt: q.body, fileCount: 0, deleted: false } })
    store.handleEvent({ seq: 5, at: 1, type: 'room.message', data: { roomId: r.id, message: posted } })
    expect(useRooms.getState().ai[r.id]!.privates).toEqual([])
    store.reset()
  })
})
