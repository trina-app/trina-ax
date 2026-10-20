import { describe, expect, test } from 'bun:test'
import { uuidv7, WsClose, type ServerEvent } from '@mycel/shared/api'
import { backoffMs, OUTBOX_MAX_BYTES, OUTBOX_MAX_FRAMES, RealtimeClient, type ConnState, type Timers, type WsLike } from '../../src/lib/realtime'

class FakeSocket implements WsLike {
  readyState = 0
  sent: string[] = []
  onopen: WsLike['onopen'] = null
  onclose: WsLike['onclose'] = null
  onmessage: WsLike['onmessage'] = null
  onerror: WsLike['onerror'] = null
  constructor(public url: string, public protocols: string[]) {}
  send(d: string) {
    this.sent.push(d)
  }
  close(code = 1000) {
    this.readyState = 3
    this.onclose?.({ code })
  }
  open() {
    this.readyState = 1
    this.onopen?.({})
  }
  recv(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
  drop(code: number) {
    this.readyState = 3
    this.onclose?.({ code })
  }
}

class FakeTimers implements Timers {
  t = 0
  q: { id: number; at: number; fn: () => void }[] = []
  n = 0
  setTimeout(fn: () => void, ms: number) {
    const id = ++this.n
    this.q.push({ id, at: this.t + ms, fn })
    return id
  }
  clearTimeout(id: unknown) {
    this.q = this.q.filter((x) => x.id !== id)
  }
  now() {
    return this.t
  }
  advance(ms: number) {
    const end = this.t + ms
    for (;;) {
      this.q.sort((a, b) => a.at - b.at)
      const next = this.q[0]
      if (!next || next.at > end) break
      this.q.shift()
      this.t = next.at
      next.fn()
    }
    this.t = end
  }
}

const CHAT = uuidv7()
const MSG = uuidv7()
const delta = (seq: number, offset: number, text: string) => ({ type: 'message.delta', seq, at: 0, data: { chatId: CHAT, messageId: MSG, offset, text } })
const hello = (epoch: string, seq: number, resumed = false) => ({ type: 'hello', epoch, seq, resumed, windowId: 'w1234567', serverVersion: '1.0.0', pingIntervalMs: 20000 })

function setup() {
  const sockets: FakeSocket[] = []
  const events: ServerEvent[] = []
  const reloads: string[] = []
  const states: ConnState[] = []
  const versions: string[] = []
  const timers = new FakeTimers()
  let win = 'w1234567'
  const client = new RealtimeClient({
    baseUrl: 'ws://team.localhost',
    windowId: () => win,
    renewWindowId: () => (win = 'w' + (sockets.length + 1) + 'abcdefg'),
    createSocket: (url, p) => {
      const s = new FakeSocket(url, p)
      sockets.push(s)
      return s
    },
    onEvent: (e) => events.push(e),
    onReload: (r) => reloads.push(r),
    onState: (s) => states.push(s),
    onHello: (h) => versions.push(h.serverVersion),
    timers,
    random: () => 0.5,
  })
  return { client, sockets, events, reloads, states, timers, versions, win: () => win }
}

describe('RealtimeClient', () => {
  test('connects with the window id and the mycel.v1 subprotocol; open after hello', () => {
    const r = setup()
    r.client.start()
    const s = r.sockets[0]!
    expect(s.url).toBe('ws://team.localhost/api/ws?windowId=w1234567')
    expect(s.protocols).toEqual(['mycel.v1'])
    s.open()
    expect(r.client.connState).toBe('connecting')
    s.recv(hello('E1', 5))
    expect(r.client.connState).toBe('open')
    expect(r.client.position).toEqual({ epoch: 'E1', seq: 5 })
    expect(r.versions).toEqual(['1.0.0'])
  })

  test('events are applied once, in seq order; unknown frames are ignored', () => {
    const r = setup()
    r.client.start()
    const s = r.sockets[0]!
    s.open()
    s.recv(hello('E1', 0))
    s.recv(delta(1, 0, 'Hel'))
    s.recv(delta(1, 0, 'Hel')) // replayed twice
    s.recv({ type: 'future.event', seq: 2, at: 0, data: {} })
    s.recv(delta(2, 3, 'lo'))
    expect(r.events.map((e) => e.seq)).toEqual([1, 2])
  })

  test('resumes with epoch and after; replays continue without a reload', () => {
    const r = setup()
    r.client.start()
    r.sockets[0]!.open()
    r.sockets[0]!.recv(hello('E1', 0))
    r.sockets[0]!.recv(delta(1, 0, 'a'))
    r.sockets[0]!.drop(1006)
    expect(r.client.connState).toBe('reconnecting')
    r.timers.advance(500) // first retry: 0–1 s random (random() = 0.5)
    const s2 = r.sockets[1]!
    expect(s2.url).toContain('epoch=E1')
    expect(s2.url).toContain('after=1')
    s2.open()
    s2.recv(hello('E1', 3, true))
    s2.recv(delta(2, 1, 'b'))
    s2.recv(delta(3, 2, 'c'))
    expect(r.events.map((e) => e.seq)).toEqual([1, 2, 3])
    expect(r.reloads).toEqual([])
  })

  test('server restart (new epoch) asks for a reload once', () => {
    const r = setup()
    r.client.start()
    r.sockets[0]!.open()
    r.sockets[0]!.recv(hello('E1', 4))
    r.sockets[0]!.drop(WsClose.serviceRestart)
    r.timers.advance(1000)
    const s2 = r.sockets[1]!
    s2.open()
    s2.recv(hello('E2', 0))
    s2.recv({ type: 'reset', epoch: 'E2', seq: 0, reason: 'epoch_mismatch' })
    expect(r.reloads).toEqual(['reset'])
    expect(r.client.position).toEqual({ epoch: 'E2', seq: 0 })
  })

  test('resync when we fell out of the buffer', () => {
    const r = setup()
    r.client.start()
    r.sockets[0]!.open()
    r.sockets[0]!.recv(hello('E1', 1))
    r.sockets[0]!.recv({ type: 'resync', epoch: 'E1', seq: 900, reason: 'buffer_overflow' })
    expect(r.reloads).toEqual(['resync'])
    r.sockets[0]!.recv(delta(900, 0, 'old'))
    r.sockets[0]!.recv(delta(901, 0, 'new'))
    expect(r.events.map((e) => e.seq)).toEqual([901])
  })

  test('4401 means signed out: no reconnect', () => {
    const r = setup()
    r.client.start()
    r.sockets[0]!.drop(WsClose.unauthorized)
    r.timers.advance(60_000)
    expect(r.sockets).toHaveLength(1)
    expect(r.client.connState).toBe('signed-out')
  })

  test('session.ended stops the client too', () => {
    const r = setup()
    r.client.start()
    r.sockets[0]!.open()
    r.sockets[0]!.recv(hello('E1', 0))
    r.sockets[0]!.recv({ type: 'session.ended', seq: 1, at: 0, data: { reason: 'password_changed' } })
    expect(r.client.connState).toBe('signed-out')
    expect(r.events).toHaveLength(1)
  })

  test('4409 (same window elsewhere) takes a new window id', () => {
    const r = setup()
    r.client.start()
    r.sockets[0]!.drop(WsClose.replaced)
    r.timers.advance(1000)
    expect(r.win()).not.toBe('w1234567')
    expect(r.sockets[1]!.url).toContain(`windowId=${r.win()}`)
  })

  test('backoff 0–1 s, then 1, 2, 4, 8, 10 s; offline after 30 s', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((n) => backoffMs(n, () => 0.25))).toEqual([250, 1000, 2000, 4000, 8000, 10000, 10000])
    const r = setup()
    r.client.start()
    r.sockets[0]!.drop(1006)
    for (let i = 0; i < 6; i++) {
      r.timers.advance(10_000)
      r.sockets.at(-1)!.drop(1006)
    }
    expect(r.states).toContain('offline')
    // back online: nudge connects at once and hello clears the state
    r.client.nudge()
    const s = r.sockets.at(-1)!
    s.open()
    s.recv(hello('E1', 0))
    expect(r.client.connState).toBe('open')
  })

