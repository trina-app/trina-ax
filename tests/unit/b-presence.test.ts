// Online status (docs/DECISIONS.md "접속 상태"; server/src/realtime/presence.ts). Two parts:
//   1. The state machine on a fake clock: a person's windows add up to the most online one; idle windows make away;
//      the last window gone makes offline only after the grace (a reload inside it tells nobody); a change is told once
//      it has held, one person's at most once per min gap; changes close together go out as one frame; a manual away
//      wins and is read from the account; only active accounts are listed (a non-account, such as the AI, never is), and
//      offline is told about anyone, at once for an account turned off; after a start, the whole list waits for the
//      warm-up.
//   2. On the real app and hub (in-memory connections): the `presence` control frame after hello (no seq, nothing but
//      ids and states), changes to the other members, the window's own `presence` frame, nothing of it in the replay
//      buffer, PUT /api/me/away (kept in the account, PATCH /api/me cannot set it), a disabled account goes offline at
//      once, a window dropped while its hello went out is never counted.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { ClientFrame, ControlFrame, PresenceFrame, ServerFrame, type PresenceState } from '@mycel/shared/api'
import { Hub } from '../../server/src/realtime/hub'
import { Presence, PRESENCE_FLUSH_MS, PRESENCE_GRACE_MS, PRESENCE_MIN_GAP_MS, PRESENCE_SETTLE_MS, PRESENCE_WARMUP_MS, startPresence, type PresenceClock } from '../../server/src/realtime/presence'
import type { RealtimeConn } from '../../server/src/services'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

setDefaultTimeout(30_000)

class FakeClock implements PresenceClock {
  t = 1_000_000
  private n = 0
  private q: { id: number; at: number; fn: () => void }[] = []
  now() { return this.t }
  setTimeout(fn: () => void, ms: number) { const id = ++this.n; this.q.push({ id, at: this.t + ms, fn }); return id }
  clearTimeout(id: unknown) { this.q = this.q.filter((x) => x.id !== id) }
  advance(ms: number) {
    const end = this.t + ms
    for (;;) {
      this.q.sort((a, b) => a.at - b.at || a.id - b.id)
      const next = this.q[0]
      if (!next || next.at > end) break
      this.q.shift()
      this.t = next.at
      next.fn()
    }
    this.t = end
  }
  get pending() { return this.q.length }
}

/** a Presence on a fake clock: what it sent, to whom */
function machine(o: { people?: string[]; away?: string[]; recipients?: string[]; warmupMs?: number } = {}) {
  const clock = new FakeClock()
  const people = new Set(o.people ?? ['ana', 'bob', 'cho'])
  const away = new Set(o.away ?? [])
  const sent: { to: string; window?: string; frame: PresenceFrame }[] = []
  /** how often the accounts were read: one person, or all of them at once */
  const lookups = { one: 0, all: 0 }
  const p = new Presence({
    send: (to, frame, window) => sent.push({ to, window, frame: PresenceFrame.parse(frame) }),
    recipients: () => o.recipients ?? ['ana', 'bob', 'cho'],
    isPerson: (id) => { lookups.one++; return people.has(id) },
    activeIds: () => { lookups.all++; return new Set(people) },
    awayOf: (id) => away.has(id),
    clock,
    warmupMs: o.warmupMs ?? 0,
  })
  /** the changes told to one recipient, in order */
  const told = (to = 'cho') => sent.filter((s) => s.to === to && !s.frame.full).flatMap((s) => s.frame.people)
  /** wait long enough for a change to be told (the min gap after the last one, the batch) */
  const settle = () => clock.advance(Math.max(PRESENCE_SETTLE_MS, PRESENCE_MIN_GAP_MS) + 300)
  return { p, clock, sent, told, settle, people, away, lookups }
}

