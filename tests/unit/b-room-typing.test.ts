// "Alice is typing…" (docs/DECISIONS.md "입력 중 표시"; server/src/rooms/typing.ts), on the real app and hub with
// in-memory connections: a page's `room.typing` reaches the room's other members as a control frame (no seq, nothing in
// the replay buffer, no row in the database), never the sender, never someone outside the room; a thread's only those
// who see its root; nothing for a room or thread the sender may not write in; the per-person budget and the places
// limit; a "stopped" only after a told "typing"; the places stop when the person's last window closes.
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { ClientFrame, ControlFrame, ROOM_TYPING_EXPIRES_MS, type RoomTypingFrame, type ServerFrame } from '@mycel/shared/api'
import { Hub } from '../../server/src/realtime/hub'
import { RoomTyping, startRoomTyping, TYPING_BUDGET, TYPING_PLACES, TYPING_WINDOW_MS } from '../../server/src/rooms/typing'
import type { RealtimeConn } from '../../server/src/services'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

setDefaultTimeout(60_000)

class MemConn implements RealtimeConn {
  sent: ServerFrame[] = []
  raw: string[] = []
  closed: { code: number; reason?: string } | null = null
  private cls: (() => void)[] = []
  private msg: ((d: string) => void)[] = []
  send(d: string) { if (this.closed) throw new Error('closed'); this.raw.push(d); this.sent.push(JSON.parse(d)) }
  /** a real socket says it closed later, not inside close(): set to hold the close callbacks until flushClose() */
  lateClose = false
  close(code: number, reason?: string) { if (this.closed) return; this.closed = { code, reason }; if (!this.lateClose) for (const f of this.cls) f() }
  flushClose() { for (const f of this.cls) f() }
  bufferedAmount() { return 0 }
  ping() {}
  onMessage(fn: (d: string) => void) { this.msg.push(fn) }
  onClose(fn: () => void) { this.cls.push(fn) }
  say(f: ClientFrame) { for (const fn of this.msg) fn(JSON.stringify(ClientFrame.parse(f))) }
  typing() { return this.sent.filter((f) => f.type === 'room.typing') as RoomTypingFrame[] }
  clear() { this.sent = []; this.raw = [] }
}

let h: Harness
let hub: Hub
let typing: RoomTyping
let t = 1_000_000
let owner: Client
type Person = { client: Client; id: string; password: string }
let ana: Person, bo: Person, cy: Person, dee: Person
let group: string
let dm: string
const cm = () => 'cm-' + crypto.randomUUID()
const send = (c: Client, roomId: string, body: string, extra: Record<string, unknown> = {}) => c.call('POST', `/api/rooms/${roomId}/messages`, { body, clientMessageId: cm(), ...extra })

let n = 0
async function connect(c: Client): Promise<MemConn> {
  const conn = new MemConn()
  await hub.attach(conn, new Request(`http://team.localhost/api/ws?windowId=win-typing-${++n}`, { headers: { origin: 'http://team.localhost', cookie: c.cookie! } }), { ip: '10.0.0.7', via: 'test' })
  return conn
}

beforeAll(async () => {
  h = await harness('b-room-typing')
  hub = new Hub(h.ctx, { now: () => h.auth.now() })
  h.ctx.services.realtime = hub
  typing = startRoomTyping(hub, h.ctx, { now: () => t })
  h.ctx.onClose(() => hub.close())
  owner = await withOwner(h)
  ana = await addMember(h, owner, { username: 'ana' })
  bo = await addMember(h, owner, { username: 'bo' })
  cy = await addMember(h, owner, { username: 'cy' })
  dee = await addMember(h, owner, { username: 'dee' })
  // a group chat of ana, bo and cy (dee is outside it); a 1:1 of ana and bo
  group = (await ana.client.call('POST', '/api/rooms', { kind: 'group', userIds: [bo.id, cy.id] })).id
  dm = (await ana.client.call('POST', '/api/rooms', { kind: 'dm', userId: bo.id })).id
})
afterAll(async () => { await h?.close() })
// each test starts with a fresh budget
beforeEach(() => { t += TYPING_WINDOW_MS + ROOM_TYPING_EXPIRES_MS })

