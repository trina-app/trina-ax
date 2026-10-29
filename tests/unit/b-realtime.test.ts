// Component B: realtime hub (seq / epoch / replay buffer / merged deltas / window targeting / slow clients) and the
// WebSocket endpoint over a real Bun server (auth, Origin, bearer subprotocol, replace, resume, reset, resync).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { WsClose, uuidv7, type ServerEventInput, type ServerFrame } from '@mycel/shared/api'
import { Hub } from '../../server/src/realtime/hub'
import type { AppContext } from '../../server/src/context'
import type { AuthInfo, RealtimeConn } from '../../server/src/services'
import { silentLogger } from '../../server/src/log'
import { startHarness, type Harness } from '../lib/b-harness'

setDefaultTimeout(30_000)

// ---------------- hub with in-memory connections ----------------
class MemConn implements RealtimeConn {
  sent: ServerFrame[] = []
  closed: { code: number; reason?: string } | null = null
  buffered = 0
  pings = 0
  private msg: ((d: string) => void)[] = []
  private cls: (() => void)[] = []
  send(d: string) { if (this.closed) throw new Error('closed'); this.sent.push(JSON.parse(d)) }
  close(code: number, reason?: string) { if (this.closed) return; this.closed = { code, reason }; for (const f of this.cls) f() }
  bufferedAmount() { return this.buffered }
  ping() { this.pings++ }
  onMessage(fn: (d: string) => void) { this.msg.push(fn) }
  onClose(fn: () => void) { this.cls.push(fn) }
  receive(o: unknown) { for (const f of this.msg) f(JSON.stringify(o)) }
  events() { return this.sent.filter((f) => 'seq' in f && f.type !== 'hello' && f.type !== 'resync' && f.type !== 'reset') as Extract<ServerFrame, { at: number }>[] }
}

const auth = (id: string, via: 'cookie' | 'bearer' = 'cookie'): AuthInfo => ({ user: { id, username: id, name: id, role: 'member', locale: 'ko', mustChangePassword: false }, session: { id: uuidv7(), client: 'web' }, via })
function fakeCtx(): AppContext {
  return {
    log: silentLogger, epoch: 'epoch-1', version: '0.0.0-test', config: { publicOrigins: ['https://acme.treesoop.com'] },
    services: {
      sessions: {
        async resolve(req: Request) {
          const b = /^Bearer (\w+)$/.exec(req.headers.get('authorization') ?? '')?.[1]
          if (b) return auth(b, 'bearer')
          const u = req.headers.get('x-user')
          return u ? auth(u) : null
        },
        async verifyPassword() { return false },
      },
    },
  } as unknown as AppContext
}
const connect = async (hub: Hub, user: string | null, q: string, h: Record<string, string> = {}) => {
  const c = new MemConn()
  const headers: Record<string, string> = { origin: 'http://team.localhost', ...h }
  if (user) headers['x-user'] = user
  await hub.attach(c, new Request(`http://team.localhost/api/ws?${q}`, { headers }), { ip: null, via: 'test' })
  return c
}
const delta = (messageId: string, offset: number, text: string): ServerEventInput => ({ type: 'message.delta', data: { chatId: uuidv7(), messageId, offset, text } })
const notice = (n: number): ServerEventInput => ({ type: 'notice', data: { level: 'info', code: 'n' + n, message: 'm' } })

