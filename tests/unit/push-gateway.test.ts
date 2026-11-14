// The push gateway (push-gateway/, contract shared/src/cloud-protocol/push-gateway.ts): team servers sign a request
// with their Ed25519 team key, the gateway sends a generic native push through APNs or FCM. Fake providers only (an
// injected fetch), keys generated here at runtime, a fake clock, the in-memory state.
import { describe, expect, test } from 'bun:test'
import { createHash, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  PUSH_GATEWAY_ERRORS, parsePushGatewayAuthorization, parsePushGatewaySend, pushGatewayAuthorization,
  pushGatewaySigningString, validPushBadge, validPushPath, validPushToken,
} from '../../shared/src/cloud-protocol/push-gateway.ts'
import { TEXT } from '../../server/src/notifications/text.ts'
import { clientBucket, createGateway, type GatewayEnv, type LogLine } from '../../push-gateway/src/gateway.ts'
import { memoryState } from '../../push-gateway/src/state.ts'
import { EVENT_TEXT, alertBody } from '../../push-gateway/src/text.ts'
import { gatewayReportsFrom } from '../../push-gateway/src/report.ts'

// ------------------------------------------------------------------ fixtures

const T0 = Date.UTC(2026, 0, 5) // a UTC day (and minute) boundary: the day window starts here
const IP = '192.0.2.10'
const IOS_TOKEN = 'ab'.repeat(32)
const ANDROID_TOKEN = `fcm-token:${'Ab9_'.repeat(12)}`

function teamKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const der = publicKey.export({ format: 'der', type: 'spki' })
  return { priv: privateKey, pub: der.toString('base64'), keyId: createHash('sha256').update(der).digest('hex') }
}
type Team = ReturnType<typeof teamKey>
const TEAM = teamKey()

const apnsKey = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const rsaKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
const SERVICE_ACCOUNT = {
  type: 'service_account', project_id: 'acme-push', client_email: 'push@acme-push.iam.example.test',
  private_key: rsaKey.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  token_uri: 'https://oauth2.googleapis.com/token',
}
const ENV: GatewayEnv = {
  APNS_KEY_ID: 'KEYID12345', APNS_TEAM_ID: 'TEAMID1234', APNS_TOPIC: 'app.example.test',
  APNS_PRIVATE_KEY: apnsKey.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  FCM_SERVICE_ACCOUNT: JSON.stringify(SERVICE_ACCOUNT),
}

const body = (o: Record<string, unknown> = {}) => JSON.stringify({
  v: 1, platform: 'ios', environment: 'production', token: IOS_TOKEN, notificationId: 'n1', code: 'room.message', locale: 'en', ...o,
})
const android = (o: Record<string, unknown> = {}) => body({ platform: 'android', token: ANDROID_TOKEN, ...o })

function signedRequest(team: Team, text: string | Uint8Array<ArrayBuffer>, ts: number, o: { header?: string | null; signBody?: string; key?: string } = {}) {
  const hash = createHash('sha256').update(o.signBody ?? text).digest('hex')
  const sig = sign(null, Buffer.from(pushGatewaySigningString(ts, hash), 'utf8'), team.priv).toString('base64')
  const header = o.header === undefined ? pushGatewayAuthorization(o.key ?? team.pub, ts, sig) : o.header
  return new Request('https://push.example.test/v1/send', {
    method: 'POST', headers: header === null ? {} : { authorization: header, 'content-type': 'application/json' }, body: text,
  })
}

interface Call { url: string; method: string; headers: Headers; body: string; signal?: AbortSignal | null }
type Responder = (c: Call, n: number) => Response | Promise<Response>

const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
const defaultResponder: Responder = (c) => {
  if (c.url === SERVICE_ACCOUNT.token_uri) return json(200, { access_token: 'ya29.test-access-token', expires_in: 3600, token_type: 'Bearer' })
  if (c.url.startsWith('https://fcm.googleapis.com/')) return json(200, { name: 'projects/acme-push/messages/1' })
  return new Response(null, { status: 200, headers: { 'apns-id': 'x' } })
}

function harness(o: { env?: Partial<GatewayEnv>; respond?: Responder; blocked?: Set<string>; replaceEnv?: GatewayEnv; fcmTimeoutMs?: number; failed?: (e: unknown) => void } = {}) {
  const calls: Call[] = []
  const logs: LogLine[] = []
  /** credential alarms (error reports when PUSH_GATEWAY_SENTRY_DSN is set) */
  const alarms: string[] = []
  const clock = { t: T0 }
  const mem = memoryState({ blocked: o.blocked })
  const respond = o.respond ?? defaultResponder
  const gw = createGateway(o.replaceEnv ?? { ...ENV, ...o.env }, {
    fetch: async (url, init) => {
      const c: Call = { url, method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: String(init?.body ?? ''), signal: init?.signal }
      calls.push(c)
      return respond(c, calls.length)
    },
    now: () => clock.t,
    log: (l) => logs.push(l),
    state: mem.state,
    fcmTimeoutMs: o.fcmTimeoutMs,
    alarm: (provider, reason) => alarms.push(`${provider}:${reason}`),
    failed: o.failed,
  })
  const handle = (req: Request, ip = IP) => gw.handle(req, ip)
  const send = (text: string, team: Team = TEAM, opts?: Parameters<typeof signedRequest>[3]) => handle(signedRequest(team, text, clock.t, opts))
  const apnsCalls = () => calls.filter((c) => c.url.includes('push.apple.com'))
  return { gw, handle, calls, logs, clock, mem, send, apnsCalls, alarms }
}

async function expectError(r: Response, error: keyof typeof PUSH_GATEWAY_ERRORS) {
  expect(r.status).toBe(PUSH_GATEWAY_ERRORS[error])
  expect(await r.json()).toEqual({ ok: false, error })
}
async function expectOk(r: Response) {
  expect(r.status).toBe(200)
  expect(await r.json()).toEqual({ ok: true })
}

function decodeJwt(jwt: string) {
  const [h, c, s] = jwt.split('.')
  return {
    header: JSON.parse(Buffer.from(h!, 'base64url').toString()), claims: JSON.parse(Buffer.from(c!, 'base64url').toString()),
    input: `${h}.${c}`, sig: Buffer.from(s!, 'base64url'),
  }
}
const verifyEs256 = (jwt: string, pub: KeyObject) => { const d = decodeJwt(jwt); return verify('sha256', Buffer.from(d.input), { key: pub, dsaEncoding: 'ieee-p1363' }, d.sig) }
const verifyRs256 = (jwt: string, pub: KeyObject) => { const d = decodeJwt(jwt); return verify('sha256', Buffer.from(d.input), pub, d.sig) }

// ------------------------------------------------------------------ contract

