// Rooms left a moment ago open at once (docs/DECISIONS.md "Rooms left a moment ago open at once", QA TC-401): the
// rooms store keeps the timeline of the last rooms left, current by the room events; going back shows it and reads only
// what came after its newest message (the server's newer cursor). It goes when it may be incomplete or no longer mine.
// And where the reader was in an AI chat (store/chats.ts chatPlaces).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { type Me } from '@mycel/shared/api'
import { setNavigator } from '../../src/lib/nav'
import { capped, KEPT_MESSAGES, KEPT_ROOMS, keptPlace, withKept, withMessage, withReactions, withThreadSummary, withUpdatedMessage, withoutRoom, useRooms, type KeptTimeline, type RoomsData } from '../../src/store/rooms'
import { CHAT_PLACES, chatEnd, chatPlace, keepChatPlace, useChats } from '../../src/store/chats'
import { useSession } from '../../src/store/session'
import { useUi } from '../../src/store/ui'
import { noteHeard } from '../../src/lib/realtime'
import { listPlace, restorePlace } from '../../src/lib/stickToBottom'
import { BEN, ME, message, room } from './rooms-fixtures'

/** the position a timeline cursor of the server's starts from (base64url JSON: {n} newer, {s} older) */
const cursorAt = (c: string | null | undefined) => (c ? (JSON.parse(atob(c.replace(/-/g, '+').replace(/_/g, '/'))) as { n?: string; s?: string }) : null)
const kept = (roomId: string, messages: ReturnType<typeof message>[], o: Partial<KeptTimeline> = {}): KeptTimeline => ({ roomId, messages, nextCursor: null, loading: false, error: null, place: null, leftAt: Date.now(), leftSeq: messages.at(-1)?.seq ?? 0, ...o })
const data = (o: Partial<RoomsData> = {}): RoomsData => ({ rooms: [], openRoomId: null, timeline: null, threadViews: {}, kept: {}, ...o })