describe('hub', () => {
  test('hello, per-user seq, only own events', async () => {
    const hub = new Hub(fakeCtx())
    const a = await connect(hub, 'alice', 'windowId=win-alice-1')
    const b = await connect(hub, 'bob', 'windowId=win-bob-1')
    expect(a.sent[0]).toMatchObject({ type: 'hello', epoch: 'epoch-1', seq: 0, resumed: false, windowId: 'win-alice-1' })
    hub.publish('alice', notice(1)); hub.publish('alice', notice(2)); hub.publish('bob', notice(3))
    expect(a.events().map((e) => e.seq)).toEqual([1, 2])
    expect(b.events().map((e) => e.seq)).toEqual([1])
    hub.close()
  })

  test('refuses: no session (4401), bad parameters (4400), foreign Origin (4403), missing Origin for cookies (4403)', async () => {
    const hub = new Hub(fakeCtx())
    expect((await connect(hub, null, 'windowId=win-xxxxxxxx')).closed?.code).toBe(WsClose.unauthorized)
    expect((await connect(hub, 'alice', 'windowId=bad')).closed?.code).toBe(WsClose.badRequest)
    expect((await connect(hub, 'alice', 'windowId=win-xxxxxxxx', { origin: 'https://evil.example' })).closed?.code).toBe(WsClose.forbiddenOrigin)
    expect((await connect(hub, 'alice', 'windowId=win-xxxxxxxx', { origin: 'null' })).closed?.code).toBe(WsClose.forbiddenOrigin)
    const c = new MemConn()
    await hub.attach(c, new Request('http://team.localhost/api/ws?windowId=win-xxxxxxxx', { headers: { 'x-user': 'alice' } }), { ip: null, via: 'test' })
    expect(c.closed?.code).toBe(WsClose.forbiddenOrigin)
    // configured public origin is fine; bearer subprotocol needs no Origin
    expect((await connect(hub, 'alice', 'windowId=win-pub-0001', { origin: 'https://acme.treesoop.com' })).closed).toBeNull()
    const m = new MemConn()
    await hub.attach(m, new Request('http://team.localhost/api/ws?windowId=win-mobile-1', { headers: { 'sec-websocket-protocol': 'mycel.v1, mycel.bearer.mia' } }), { ip: null, via: 'test' })
    expect(m.closed).toBeNull()
    expect(m.sent[0]).toMatchObject({ type: 'hello' })
    hub.close()
  })

  test('resume replays what was missed; same epoch + seq in buffer', async () => {
    const hub = new Hub(fakeCtx())
    const a = await connect(hub, 'alice', 'windowId=win-alice-1')
    for (let i = 1; i <= 5; i++) hub.publish('alice', notice(i))
    a.close(1006)
    for (let i = 6; i <= 8; i++) hub.publish('alice', notice(i))
    const r = await connect(hub, 'alice', 'windowId=win-alice-1&epoch=epoch-1&after=5')
    expect(r.sent[0]).toMatchObject({ type: 'hello', resumed: true, seq: 8 })
    expect(r.events().map((e) => e.seq)).toEqual([6, 7, 8])
    hub.close()
  })

  test('other epoch -> reset; seq older than the buffer -> resync; seq from the future -> resync', async () => {
    const hub = new Hub(fakeCtx(), { replayMinEvents: 3, replayMinMs: 0 })
    for (let i = 1; i <= 10; i++) hub.publish('alice', notice(i))
    const reset = await connect(hub, 'alice', 'windowId=win-alice-1&epoch=old-epoch&after=4')
    expect(reset.sent.map((f) => f.type)).toEqual(['hello', 'reset'])
    expect(reset.sent[1]).toMatchObject({ reason: 'server_restarted', seq: 10 })
    const old = await connect(hub, 'alice', 'windowId=win-alice-2&epoch=epoch-1&after=2')
    expect(old.sent.map((f) => f.type)).toEqual(['hello', 'resync'])
    const future = await connect(hub, 'alice', 'windowId=win-alice-3&epoch=epoch-1&after=99')
    expect(future.sent.map((f) => f.type)).toEqual(['hello', 'resync'])
    const ok = await connect(hub, 'alice', 'windowId=win-alice-4&epoch=epoch-1&after=8')
    expect(ok.events().map((e) => e.seq)).toEqual([9, 10])
    hub.close()
  })

  test('consecutive deltas of one message are kept as one entry with the newest seq; replay covers the gap by offset', async () => {
    const hub = new Hub(fakeCtx())
    const m = uuidv7()
    const live = await connect(hub, 'alice', 'windowId=win-alice-1')
    hub.publish('alice', delta(m, 0, 'Hel'))
    hub.publish('alice', delta(m, 3, 'lo '))
    hub.publish('alice', delta(m, 6, 'world'))
    hub.publish('alice', notice(1))
    expect(live.events().length).toBe(4) // live: every delta on its own
    const r = await connect(hub, 'alice', 'windowId=win-alice-2&epoch=epoch-1&after=1')
    const ev = r.events()
    expect(ev.map((e) => e.type)).toEqual(['message.delta', 'notice'])
    expect(ev[0]).toMatchObject({ seq: 3, data: { offset: 0, text: 'Hello world' } })
    hub.close()
  })

  test('a reset delta is not merged into the deltas before it; the deltas after it merge into it', async () => {
    const hub = new Hub(fakeCtx())
    const m = uuidv7()
    hub.publish('alice', delta(m, 0, 'Hello'))
    hub.publish('alice', { type: 'message.delta', data: { chatId: uuidv7(), messageId: m, offset: 0, text: '', reset: true } })
    hub.publish('alice', delta(m, 0, 'Hi'))
    const r = await connect(hub, 'alice', 'windowId=win-alice-3&epoch=epoch-1&after=0')
    const ev = r.events()
    expect(ev).toHaveLength(2)
    expect(ev[0]).toMatchObject({ data: { offset: 0, text: 'Hello' } })
    expect(ev[1]).toMatchObject({ seq: 3, data: { offset: 0, text: 'Hi', reset: true } })
    hub.close()
  })

  test('window-targeted events reach only that window, also on resume; acked browser calls are not replayed', async () => {
    const hub = new Hub(fakeCtx())
    const w1 = await connect(hub, 'alice', 'windowId=win-desk-1')
    const w2 = await connect(hub, 'alice', 'windowId=win-web-02')
    const call = (id: string): ServerEventInput => ({ type: 'browser.call', data: { windowId: 'win-desk-1', call: { callId: id, turnId: uuidv7(), chatId: uuidv7(), tool: 'navigate', args: { url: 'https://example.com' }, deadline: Date.now() + 1000 } } })
    hub.publishTo('alice', 'win-desk-1', call('c1'))
    hub.publishTo('alice', 'win-desk-1', call('c2'))
    expect(w1.events().length).toBe(2)
    expect(w2.events().length).toBe(0)
    w1.receive({ type: 'browser.ack', callId: 'c1' })
    w1.close(1006)
    const back = await connect(hub, 'alice', 'windowId=win-desk-1&epoch=epoch-1&after=0')
    expect(back.events().map((e) => (e.type === 'browser.call' ? e.data.call.callId : e.type))).toEqual(['c2'])
    const other = await connect(hub, 'alice', 'windowId=win-web-02&epoch=epoch-1&after=0')
    expect(other.events().length).toBe(0)
    hub.close()
  })

  test('same window again replaces the old socket (4409); app ping -> pong; bad frames -> error frame', async () => {
    const hub = new Hub(fakeCtx())
    const a = await connect(hub, 'alice', 'windowId=win-alice-1')
    const b = await connect(hub, 'alice', 'windowId=win-alice-1')
    expect(a.closed?.code).toBe(WsClose.replaced)
    expect(b.closed).toBeNull()
    hub.publish('alice', notice(1))
    expect(b.events().length).toBe(1)
    expect(a.events().length).toBe(0)
    b.receive({ type: 'ping', t: 42 })
    expect(b.sent.at(-1)).toEqual({ type: 'pong', t: 42 })
    b.receive({ type: 'nope' })
    expect(b.sent.at(-1)).toMatchObject({ type: 'error', code: 'validation' })
    hub.close()
  })

  test('slow client is closed with 4408; disconnectUser closes with 4401; shutdown with 1012', async () => {
    const hub = new Hub(fakeCtx(), { maxBufferedBytes: 100 })
    const slow = await connect(hub, 'alice', 'windowId=win-slow-01')
    slow.buffered = 1000
    hub.publish('alice', notice(1))
    expect(slow.closed?.code).toBe(WsClose.tooSlow)
    const b = await connect(hub, 'bob', 'windowId=win-bob-001')
    hub.disconnectUser('bob', 'password_changed')
    expect(b.closed?.code).toBe(WsClose.unauthorized)
    const c = await connect(hub, 'carol', 'windowId=win-carol-1')
    hub.close()
    expect(c.closed?.code).toBe(WsClose.serviceRestart)
  })

  test('protocol pings every interval; buffer stays bounded', async () => {
    const hub = new Hub(fakeCtx(), { pingIntervalMs: 20, replayMinEvents: 10, replayMinMs: 0 })
    const a = await connect(hub, 'alice', 'windowId=win-alice-1')
    await Bun.sleep(90)
    expect(a.pings).toBeGreaterThanOrEqual(2)
    for (let i = 0; i < 100; i++) hub.publish('alice', notice(i))
    const r = await connect(hub, 'alice', 'windowId=win-alice-2&epoch=epoch-1&after=92')
    expect(r.events().map((e) => e.seq)).toEqual([93, 94, 95, 96, 97, 98, 99, 100])
    const old = await connect(hub, 'alice', 'windowId=win-alice-3&epoch=epoch-1&after=85')
    expect(old.sent.map((f) => f.type)).toEqual(['hello', 'resync'])
    hub.close()
  })

  test('publishEach builds per person (only people the hub knows)', async () => {
    const hub = new Hub(fakeCtx())
    const a = await connect(hub, 'alice', 'windowId=win-alice-1')
    const b = await connect(hub, 'bob', 'windowId=win-bob-001')
    hub.publishEach((u) => (u === 'alice' ? { type: 'files.changed', data: { changes: [{ path: 'shared/x.md', action: 'create', by: null, turnId: null }] } } : null))
    expect(a.events().map((e) => e.type)).toEqual(['files.changed'])
    expect(b.events().length).toBe(0)
    hub.close()
  })
})