describe('push gateway contract', () => {
  const ok = JSON.parse(body())
  test('strict body: the fields and nothing else, each value checked', () => {
    expect(parsePushGatewaySend(ok)).toEqual(ok)
    const full = JSON.parse(android({ path: '/rooms/abc123', ttlSeconds: 3600, locale: 'ko', tag: 'dev_42-a' }))
    expect(parsePushGatewaySend(full)).toEqual(full)
    expect(parsePushGatewaySend({ ...ok, path: '/' })?.path).toBe('/')
    const bad: Record<string, unknown>[] = [
      { extra: 1 }, { v: 2 }, { v: '1' }, { platform: 'web' }, { environment: 'dev' }, { token: 'AB'.repeat(32) }, { token: 'ab'.repeat(31) },
      { notificationId: '' }, { notificationId: 'a'.repeat(101) }, { notificationId: 'a b' }, { code: 'room' }, { code: 'Room.message' },
      { code: 'a.b.c.d.e' }, { code: `a.${'b'.repeat(63)}` }, { code: 'room.' }, { locale: 'fr' }, { path: null }, { path: 'rooms/x' },
      { path: '//x' }, { path: '/rooms/../x' }, { path: '/rooms/x?y=1' }, { path: '/rooms/' }, { path: 'https://example.test/x' },
      { path: `/${'a'.repeat(200)}` }, { ttlSeconds: -1 }, { ttlSeconds: 86_401 }, { ttlSeconds: 1.5 }, { ttlSeconds: '60' }, { ttlSeconds: null },
      { tag: '' }, { tag: 'dev 42' }, { tag: 'x'.repeat(101) }, { tag: 42 }, { tag: null }, { tag: 'dev/42' },
      { badge: -1 }, { badge: 10_000 }, { badge: 1.5 }, { badge: '3' }, { badge: null }, { badge: Number.NaN }, { badge: true },
    ]
    // the app icon's number: a whole number from 0 to 9999, nothing else
    for (const b of [0, 1, 9999]) expect(parsePushGatewaySend({ ...ok, badge: b })?.badge).toBe(b)
    expect(parsePushGatewaySend({ ...ok, tag: 'x'.repeat(100) })?.tag).toBe('x'.repeat(100))
    for (const b of bad) expect(parsePushGatewaySend({ ...ok, ...b })).toBeNull()
    // android tokens are FCM registration tokens, always the production environment
    expect(parsePushGatewaySend(JSON.parse(android({ environment: 'sandbox' })))).toBeNull()
    expect(parsePushGatewaySend(JSON.parse(android({ token: IOS_TOKEN })))).not.toBeNull()
    expect(parsePushGatewaySend(JSON.parse(body({ token: ANDROID_TOKEN })))).toBeNull()
    for (const x of [null, [], 'x', 1]) expect(parsePushGatewaySend(x)).toBeNull()
    const { code: _code, ...noCode } = ok
    expect(parsePushGatewaySend(noCode)).toBeNull()
  })
  test('token and path validators', () => {
    expect(validPushToken('ios', 'a'.repeat(200))).toBe(true)
    expect(validPushToken('ios', 'a'.repeat(201))).toBe(false)
    expect(validPushToken('android', 'x'.repeat(32))).toBe(true)
    expect(validPushToken('android', 'x'.repeat(31))).toBe(false)
    expect(validPushToken('android', 'x'.repeat(3001))).toBe(false)
    expect(validPushToken('android', `${'x'.repeat(40)}/`)).toBe(false)
    expect(validPushPath('/rooms/abc123')).toBe(true)
    expect(validPushPath(`/${'a'.repeat(199)}`)).toBe(true)
    expect(validPushPath('/rooms/abc 123')).toBe(false)
  })
  test('signing string, Authorization header both ways, bounded', () => {
    expect(pushGatewaySigningString(1700000000000, 'e3b0')).toBe('mycel-push-v1\nPOST\n/v1/send\n1700000000000\ne3b0')
    const h = pushGatewayAuthorization(TEAM.pub, 1700000000000, 'c2ln')
    expect(h).toBe(`MycelPush key=${TEAM.pub}, ts=1700000000000, sig=c2ln`)
    expect(parsePushGatewayAuthorization(h)).toEqual({ key: TEAM.pub, ts: 1700000000000, sig: 'c2ln' })
    for (const x of [null, undefined, '', 'MycelRelay team=x, ts=1, sig=c2ln', `mycelpush key=${TEAM.pub}, ts=1, sig=c2ln`,
      `MycelPush key=${TEAM.pub}, ts=-1, sig=c2ln`, `MycelPush key=${TEAM.pub}, ts=1, sig=c2ln, x=1`, `MycelPush key=a, ts=1, sig=${'A'.repeat(201)}`,
      `MycelPush key=${TEAM.pub}, ts=99999999999999999, sig=c2ln`, `MycelPush key=${TEAM.pub},ts=1,sig=c2ln`]) {
      expect(parsePushGatewayAuthorization(x)).toBeNull()
    }
  })
  test('the contract file has no imports and Node loads it as it is (type stripping)', () => {
    const file = path.resolve(import.meta.dir, '../../shared/src/cloud-protocol/push-gateway.ts')
    expect(fs.readFileSync(file, 'utf8')).not.toMatch(/^\s*(import|export .* from)\b/m)
    if (!Bun.which('node')) return
    const p = Bun.spawnSync(['node', '--disable-warning=ExperimentalWarning', '-e', `import(${JSON.stringify(file)}).then((m) => console.log(m.pushGatewaySigningString(1, 'ab'), m.PUSH_GATEWAY_ERRORS.token_invalid))`])
    expect(p.exitCode).toBe(0)
    expect(p.stdout.toString()).toBe('mycel-push-v1\nPOST\n/v1/send\n1\nab 410\n')
  })
})

// ------------------------------------------------------------------ requests and signatures