describe('room.typing on the sockets', () => {
  test('the other members get a control frame with the id only; not the sender, not someone outside; nothing kept', async () => {
    const a = await connect(ana.client), b = await connect(bo.client), c = await connect(cy.client), d = await connect(dee.client), o = await connect(owner)
    for (const x of [a, b, c, d, o]) x.clear()
    const rows = (h.ctx.db.query("SELECT COUNT(*) n FROM sqlite_master WHERE type = 'table'").get() as { n: number }).n
    const messages = (h.ctx.db.query('SELECT COUNT(*) n FROM room_messages').get() as { n: number }).n
    const seqBefore = hub.lastSeq(bo.id)
    a.say({ type: 'room.typing', roomId: group, threadRootId: null, typing: true })
    const want = { type: 'room.typing', roomId: group, threadRootId: null, userId: ana.id, typing: true }
    expect(b.typing()).toEqual([want as RoomTypingFrame])
    expect(c.typing()).toEqual([want as RoomTypingFrame])
    // a control frame: no seq or time, exactly these keys
    expect(ControlFrame.parse(b.sent[0])).toEqual(want as RoomTypingFrame)
    expect(Object.keys(JSON.parse(b.raw[0]!)).sort()).toEqual(['roomId', 'threadRootId', 'type', 'typing', 'userId'])
    // never back to the sender; nothing to people outside the room (an admin owner included)
    expect(a.sent).toEqual([])
    expect(d.sent).toEqual([])
    expect(o.sent).toEqual([])
    // not stored: no new table, no message; not in the replay buffer (a resume gets no typing back)
    expect((h.ctx.db.query("SELECT COUNT(*) n FROM sqlite_master WHERE type = 'table'").get() as { n: number }).n).toBe(rows)
    expect((h.ctx.db.query('SELECT COUNT(*) n FROM room_messages').get() as { n: number }).n).toBe(messages)
    expect(hub.lastSeq(bo.id)).toBe(seqBefore)
    const resumed = new MemConn()
    await hub.attach(resumed, new Request(`http://team.localhost/api/ws?windowId=win-typing-resume&epoch=${h.ctx.epoch}&after=0`, { headers: { origin: 'http://team.localhost', cookie: bo.client.cookie! } }), { ip: '10.0.0.7', via: 'test' })
    expect(resumed.sent.find((f) => f.type === 'hello')).toBeTruthy()
    expect(resumed.typing()).toEqual([])
    // stopped: the same people are told at once
    a.say({ type: 'room.typing', roomId: group, threadRootId: null, typing: false })
    expect(b.typing().at(-1)).toEqual({ ...want, typing: false } as RoomTypingFrame)
    expect(c.typing().at(-1)).toEqual({ ...want, typing: false } as RoomTypingFrame)
    expect(d.sent).toEqual([])
    for (const x of [a, b, c, d, o, resumed]) x.close(1000)
  })

  test('a 1:1 reaches the other person only', async () => {
    const a = await connect(ana.client), b = await connect(bo.client), c = await connect(cy.client)
    for (const x of [a, b, c]) x.clear()
    a.say({ type: 'room.typing', roomId: dm, threadRootId: null, typing: true })
    expect(b.typing().map((f) => f.userId)).toEqual([ana.id])
    expect(c.sent).toEqual([])
    for (const x of [a, b, c]) x.close(1000)
  })

  test('a room the sender is not in, an unknown room, a thread root they cannot see: nothing for anyone, no answer', async () => {
    const a = await connect(ana.client), b = await connect(bo.client), d = await connect(dee.client)
    for (const x of [a, b, d]) x.clear()
    // dee is not in the group chat: nothing goes to its members
    d.say({ type: 'room.typing', roomId: group, threadRootId: null, typing: true })
    d.say({ type: 'room.typing', roomId: '019a5f00-0000-7000-8000-00000000ffff', threadRootId: null, typing: true })
    expect(a.sent).toEqual([])
    expect(b.sent).toEqual([])
    // not even an error frame that would tell the room exists
    expect(d.sent).toEqual([])
    // a "thread" whose root is in another room
    const elsewhere = await send(ana.client, dm, 'in the 1:1')
    const c = await connect(cy.client)
    c.clear()
    a.say({ type: 'room.typing', roomId: group, threadRootId: elsewhere.id, typing: true })
    expect(b.typing()).toEqual([])
    expect(c.typing()).toEqual([])
    for (const x of [a, b, c, d]) x.close(1000)
  })

  test('a thread: scoped to it, and only to members who see its root (a later member of a group chat does not)', async () => {
    const root = await send(bo.client, group, 'ROOT for the thread')
    // dee joins the group chat after the root: she sees it from her join on, so not the root nor its thread
    await ana.client.call('POST', `/api/rooms/${group}/members`, { userIds: [dee.id] })
    const a = await connect(ana.client), b = await connect(bo.client), c = await connect(cy.client), d = await connect(dee.client)
    for (const x of [a, b, c, d]) x.clear()
    a.say({ type: 'room.typing', roomId: group, threadRootId: root.id, typing: true })
    expect(b.typing()).toEqual([{ type: 'room.typing', roomId: group, threadRootId: root.id, userId: ana.id, typing: true }])
    expect(c.typing().map((f) => f.threadRootId)).toEqual([root.id])
    expect(d.sent).toEqual([])
    // dee cannot type into it either
    d.say({ type: 'room.typing', roomId: group, threadRootId: root.id, typing: true })
    expect(a.sent).toEqual([])
    // the room's own box still reaches her
    b.say({ type: 'room.typing', roomId: group, threadRootId: null, typing: true })
    expect(d.typing().map((f) => [f.userId, f.threadRootId])).toEqual([[bo.id, null]])
    for (const x of [a, b, c, d]) x.close(1000)
  })

  test('a "stopped" with nothing told before goes nowhere; the places stop when the last window closes', async () => {
    const a1 = await connect(ana.client), a2 = await connect(ana.client), b = await connect(bo.client)
    for (const x of [a1, a2, b]) x.clear()
    a1.say({ type: 'room.typing', roomId: dm, threadRootId: null, typing: false })
    expect(b.sent).toEqual([])
    a1.say({ type: 'room.typing', roomId: dm, threadRootId: null, typing: true })
    expect(b.typing().map((f) => f.typing)).toEqual([true])
    // one of two windows closes: nothing yet
    a1.close(1000)
    expect(b.typing().map((f) => f.typing)).toEqual([true])
    // the last one: stopped at once
    a2.close(1000)
    expect(b.typing().map((f) => f.typing)).toEqual([true, false])
    expect(typing.size).toBe(0)
    b.close(1000)
  })
})

