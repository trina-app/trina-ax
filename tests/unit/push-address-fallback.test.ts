// Push sends try the checked addresses one after another (server/src/notifications/push-transport.ts postPinned):
// IPv4 first, the next address only after a failure before the connection is up, and never a second send once the
// request may have been written. A machine with no IPv6 route used to fail every send to a host whose DNS lists IPv6
// first (push.trina.app, fcm.googleapis.com, web.push.apple.com).
import { afterEach, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import type https from 'node:https'
import { harness, withOwner, type Harness } from './a-lib'
import { createLogger } from '../../server/src/log'
import { padPrivateKey } from '../../server/src/notifications/push-config'
import { PushService } from '../../server/src/notifications/push-service'
import { notificationsOf } from '../../server/src/notifications/service'
import { createNativeTransport, type NativeSend } from '../../server/src/notifications/push-native'
import { connectOrder, createPushTransport, postPinned, PushSendError, type PushSend } from '../../server/src/notifications/push-transport'

const V6A = '2001:4860:4860::8888', V6B = '2001:4860:4860::8844', V4A = '8.8.8.8', V4B = '8.8.4.4'
type Address = { address: string; family: number }
const v6 = (address: string): Address => ({ address, family: 6 }), v4 = (address: string): Address => ({ address, family: 4 })
/** unreachable/refused: fails before the TCP connection is up; hang: never connects; tls-fail: fails after TCP, before
 * TLS; after-write: the request went out, then the connection fails; ok: answers 201. */
type Plan = 'unreachable' | 'refused' | 'hang' | 'tls-fail' | 'after-write' | 'ok'
type Try = Address & { wrote: boolean }

/** https.request as a fake network: the events of a real request, per pinned address. */
function network(plan: (a: Address) => Plan) {
  const tries: Try[] = []
  const request = ((options: any, cb: any) => {
    let pinned!: Address
    options.lookup(options.hostname, { all: true }, (_e: unknown, list: Address[]) => { pinned = list[0]! })
    expect(options.servername).toBe(options.hostname)
    const t: Try = { ...pinned, wrote: false }; tries.push(t)
    const req = new EventEmitter() as any, socket = new EventEmitter() as any
    let destroyed = false; socket.connecting = true
    // like Node: destroying a request that has no response yet still reports "socket hang up"
    req.destroy = () => { if (destroyed) return; destroyed = true; socket.connecting = false; queueMicrotask(() => req.emit('error', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))) }
    const fail = (code: string) => { if (!destroyed) req.emit('error', Object.assign(new Error(`connect ${code} ${pinned.address}:443`), { code })) }
    req.end = () => queueMicrotask(() => {
      if (destroyed) return
      const p = plan(pinned)
      // Bun reports a refused connect before the socket event, Node after it: both orders occur
      if (p === 'unreachable') { socket.connecting = false; fail('ENETUNREACH'); req.emit('socket', socket); return }
      req.emit('socket', socket)
      if (p === 'hang') return
      if (p === 'refused') { socket.connecting = false; fail('ECONNREFUSED'); return }
      socket.connecting = false; socket.emit('connect')
      if (p === 'tls-fail') { fail('ERR_TLS_CERT_ALTNAME_INVALID'); return }
      socket.emit('secureConnect'); t.wrote = true
      // a connect-phase code, but the request is already out: final
      if (p === 'after-write') { fail('ECONNREFUSED'); return }
      cb({ statusCode: 201, destroy() {} })
    })
    return req
  }) as unknown as typeof https.request
  return { tries, request, writes: () => tries.filter(t => t.wrote).length }
}
const noV6Route = (a: Address): Plan => a.family === 6 ? 'unreachable' : 'ok'
const post = (n: ReturnType<typeof network>, addresses: Address[], o: Partial<Parameters<typeof postPinned>[0]> = {}) =>
  postPinned({ url: new URL('https://push.example.test/v1/send'), signal: new AbortController().signal, beforeSend: () => true, lookup: async () => addresses, request: n.request, body: Buffer.from('{}'), ...o })
const failure = async (p: Promise<unknown>) => { try { await p } catch (e) { expect(e).toBeInstanceOf(PushSendError); return { message: (e as PushSendError).message, ...(e as PushSendError).detail } } throw new Error('expected a failure') }