describe('push gateway: routes, body and signature', () => {
  test('GET /health; everything but POST /v1/send is 404', async () => {
    const { handle } = harness()
    await expectOk(await handle(new Request('https://push.example.test/health')))
    for (const [m, p] of [['GET', '/v1/send'], ['POST', '/v1/other'], ['POST', '/'], ['PUT', '/v1/send'], ['POST', '/health']]) {
      await expectError(await handle(new Request(`https://push.example.test${p}`, { method: m!, body: m === 'GET' ? undefined : '{}' })), 'not_found')
    }
  })

  test('a valid signature is accepted and sent once', async () => {
    const h = harness()
    await expectOk(await h.send(body()))
    expect(h.apnsCalls().length).toBe(1)
    expect(h.logs).toEqual([{ evt: 'push', outcome: 'sent', platform: 'ios', status: 200 }])
  })

  test('missing header, wrong key, tampered body, old or future ts, not an Ed25519 key: 401 and nothing sent', async () => {
    const h = harness()
    const other = teamKey()
    await expectError(await h.send(body(), TEAM, { header: null }), 'unauthorized')
    await expectError(await h.send(body(), TEAM, { header: 'Bearer abc' }), 'unauthorized')
    await expectError(await h.send(body(), TEAM, { key: other.pub }), 'unauthorized')
    await expectError(await h.send(body({ code: 'chat.message' }), TEAM, { signBody: body() }), 'unauthorized')
    const rsaPub = rsaKey.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    await expectError(await h.send(body(), TEAM, { key: rsaPub.slice(0, 200) }), 'unauthorized')
    // a signature over another timestamp
    const r = signedRequest(TEAM, body(), h.clock.t)
    const forged = pushGatewayAuthorization(TEAM.pub, h.clock.t + 1, parsePushGatewayAuthorization(r.headers.get('authorization'))!.sig)
    await expectError(await h.send(body(), TEAM, { header: forged }), 'unauthorized')
    await expectError(await h.handle(signedRequest(TEAM, body(), T0 - 300_001)), 'clock_skew')
    await expectError(await h.handle(signedRequest(TEAM, body(), T0 + 300_001)), 'clock_skew')
    expect(h.calls).toEqual([])
    // ±5 minutes is fine
    await expectOk(await h.handle(signedRequest(TEAM, body({ notificationId: 'edge' }), T0 - 300_000)))
  })

  test('body: larger than 4096 bytes is 413 (streamed, Content-Length not trusted); bad JSON, bad UTF-8, schema: 400', async () => {
    const h = harness()
    const big = body({ notificationId: 'x'.repeat(100), path: `/${'a'.repeat(199)}` }).padEnd(4097, ' ')
    await expectError(await h.send(big), 'body_too_large')
    const chunk = new TextEncoder().encode('x'.repeat(1024))
    const stream = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(chunk) } }) // endless, no Content-Length
    const sig = signedRequest(TEAM, '', h.clock.t).headers.get('authorization')!
    await expectError(await h.handle(new Request('https://push.example.test/v1/send', { method: 'POST', headers: { authorization: sig }, body: stream })), 'body_too_large')
    // exactly 4096 bytes is read (and then refused for its content)
    const short = body({ extra: '' })
    const exact = short.replace('"extra":""', `"extra":"${'x'.repeat(4096 - short.length)}"`)
    expect(exact.length).toBe(4096)
    await expectError(await h.send(exact), 'invalid_body')
    await expectError(await h.send('{"v":1'), 'invalid_body')
    await expectError(await h.send(''), 'invalid_body')
    await expectError(await h.send(body({ extra: true })), 'invalid_body')
    await expectError(await h.send(body({ path: '/rooms/../admin' })), 'invalid_body')
    const badUtf8 = new Uint8Array([...new TextEncoder().encode('{"v":1,"x":"'), 0xff, ...new TextEncoder().encode('"}')])
    await expectError(await h.handle(signedRequest(TEAM, badUtf8, h.clock.t)), 'invalid_body')
    expect(h.calls).toEqual([])
  })
})

// ------------------------------------------------------------------ TOFU, limits, dedupe

describe('push gateway: trust on first use, limits, dedupe', () => {
  test('an unknown key is recorded with its first-seen time; a blocked key is 403', async () => {
    const h = harness({ blocked: new Set() })
    await expectOk(await h.send(body()))
    expect(h.mem.shards.shards.get(`k:${TEAM.keyId}`)?.get('seen')).toEqual({ firstSeenMs: T0 }) // confirmed: delivered
    h.clock.t += 3600_000
    await expectOk(await h.send(body({ notificationId: 'n2' })))
    expect(h.mem.shards.shards.get(`k:${TEAM.keyId}`)?.get('seen')).toEqual({ firstSeenMs: T0 }) // kept, not moved
    const bad = teamKey()
    h.mem.blocked.add(bad.keyId)
    const before = h.calls.length
    await expectError(await h.send(body(), bad), 'key_blocked')
    expect(h.calls.length).toBe(before)
    expect(h.mem.shards.shards.has(`k:${bad.keyId}`)).toBe(false)
  })

  test('a young key gets 120 a minute; after 24 h the established limit (1200)', async () => {
    const h = harness()
    const token = (i: number) => i.toString(16).padStart(4, '0').repeat(16)
    for (let i = 0; i < 120; i++) expect((await h.send(body({ token: token(i), notificationId: `y${i}` }))).status).toBe(200)
    const r = await h.send(body({ token: token(120), notificationId: 'y120' }))
    await expectError(r, 'rate_limited')
    expect(r.headers.get('retry-after')).toBe('60')
    h.clock.t += 24 * 3600_000
    for (let i = 0; i < 121; i++) expect((await h.send(body({ token: token(i), notificationId: `e${i}` }))).status).toBe(200)
    expect(h.apnsCalls().length).toBe(241)
  })

  test('a device token gets 20 a minute and 200 a day (429 with Retry-After); a refused send can be sent later', async () => {
    const h = harness()
    for (let i = 0; i < 20; i++) await expectOk(await h.send(body({ notificationId: `m${i}` })))
    h.clock.t += 15_000
    const r = await h.send(body({ notificationId: 'm20' }))
    await expectError(r, 'rate_limited')
    expect(r.headers.get('retry-after')).toBe('45')
    h.clock.t = T0 + 60_000
    await expectOk(await h.send(body({ notificationId: 'm20' }))) // not a duplicate: the refused one was not reserved
    for (let m = 1; m < 10; m++) {
      h.clock.t = T0 + m * 60_000
      for (let i = m === 1 ? 1 : 0; i < 20; i++) await expectOk(await h.send(body({ notificationId: `d${m}-${i}` })))
    }
    h.clock.t = T0 + 10 * 60_000
    const day = await h.send(body({ notificationId: 'over' }))
    await expectError(day, 'rate_limited')
    expect(Number(day.headers.get('retry-after'))).toBe((86_400_000 - 10 * 60_000) / 1000)
    expect(h.apnsCalls().length).toBe(200)
    // another device of the same team is not affected
    await expectOk(await h.send(body({ token: 'cd'.repeat(32), notificationId: 'over' })))
  })

  test('the same (key, token, notificationId) within 10 minutes is 200 without sending again', async () => {
    const h = harness()
    await expectOk(await h.send(body()))
    h.clock.t += 1000
    await expectOk(await h.send(body())) // a replay of the same request inside the ts window too
    expect(h.apnsCalls().length).toBe(1)
    expect(h.logs.map((l) => l.outcome)).toEqual(['sent', 'duplicate'])
    // another team server sending the same id to the same phone is its own notification
    await expectOk(await h.send(body(), teamKey()))
    expect(h.apnsCalls().length).toBe(2)
    h.clock.t = T0 + 10 * 60_000
    await expectOk(await h.send(body()))
    expect(h.apnsCalls().length).toBe(3)
  })

  test('a key that never had a delivered send is forgotten after 24 h; the first delivered send keeps it', async () => {
    let down = true
    const h = harness({ respond: (c, n) => (down ? new Response(null, { status: 500 }) : defaultResponder(c, n)) })
    const shard = () => h.mem.shards.shards.get(`k:${TEAM.keyId}`)
    await expectError(await h.send(body()), 'provider_error')
    expect(shard()?.get('seen')).toEqual({ firstSeenMs: T0, until: T0 + 86_400_000 })
    h.mem.shards.sweep(T0 + 86_400_000)
    expect(shard()).toBeUndefined() // nothing of a key that never delivered stays
    await expectError(await h.send(body()), 'provider_error')
    // an expired record that was not swept yet counts as new too
    h.clock.t = T0 + 86_400_000
    down = false
    await expectOk(await h.send(body()))
    expect(shard()?.get('seen')).toEqual({ firstSeenMs: T0 + 86_400_000 })
    h.mem.shards.sweep(T0 + 30 * 86_400_000)
    expect([...shard()!.keys()]).toEqual(['seen'])
  })

  test('the device budget is per (key, token): one team server cannot use up a phone for another team', async () => {
    const h = harness()
    for (let i = 0; i < 20; i++) await expectOk(await h.send(body({ notificationId: `a${i}` })))
    await expectError(await h.send(body({ notificationId: 'a20' })), 'rate_limited')
    await expectOk(await h.send(body({ notificationId: 'b0' }), teamKey()))
    const pair = createHash('sha256').update(`${TEAM.keyId}:${createHash('sha256').update(IOS_TOKEN).digest('hex')}`).digest('hex')
    expect(h.mem.shards.shards.get(`t:${pair}`)?.get('b:min')).toEqual({ w: T0 / 60_000, n: 20, until: T0 + 60_000 })
  })

  test('a client address gets 600 send requests a minute, counted before the signature; IPv6 by its /64', async () => {
    const h = harness()
    const unsigned = () => new Request('https://push.example.test/v1/send', { method: 'POST', body: body() })
    for (let i = 0; i < 600; i++) expect((await h.handle(unsigned(), '2001:db8:1:2::1')).status).toBe(401)
    const r = await h.handle(signedRequest(TEAM, body(), h.clock.t), '2001:db8:1:2:ffff::9') // the same /64
    await expectError(r, 'rate_limited')
    expect(r.headers.get('retry-after')).toBe('60')
    expect(h.calls).toEqual([])
    await expectOk(await h.handle(signedRequest(TEAM, body(), h.clock.t), '2001:db8:1:3::1'))
    await expectOk(await h.handle(new Request('https://push.example.test/health'), '2001:db8:1:2::1')) // not counted
    h.clock.t += 60_000
    await expectOk(await h.handle(signedRequest(TEAM, body({ notificationId: 'n2' }), h.clock.t), '2001:db8:1:2::1'))
  })

  test('client buckets: IPv4 as it is, IPv6 by /64, mapped IPv4 as IPv4, anything else shared', () => {
    const cases: [string, string][] = [
      ['192.0.2.1', '192.0.2.1'], ['::ffff:192.0.2.1', '192.0.2.1'], ['2001:db8::1', '2001:db8:0:0::/64'],
      ['2001:0DB8:0000:0000:0001::', '2001:db8:0:0::/64'], ['fe80::1%en0', 'fe80:0:0:0::/64'], ['::1', '0:0:0:0::/64'],
      ['1:2:3:4:5:6:7:8', '1:2:3:4::/64'], ['1:2:3:4:5:6:7:8:9', 'other'], ['1::2::3', 'other'], ['unknown', 'other'], ['', 'other'],
    ]
    for (const [a, want] of cases) expect(clientBucket(a)).toBe(want)
  })

  test('a send that failed is not remembered: the retry sends', async () => {
    const h = harness({ respond: (c, n) => (n === 1 ? new Response('{"reason":"InternalServerError"}', { status: 500 }) : defaultResponder(c, n)) })
    await expectError(await h.send(body()), 'provider_error')
    await expectOk(await h.send(body()))
    expect(h.apnsCalls().length).toBe(2)
  })
})