describe('limits', () => {
  test(`at most ${TYPING_BUDGET} frames per ${TYPING_WINDOW_MS / 1000} s per person; then again after the window`, async () => {
    const a = await connect(ana.client), b = await connect(bo.client)
    for (const x of [a, b]) x.clear()
    for (let i = 0; i < TYPING_BUDGET + 15; i++) a.say({ type: 'room.typing', roomId: dm, threadRootId: null, typing: true })
    expect(b.typing()).toHaveLength(TYPING_BUDGET)
    // another person's budget is their own
    b.say({ type: 'room.typing', roomId: dm, threadRootId: null, typing: true })
    expect(a.typing()).toHaveLength(1)
    t += TYPING_WINDOW_MS
    a.say({ type: 'room.typing', roomId: dm, threadRootId: null, typing: true })
    expect(b.typing()).toHaveLength(TYPING_BUDGET + 1)
    for (const x of [a, b]) x.close(1000)
  })

  test(`at most ${TYPING_PLACES} places at once; an expired place frees its slot`, async () => {
    const roots: string[] = []
    for (let i = 0; i < TYPING_PLACES + 1; i++) roots.push((await send(ana.client, dm, `root ${i}`)).id)
    const a = await connect(ana.client), b = await connect(bo.client)
    for (const x of [a, b]) x.clear()
    for (const r of roots) a.say({ type: 'room.typing', roomId: dm, threadRootId: r, typing: true })
    expect(b.typing()).toHaveLength(TYPING_PLACES)
    // the receivers' expiry has passed for the first ones: their slots are free again
    t += ROOM_TYPING_EXPIRES_MS
    a.say({ type: 'room.typing', roomId: dm, threadRootId: roots.at(-1)!, typing: true })
    expect(b.typing().at(-1)?.threadRootId).toBe(roots.at(-1)!)
    for (const x of [a, b]) x.close(1000)
  })

  test('an archived room: nothing goes out', async () => {
    const g = (await cy.client.call('POST', '/api/rooms', { kind: 'group', userIds: [ana.id, bo.id] })).id
    h.ctx.db.query('UPDATE rooms SET archived_at = ? WHERE id = ?').run(new Date().toISOString(), g)
    const a = await connect(ana.client), b = await connect(bo.client)
    for (const x of [a, b]) x.clear()
    a.say({ type: 'room.typing', roomId: g, threadRootId: null, typing: true })
    expect(b.sent).toEqual([])
    for (const x of [a, b]) x.close(1000)
  })
})

describe('the server ends a person', () => {
  test('turned off with two windows open: their places stop at once and nothing of them is kept', async () => {
    const eve = await addMember(h, owner, { username: 'eve' })
    const room = (await eve.client.call('POST', '/api/rooms', { kind: 'dm', userId: ana.id })).id
    const e1 = await connect(eve.client), e2 = await connect(eve.client), a = await connect(ana.client)
    for (const x of [e1, e2, a]) x.clear()
    // as Bun's sockets: the hub's own "closed" comes while both windows are still listed
    e1.lateClose = e2.lateClose = true
    const kept = typing.size
    e1.say({ type: 'room.typing', roomId: room, threadRootId: null, typing: true })
    expect(a.typing().map((f) => [f.userId, f.typing])).toEqual([[eve.id, true]])
    expect(typing.size).toBe(kept + 1)
    await owner.call('PATCH', `/api/admin/users/${eve.id}`, { status: 'disabled' })
    expect(e1.closed?.code).toBe(4401)
    expect(e2.closed?.code).toBe(4401)
    // told now, not after the receivers' 5 s
    expect(a.typing().map((f) => [f.userId, f.typing])).toEqual([[eve.id, true], [eve.id, false]])
    expect(typing.size).toBe(kept)
    e1.flushClose(); e2.flushClose()
    expect(a.typing()).toHaveLength(2)
    a.close(1000)
  })
})