// ---------------- the real endpoint ----------------
describe('GET /api/ws over Bun', () => {
  let h: Harness
  beforeAll(async () => { h = await startHarness({ name: 'b-ws' }) })
  afterAll(async () => { await h.close() })

  test('cookie session + Origin: hello with the server epoch; events arrive', async () => {
    const s = await h.ws('alice', { windowId: 'win-real-001' })
    const hello = await s.next('hello')
    expect(hello.epoch).toBe(h.ctx.epoch)
    expect(s.ws.protocol).toBe('mycel.v1')
    h.ctx.services.realtime.publish('alice', { type: 'notice', data: { level: 'info', code: 'x', message: 'hi' } })
    const n = await s.next('notice')
    expect(n.data.code).toBe('x')
    s.close()
  })

  test('without a session: closed with 4401; foreign Origin: 4403', async () => {
    const s = await h.ws('nobody', { windowId: 'win-real-002' })
    expect((await s.closedWith())?.code).toBe(WsClose.unauthorized)
    const o = await h.ws('alice', { windowId: 'win-real-003', origin: 'https://evil.example' })
    expect((await o.closedWith())?.code).toBe(WsClose.forbiddenOrigin)
  })

  test('bearer token as a subprotocol (mobile shells); the token protocol is never echoed', async () => {
    const s = await h.ws('bob', { windowId: 'win-real-004', bearer: true })
    await s.next('hello')
    expect(s.ws.protocol).toBe('mycel.v1')
    s.close()
  })

  test('resume after a drop gets the missed events; a restarted server (other epoch) answers reset', async () => {
    const s = await h.ws('carol', { windowId: 'win-real-005' })
    await s.next('hello')
    h.ctx.services.realtime.publish('carol', { type: 'notice', data: { level: 'info', code: 'a', message: '' } })
    await s.next('notice', (f) => f.data.code === 'a')
    const seen = s.lastSeq()
    s.close()
    await s.closedWith()
    h.ctx.services.realtime.publish('carol', { type: 'notice', data: { level: 'info', code: 'b', message: '' } })
    const r = await h.ws('carol', { windowId: 'win-real-005', epoch: h.ctx.epoch, after: seen })
    expect((await r.next('hello')).resumed).toBe(true)
    expect((await r.next('notice')).data.code).toBe('b')
    r.close()
    const x = await h.ws('carol', { windowId: 'win-real-006', epoch: 'not-this-epoch', after: 3 })
    expect((await x.next('reset')).reason).toBe('server_restarted')
    x.close()
  })

  test('plain GET without upgrade is a 400 JSON error', async () => {
    const r = await h.req('alice', '/api/ws?windowId=win-real-007')
    expect(r.status).toBe(400)
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('bad_request')
  })
})