// ------------------------------------------------------------------ APNs

describe('push gateway: APNs', () => {
  test('request shape: host by environment, headers, provider token, a body with no extra fields', async () => {
    const h = harness({ env: { APNS_SANDBOX: 'on' } })
    await expectOk(await h.send(body({ path: '/rooms/abc123', ttlSeconds: 3600, locale: 'ko', tag: 'dev_42' })))
    await expectOk(await h.send(body({ environment: 'sandbox', notificationId: 'n2', code: 'schedule.failure' })))
    const [prod, sandbox] = h.apnsCalls()
    expect(prod!.url).toBe(`https://api.push.apple.com/3/device/${IOS_TOKEN}`)
    expect(sandbox!.url).toBe(`https://api.sandbox.push.apple.com/3/device/${IOS_TOKEN}`)
    expect(prod!.method).toBe('POST')
    expect(Object.fromEntries([...prod!.headers].filter(([k]) => k !== 'authorization'))).toEqual({
      'apns-topic': 'app.example.test', 'apns-push-type': 'alert', 'apns-priority': '10',
      'apns-expiration': String(T0 / 1000 + 3600), 'apns-collapse-id': 'n1', 'content-type': 'application/json',
    })
    expect(sandbox!.headers.get('apns-expiration')).toBe('0')
    // only aps and body at the top level: expo-notifications reads the data from userInfo["body"] on iOS
    // a room notice is mutable (the app's extension may put who and where in the title); the generic alert stays
    expect(JSON.parse(prod!.body)).toEqual({
      aps: { alert: { title: 'Trina AX', body: '새 메시지가 있어요' }, sound: 'default', 'mutable-content': 1 },
      body: { notificationId: 'n1', code: 'room.message', path: '/rooms/abc123', device: 'dev_42' },
    })
    expect(JSON.parse(sandbox!.body)).toEqual({
      aps: { alert: { title: 'Trina AX', body: 'A scheduled task needs your attention.' }, sound: 'default' },
      body: { notificationId: 'n2', code: 'schedule.failure' },
    })
    const auth = prod!.headers.get('authorization')!
    expect(auth).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/)
    const jwt = auth.slice('bearer '.length)
    const d = decodeJwt(jwt)
    expect(d.header).toEqual({ alg: 'ES256', kid: 'KEYID12345' })
    expect(d.claims).toEqual({ iss: 'TEAMID1234', iat: T0 / 1000 })
    expect(verifyEs256(jwt, apnsKey.publicKey)).toBe(true)
    expect(verifyEs256(jwt, generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey)).toBe(false)
    expect(sandbox!.headers.get('authorization')).toBe(auth) // the token is reused
  })

  test('only room notices and a chat shared by name are mutable; the generic alert is the fallback and no name or new field reaches APNs', async () => {
    const h = harness()
    for (const [i, code] of ['room.dm', 'room.mention', 'schedule.success', 'connection.reconnect', 'chat.reply', 'roomx.dm', 'chat.shared', 'chat.shared_x'].entries()) await expectOk(await h.send(body({ notificationId: `m${i}`, code, locale: 'en', tag: 'dev_7' })))
    const sent = h.apnsCalls().map(c => JSON.parse(c.body) as { aps: Record<string, unknown>; body: Record<string, string> })
    expect(sent.map(p => p.aps['mutable-content'] ?? null)).toEqual([1, 1, null, null, null, null, 1, null])
    // what the phone shows when the extension gets no answer (or the app has none): today's words, unchanged
    expect(sent[0]!.aps.alert).toEqual({ title: 'Trina AX', body: 'You have a new message' })
    expect(sent[1]!.aps.alert).toEqual({ title: 'Trina AX', body: 'You have a new message' })
    // a chat shared by name: its own generic line, never who or which chat (the extension asks the team for who)
    expect(sent[6]!.aps.alert).toEqual({ title: 'Trina AX', body: 'Someone shared a chat with you.' })
    for (const p of sent) {
      expect(Object.keys(p).sort()).toEqual(['aps', 'body'])
      expect(Object.keys(p.aps).filter(k => k !== 'mutable-content').sort()).toEqual(['alert', 'sound'])
      expect(Object.keys(p.body).sort()).toEqual(['code', 'device', 'notificationId'])
    }
    // the contract has no field for a name: a team server cannot send one
    await expectError(await h.send(body({ notificationId: 'm9', code: 'room.dm', title: '민준 · #마케팅' })), 'invalid_body')
  })

  test('badge: the number goes to aps.badge (0 too, it clears the icon), and only when the request has one', async () => {
    const h = harness()
    await expectOk(await h.send(body({ notificationId: 'b1', badge: 7 })))
    await expectOk(await h.send(body({ notificationId: 'b2', badge: 0, code: 'schedule.success' })))
    await expectOk(await h.send(body({ notificationId: 'b3' })))
    const sent = h.apnsCalls().map(c => JSON.parse(c.body) as { aps: Record<string, unknown>; body: Record<string, string> })
    expect(sent.map(p => p.aps.badge ?? null)).toEqual([7, 0, null])
    // a number only: nothing about what it counts reaches APNs or the app's data
    for (const p of sent) expect(Object.keys(p.body).sort()).toEqual(['code', 'notificationId'])
  })

  test('the provider token is reused for at most 50 minutes; long ids collapse by their hash; APP_TITLE', async () => {
    const h = harness({ env: { APP_TITLE: 'Acme' } })
    await expectOk(await h.send(body()))
    h.clock.t += 49 * 60_000
    await expectOk(await h.send(body({ notificationId: 'n2' })))
    h.clock.t += 2 * 60_000
    const long = 'L'.repeat(100)
    await expectOk(await h.send(body({ notificationId: long })))
    const [a, b, c] = h.apnsCalls()
    expect(b!.headers.get('authorization')).toBe(a!.headers.get('authorization')!)
    expect(c!.headers.get('authorization')).not.toBe(a!.headers.get('authorization')!)
    expect(verifyEs256(c!.headers.get('authorization')!.slice(7), apnsKey.publicKey)).toBe(true)
    expect(c!.headers.get('apns-collapse-id')).toBe(createHash('sha256').update(long).digest('hex'))
    expect(JSON.parse(c!.body).aps.alert.title).toBe('Acme')
    expect(decodeJwt(c!.headers.get('authorization')!.slice(7)).claims.iat).toBe(h.clock.t / 1000)
  })

  test('410, Unregistered and BadDeviceToken: 410 so the team server deletes the device; other failures 502', async () => {
    const cases: [number, string | null, number][] = [
      [410, 'Unregistered', 410], [410, null, 410], [400, 'BadDeviceToken', 410], [400, 'BadTopic', 502], [500, 'InternalServerError', 502],
      [503, 'ServiceUnavailable', 502], [429, 'TooManyRequests', 502], [403, 'InvalidProviderToken', 502],
    ]
    for (const [status, reason, want] of cases) {
      const h = harness({ respond: () => new Response(reason ? JSON.stringify({ reason }) : null, { status }) })
      const r = await h.send(body())
      expect(r.status).toBe(want)
      expect(h.apnsCalls().length).toBe(1)
    }
    const thrown = harness({ respond: () => { throw new Error('connect ECONNREFUSED') } })
    await expectError(await thrown.send(body()), 'provider_error')
  })

  test('403 ExpiredProviderToken: one new token, then the answer of that try', async () => {
    const expiredOnce = harness({ respond: (c, n) => (n === 1 ? json(403, { reason: 'ExpiredProviderToken' }) : defaultResponder(c, n)) })
    await expectOk(await expiredOnce.send(body()))
    const [first, retry] = expiredOnce.apnsCalls()
    expect(retry!.headers.get('authorization')).not.toBe(first!.headers.get('authorization')!)
    expect(decodeJwt(retry!.headers.get('authorization')!.slice(7)).claims.iat).toBe(expiredOnce.clock.t / 1000)
    const always = harness({ respond: () => json(403, { reason: 'ExpiredProviderToken' }) })
    await expectError(await always.send(body()), 'provider_error')
    expect(always.apnsCalls().length).toBe(2)
  })

  test('sandbox tokens are 503 unsupported_environment unless APNS_SANDBOX=on', async () => {
    for (const v of [undefined, 'off', '1', 'true']) {
      const h = harness({ env: { APNS_SANDBOX: v } })
      await expectError(await h.send(body({ environment: 'sandbox' })), 'unsupported_environment')
      expect(h.calls).toEqual([])
    }
  })
})