describe('the state machine', () => {
  test('a window opening: the whole list to that window at once, online to the team once it has held', () => {
    const m = machine()
    m.p.open('ana', 'w1')
    expect(m.sent[0]).toEqual({ to: 'ana', window: 'w1', frame: { type: 'presence', full: true, people: [] } })
    // not yet: a change is told once it has held
    m.clock.advance(PRESENCE_SETTLE_MS - 1)
    expect(m.told()).toEqual([])
    m.settle()
    expect(m.told()).toEqual([{ id: 'ana', state: 'online' }])
    // every open window of the team, ana's own too
    expect(m.sent.filter((s) => !s.frame.full).map((s) => s.to).sort()).toEqual(['ana', 'bob', 'cho'])
    // a window opening later gets the list with ana in it
    m.p.open('bob', 'w2')
    expect(m.sent.at(-1)).toEqual({ to: 'bob', window: 'w2', frame: { type: 'presence', full: true, people: [{ id: 'ana', state: 'online' }] } })
  })

  test('several devices add up to the most online one', () => {
    const m = machine()
    m.p.open('ana', 'phone')
    m.p.open('ana', 'laptop')
    m.settle()
    m.p.activity('ana', 'phone', 'idle')
    m.settle()
    // the laptop is still in use
    expect(m.p.told('ana')).toBe('online')
    m.p.activity('ana', 'laptop', 'idle')
    m.settle()
    expect(m.p.told('ana')).toBe('away')
    // either one in use again: online
    m.p.activity('ana', 'phone', 'active')
    m.settle()
    expect(m.p.told('ana')).toBe('online')
    // one closed, the other still open and in use
    m.p.close('ana', 'laptop')
    m.clock.advance(PRESENCE_GRACE_MS * 2)
    expect(m.p.told('ana')).toBe('online')
    expect(m.told()).toEqual([{ id: 'ana', state: 'online' }, { id: 'ana', state: 'away' }, { id: 'ana', state: 'online' }])
  })

  test('idle makes away once it has held; a quick back and forth tells nobody', () => {
    const m = machine()
    m.p.open('ana', 'w1')
    m.settle()
    m.p.activity('ana', 'w1', 'idle')
    m.clock.advance(500)
    m.p.activity('ana', 'w1', 'active')
    m.settle()
    expect(m.told()).toEqual([{ id: 'ana', state: 'online' }])
    m.p.activity('ana', 'w1', 'idle')
    m.settle()
    expect(m.told()).toEqual([{ id: 'ana', state: 'online' }, { id: 'ana', state: 'away' }])
    // the same state again changes nothing
    m.p.activity('ana', 'w1', 'idle')
    m.settle()
    expect(m.told()).toHaveLength(2)
  })

  test('the last window gone: offline only after the grace; a reload inside it tells nobody', () => {
    const m = machine()
    m.p.open('ana', 'w1')
    m.settle()
    // a reload: the window goes and a new one comes 3 s later
    m.p.close('ana', 'w1')
    m.clock.advance(3000)
    m.p.open('ana', 'w2')
    m.clock.advance(PRESENCE_GRACE_MS * 2)
    expect(m.told()).toEqual([{ id: 'ana', state: 'online' }])
    // gone for good
    m.p.close('ana', 'w2')
    m.clock.advance(PRESENCE_GRACE_MS - 1)
    expect(m.p.told('ana')).toBe('online')
    m.clock.advance(400)
    expect(m.told()).toEqual([{ id: 'ana', state: 'online' }, { id: 'ana', state: 'offline' }])
    // and forgotten: nothing kept about her, no timer left
    expect(m.p.list()).toEqual([])
    expect(m.clock.pending).toBe(0)
  })

  test('an idle tab that reconnects says so at once: nobody sees it flick to online', () => {
    const m = machine()
    m.p.open('ana', 'w1')
    m.p.activity('ana', 'w1', 'idle')
    m.settle()
    expect(m.p.told('ana')).toBe('away')
    m.p.close('ana', 'w1')
    m.clock.advance(5000)
    // a new connection counts as in use until the page says otherwise, a few milliseconds later
    m.p.open('ana', 'w1')
    m.clock.advance(20)
    m.p.activity('ana', 'w1', 'idle')
    m.settle()
    expect(m.told()).toEqual([{ id: 'ana', state: 'away' }])
  })

  test('changes close together go out as one frame', () => {
    const m = machine()
    m.p.open('ana', 'w1')
    m.p.open('bob', 'w2')
    m.settle()
    const frames = m.sent.filter((s) => s.to === 'cho' && !s.frame.full)
    expect(frames).toHaveLength(1)
    expect(frames[0]!.frame.people).toEqual([{ id: 'ana', state: 'online' }, { id: 'bob', state: 'online' }])
  })

  test('manual away wins over a window in use, and back to automatic; read from the account on the first window', () => {
    const m = machine({ away: ['bob'] })
    m.p.open('ana', 'w1')
    m.settle()
    m.p.setAway('ana', true)
    m.settle()
    expect(m.p.told('ana')).toBe('away')
    m.p.setAway('ana', false)
    m.settle()
    expect(m.p.told('ana')).toBe('online')
    // bob set himself away on another day: his first window reads it
    m.p.open('bob', 'w2')
    m.settle()
    expect(m.p.told('bob')).toBe('away')
    // nobody connected: nothing to change (his next window reads the account again)
    m.p.setAway('cho', true)
    expect(m.p.current('cho')).toBe('offline')
  })

  test('team scoping: only active accounts are listed; the AI or a turned-off account never shows online, but offline is told', () => {
    const m = machine({ people: ['ana', 'bob'] })
    // not an account of this team (the AI is none; nor is a deleted or disabled account): never online, never listed
    m.p.open('trina', 'w9')
    m.settle()
    expect(m.told().map((x) => x.id)).not.toContain('trina')
    expect(m.p.list()).toEqual([])
    m.p.open('ana', 'w1')
    m.p.open('bob', 'w2')
    m.settle()
    expect(m.p.list()).toEqual([{ id: 'ana', state: 'online' }, { id: 'bob', state: 'online' }])
    // bob's account is turned off: no longer listed to a new window, and offline is told as soon as his windows close
    // (no grace: nobody waits for it to come back)
    m.people.delete('bob')
    expect(m.p.list()).toEqual([{ id: 'ana', state: 'online' }])
    m.p.close('bob', 'w2')
    m.clock.advance(PRESENCE_FLUSH_MS + 10)
    expect(m.told()).toContainEqual({ id: 'bob', state: 'offline' })
    // only the people with a window open are told
    expect(new Set(m.sent.map((s) => s.to))).toEqual(new Set(['ana', 'bob', 'cho', 'trina']))
  })

  test('one person\'s changes are told at most once per min gap, the newest winning: a page flipping its state cannot keep the team busy', () => {
    const m = machine()
    m.p.open('ana', 'w1')
    m.settle()
    const before = m.told().length
    // idle and active, each held a little longer than the settle, for a minute
    for (let i = 0; i < 30; i++) {
      m.p.activity('ana', 'w1', i % 2 ? 'active' : 'idle')
      m.clock.advance(PRESENCE_SETTLE_MS + 500)
    }
    const told = m.told().slice(before)
    expect(told.length).toBeLessThanOrEqual(Math.ceil((30 * (PRESENCE_SETTLE_MS + 500)) / PRESENCE_MIN_GAP_MS) + 1)
    expect(told.length).toBeGreaterThan(0)
    // the last state wins once it holds
    m.settle()
    expect(m.p.told('ana')).toBe(m.p.current('ana'))
  })

  test('after a start the whole list waits for the warm-up: a deploy does not take every dot off the screen', () => {
    const m = machine({ warmupMs: PRESENCE_WARMUP_MS })
    // everyone reconnects after the restart; their own lists wait
    m.p.open('ana', 'w1')
    m.clock.advance(3000)
    m.p.open('bob', 'w2')
    m.p.activity('bob', 'w2', 'idle')
    m.clock.advance(5000)
    expect(m.sent.filter((s) => s.frame.full)).toEqual([])
    // changes still go out as they come (they only add to what a screen shows)
    expect(m.told()).toEqual([{ id: 'ana', state: 'online' }, { id: 'bob', state: 'away' }])
    m.clock.advance(PRESENCE_WARMUP_MS)
    const full = m.sent.filter((s) => s.frame.full)
    expect(full.map((s) => [s.to, s.window])).toEqual([['ana', 'w1'], ['bob', 'w2']])
    expect(full[0]!.frame.people).toEqual([{ id: 'ana', state: 'online' }, { id: 'bob', state: 'away' }])
    // later windows get theirs at once
    m.p.open('cho', 'w3')
    expect(m.sent.at(-1)).toMatchObject({ to: 'cho', window: 'w3', frame: { full: true } })
  })

  test('an account turned off while its last window\'s grace runs: offline as soon as its sessions end, not 30 s later', () => {
    const m = machine()
    m.p.open('ana', 'w1')
    m.settle()
    // the tab closed: the grace runs, she still shows online
    m.p.close('ana', 'w1')
    m.clock.advance(5000)
    expect(m.p.told('ana')).toBe('online')
    // an admin turns her account off: no window is left to close; the hub says her sessions ended
    m.people.delete('ana')
    m.p.recheck('ana')
    m.clock.advance(PRESENCE_FLUSH_MS + 10)
    expect(m.told()).toEqual([{ id: 'ana', state: 'online' }, { id: 'ana', state: 'offline' }])
    // an active account (a password change ends every session too) keeps its grace as it was
    m.p.open('bob', 'w2')
    m.settle()
    m.p.close('bob', 'w2')
    m.clock.advance(PRESENCE_GRACE_MS - 5000)
    m.p.recheck('bob')
    m.clock.advance(5000 + PRESENCE_FLUSH_MS + 10)
    expect(m.p.told('bob')).toBe('offline')
  })

  test('the accounts are read once for a whole list and once for a batch of changes, not once per person', () => {
    const m = machine({ people: ['ana', 'bob', 'cho', 'dan'] })
    for (const id of ['ana', 'bob', 'cho', 'dan']) m.p.open(id, `w-${id}`)
    m.lookups.all = 0
    m.settle()
    // four changes in one frame: one read
    expect(m.sent.filter((s) => s.to === 'ana' && !s.frame.full)).toHaveLength(1)
    expect(m.lookups.all).toBe(1)
    m.lookups.all = 0
    expect(m.p.list()).toHaveLength(4)
    expect(m.lookups.all).toBe(1)
  })

  test('activity of a window it does not know is ignored; stop clears every timer', () => {
    const m = machine()
    m.p.activity('ana', 'nope', 'idle')
    expect(m.p.current('ana')).toBe('offline')
    m.p.open('ana', 'w1')
    m.p.activity('ana', 'other', 'idle')
    expect(m.p.current('ana')).toBe('online')
    m.p.stop()
    m.clock.advance(PRESENCE_GRACE_MS * 2)
    expect(m.told()).toEqual([])
  })
})

