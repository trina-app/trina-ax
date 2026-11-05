// The push gateway (push-gateway/, contract shared/src/cloud-protocol/push-gateway.ts): team servers sign a request
// with their Ed25519 team key, the gateway sends a generic native push through APNs or FCM. Fake providers only (an
// injected fetch), keys generated here at runtime, a fake clock, the in-memory state.
import { describe, expect, test } from 'bun:test'
import { createHash, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  PUSH_GATEWAY_ERRORS, parsePushGatewayAuthorization, parsePushGatewaySend, pushGatewayAuthorization,
  pushGatewaySigningString, validPushPath, validPushToken,
} from '../../shared/src/cloud-protocol/push-gateway.ts'
import { TEXT } from '../../server/src/notifications/text.ts'
import { clientBucket, createGateway, type GatewayEnv, type LogLine } from '../../push-gateway/src/gateway.ts'
import { memoryState } from '../../push-gateway/src/state.ts'
import { EVENT_TEXT, alertBody } from '../../push-gateway/src/text.ts'

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

interface Call { url: string; method: string; headers: Headers; body: string }
type Responder = (c: Call, n: number) => Response | Promise<Response>

const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
const defaultResponder: Responder = (c) => {
  if (c.url === SERVICE_ACCOUNT.token_uri) return json(200, { access_token: 'ya29.test-access-token', expires_in: 3600, token_type: 'Bearer' })
  if (c.url.startsWith('https://fcm.googleapis.com/')) return json(200, { name: 'projects/acme-push/messages/1' })
  return new Response(null, { status: 200, headers: { 'apns-id': 'x' } })
}

function harness(o: { env?: Partial<GatewayEnv>; respond?: Responder; blocked?: Set<string>; replaceEnv?: GatewayEnv } = {}) {
  const calls: Call[] = []
  const logs: LogLine[] = []
  const clock = { t: T0 }
  const mem = memoryState({ blocked: o.blocked })
  const respond = o.respond ?? defaultResponder
  const gw = createGateway(o.replaceEnv ?? { ...ENV, ...o.env }, {
    fetch: async (url, init) => {
      const c: Call = { url, method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: String(init?.body ?? '') }
      calls.push(c)
      return respond(c, calls.length)
    },
    now: () => clock.t,
    log: (l) => logs.push(l),
    state: mem.state,
  })
  const handle = (req: Request, ip = IP) => gw.handle(req, ip)
  const send = (text: string, team: Team = TEAM, opts?: Parameters<typeof signedRequest>[3]) => handle(signedRequest(team, text, clock.t, opts))
  const apnsCalls = () => calls.filter((c) => c.url.includes('push.apple.com'))
  return { gw, handle, calls, logs, clock, mem, send, apnsCalls }
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
    ]
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
    expect(JSON.parse(prod!.body)).toEqual({
      aps: { alert: { title: 'Trina AX', body: '새 메시지가 있어요' }, sound: 'default' },
      body: { notificationId: 'n1', code: 'room.message', path: '/rooms/abc123', tag: 'dev_42' },
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
        data: { notificationId: 'n1', code: 'connection.reconnect', path: '/rooms/abc123', tag: 'dev-7' },
        android: { priority: 'HIGH', ttl: '600s', collapse_key: 'n1', notification: { channel_id: 'default', tag: 'n1' } },
      },
    })
    h.clock.t += 3600_000 - 61_000
    await expectOk(await h.send(android({ notificationId: 'n2' })))
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
})

// ------------------------------------------------------------------ configuration, text, logs

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
    for (const code of ['schedule.success', 'schedule.failure', 'connection.reconnect'] as const) expect(EVENT_TEXT[code]).toEqual(TEXT[code])
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
