// The phone app's push: device registration bound to the login session, delivery through the push gateway with the
// same queue, cancellation and retry rules as Web Push (server/src/notifications/push-service.ts, push-native.ts).
import { afterEach, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { WORK } from '../lib/env'
import { EventEmitter } from 'node:events'
import type https from 'node:https'
import { addMember, harness, withOwner, OWNER_PW, type Harness } from './a-lib'
import { PushService, type PushOptions } from '../../server/src/notifications/push-service'
import { notificationsOf } from '../../server/src/notifications/service'
import { registerPushPath } from '../../server/src/notifications/push-events'
import { createNativeTransport, signedGatewayRequest, validGatewayUrl, type NativeSend } from '../../server/src/notifications/push-native'
import { loadAppConfig } from '../../server/src/app-config'
import { parsePushGatewayAuthorization, parsePushGatewaySend, pushGatewaySigningString } from '../../shared/src/cloud-protocol/push-gateway'

let h: Harness, p: PushService
const nowBase = Date.now(); let now = nowBase
const gateway = { url: 'https://push.example.test' }
const iosToken = () => crypto.randomBytes(32).toString('hex')
const device = (token = iosToken()) => ({ consent: true as const, platform: 'ios' as const, environment: 'production' as const, token })
const sessionOf = (user = 'olga') => (h.ctx.db.query('SELECT id FROM sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 1').get(user) as { id: string }).id
async function setup(options: Partial<PushOptions> = {}) {
  now = nowBase; h = await harness('push-native'); await withOwner(h)
  p = new PushService(h.ctx, { config: () => null, native: () => gateway, transport: async () => { throw new Error('no web push here') }, nativeTransport: async () => ({ statusCode: 200 }), now: () => now, ...options })
  return sessionOf()
}
const event = (id: string, user = 'olga') => notificationsOf(h.ctx).connectionReconnect(user, id, new Date(now).toISOString())
afterEach(async () => { await p?.stop(); await h?.close() })

test('off without a gateway; a device is bound to this session, encrypted, idempotent and turns push on', async () => {
  const sid = await setup({ native: () => null })
  expect(p.settings('olga', sid).native).toEqual({ available: false, deviceId: null, gateway: null })
  expect(() => p.registerDevice('olga', sid, device())).toThrow()
  await p.stop(); p = new PushService(h.ctx, { config: () => null, native: () => gateway, now: () => now })
  const d = device(), reg = p.registerDevice('olga', sid, d)
  expect(p.registerDevice('olga', sid, d).id).toBe(reg.id)
  expect(p.settings('olga', sid)).toMatchObject({ enabled: true, native: { available: true, deviceId: reg.id }, subscriptionId: null, optedOut: false })
  const raw = JSON.stringify(h.ctx.db.query('SELECT * FROM push_subscriptions').all())
  expect(raw).not.toContain(d.token); expect(raw).toContain('"kind":"native"')
  for (const bad of [{ ...d, token: d.token.toUpperCase() }, { ...d, token: 'ExponentPushToken[abc]' + 'x'.repeat(40) }, { ...d, platform: 'android' as const, environment: 'sandbox' as const }]) expect(() => p.registerDevice('olga', sid, bad as never)).toThrow()
})

test('an event reaches the phone through the gateway with ids, code, locale and path only; Web Push is not needed', async () => {
  const sent: NativeSend[] = []
  const sid = await setup({ nativeTransport: async i => { sent.push(i); return { statusCode: 200 } } })
  const d = device(); p.registerDevice('olga', sid, d)
  now += 10; event('native-1'); await p.tick(); await p.tick()
  expect(sent).toHaveLength(1)
  expect(sent[0]!.device).toEqual({ platform: 'ios', token: d.token, environment: 'production' })
  expect(sent[0]!.payload).toEqual({ notificationId: expect.any(String), code: 'connection.reconnect', locale: 'ko', path: '/settings/notifications', tag: expect.any(String) })
  expect(sent[0]!.payload.tag).toBe(p.settings('olga', sid).native!.deviceId!)
  expect(sent[0]!.config).toEqual(gateway)
  expect(h.ctx.db.query('SELECT state FROM push_deliveries').get()).toEqual({ state: 'sent' })
})

test('a registered path resolver names the page; anything but an id path is dropped', async () => {
  const sent: NativeSend[] = []
  const sid = await setup({ nativeTransport: async i => { sent.push(i); return { statusCode: 200 } } })
  p.registerDevice('olga', sid, device())
  registerPushPath('connection.reconnect', (_ctx, id) => `/rooms/${id}`)
  now += 10; event('path-1'); await p.tick()
  expect(sent[0]!.payload.path).toBe(`/rooms/${sent[0]!.payload.notificationId}`)
  registerPushPath('connection.reconnect', () => 'https://evil.example/')
  now += 10; event('path-2'); await p.tick()
  expect(sent[1]!.payload.path).toBeUndefined()
  registerPushPath('connection.reconnect', () => '/settings/notifications')
})

test('410 from the gateway deletes the device, its 404 does not; 5xx retries within the bounded budget', async () => {
  let status = 404
  const sid = await setup({ nativeTransport: async () => ({ statusCode: status }) })
  p.registerDevice('olga', sid, device()); now += 10; event('wrong-address'); await p.tick()
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM push_subscriptions').get()).toEqual({ n: 1 })
  status = 410; now += 10; event('gone'); await p.tick()
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM push_subscriptions').get()).toEqual({ n: 0 })
  now += 10; status = 503; p.registerDevice('olga', sid, device()); now += 10; event('retry'); await p.tick()
  now += 31_000; await p.tick(); now += 121_000; await p.tick(); now += 121_000; await p.tick()
  expect(h.ctx.db.query("SELECT state,attempts FROM push_deliveries WHERE state<>'cancelled'").all()).toEqual([{ state: 'failed', attempts: 3 }])
})

test('logout (session revoked) during gateway preparation sends nothing and removes the device', async () => {
  let admitted = 0, finish!: () => void
  const sid = await setup({ nativeTransport: async i => { await new Promise<void>(r => finish = r); if (i.beforeSend()) admitted++; return { statusCode: 200 } } })
  p.registerDevice('olga', sid, device()); now += 10; event('revoke'); const work = p.tick()
  await Bun.sleep(10); h.auth.revokeSession(sid); finish(); await work
  expect(admitted).toBe(0)
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM push_subscriptions').get()).toEqual({ n: 0 })
})

test('turning push off removes the phone too and is remembered; a new gateway address leaves old devices unused', async () => {
  let calls = 0
  const sid = await setup({ nativeTransport: async () => { calls++; return { statusCode: 200 } } })
  p.registerDevice('olga', sid, device())
  expect(p.setEnabled('olga', sid, false)).toMatchObject({ enabled: false, optedOut: true, native: { deviceId: null } })
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM push_subscriptions').get()).toEqual({ n: 0 })
  p.registerDevice('olga', sid, device())
  let url = gateway.url
  await p.stop(); p = new PushService(h.ctx, { config: () => null, native: () => ({ url }), nativeTransport: async () => { calls++; return { statusCode: 200 } }, now: () => now })
  url = 'https://push2.example.test'; now += 10; event('moved'); await p.tick()
  expect(calls).toBe(0)
  expect(p.settings('olga', sid).native).toEqual({ available: true, deviceId: null, gateway: 'push2.example.test' })
})

test('a token belongs to the latest session that registered it, also across accounts on a reinstalled phone', async () => {
  const sid = await setup()
  const shared = device(); p.registerDevice('olga', sid, shared)
  const c2 = h.client(); await c2.login('olga', OWNER_PW)
  const sid2 = sessionOf()
  expect(sid2).not.toBe(sid)
  const second = p.registerDevice('olga', sid2, shared)
  expect(h.ctx.db.query('SELECT id,session_id FROM push_subscriptions').all()).toEqual([{ id: second.id, session_id: sid2 }])
  const mia = await addMember(h, c2, { username: 'mia' })
  const miaReg = p.registerDevice(mia.id, sessionOf(mia.id), shared)
  expect(h.ctx.db.query('SELECT id,user_id FROM push_subscriptions').all()).toEqual([{ id: miaReg.id, user_id: mia.id }])
  expect(() => p.unsubscribe(mia.id, sessionOf(mia.id), miaReg.id, 'web')).toThrow()
  expect(() => p.unsubscribe('olga', sid2, miaReg.id, 'native')).toThrow()
  p.unsubscribe(mia.id, sessionOf(mia.id), miaReg.id, 'native')
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM push_subscriptions').get()).toEqual({ n: 0 })
})

test('the HTTP routes need the session and answer 503 while this server has no gateway', async () => {
  h = await harness('push-native-routes'); const owner = await withOwner(h)
  p = new PushService(h.ctx, { config: () => null, native: () => null })
  const r = await owner.raw('POST', '/api/push/devices', device())
  expect(r.status).toBe(503)
  expect((await h.client().raw('POST', '/api/push/devices', device())).status).toBe(401)
  expect((await owner.call('GET', '/api/push')).native).toEqual({ available: false, deviceId: null, gateway: null })
})

test('the gateway request is signed with the team key over the exact body; private addresses and late cancellation send nothing', async () => {
  h = await harness('push-native-transport')
  let calls = 0, sentBody = '', headers: Record<string, string> = {}, pinned: unknown
  const request = ((options: any, cb: any) => {
    calls++; headers = options.headers; options.lookup(options.hostname, {}, (_e: any, a: any, f: any) => { pinned = { address: a, family: f } })
    const req = new EventEmitter() as any; req.destroy = () => {}; req.end = (b: Buffer) => { sentBody = b.toString(); queueMicrotask(() => cb({ statusCode: 200, destroy() {} })) }; return req
  }) as unknown as typeof https.request
  const input: NativeSend = { device: { platform: 'ios', token: iosToken(), environment: 'production' }, payload: { notificationId: 'n-1', code: 'schedule.success', locale: 'en', path: '/rooms/r1', tag: 'device-1' }, config: gateway, signal: new AbortController().signal, beforeSend: () => true, ttlSeconds: 90 }
  const blocked = createNativeTransport({ dataDir: h.ctx.config.dataDir, request, lookup: async () => [{ address: '10.0.0.5', family: 4 }] })
  await expect(blocked(input)).rejects.toThrow(); expect(calls).toBe(0)
  const valid = createNativeTransport({ dataDir: h.ctx.config.dataDir, request, lookup: async () => [{ address: '8.8.8.8', family: 4 }] })
  expect(await valid(input)).toEqual({ statusCode: 200 }); expect(pinned).toEqual({ address: '8.8.8.8', family: 4 })
  const body = JSON.parse(sentBody)
  expect(parsePushGatewaySend(body)).toEqual(body)
  expect(Object.keys(body).sort()).toEqual(['code', 'environment', 'locale', 'notificationId', 'path', 'platform', 'tag', 'token', 'ttlSeconds', 'v'])
  const auth = parsePushGatewayAuthorization(headers.authorization)!
  const key = crypto.createPublicKey({ key: Buffer.from(auth.key, 'base64'), format: 'der', type: 'spki' })
  expect(crypto.verify(null, Buffer.from(pushGatewaySigningString(auth.ts, crypto.createHash('sha256').update(sentBody).digest('hex'))), key, Buffer.from(auth.sig, 'base64'))).toBe(true)
  expect(crypto.verify(null, Buffer.from(pushGatewaySigningString(auth.ts, crypto.createHash('sha256').update(sentBody + ' ').digest('hex'))), key, Buffer.from(auth.sig, 'base64'))).toBe(false)
  let allowed = true
  const late = createNativeTransport({ dataDir: h.ctx.config.dataDir, request, lookup: async () => { allowed = false; return [{ address: '8.8.8.8', family: 4 }] } })
  await expect(late({ ...input, beforeSend: () => allowed })).rejects.toThrow(); expect(calls).toBe(1)
  // the same team key signs every request (the relay's key file)
  const again = signedGatewayRequest(body, crypto.generateKeyPairSync('ed25519').privateKey, 'AAAA')
  expect(again.body).toBe(sentBody)
})

test('gateway address setting: https host only; off by default, server.json or MYCEL_PUSH_GATEWAY turn it on', () => {
  for (const ok of ['https://push.trina.app', 'https://push.example.test/']) expect(validGatewayUrl(ok)).toBe(ok.replace(/\/$/, ''))
  for (const bad of ['http://push.example.test', 'https://u@push.example.test', 'https://push.example.test:444', 'https://push.example.test/v1', 'https://push.example.test?x', 'https://localhost', 42,
    'http://127.0.0.1', 'http://10.0.0.5:8787', 'http://push.example.test:8787', 'http://127.0.0.1:8787/v1', 'http://u@127.0.0.1:8787']) expect(validGatewayUrl(bad)).toBeNull()
  // a gateway on this machine (next to the server, or a local test) over plain http
  for (const ok of ['http://127.0.0.1:8787', 'http://localhost:8787', 'http://[::1]:8787']) expect(validGatewayUrl(ok)).toBe(ok)
  const dir = path.join(WORK, 'push-native-config'); fs.mkdirSync(dir, { recursive: true })
  const file = (o: object) => { const f = path.join(dir, `server-${Math.random().toString(36).slice(2)}.json`); fs.writeFileSync(f, JSON.stringify(o)); return f }
  const load = (extra: Record<string, string>, o: object = {}) => { try { return loadAppConfig({ argv: ['--config', file(o)], env: extra }).push } catch (e) { return (e as Error).name } }
  expect(load({})).toEqual({ gatewayUrl: null }) // off until the operator chooses a gateway
  expect(load({}, { push: { gatewayUrl: 'https://push.example.test' } })).toEqual({ gatewayUrl: 'https://push.example.test' })
  expect(load({}, { push: { gatewayUrl: null } })).toEqual({ gatewayUrl: null })
  expect(load({ MYCEL_PUSH_GATEWAY: '' })).toEqual({ gatewayUrl: null })
  expect(load({ MYCEL_PUSH_GATEWAY: 'https://push.example.test' })).toEqual({ gatewayUrl: 'https://push.example.test' })
  expect(load({ MYCEL_PUSH_GATEWAY: 'http://push.example.test' })).toBe('ConfigError')
  expect(load({ MYCEL_PUSH_GATEWAY: 'http://127.0.0.1:8787' })).toEqual({ gatewayUrl: 'http://127.0.0.1:8787' })
  expect(load({ MYCEL_PUSH_GATEWAY: 'http://10.0.0.5:8787' })).toBe('ConfigError')
})

test('the app removes its device after a team switch with the key from registration, without a session; nothing else does', async () => {
  const sid = await setup()
  const first = p.registerDevice('olga', sid, device())
  expect(first.removeKey).toMatch(/^[A-Za-z0-9_-]{43}$/)
  const again = p.registerDevice('olga', sid, device())
  // a re-registration of the same token rotates the key; here a new token replaced the row, so the old key is dead too
  p.removeDevice(first.id, { key: first.removeKey })
  expect(h.ctx.db.query('SELECT id FROM push_subscriptions').all()).toEqual([{ id: again.id }])
  p.removeDevice(again.id, { key: 'A'.repeat(43) })
  p.removeDevice('no-such-device', { key: again.removeKey })
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM push_subscriptions').get()).toEqual({ n: 1 })
  const r = await h.client().raw('POST', `/api/push/devices/${again.id}/remove`, { key: 'B'.repeat(43) })
  expect(r.status).toBe(204)
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM push_subscriptions').get()).toEqual({ n: 1 })
  p.removeDevice(again.id, { key: again.removeKey })
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM push_subscriptions').get()).toEqual({ n: 0 })
})
test('registering the same token again rotates the removal key', async () => {
  const sid = await setup()
  const d = device(), one = p.registerDevice('olga', sid, d), two = p.registerDevice('olga', sid, d)
  expect(two.id).toBe(one.id); expect(two.removeKey).not.toBe(one.removeKey)
  p.removeDevice(one.id, { key: one.removeKey })
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM push_subscriptions').get()).toEqual({ n: 1 })
  p.removeDevice(two.id, { key: two.removeKey })
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM push_subscriptions').get()).toEqual({ n: 0 })
})

test('a gateway on this machine gets the same signed request over loopback http; a late cancellation sends nothing', async () => {
  h = await harness('push-native-loopback')
  const seen: { body: string; auth: string | null; path: string }[] = []
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async req => { seen.push({ body: await req.text(), auth: req.headers.get('authorization'), path: new URL(req.url).pathname }); return Response.json({ ok: true }) } })
  try {
    const transport = createNativeTransport({ dataDir: h.ctx.config.dataDir })
    const input: NativeSend = { device: { platform: 'android', token: 'fcm:' + 'A'.repeat(140), environment: 'production' }, payload: { notificationId: 'n-2', code: 'room.dm' as never, locale: 'ko', tag: 'device-2' }, config: { url: `http://127.0.0.1:${server.port}` }, signal: new AbortController().signal, beforeSend: () => true, ttlSeconds: 60 }
    expect(await transport(input)).toEqual({ statusCode: 200 })
    expect(seen).toHaveLength(1); expect(seen[0]!.path).toBe('/v1/send')
    const auth = parsePushGatewayAuthorization(seen[0]!.auth)!
    const key = crypto.createPublicKey({ key: Buffer.from(auth.key, 'base64'), format: 'der', type: 'spki' })
    expect(crypto.verify(null, Buffer.from(pushGatewaySigningString(auth.ts, crypto.createHash('sha256').update(seen[0]!.body).digest('hex'))), key, Buffer.from(auth.sig, 'base64'))).toBe(true)
    await expect(transport({ ...input, beforeSend: () => false })).rejects.toThrow()
    expect(seen).toHaveLength(1)
  } finally { server.stop(true) }
})