describe('a kept room stays current by the events', () => {
  test('a new message is added once, and still counts as unread (the room is not on screen)', () => {
    const r = room({ lastSeq: 2 })
    const m1 = message({ roomId: r.id, seq: 1 }), m2 = message({ roomId: r.id, seq: 2 })
    const m3 = message({ roomId: r.id, seq: 3, body: 'while away' })
    let d = data({ rooms: [r], kept: { [r.id]: kept(r.id, [m1, m2]) } })
    d = withMessage(d, r.id, m3, ME.id)
    d = withMessage(d, r.id, m3, ME.id)
    expect(d.kept![r.id]!.messages.map((m) => m.seq)).toEqual([1, 2, 3])
    expect(d.rooms[0]!.unreadCount).toBe(1)
    // a reply that stays in its thread is not in the timeline
    d = withMessage(d, r.id, message({ roomId: r.id, seq: 4, threadRootId: m1.id }), ME.id)
    expect(d.kept![r.id]!.messages).toHaveLength(3)
  })

  test('an edit, a delete, reactions and a thread count change it in place; other rooms untouched', () => {
    const r = room(), other = room()
    const m1 = message({ roomId: r.id, seq: 1, body: 'first' }), m2 = message({ roomId: r.id, seq: 2, body: 'second' })
    const o1 = message({ roomId: other.id, seq: 1 })
    let d = data({ rooms: [r, other], kept: { [r.id]: kept(r.id, [m1, m2]), [other.id]: kept(other.id, [o1]) } })
    const otherKept = d.kept![other.id]
    d = withUpdatedMessage(d, r.id, { ...m1, body: 'first, edited', editedAt: m1.createdAt })
    d = withUpdatedMessage(d, r.id, { ...m2, body: '', deletedAt: m2.createdAt })
    d = withReactions(d, r.id, m1.id, [{ emoji: '👍', count: 1, mine: false, users: [BEN] }])
    d = withThreadSummary(d, r.id, m1.id, { replyCount: 2, lastReplyAt: m1.createdAt, repliers: [BEN] } as never)
    const [a, b] = d.kept![r.id]!.messages
    expect(a).toMatchObject({ body: 'first, edited', reactions: [{ emoji: '👍', count: 1 }], thread: { replyCount: 2 } })
    expect(b).toMatchObject({ body: '', deletedAt: m2.createdAt })
    expect(d.kept![other.id]).toBe(otherKept)
  })

  test('a room I am no longer in takes its kept messages with it', () => {
    const r = room()
    const d = withoutRoom(data({ rooms: [r], kept: { [r.id]: kept(r.id, [message({ roomId: r.id, seq: 1 })]) } }), r.id)
    expect(d.kept).toEqual({})
  })

  test('bounded: the newest KEPT_MESSAGES of a room (older from the oldest kept), the last KEPT_ROOMS rooms', () => {
    const r = room()
    const many = Array.from({ length: KEPT_MESSAGES + 30 }, (_, i) => message({ roomId: r.id, seq: i + 1 }))
    const cut = capped(kept(r.id, many))
    expect(cut.messages).toHaveLength(KEPT_MESSAGES)
    expect(cut.messages[0]!.seq).toBe(31)
    expect(cursorAt(cut.nextCursor)).toEqual({ s: '31' })
    // events keep it bounded too
    const d = withMessage(data({ rooms: [r], kept: { [r.id]: cut } }), r.id, message({ roomId: r.id, seq: KEPT_MESSAGES + 31 }), ME.id)
    expect(d.kept![r.id]!.messages).toHaveLength(KEPT_MESSAGES)
    let all: Record<string, KeptTimeline> = {}
    const rooms = Array.from({ length: KEPT_ROOMS + 2 }, () => room())
    rooms.forEach((x, i) => { all = withKept(all, kept(x.id, [message({ roomId: x.id, seq: 1 })], { leftAt: 1000 + i })) })
    expect(Object.keys(all)).toHaveLength(KEPT_ROOMS)
    // the two left first went
    expect(all[rooms[0]!.id]).toBeUndefined()
    expect(all[rooms[1]!.id]).toBeUndefined()
    expect(all[rooms.at(-1)!.id]).toBeDefined()
  })
})