const pair = () => { const e = crypto.createECDH('prime256v1'); e.generateKeys(); return { publicKey: e.getPublicKey().toString('base64url'), privateKey: padPrivateKey(e.getPrivateKey().toString('base64url')) } }
const webInput = (): PushSend => ({ config: { enabled: true, subject: 'mailto:push@example.test', ...pair() }, subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic', keys: { p256dh: pair().publicKey, auth: crypto.randomBytes(16).toString('base64url') } }, payload: { notificationId: 'n-1', subscriptionId: 's-1', code: 'schedule.success' }, signal: new AbortController().signal, beforeSend: () => true, ttlSeconds: 60 })
const nativeInput = (): NativeSend => ({ device: { platform: 'ios', token: crypto.randomBytes(32).toString('hex'), environment: 'production' }, payload: { notificationId: 'n-1', code: 'schedule.success', locale: 'en', tag: 'device-1' }, config: { url: 'https://push.example.test' }, signal: new AbortController().signal, beforeSend: () => true, ttlSeconds: 90 })

let h: Harness | undefined, service: PushService | undefined
afterEach(async () => { await service?.stop(); service = undefined; await h?.close(); h = undefined })

test('connect order: IPv4 first, then the families alternate, resolver order kept within each', () => {
  expect(connectOrder([v6(V6A), v6(V6B), v4(V4A), v4(V4B)])).toEqual([v4(V4A), v6(V6A), v4(V4B), v6(V6B)])
  expect(connectOrder([v6(V6A), v6(V6B), v4(V4A)])).toEqual([v4(V4A), v6(V6A), v6(V6B)])
  expect(connectOrder([v6(V6A), v6(V6B)])).toEqual([v6(V6A), v6(V6B)])
  expect(connectOrder([v4(V4B), v4(V4A)])).toEqual([v4(V4B), v4(V4A)])
})

test('the gateway lists IPv6 first and this machine has no IPv6 route: the push goes out once, over IPv4', async () => {
  h = await harness('push-fallback-native')
  const n = network(noV6Route)
  const transport = createNativeTransport({ dataDir: h.ctx.config.dataDir, request: n.request, lookup: async () => [v6(V6A), v6(V6B), v4(V4A), v4(V4B)] })
  expect(await transport(nativeInput())).toEqual({ statusCode: 201 })
  expect(n.tries.map(t => t.address)).toEqual([V4A]); expect(n.writes()).toBe(1)
})

test('Web Push: a refused or unroutable address before the connection is up moves to the next checked one; sent once', async () => {
  const n = network(a => a.address === V4A ? 'refused' : a.address === V6A ? 'unreachable' : 'ok')
  const transport = createPushTransport({ request: n.request, lookup: async () => [v6(V6A), v6(V6B), v4(V4A), v4(V4B)] })
  expect(await transport(webInput())).toEqual({ statusCode: 201 })
  expect(n.tries.map(t => t.address)).toEqual([V4A, V6A, V4B]); expect(n.writes()).toBe(1)
  // an IPv4 address that never connects: the next one after the short connect timeout, well inside the bound
  const slow = network(a => a.family === 4 ? 'hang' : 'ok'), started = performance.now()
  expect(await post(slow, [v4(V4A), v6(V6A)], { connectTimeoutMs: 40 })).toEqual({ statusCode: 201 })
  expect(slow.tries.map(t => t.address)).toEqual([V4A, V6A]); expect(slow.writes()).toBe(1)
  expect(performance.now() - started).toBeLessThan(2000)
})

test('once the connection is up, a failure is final: no other address is tried, so nothing is sent twice', async () => {
  for (const [plan, phase] of [['after-write', 'request'], ['tls-fail', 'tls']] as const) {
    const n = network(a => a.address === V4A ? plan : 'ok')
    expect(await failure(post(n, [v4(V4A), v6(V6A), v4(V4B)]))).toMatchObject({ message: 'push_transport_failed', phase, families: '4' })
    expect(n.tries.map(t => t.address)).toEqual([V4A])
  }
  // the native and Web Push transports go through the same path
  h = await harness('push-fallback-final')
  const n = network(() => 'after-write')
  await expect(createNativeTransport({ dataDir: h.ctx.config.dataDir, request: n.request, lookup: async () => [v4(V4A), v4(V4B)] })(nativeInput())).rejects.toThrow('push_transport_failed')
  await expect(createPushTransport({ request: n.request, lookup: async () => [v4(V4A), v4(V4B)] })(webInput())).rejects.toThrow('push_transport_failed')
  expect(n.tries.map(t => t.address)).toEqual([V4A, V4A])
})

test('every address unreachable fails at once; black-holed addresses fail within the overall bound; nothing is written', async () => {
  const n = network(noV6Route), started = performance.now()
  expect(await failure(post(n, [v6(V6A), v6(V6B)]))).toEqual({ message: 'push_transport_failed', phase: 'connect', code: 'ENETUNREACH', families: '6,6' })
  expect(performance.now() - started).toBeLessThan(1000); expect(n.tries).toHaveLength(2); expect(n.writes()).toBe(0)
  const hole = network(() => 'hang'), t0 = performance.now()
  expect(await failure(post(hole, [v6(V6A), v6(V6B), v4(V4A), v4(V4B)], { connectTimeoutMs: 60, timeoutMs: 150 }))).toMatchObject({ message: 'push_timeout', phase: 'connect' })
  const took = performance.now() - t0
  expect(took).toBeGreaterThanOrEqual(140); expect(took).toBeLessThan(2000)
  expect(hole.tries.length).toBeGreaterThanOrEqual(2); expect(hole.writes()).toBe(0)
  // the overall bound also ends a connect that never times out by itself, and no late attempt starts
  const count = hole.tries.length; await Bun.sleep(100); expect(hole.tries).toHaveLength(count)
})

test('beforeSend is checked again right before each next address; private addresses are refused before any socket', async () => {
  const n = network(() => 'refused')
  let checks = 0
  expect(await failure(post(n, [v4(V4A), v6(V6A)], { beforeSend: () => ++checks === 1 }))).toMatchObject({ message: 'push_cancelled' })
  expect(n.tries).toHaveLength(1); expect(checks).toBe(2)
  const blocked = network(() => 'ok')
  expect(await failure(post(blocked, [v4(V4A), v6('fd00::1')]))).toMatchObject({ message: 'push_address_refused' })
  expect(await failure(post(blocked, [v4('10.0.0.5')]))).toMatchObject({ message: 'push_address_refused' })
  expect(blocked.tries).toHaveLength(0)
})

test('the push service logs one outcome line per attempt: codes and families only, never a token or an address', async () => {
  const lines: string[] = []
  h = await harness('push-fallback-log', {}, { log: createLogger({ level: 'debug', sink: l => lines.push(l) }) }); await withOwner(h)
  let addresses = [v6(V6A), v6(V6B)], now = Date.now()
  const n = network(noV6Route)
  service = new PushService(h.ctx, { config: () => null, native: () => ({ url: 'https://push.example.test' }), transport: async () => { throw new Error('no web push here') }, now: () => now,
    nativeTransport: createNativeTransport({ dataDir: h.ctx.config.dataDir, request: n.request, lookup: async () => addresses }) })
  const sid = (h.ctx.db.query("SELECT id FROM sessions WHERE user_id='olga' ORDER BY created_at DESC LIMIT 1").get() as { id: string }).id
  const token = crypto.randomBytes(32).toString('hex')
  service.registerDevice('olga', sid, { consent: true, platform: 'ios', environment: 'production', token })
  now += 10; notificationsOf(h.ctx).connectionReconnect('olga', 'fallback-1', new Date(now).toISOString()); await service.tick()
  expect(h.ctx.db.query('SELECT state,attempts FROM push_deliveries').get()).toEqual({ state: 'pending', attempts: 1 })
  const pushLines = () => lines.map(l => JSON.parse(l)).filter(l => String(l.msg).startsWith('push deliver'))
  expect(pushLines()).toEqual([expect.objectContaining({ level: 'warn', msg: 'push delivery failed', kind: 'native', attempt: 1, outcome: 'push_transport_failed', phase: 'connect', code: 'ENETUNREACH', families: '6,6' })])
  addresses = [v6(V6A), v4(V4A)]; now += 31_000; await service.tick()
  expect(h.ctx.db.query('SELECT state,attempts FROM push_deliveries').get()).toEqual({ state: 'sent', attempts: 2 })
  expect(pushLines()[1]).toMatchObject({ level: 'debug', msg: 'push delivered', kind: 'native', attempt: 2, status: 201 })
  expect(n.writes()).toBe(1)
  for (const l of lines) for (const secret of [token, V6A, V6B, V4A, 'push.example.test']) expect(l).not.toContain(secret)
})