  test('app-level ping; no pong within the timeout = dead link, reconnect', () => {
    const r = setup()
    r.client.start()
    const s = r.sockets[0]!
    s.open()
    s.recv(hello('E1', 0))
    r.timers.advance(20_000)
    expect(JSON.parse(s.sent.at(-1)!).type).toBe('ping')
    r.timers.advance(10_000)
    expect(r.client.connState).toBe('reconnecting')
    r.timers.advance(1000)
    expect(r.sockets).toHaveLength(2)
  })

  test('pong keeps the link', () => {
    const r = setup()
    r.client.start()
    const s = r.sockets[0]!
    s.open()
    s.recv(hello('E1', 0))
    r.timers.advance(20_000)
    s.recv({ type: 'pong', t: 1 })
    r.timers.advance(15_000)
    expect(r.client.connState).toBe('open')
    expect(r.sockets).toHaveLength(1)
  })

  test('frames sent while disconnected wait in the outbox (except pings)', () => {
    const r = setup()
    r.client.start()
    r.client.send({ type: 'browser.ack', callId: 'c1' })
    r.client.send({ type: 'ping', t: 1 })
    const s = r.sockets[0]!
    s.open()
    expect(s.sent).toEqual([])
    s.recv(hello('E1', 0))
    expect(s.sent.map((x) => JSON.parse(x).type)).toEqual(['browser.ack'])
  })

  test('the outbox is bounded while the link is down: oldest frames go first, by count and by size', () => {
    const r = setup()
    r.client.start()
    for (let i = 0; i < OUTBOX_MAX_FRAMES + 50; i++) r.client.send({ type: 'browser.ack', callId: `c${i}` })
    expect(r.client.queued).toBe(OUTBOX_MAX_FRAMES)
    const s = r.sockets[0]!
    s.open()
    s.recv(hello('E1', 0))
    expect(JSON.parse(s.sent[0]!).callId).toBe('c50')
    expect(r.client.queued).toBe(0)
    s.drop(1006)
    // big screenshots: the byte cap holds well below the frame cap
    const big = 'x'.repeat(1_900_000)
    for (let i = 0; i < 10; i++) r.client.send({ type: 'browser.result', result: { callId: `b${i}`, ok: true, content: [{ type: 'text', text: big }] } })
    expect(r.client.queued).toBeLessThanOrEqual(Math.ceil(OUTBOX_MAX_BYTES / big.length))
    expect(r.client.queued).toBeGreaterThan(0)
  })
})