describe('leaving and going back', () => {
  const realFetch = globalThis.fetch
  let calls: { method: string; path: string; cursor: string | null }[] = []
  /** the server's messages per room, and what it answers otherwise */
  let server: Record<string, ReturnType<typeof message>[]> = {}
  let refuse: number | null = null
  let held: ((ok: boolean) => void)[] = []
  let hold = false
  beforeEach(() => {
    calls = []
    server = {}
    refuse = null
    held = []
    hold = false
    useRooms.getState().reset()
    // the live connection is up (going back to a kept room shows it only then)
    useUi.setState({ conn: 'open' })
    noteHeard()
    setNavigator(() => {})
    useSession.setState({ status: { kind: 'signed-in', me: { user: { id: ME.id, name: ME.name } } as unknown as Me } })
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://team.localhost')
      const method = init?.method ?? 'GET'
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
      calls.push({ method, path: url.pathname, cursor: url.searchParams.get('cursor') })
      const m = /^\/api\/rooms\/([^/]+)\/messages$/.exec(url.pathname)
      if (method === 'GET' && m) {
        if (hold) await new Promise<boolean>((res) => held.push(res))
        if (refuse) return json({ error: { code: refuse === 403 ? 'forbidden' : 'not_found', message: 'no' } }, refuse)
        const all = server[m[1]!] ?? []
        const limit = Number(url.searchParams.get('limit') ?? 50)
        const c = cursorAt(url.searchParams.get('cursor'))
        if (c?.n) {
          const after = all.filter((x) => x.seq > Number(c.n))
          return json({ items: after.slice(0, limit), nextCursor: null, ...(after.length > limit ? { newerCursor: 'more' } : {}) })
        }
        return json({ items: all.slice(-limit), nextCursor: all.length > limit ? 'older' : null })
      }
      if (method === 'GET' && url.pathname === '/api/rooms') {
        if (hold) await new Promise<boolean>((res) => held.push(res))
        return json({ items: useRooms.getState().rooms })
      }
      if (url.pathname.endsWith('/ai')) return json({ answering: 0, mine: [] })
      if (url.pathname.endsWith('/ai/requests')) return json({ items: [] })
      if (url.pathname.endsWith('/members')) return json({ items: [] })
      return json({ error: { code: 'not_found', message: 'gone' } }, 404)
    }) as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    useSession.setState({ status: { kind: 'loading' } })
    useUi.setState({ conn: 'idle' })
    useRooms.getState().reset()
  })
  const tick = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)) }
  const reads = (roomId: string) => calls.filter((c) => c.method === 'GET' && c.path === `/api/rooms/${roomId}/messages`)
  const seqs = () => useRooms.getState().timeline!.messages.map((m) => m.seq)

  /** room A opened and read, then left for room B: A is kept */
  async function leftA(n = 60) {
    const a = room({ name: 'acme-a', lastSeq: n, lastReadSeq: n }), b = room({ name: 'acme-b' })
    server[a.id] = Array.from({ length: n }, (_, i) => message({ roomId: a.id, seq: i + 1, body: `a-${i + 1}` }))
    server[b.id] = [message({ roomId: b.id, seq: 1 })]
    useRooms.setState({ rooms: [a, b], loaded: true })
    useRooms.getState().open(a.id)
    await tick()
    useRooms.getState().close(a.id, { messageId: server[a.id]![20]!.id, offset: 12 })
    useRooms.getState().open(b.id)
    await tick()
    calls = []
    return { a, b }
  }

  test('going back shows the kept messages at once and asks only for what came after the newest; a message sent while away shows once', async () => {
    const { a, b } = await leftA()
    expect(useRooms.getState().kept[a.id]).toMatchObject({ place: { offset: 12 } })
    expect(useRooms.getState().kept[a.id]!.messages).toHaveLength(50)
    // someone writes in A while I am in B: the event lands in the kept timeline, and the server has it too
    const live = message({ roomId: a.id, seq: 61, body: 'while away' })
    server[a.id]!.push(live)
    useRooms.getState().handleEvent({ type: 'room.message', seq: 1, at: Date.now(), data: { roomId: a.id, message: live } })
    useRooms.getState().close(b.id, null)
    useRooms.getState().open(a.id)
    // on screen before any answer: not loading, the message there
    expect(useRooms.getState().timeline).toMatchObject({ roomId: a.id, loading: false, error: null })
    expect(seqs().at(-1)).toBe(61)
    await tick()
    // one read, from after the newest kept message (not the newest page again)
    expect(reads(a.id).map((c) => cursorAt(c.cursor))).toEqual([{ n: '61' }])
    expect(seqs().filter((s) => s === 61)).toHaveLength(1)
    expect(seqs()).toHaveLength(51)
    // it left the kept rooms while on screen
    expect(useRooms.getState().kept[a.id]).toBeUndefined()
  })

  test('a message the events did not bring comes with the read after, once; an edit made during that read stays', async () => {
    const { a, b } = await leftA()
    const missed = message({ roomId: a.id, seq: 61, body: 'missed' })
    server[a.id]!.push(missed)
    useRooms.getState().close(b.id, null)
    hold = true
    useRooms.getState().open(a.id)
    await tick()
    // an edit of a kept message arrives while the read is on its way; the server's page has the old copy of it
    const sixty = server[a.id]![59]!
    useRooms.getState().handleEvent({ type: 'room.message.updated', seq: 2, at: Date.now(), data: { roomId: a.id, message: { ...sixty, body: 'edited', editedAt: sixty.createdAt } } })
    held.forEach((r) => r(true))
    await tick()
    expect(seqs().slice(-2)).toEqual([60, 61])
    expect(useRooms.getState().timeline!.messages.find((m) => m.seq === 60)!.body).toBe('edited')
  })

  test('more than a page came that the events did not bring: the newest page as on a first open, no gap', async () => {
    const { a, b } = await leftA()
    for (let i = 61; i <= 130; i++) server[a.id]!.push(message({ roomId: a.id, seq: i }))
    useRooms.getState().close(b.id, null)
    useRooms.getState().open(a.id)
    await tick()
    expect(reads(a.id).map((c) => cursorAt(c.cursor))).toEqual([{ n: '60' }, null])
    expect(seqs()).toEqual(Array.from({ length: 50 }, (_, i) => 81 + i))
  })

  test('the room is no longer mine (403 or 404): nothing of it stays on screen', async () => {
    for (const status of [404, 403]) {
      const { a, b } = await leftA()
      refuse = status
      useRooms.getState().close(b.id, null)
      useRooms.getState().open(a.id)
      await tick()
      expect(useRooms.getState().timeline).toMatchObject({ roomId: a.id, messages: [], loading: false })
      expect(useRooms.getState().timeline!.error).toBeTruthy()
      expect(useRooms.getState().kept[a.id]).toBeUndefined()
      useRooms.getState().reset()
      refuse = null
    }
  })

  test('the live connection down (it may have missed that I was taken out): read as the first time, nothing kept shown', async () => {
    const { a, b } = await leftA()
    useRooms.getState().close(b.id, null)
    for (const conn of ['reconnecting', 'offline'] as const) {
      useUi.setState({ conn })
      useRooms.getState().open(a.id)
      expect(useRooms.getState().timeline).toMatchObject({ roomId: a.id, messages: [], loading: true })
      await tick()
      expect(reads(a.id).at(-1)!.cursor).toBeNull()
      useRooms.getState().close(a.id, null)
    }
    // taken out meanwhile: the read says so and nothing of the room shows
    useUi.setState({ conn: 'reconnecting' })
    useRooms.getState().close(a.id, null)
    refuse = 404
    useRooms.getState().open(a.id)
    await tick()
    expect(useRooms.getState().timeline).toMatchObject({ messages: [], loading: false })
  })

  test('a link quiet for longer than a ping and its answer (a computer waking from sleep): read as the first time', async () => {
    const { a, b } = await leftA()
    useRooms.getState().close(b.id, null)
    noteHeard(Date.now() - 31_000)
    useRooms.getState().open(a.id)
    expect(useRooms.getState().timeline).toMatchObject({ messages: [], loading: true })
    await tick()
    expect(reads(a.id).map((c) => c.cursor)).toEqual([null])
  })

  test('a reconnect that could not resume: the room open then is not kept when left before it is read again (review of #611)', async () => {
    const { a, b } = await leftA()
    useRooms.getState().close(b.id, null)
    useRooms.getState().open(a.id)
    await tick()
    // the link could not resume: the open room's messages may be out of date until its newest page is read again
    hold = true
    useRooms.getState().forgetKept()
    void useRooms.getState().resync()
    await tick()
    // left while the rooms list is read (before the room's own read has even started): not kept, so going back reads
    // it as the first time
    expect(useRooms.getState().timeline!.loading).toBe(false)
    useRooms.getState().close(a.id, null)
    expect(useRooms.getState().kept[a.id]).toBeUndefined()
    held.forEach((h) => h(true))
    held = []
    hold = false
    await tick()
    // read afresh, then left: kept again
    useRooms.getState().open(a.id)
    await tick()
    useRooms.getState().close(a.id, null)
    expect(useRooms.getState().kept[a.id]).toBeDefined()
  })

  test('someone joined or left while it was open: not kept when left, even after the newest page was read again', async () => {
    const { a, b } = await leftA()
    useRooms.getState().close(b.id, null)
    useRooms.getState().open(a.id)
    await tick()
    useRooms.getState().handleEvent({ type: 'room.updated', seq: 6, at: Date.now(), data: { roomId: a.id, change: 'members', room: { ...a, memberCount: 4 } } })
    await tick()
    // (the re-read of the newest page covers 50 of the kept messages: the older ones may still show their reactions)
    useRooms.getState().close(a.id, null)
    expect(useRooms.getState().kept[a.id]).toBeUndefined()
  })

  test('a network failure on the read after keeps what is on screen', async () => {
    const { a, b } = await leftA()
    globalThis.fetch = (async () => { throw new TypeError('Failed to fetch') }) as unknown as typeof fetch
    useRooms.getState().close(b.id, null)
    useRooms.getState().open(a.id)
    await tick()
    expect(useRooms.getState().timeline).toMatchObject({ loading: false, error: null })
    expect(seqs()).toHaveLength(50)
  })

  test('dropped when unsure: a reconnect that could not resume, a members change, leaving the list, sign-out', async () => {
    const { a, b } = await leftA()
    // resync: every kept room goes (the events in between are lost)
    await useRooms.getState().resync().catch(() => {})
    expect(useRooms.getState().kept).toEqual({})
    // a members change of a kept room
    useRooms.setState({ kept: { [a.id]: kept(a.id, server[a.id]!.slice(-5)) } })
    useRooms.getState().handleEvent({ type: 'room.updated', seq: 3, at: Date.now(), data: { roomId: a.id, change: 'members', room: { ...a, memberCount: 4 } } })
    expect(useRooms.getState().kept[a.id]).toBeUndefined()
    // taken out of the room
    useRooms.setState({ kept: { [a.id]: kept(a.id, server[a.id]!.slice(-5)) } })
    useRooms.getState().handleEvent({ type: 'room.updated', seq: 4, at: Date.now(), data: { roomId: a.id, change: 'removed', room: null } })
    expect(useRooms.getState().kept[a.id]).toBeUndefined()
    // the rooms list read again without it
    useRooms.setState({ rooms: [a, b], kept: { [a.id]: kept(a.id, server[a.id]!.slice(-5)), [b.id]: kept(b.id, server[b.id]!) } })
    globalThis.fetch = (async () => new Response(JSON.stringify({ items: [b] }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    await useRooms.getState().loadRooms()
    expect(Object.keys(useRooms.getState().kept)).toEqual([b.id])
    // sign-out (or another person signing in) empties it
    useRooms.getState().reset()
    expect(useRooms.getState().kept).toEqual({})
  })

  test('not kept: a window around an older message, a timeline still loading or failed, one being read again after a members change', async () => {
    const r = room({ lastSeq: 9 })
    const ms = [message({ roomId: r.id, seq: 9 })]
    useRooms.setState({ rooms: [r], loaded: true })
    for (const timeline of [{ roomId: r.id, messages: ms, nextCursor: null, newerCursor: 'newer', loading: false, error: null }, { roomId: r.id, messages: ms, nextCursor: null, loading: true, error: null }, { roomId: r.id, messages: ms, nextCursor: null, loading: false, error: new Error('x') }]) {
      useRooms.setState({ openRoomId: r.id, timeline })
      useRooms.getState().close(r.id)
      expect(useRooms.getState().kept[r.id]).toBeUndefined()
    }
    // someone joined while it was open: its re-read is on its way when I leave
    hold = true
    server[r.id] = ms
    useRooms.setState({ openRoomId: r.id, timeline: { roomId: r.id, messages: ms, nextCursor: null, loading: false, error: null } })
    useRooms.getState().handleEvent({ type: 'room.updated', seq: 5, at: Date.now(), data: { roomId: r.id, change: 'members', room: { ...r, memberCount: 4 } } })
    useRooms.getState().close(r.id)
    expect(useRooms.getState().kept[r.id]).toBeUndefined()
    // a room not in my list (a link opened before the list came) is not kept either
    useRooms.setState({ rooms: [], openRoomId: r.id, timeline: { roomId: r.id, messages: ms, nextCursor: null, loading: false, error: null } })
    useRooms.getState().close(r.id)
    expect(useRooms.getState().kept[r.id]).toBeUndefined()
    held.forEach((h) => h(true))
  })
})

describe('where the reader was', () => {
  test('a room opens at the message I left it at only while nothing came since; else at the newest', () => {
    const r = room()
    const m1 = message({ roomId: r.id, seq: 1 }), m2 = message({ roomId: r.id, seq: 2 })
    const place = { messageId: m1.id, offset: 8 }
    const k = kept(r.id, [m1, m2], { place })
    expect(keptPlace(k)).toEqual(place)
    expect(keptPlace(kept(r.id, [m1, m2]))).toBeNull()
    expect(keptPlace(null)).toBeNull()
    // a message came while away (the events added it): the newest, with it in sight
    const d = withMessage(data({ rooms: [r], kept: { [r.id]: k } }), r.id, message({ roomId: r.id, seq: 3 }), ME.id)
    expect(keptPlace(d.kept![r.id]!)).toBeNull()
  })

  type Box = { top: number; bottom: number }
  const rowAt = (id: string, top: number, height = 40) => ({ id, getAttribute: (n: string) => (n === 'data-message-id' ? id : null), getBoundingClientRect: (): Box => ({ top, bottom: top + height }) })
  const list = (rows: ReturnType<typeof rowAt>[], o: { top?: number; clientHeight?: number; scrollTop?: number } = {}) => ({
    scrollTop: o.scrollTop ?? 500, clientHeight: o.clientHeight ?? 600,
    getBoundingClientRect: () => ({ top: o.top ?? 100, bottom: (o.top ?? 100) + (o.clientHeight ?? 600) }),
    querySelectorAll: () => rows,
  })

  test('the first row in sight and how far below the top; nothing at the bottom or out of sight', () => {
    const rows = [rowAt('room-msg-a', 20), rowAt('room-msg-b', 90), rowAt('room-msg-c', 150)]
    const idOf = (r: { id: string }) => r.id.slice('room-msg-'.length) || null
    // a (bottom 60) is above the list's top (100): b, whose top is 10 px above it
    expect(listPlace(list(rows), 'x', idOf, false)).toEqual({ messageId: 'b', offset: -10 })
    expect(listPlace(list(rows), 'x', idOf, true)).toBeNull()
    expect(listPlace(list(rows, { clientHeight: 0 }), 'x', idOf, false)).toBeNull()
    expect(listPlace(list([]), 'x', idOf, false)).toBeNull()
  })

  test('put back: the row where it was; a row that is gone leaves the list as it is', () => {
    const el = list([])
    // the row is now 300 px below the list's top; it was 20 px below it
    expect(restorePlace(el, rowAt('x', 400), 20)).toBe(true)
    expect(el.scrollTop).toBe(500 + 280)
    expect(restorePlace(el, null, 20)).toBe(false)
    expect(el.scrollTop).toBe(780)
  })

  test("AI chats: the last CHAT_PLACES places, none at the bottom, gone at sign-out", () => {
    for (let i = 0; i < CHAT_PLACES + 3; i++) keepChatPlace(`chat-${i}`, { messageId: `m-${i}`, offset: i, last: 'x' })
    expect(chatPlace('chat-0')).toBeNull()
    expect(chatPlace(`chat-${CHAT_PLACES + 2}`)).toEqual({ messageId: `m-${CHAT_PLACES + 2}`, offset: CHAT_PLACES + 2, last: 'x' })
    keepChatPlace(`chat-${CHAT_PLACES + 2}`, null)
    expect(chatPlace(`chat-${CHAT_PLACES + 2}`)).toBeNull()
    useChats.getState().reset()
    expect(chatPlace(`chat-${CHAT_PLACES + 1}`)).toBeNull()
    // the chat's end: an answer that went on (longer, or done) or a new message is a change
    const a = { id: 'a1', content: 'Hello', status: 'streaming' as const }
    expect(chatEnd([a])).toBe(chatEnd([{ ...a }]))
    expect(chatEnd([a])).not.toBe(chatEnd([{ ...a, content: 'Hello there' }]))
    expect(chatEnd([a])).not.toBe(chatEnd([{ ...a, status: 'done' as const }]))
    expect(chatEnd([a])).not.toBe(chatEnd([a, { id: 'q2', content: 'next', status: 'done' as const }]))
  })
})