// ------------------------------------------------------------------ FCM

describe('push gateway: FCM', () => {
  test('OAuth: an RS256 assertion exchanged at token_uri, cached until 60 s before expiry; send shape', async () => {
    const h = harness()
    await expectOk(await h.send(android({ path: '/rooms/abc123', ttlSeconds: 600, locale: 'ja', code: 'connection.reconnect', tag: 'dev-7' })))
    const [oauth, send] = h.calls
    expect(oauth!.url).toBe('https://oauth2.googleapis.com/token')
    expect(oauth!.method).toBe('POST')
    expect(oauth!.headers.get('content-type')).toBe('application/x-www-form-urlencoded')
    const form = new URLSearchParams(oauth!.body)
    expect([...form.keys()]).toEqual(['grant_type', 'assertion'])
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    const assertion = form.get('assertion')!
    expect(verifyRs256(assertion, rsaKey.publicKey)).toBe(true)
    const d = decodeJwt(assertion)
    expect(d.header).toEqual({ alg: 'RS256', typ: 'JWT' })
    expect(d.claims).toEqual({
      iss: 'push@acme-push.iam.example.test', scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token', iat: T0 / 1000, exp: T0 / 1000 + 3600,
    })
    expect(send!.url).toBe('https://fcm.googleapis.com/v1/projects/acme-push/messages:send')
    expect(send!.headers.get('authorization')).toBe('Bearer ya29.test-access-token')
    expect(JSON.parse(send!.body)).toEqual({
      message: {
        token: ANDROID_TOKEN,
        notification: { title: 'Trina AX', body: '接続のために再ログインが必要です。' },
        // flat strings and no key named "body" (Android would read a JSON "body" as expo-notifications' own format)
        data: { notificationId: 'n1', code: 'connection.reconnect', path: '/rooms/abc123', device: 'dev-7' },
        android: { priority: 'HIGH', ttl: '600s', collapse_key: 'n1', notification: { channel_id: 'default', tag: 'n1' } },
      },
    })
    h.clock.t += 3600_000 - 61_000
    await expectOk(await h.send(android({ notificationId: 'n2' })))
    expect(JSON.parse(h.calls[2]!.body).message.android.notification).toEqual({ channel_id: 'default', tag: 'n2' })
    expect(h.calls.length).toBe(3) // the cached token
    expect(JSON.parse(h.calls[2]!.body).message.data).toEqual({ notificationId: 'n2', code: 'room.message' })
    expect(JSON.parse(h.calls[2]!.body).message.android.ttl).toBe('0s')
    h.clock.t += 2000
    await expectOk(await h.send(android({ notificationId: 'n3' })))
    expect(h.calls.map((c) => c.url.includes('oauth2'))).toEqual([true, false, false, true, false])
  })

  test('UNREGISTERED and an invalid registration token: 410; 5xx, 429, OAuth failure: 502', async () => {
    const fcmError = (status: number, s: string, message: string, errorCode?: string) => json(status, {
      error: { code: status, message, status: s, details: errorCode ? [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode }] : [] },
    })
    const cases: [Response, number][] = [
      [fcmError(404, 'NOT_FOUND', 'Requested entity was not found.', 'UNREGISTERED'), 410],
      [fcmError(400, 'INVALID_ARGUMENT', 'The registration token is not a valid FCM registration token', 'INVALID_ARGUMENT'), 410],
      [fcmError(400, 'INVALID_ARGUMENT', 'Invalid value at message.android.ttl', 'INVALID_ARGUMENT'), 502],
      [fcmError(500, 'INTERNAL', 'Internal error', 'INTERNAL'), 502],
      [fcmError(503, 'UNAVAILABLE', 'Unavailable', 'UNAVAILABLE'), 502],
      [fcmError(429, 'RESOURCE_EXHAUSTED', 'Quota', 'QUOTA_EXCEEDED'), 502],
      [new Response('<html>bad gateway</html>', { status: 502 }), 502],
    ]
    for (const [res, want] of cases) {
      const h = harness({ respond: (c, n) => (c.url.startsWith('https://fcm.') ? res.clone() : defaultResponder(c, n)) })
      expect((await h.send(android())).status).toBe(want)
    }
    const oauthDown = harness({ respond: (c, n) => (c.url.includes('oauth2') ? json(400, { error: 'invalid_grant' }) : defaultResponder(c, n)) })
    await expectError(await oauthDown.send(android()), 'provider_error')
    expect(oauthDown.calls.filter((c) => c.url.startsWith('https://fcm.')).length).toBe(0)
  })

  test('a hanging FCM or OAuth call ends within the time limit as 502 and frees the dedupe entry: the retry sends (TC-387)', async () => {
    // a provider that never answers; only the gateway's abort signal ends the call (like fetch does)
    const hang = (c: Call) => new Promise<Response>((_, reject) => {
      if (!c.signal) return // no signal: hangs for ever, the test times out
      c.signal.addEventListener('abort', () => reject(c.signal!.reason), { once: true })
    })
    for (const where of ['https://fcm.', 'https://oauth2.']) {
      let stuck = true
      const h = harness({ fcmTimeoutMs: 50, respond: (c, n) => (stuck && c.url.startsWith(where) ? hang(c) : defaultResponder(c, n)) })
      const started = performance.now()
      await expectError(await h.send(android()), 'provider_error')
      expect(performance.now() - started).toBeLessThan(2000)
      expect(h.calls.every((c) => c.signal instanceof AbortSignal)).toBe(true)
      // the team server's retry (same notificationId) is sent, not answered as a duplicate
      stuck = false
      await expectOk(await h.send(android()))
      expect(h.calls.filter((c) => c.url.startsWith('https://fcm.')).length).toBe(where === 'https://fcm.' ? 2 : 1)
      expect(h.logs.map((l) => l.outcome)).toEqual(['provider_error', 'sent'])
    }
  })

  test('an FCM error answer whose body stops after the headers ends within the limit as 502', async () => {
    const stalled = (c: Call) => new Response(new ReadableStream<Uint8Array>({
      start(ctl) {
        ctl.enqueue(new TextEncoder().encode('{"error":{"status":"UNAVA'))
        c.signal?.addEventListener('abort', () => ctl.error(c.signal!.reason), { once: true })
      },
    }), { status: 503, headers: { 'content-type': 'application/json' } })
    const h = harness({ fcmTimeoutMs: 50, respond: (c, n) => (c.url.startsWith('https://fcm.') ? stalled(c) : defaultResponder(c, n)) })
    const started = performance.now()
    await expectError(await h.send(android()), 'provider_error')
    expect(performance.now() - started).toBeLessThan(2000)
  })

  test('the default FCM time limit is shorter than the team server\'s 10 s wait', async () => {
    const { FCM_TIMEOUT_MS } = await import('../../push-gateway/src/fcm.ts')
    const service = fs.readFileSync(path.resolve(import.meta.dir, '../../server/src/notifications/push-service.ts'), 'utf8')
    expect(service).toContain('this.o.requestTimeoutMs??10_000')
    expect(service).toContain('this.o.now()+(attempts===1?30_000:120_000)') // the first retry comes 30 s later
    expect(FCM_TIMEOUT_MS).toBeLessThan(10_000)
  })
})