// ---------------- on the real app and hub ----------------
class MemConn implements RealtimeConn {
  sent: ServerFrame[] = []
  raw: string[] = []
  closed: { code: number; reason?: string } | null = null
  private cls: (() => void)[] = []
  private msg: ((d: string) => void)[] = []
  send(d: string) { if (this.closed) throw new Error('closed'); this.raw.push(d); this.sent.push(JSON.parse(d)) }
  close(code: number, reason?: string) { if (this.closed) return; this.closed = { code, reason }; for (const f of this.cls) f() }
  bufferedAmount() { return 0 }
  ping() {}
  onMessage(fn: (d: string) => void) { this.msg.push(fn) }
  onClose(fn: () => void) { this.cls.push(fn) }
  /** the page sends a client frame */
  say(f: ClientFrame) { for (const fn of this.msg) fn(JSON.stringify(ClientFrame.parse(f))) }
  presence() { return this.sent.filter((f) => f.type === 'presence') as PresenceFrame[] }
  clear() { this.sent = []; this.raw = [] }
}

let h: Harness
let hub: Hub
let clock: FakeClock
let presence: Presence
let owner: Client
let ownerId: string
let bob: { client: Client; id: string; password: string }
let cho: { client: Client; id: string; password: string }

async function connect(c: Client, windowId: string, q = ''): Promise<MemConn> {
  const conn = new MemConn()
  await hub.attach(conn, new Request(`http://team.localhost/api/ws?windowId=${windowId}${q}`, { headers: { origin: 'http://team.localhost', cookie: c.cookie! } }), { ip: '10.0.0.7', via: 'test' })
  return conn
}
const settle = () => clock.advance(Math.max(PRESENCE_SETTLE_MS, PRESENCE_MIN_GAP_MS) + 300)
const changes = (c: MemConn) => c.presence().filter((f) => !f.full).flatMap((f) => f.people)
const stateIn = (c: MemConn, id: string): PresenceState => {
  let s: PresenceState = 'offline'
  for (const f of c.presence()) {
    if (f.full) s = f.people.find((p) => p.id === id)?.state ?? 'offline'
    else for (const p of f.people) if (p.id === id) s = p.state
  }
  return s
}