// ------------------------------------------------------------------ configuration, text, logs

describe('push gateway: badge', () => {
  test('contract: an optional whole number from 0 to 9999; absent stays absent (an older team server)', () => {
    for (const n of [0, 1, 42, 9999]) expect(validPushBadge(n)).toBe(true)
    for (const n of [-1, 10_000, 0.5, '1', null, undefined, Number.POSITIVE_INFINITY]) expect(validPushBadge(n)).toBe(false)
    expect(parsePushGatewaySend(JSON.parse(body()))).not.toHaveProperty('badge')
  })

  test('a bad badge is refused as a bad body, before anything is sent', async () => {
    const h = harness()
    await expectError(await h.send(body({ badge: -1 })), 'invalid_body')
    await expectError(await h.send(body({ badge: 10_000 })), 'invalid_body')
    expect(h.apnsCalls().length).toBe(0)
  })
})

describe('push gateway: FCM badge', () => {
  test('badge: accepted, but not sent to FCM (launchers add up each notification\'s count); never in data', async () => {
    const h = harness()
    await expectOk(await h.send(android({ notificationId: 'b1', badge: 12 })))
    await expectOk(await h.send(android({ notificationId: 'b2', badge: 0 })))
    const sends = h.calls.filter(c => c.url.includes('fcm.googleapis.com')).map(c => JSON.parse(c.body).message)
    expect(sends[0].android.notification).toEqual({ channel_id: 'default', tag: 'b1' })
    expect(sends[1].android.notification).toEqual({ channel_id: 'default', tag: 'b2' })
    for (const m of sends) expect(Object.keys(m.data).sort()).toEqual(['code', 'notificationId'])
  })
})

describe('push gateway: configuration, text and logs', () => {
  test('a platform without credentials is 503 not_configured', async () => {
    const noApns = harness({ replaceEnv: { FCM_SERVICE_ACCOUNT: ENV.FCM_SERVICE_ACCOUNT } })
    await expectError(await noApns.send(body()), 'not_configured')
    await expectOk(await noApns.send(android()))
    const noFcm = harness({ replaceEnv: { ...ENV, FCM_SERVICE_ACCOUNT: undefined } })
    await expectError(await noFcm.send(android()), 'not_configured')
    await expectOk(await noFcm.send(body()))
    const brokenFcm = harness({ env: { FCM_SERVICE_ACCOUNT: '{"project_id":"x"}' } })
    await expectError(await brokenFcm.send(android()), 'not_configured')
    expect(brokenFcm.logs[0]).toEqual({ evt: 'config', outcome: 'fcm_invalid' })
    // a .p8 that is not a key: the provider fails, nothing is sent
    const badKey = harness({ env: { APNS_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----' } })
    await expectError(await badKey.send(body()), 'provider_error')
    expect(badKey.calls).toEqual([])
    // a PEM pasted on one line with \n written out works
    const oneLine = harness({ env: { APNS_PRIVATE_KEY: ENV.APNS_PRIVATE_KEY!.replace(/\n/g, '\\n') } })
    await expectOk(await oneLine.send(body()))
  })

  test('generic text only: the event texts are the team server\'s; room./chat. say "new message", the rest "new notification"', () => {
    for (const code of ['schedule.success', 'schedule.failure', 'connection.reconnect', 'chat.answer_done', 'chat.shared', 'room_app.paused'] as const) expect(EVENT_TEXT[code]).toEqual(TEXT[code])
    expect(alertBody('chat.shared', 'ko')).toBe('누군가 채팅을 공유했어요.')
    expect(alertBody('room_app.paused', 'en')).toBe('An app in a room was paused for today.')
    expect(alertBody('chat.answer_done', 'en')).toBe('Trina replied in your chat.')
    expect(alertBody('room.message', 'id')).toBe('Ada pesan baru')
    expect(alertBody('chat.mention', 'es')).toBe('Tienes un mensaje nuevo')
    expect(alertBody('schedule.success', 'en')).toBe('A scheduled task completed.')
    expect(alertBody('task.done', 'ko')).toBe('새 알림이 있어요')
    expect(alertBody('constructor.x', 'ja')).toBe('新しいお知らせがあります')
    expect(alertBody('rooms.message', 'en')).toBe('You have a new notification')
  })

  test('logs carry outcome codes only: no token, body, key, signature, provider token or provider answer', async () => {
    const secrets = ['Unregistered', 'BadDeviceToken', 'registration token', 'InternalServerError']
    const h = harness({
      env: { APNS_SANDBOX: 'on' },
      respond: (c, n) => {
        if (c.url.includes('/3/device/') && c.url.includes('dead')) return json(410, { reason: 'Unregistered' })
        if (c.url.startsWith('https://fcm.') && c.body.includes('broken')) return json(500, { error: { message: 'InternalServerError' } })
        return defaultResponder(c, n)
      },
    })
    const dead = 'dead'.repeat(16)
    const requests = [body(), body(), body({ token: dead }), android(), android({ token: `broken:${'x'.repeat(40)}` }), body({ extra: 1 }), body({ environment: 'sandbox', notificationId: 's' })]
    for (const b of requests) await h.send(b)
    await h.send(body(), TEAM, { header: null })
    await h.handle(signedRequest(TEAM, body(), T0 - 999_999))
    expect(h.logs.map((l) => l.outcome)).toEqual(['sent', 'duplicate', 'token_invalid', 'sent', 'provider_error', 'invalid_body', 'sent', 'unauthorized', 'clock_skew'])
    for (const l of h.logs) for (const k of Object.keys(l)) expect(['evt', 'outcome', 'platform', 'status']).toContain(k)
    const text = JSON.stringify(h.logs)
    const tokenIds = [IOS_TOKEN, dead, ANDROID_TOKEN].map((t) => createHash('sha256').update(t).digest('hex'))
    for (const s of [IOS_TOKEN, dead, ANDROID_TOKEN, 'broken', TEAM.pub, TEAM.keyId, 'ya29', 'room.message', 'n1', 'bearer', IP, '192.0.2', ...tokenIds, ...secrets]) expect(text).not.toContain(s)
    for (const c of h.calls) if (c.headers.get('authorization')?.startsWith('bearer ')) expect(text).not.toContain(c.headers.get('authorization')!.slice(7, 40))
  })
})

// ------------------------------------------------------------------ error reports (report.ts)

describe('push gateway: our credentials refused are reported, dead device tokens are not', () => {
  test('APNs: a refused provider token, key, team or topic alarms with its reason; a dead device does not', async () => {
    const cases: [number, string | null, string[]][] = [
      [403, 'InvalidProviderToken', ['apns:InvalidProviderToken']], [403, 'MissingProviderToken', ['apns:MissingProviderToken']],
      [400, 'TopicDisallowed', ['apns:TopicDisallowed']], [400, 'BadTopic', ['apns:BadTopic']], [403, 'BadCertificate', ['apns:BadCertificate']],
      [403, null, ['apns:http_403']],
      // one phone: not an operator problem
      [410, 'Unregistered', []], [410, null, []], [400, 'BadDeviceToken', []],
      // Apple's own trouble or a busy device: logged as 502, not a credential alarm
      [500, 'InternalServerError', []], [503, 'ServiceUnavailable', []], [429, 'TooManyRequests', []], [400, 'PayloadTooLarge', []],
    ]
    for (const [status, reason, want] of cases) {
      const h = harness({ respond: () => new Response(reason ? JSON.stringify({ reason }) : null, { status }) })
      await h.send(body())
      expect({ status, reason, alarms: h.alarms }).toEqual({ status, reason, alarms: want })
    }
    // ExpiredProviderToken once is renewed silently; for a token signed just now it is our key's fault
    const once = harness({ respond: (c, n) => (n === 1 ? json(403, { reason: 'ExpiredProviderToken' }) : defaultResponder(c, n)) })
    await expectOk(await once.send(body()))
    expect(once.alarms).toEqual([])
    const always = harness({ respond: () => json(403, { reason: 'ExpiredProviderToken' }) })
    await always.send(body())
    expect(always.alarms).toEqual(['apns:ExpiredProviderToken'])
    // a key that cannot be read
    const badKey = harness({ env: { APNS_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----' } })
    await expectError(await badKey.send(body()), 'provider_error')
    expect(badKey.alarms).toEqual(['apns:key_unreadable'])
  })

  test('FCM: a refused service account alarms; UNREGISTERED, a bad token and SENDER_ID_MISMATCH do not', async () => {
    const fcmError = (status: number, s: string, message: string, errorCode?: string) => json(status, {
      error: { code: status, message, status: s, details: errorCode ? [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode }] : [] },
    })
    const cases: [Response, string[]][] = [
      [fcmError(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.'), ['fcm:UNAUTHENTICATED']],
      [fcmError(403, 'PERMISSION_DENIED', 'Permission denied on resource project.'), ['fcm:PERMISSION_DENIED']],
      [fcmError(401, 'UNAUTHENTICATED', 'Auth error from APNS or Web Push Service', 'THIRD_PARTY_AUTH_ERROR'), ['fcm:THIRD_PARTY_AUTH_ERROR']],
      [new Response('forbidden', { status: 403 }), ['fcm:http_403']],
      [fcmError(404, 'NOT_FOUND', 'Requested entity was not found.', 'UNREGISTERED'), []],
      [fcmError(400, 'INVALID_ARGUMENT', 'The registration token is not a valid FCM registration token', 'INVALID_ARGUMENT'), []],
      [fcmError(403, 'PERMISSION_DENIED', 'SenderId mismatch', 'SENDER_ID_MISMATCH'), []],
      [fcmError(500, 'INTERNAL', 'Internal error', 'INTERNAL'), []],
      [fcmError(429, 'RESOURCE_EXHAUSTED', 'Quota', 'QUOTA_EXCEEDED'), []],
    ]
    for (const [res, want] of cases) {
      const h = harness({ respond: (c, n) => (c.url.startsWith('https://fcm.') ? res.clone() : defaultResponder(c, n)) })
      await h.send(android())
      expect(h.alarms).toEqual(want)
    }
    // the OAuth exchange refused (a deleted or disabled key) alarms; Google's 5xx does not
    // only 400, 401 and 403 are a refusal: a 429 (Google busy) or 404 is not
    for (const [status, want] of [[400, ['fcm:oauth_400']], [401, ['fcm:oauth_401']], [403, ['fcm:oauth_403']], [429, []], [404, []], [503, []]] as const) {
      const h = harness({ respond: (c, n) => (c.url.includes('oauth2') ? json(status, { error: 'invalid_grant' }) : defaultResponder(c, n)) })
      await expectError(await h.send(android()), 'provider_error')
      expect(h.alarms).toEqual([...want])
    }
    // a service account that is set but cannot be read alarms once, at start
    const broken = harness({ env: { FCM_SERVICE_ACCOUNT: '{"type":"service_account"}' } })
    expect(broken.alarms).toEqual(['fcm:service_account_invalid'])
  })

  test('a send that throws is answered 500 internal and handed to the report', async () => {
    const failures: unknown[] = []
    const h = harness({ failed: (e) => failures.push(e) })
    const throwing = Object.assign(Object.create(h.mem.state) as typeof h.mem.state, { admitKey: async () => { throw new TypeError('state broke') } })
    const gw = createGateway(ENV, { fetch: async () => new Response(null), now: () => h.clock.t, log: () => {}, state: throwing, failed: (e) => failures.push(e) })
    const r = await gw.handle(signedRequest(TEAM, body(), h.clock.t), IP)
    await expectError(r, 'internal')
    expect(failures.length).toBe(1)
    expect((failures[0] as Error).message).toBe('state broke')
  })

  test('gatewayReportsFrom: no key, no reporter, no alarm; with a key an alarm is one event without tokens or keys', async () => {
    expect(gatewayReportsFrom({}, { build: 'abc' })).toEqual({ reporter: null, invalid: false })
    expect(gatewayReportsFrom({ PUSH_GATEWAY_SENTRY_DSN: '  ' }, { build: 'abc' })).toEqual({ reporter: null, invalid: false })
    expect(gatewayReportsFrom({ PUSH_GATEWAY_SENTRY_DSN: 'not a key' }, { build: 'abc' })).toEqual({ reporter: null, invalid: true })

    const posts: { url: string; body: string }[] = []
    const fake = async (url: string, init: RequestInit) => { posts.push({ url, body: String(init.body) }); return new Response(null, { status: 200 }) }
    const reports = gatewayReportsFrom({ PUSH_GATEWAY_SENTRY_DSN: 'https://0123abcd@o1.ingest.example.test/42', PUSH_GATEWAY_SENTRY_ENV: 'staging' }, { build: 'abcdef012345', fetch: fake, now: () => T0 })
    // the real path: APNs refuses our key while a team sends to a phone
    const h = harness({ respond: () => json(403, { reason: 'InvalidProviderToken' }) })
    const gw = createGateway(ENV, {
      fetch: async () => json(403, { reason: 'InvalidProviderToken' }), now: () => h.clock.t, log: () => {}, state: h.mem.state, alarm: reports.alarm,
    })
    await gw.handle(signedRequest(TEAM, body(), h.clock.t), IP)
    await gw.handle(signedRequest(TEAM, body({ notificationId: 'n2' }), h.clock.t), IP)
    await reports.reporter!.flush(1000)
    expect(posts.length).toBe(1) // the same refusal again is not sent twice
    // a revoked key fails every send: an hour later the same refusal is still held out (one event an hour, not a minute)
    let clock = T0
    const later = gatewayReportsFrom({ PUSH_GATEWAY_SENTRY_DSN: 'https://0123abcd@o1.ingest.example.test/42' }, { build: 'x', fetch: fake, now: () => clock })
    later.alarm!('fcm', 'oauth_400')
    clock = T0 + 59 * 60_000
    later.alarm!('fcm', 'oauth_400')
    clock = T0 + 60 * 60_000
    later.alarm!('fcm', 'oauth_400')
    await later.reporter!.flush(1000)
    expect(posts.length).toBe(3)
    expect(posts[0]!.url).toBe('https://o1.ingest.example.test/api/42/envelope/')
    const event = JSON.parse(posts[0]!.body.split('\n')[2]!)
    expect(event.release).toBe('push-gateway@abcdef012345')
    expect(event.environment).toBe('staging')
    expect(event.tags).toEqual({ provider: 'apns', reason: 'InvalidProviderToken' })
    expect(event.exception.values[0].type).toBe('CredentialRejected')
    expect(event.exception.values[0].value).toBe("APNs refused the gateway's credentials")
    for (const s of [IOS_TOKEN, TEAM.pub, TEAM.keyId, IP, 'room.message', 'n1', ENV.APNS_KEY_ID!, ENV.APNS_TEAM_ID!, 'BEGIN']) expect(posts[0]!.body).not.toContain(s)
  })
})