beforeAll(async () => {
  h = await harness('b-presence')
  clock = new FakeClock()
  hub = new Hub(h.ctx, { now: () => h.auth.now() })
  h.ctx.services.realtime = hub
  presence = startPresence(hub, h.ctx, { clock, warmupMs: 0 })
  h.ctx.onClose(() => hub.close())
  owner = await withOwner(h)
  ownerId = (await owner.call('GET', '/api/me')).user.id
  bob = await addMember(h, owner, { username: 'bob' })
  cho = await addMember(h, owner, { username: 'cho' })
})
afterAll(async () => { await h?.close() })

describe('the presence frame on the socket', () => {
  test('after hello: the whole list, a control frame without seq, ids and states only; changes reach the others', async () => {
    const o = await connect(owner, 'win-owner-1')
    expect(o.sent.map((f) => f.type)).toEqual(['hello', 'presence'])
    const first = o.sent[1]!
    expect(ControlFrame.parse(first)).toEqual({ type: 'presence', full: true, people: [] })
    // exactly these keys: no seq or time, no device or window
    expect(Object.keys(JSON.parse(o.raw[1]!)).sort()).toEqual(['full', 'people', 'type'])
    settle()
    const b = await connect(bob.client, 'win-bob-1')
    // bob's list has the owner, as the team was told
    expect(b.presence()[0]).toEqual({ type: 'presence', full: true, people: [{ id: ownerId, state: 'online' }] })
    settle()
    expect(changes(o)).toContainEqual({ id: bob.id, state: 'online' })
    for (const f of o.presence()) for (const p of f.people) expect(Object.keys(p).sort()).toEqual(['id', 'state'])
    expect(JSON.stringify(o.sent)).not.toMatch(/win-bob|userAgent|lastSeen|desktop|mobile/)
    o.close(1000); b.close(1000)
    clock.advance(PRESENCE_GRACE_MS + 400)
  })

  test('the page says idle: away for the team; in use again: online; nothing of it is replayed after a reconnect', async () => {
    const o = await connect(owner, 'win-owner-2')
    const b = await connect(bob.client, 'win-bob-2')
    settle()
    b.say({ type: 'presence', state: 'idle' })
    settle()
    expect(stateIn(o, bob.id)).toBe('away')
    b.say({ type: 'presence', state: 'active' })
    settle()
    expect(stateIn(o, bob.id)).toBe('online')
    // the owner's window reconnects asking for a replay: events would come again, presence frames never (a new list)
    const hello = o.sent.find((f) => f.type === 'hello') as { epoch: string; seq: number }
    o.close(1000)
    const again = await connect(owner, 'win-owner-2', `&epoch=${hello.epoch}&after=0`)
    const presence = again.presence()
    expect(presence).toHaveLength(1)
    expect(presence[0]!.full).toBe(true)
    expect(presence[0]!.people).toContainEqual({ id: bob.id, state: 'online' })
    again.close(1000); b.close(1000)
    clock.advance(PRESENCE_GRACE_MS + 400)
  })

  test('an unknown state is refused as an invalid frame and changes nothing', async () => {
    const b = await connect(bob.client, 'win-bob-3')
    settle()
    b.clear()
    for (const fn of (b as unknown as { msg: ((d: string) => void)[] }).msg) fn(JSON.stringify({ type: 'presence', state: 'busy', device: 'phone' }))
    expect(b.sent.map((f) => f.type)).toEqual(['error'])
    settle()
    expect(changes(b)).toEqual([])
    b.close(1000)
    clock.advance(PRESENCE_GRACE_MS + 400)
  })

  test('PUT /api/me/away: kept in my account, the team sees away, my other windows read my account; back to automatic', async () => {
    const o = await connect(owner, 'win-owner-4')
    const b = await connect(bob.client, 'win-bob-4')
    settle()
    expect(stateIn(o, bob.id)).toBe('online')
    expect(await bob.client.call('PUT', '/api/me/away', { away: true })).toEqual({ away: true })
    settle()
    expect(stateIn(o, bob.id)).toBe('away')
    expect((await bob.client.call('GET', '/api/me')).user.prefs.away).toBe(true)
    // his own windows read his account again (the menu's word)
    expect(b.sent.some((f) => f.type === 'notice' && (f as { data: { code: string } }).data.code === 'my_profile_changed')).toBe(true)
    // PATCH /api/me cannot set it (nor clear it), and keeps his other preferences
    await bob.client.call('PATCH', '/api/me', { prefs: { theme: 'dark', away: false } })
    const me = (await bob.client.call('GET', '/api/me')).user.prefs
    expect(me).toEqual({ theme: 'dark', away: true })
    // it stays across connections: a new window still shows away
    b.close(1000)
    clock.advance(PRESENCE_GRACE_MS + 400)
    expect(stateIn(o, bob.id)).toBe('offline')
    const b2 = await connect(bob.client, 'win-bob-5')
    settle()
    expect(stateIn(o, bob.id)).toBe('away')
    await bob.client.call('PUT', '/api/me/away', { away: false })
    settle()
    expect(stateIn(o, bob.id)).toBe('online')
    expect((await bob.client.call('GET', '/api/me')).user.prefs.away).toBeUndefined()
    // only one's own: the body names nobody, and anything more is refused
    expect((await bob.client.try('PUT', '/api/me/away', { away: true, userId: ownerId })).status).toBe(400)
    expect((await owner.call('GET', '/api/me')).user.prefs.away).toBeUndefined()
    o.close(1000); b2.close(1000)
    clock.advance(PRESENCE_GRACE_MS + 400)
  })

  test('a disabled account: its windows close and it goes offline; it is no longer listed', async () => {
    const o = await connect(owner, 'win-owner-6')
    const c = await connect(cho.client, 'win-cho-6')
    settle()
    expect(stateIn(o, cho.id)).toBe('online')
    await owner.call('PATCH', `/api/admin/users/${cho.id}`, { status: 'disabled' })
    expect(c.closed?.code).toBe(4401)
    // at once, not after the grace
    clock.advance(PRESENCE_FLUSH_MS + 10)
    expect(stateIn(o, cho.id)).toBe('offline')
    const o2 = await connect(owner, 'win-owner-7')
    expect(o2.presence()[0]!.people.map((p) => p.id)).not.toContain(cho.id)
    o.close(1000); o2.close(1000)
  })

  test('a window dropped while its hello went out (too slow) is never counted: no one sees its person online', async () => {
    const o = await connect(owner, 'win-owner-8')
    settle()
    const slow = new MemConn()
    slow.bufferedAmount = () => 64 * 1024 * 1024
    await hub.attach(slow, new Request('http://team.localhost/api/ws?windowId=win-bob-slow', { headers: { origin: 'http://team.localhost', cookie: bob.client.cookie! } }), { ip: '10.0.0.7', via: 'test' })
    expect(slow.closed?.code).toBe(4408)
    settle()
    expect(presence.current(bob.id)).toBe('offline')
    expect(stateIn(o, bob.id)).toBe('offline')
    o.close(1000)
    clock.advance(PRESENCE_GRACE_MS + 400)
  })

  test('disabled during the grace of its last window: offline for the team at once', async () => {
    const dan = await addMember(h, owner, { username: 'dan' })
    const o = await connect(owner, 'win-owner-9')
    const d = await connect(dan.client, 'win-dan-9')
    settle()
    expect(stateIn(o, dan.id)).toBe('online')
    // the tab closes; within the grace an admin turns the account off
    d.close(1000)
    clock.advance(3000)
    expect(stateIn(o, dan.id)).toBe('online')
    await owner.call('PATCH', `/api/admin/users/${dan.id}`, { status: 'disabled' })
    clock.advance(PRESENCE_FLUSH_MS + 10)
    expect(stateIn(o, dan.id)).toBe('offline')
    o.close(1000)
  })
})
