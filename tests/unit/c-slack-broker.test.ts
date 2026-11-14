// The Slack broker client (server/src/integrations/slack/broker.ts) against the contract
// (shared/src/cloud-protocol/slack-broker.ts): the sealed-token vector shared with the control plane
// (trina-cloud tests/slack-broker.test.ts "the vector shared with trina-ax"), the signature every call carries, which
// broker origin is used, refusals that never carry the broker's message, Slack's own pages only, and the long-poll feed
// (events handed on, acknowledged with the next poll, backoff, not served, stop). No network: a fake fetch or the fake
// broker on 127.0.0.1.
import crypto from 'node:crypto'
import { afterAll, describe, expect, test } from 'bun:test'
import { SLACK_BROKER_PATHS, parseSlackBrokerAuthorization, slackBrokerSealAad, slackBrokerSigningString, SLACK_BROKER_SEAL_ALG } from '@mycel/shared/cloud-protocol'
import { SERVICE_HOSTS } from '../../shared/src/service-hosts'
import { SlackBrokerClient, SlackBrokerError, SlackBrokerFeed, challengeOf, openSealedToken, sealKeyPair, slackBrokerOrigin, type BrokerFetch } from '../../server/src/integrations/slack/broker'
import { createLogger } from '../../server/src/log'
import { sealForTest, startFakeBroker } from '../lib/fake-slack-broker'
import { waitFor } from '../lib/wait'

const x25519 = (seed: string) => crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), Buffer.from(seed, 'hex')]), format: 'der', type: 'pkcs8' })
/** computed by the control plane's sealer (trina-cloud src/slack-broker/seal.ts) with the keys below; both sides check it */
const VECTOR = { sealKey: '43EthRoOXXm4McXjSrIrQaGYFx3iCbi4-sojoRxiSFk', epk: 'tb6oI9nJ_1dgkcVLfFlsCuKWiE8OFQKQ6IRV1_umEm8', ct: 'ro_BV8TiWOmRQ5F8S8p4JCmYHDYDDwzl6Z3TnrPG5g' }
const INSTALL = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'

const team = crypto.generateKeyPairSync('ed25519')
const identity = () => ({ key: team.privateKey, publicKey: (team.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64') })
const log = createLogger({ level: 'error', sink: () => {} })
const BOT = 'xoxb-111-222-' + 'b'.repeat(24)
const broker = startFakeBroker({ servedKey: identity().publicKey, botToken: BOT, teamOrigin: () => 'http://team.localhost' })
afterAll(() => broker.close())
const client = (o: { fetch?: BrokerFetch } = {}) => new SlackBrokerClient({ origin: broker.url, identity, ...o })

describe('the sealed bot token', () => {
  test('the vector shared with the control plane opens here', () => {
    const teamKey = x25519('a8' + 'ab'.repeat(30) + '6b')
    const raw = (crypto.createPublicKey(teamKey).export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64url')
    expect(raw).toBe(VECTOR.sealKey)
    const sealed = { alg: SLACK_BROKER_SEAL_ALG, epk: VECTOR.epk, iv: 'BwcHBwcHBwcHBwcH', ct: VECTOR.ct } as const
    expect(openSealedToken(sealed, teamKey, INSTALL, 'T0VECTOR')).toBe('xoxb-1-2-vector')
    // the contract's seal written here gives the same bytes from the same keys
    expect(sealForTest('xoxb-1-2-vector', VECTOR.sealKey, slackBrokerSealAad(INSTALL, 'T0VECTOR'), { privateKey: x25519('c8' + 'cd'.repeat(30) + '4d'), iv: Buffer.alloc(12, 7) })).toEqual(sealed)
    // another install or workspace, or another key: it does not open
    expect(() => openSealedToken(sealed, teamKey, crypto.randomUUID(), 'T0VECTOR')).toThrow()
    expect(() => openSealedToken(sealed, teamKey, INSTALL, 'T0OTHER')).toThrow()
    expect(() => openSealedToken(sealed, x25519('11'.repeat(32)), INSTALL, 'T0VECTOR')).toThrow()
  })

  test('a fresh key per request; a token sealed to another key is refused, never handed on', async () => {
    const a = sealKeyPair(), b = sealKeyPair()
    expect(a.sealKey).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(a.sealKey).not.toBe(b.sealKey)
    const install = { installId: INSTALL, teamId: 'T0ACME', teamName: 'Acme', enterpriseId: null, botUserId: 'U0BOT', appId: 'A0APP', scopes: [], installedAt: new Date().toISOString() }
    // a broker that seals to a key of its own choosing (not the request's): the answer does not open
    const wrong: BrokerFetch = async () => Response.json({ install, token: sealForTest(BOT, b.sealKey, slackBrokerSealAad(INSTALL, 'T0ACME')) })
    const e = await client({ fetch: wrong }).token().catch((x) => x)
    expect(e).toBeInstanceOf(SlackBrokerError)
    expect(e.code).toBe('unreachable')
    // sealed to the request's key, but not a bot token: refused too
    const notBot: BrokerFetch = async (_u, init) => Response.json({ install, token: sealForTest('xapp-1-A0APP-1-' + 'a'.repeat(30), JSON.parse(String(init.body)).sealKey, slackBrokerSealAad(INSTALL, 'T0ACME')) })
    expect((await client({ fetch: notBot }).token().catch((x) => x)).code).toBe('unreachable')
  })
})

describe('calls', () => {
  test('every call is signed over its path, time, nonce and body hash; a nonce is never used twice', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    const rec: BrokerFetch = async (url, init) => { seen.push({ url, init }); return Response.json({ ok: true, appId: 'A0APP', install: null }) }
    await client({ fetch: rec }).status()
    await client({ fetch: rec }).status()
    const [one, two] = seen
    expect(one!.url).toBe(broker.url + SLACK_BROKER_PATHS.status)
    expect(one!.init.redirect).toBe('manual')
    const auth = parseSlackBrokerAuthorization((one!.init.headers as Record<string, string>).authorization)!
    expect(auth.key).toBe(identity().publicKey)
    const body = String(one!.init.body)
    expect(JSON.parse(body)).toEqual({ v: 1 })
    const signed = slackBrokerSigningString(SLACK_BROKER_PATHS.status, auth.ts, auth.nonce, crypto.createHash('sha256').update(body).digest('hex'))
    expect(crypto.verify(null, Buffer.from(signed), team.publicKey, Buffer.from(auth.sig, 'base64'))).toBe(true)
    // the Drive broker's signing string is another one: this signature does not verify there
    expect(signed.startsWith('trina-slack-broker-v1\nPOST\n')).toBe(true)
    expect(parseSlackBrokerAuthorization((two!.init.headers as Record<string, string>).authorization)!.nonce).not.toBe(auth.nonce)
    // the fake broker checks the same: a real round trip
    expect(await client().status()).toEqual({ appId: 'A0APP', install: null })
  })

  test('refusals are the broker\'s code only; anything else is unreachable', async () => {
    const answer = (status: number, body: string): BrokerFetch => async () => new Response(body, { status, headers: { 'content-type': 'application/json' } })
    const code = async (f: BrokerFetch) => (await client({ fetch: f }).status().catch((e) => e) as SlackBrokerError)
    const notHosted = await code(answer(403, JSON.stringify({ error: { code: 'not_hosted', message: 'secret details xoxb-should-not-appear' } })))
    expect(notHosted.code).toBe('not_hosted')
    expect(notHosted.message).not.toContain('xoxb')
    expect((await code(answer(502, '<html>bad gateway</html>'))).code).toBe('unreachable')
    expect((await code(answer(429, ''))).code).toBe('rate_limited')
    expect((await code(answer(400, JSON.stringify({ error: { code: 'NOT A CODE; drop table' } })))).code).toBe('unreachable')
    expect((await code(async () => { throw new Error('ECONNREFUSED') })).code).toBe('unreachable')
    // a redirect is never followed
    expect((await code(async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }))).code).toBe('unreachable')
    // the fake broker: another key is not served
    const other = crypto.generateKeyPairSync('ed25519')
    const stranger = new SlackBrokerClient({ origin: broker.url, identity: () => ({ key: other.privateKey, publicKey: (other.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64') }) })
    expect((await stranger.status().catch((e) => e)).code).toBe('not_hosted')
  })

  test('the browser only ever goes to Slack\'s own pages', async () => {
    const start = (url: string): BrokerFetch => async () => Response.json({ authorizationUrl: url, expiresAt: new Date().toISOString() })
    const state = 's'.repeat(43), ok = `https://slack.com/oauth/v2/authorize?client_id=1111111111.2222222222&state=${state}`
    expect(await client({ fetch: start(ok) }).startInstall('r'.repeat(43), challengeOf('v'.repeat(64)))).toBe(ok)
    for (const bad of [`https://evil.example/oauth/v2/authorize?client_id=1.2&state=${state}`, `https://slack.com.evil.example/oauth/v2/authorize?client_id=1111.2222&state=${state}`,
      `http://slack.com/oauth/v2/authorize?client_id=1111.2222&state=${state}`, `https://slack.com/openid/connect/authorize?client_id=1111.2222&state=${state}`, `https://slack.com/oauth/v2/authorize?state=${state}`])
      expect((await client({ fetch: start(bad) }).startInstall('r'.repeat(43), challengeOf('v'.repeat(64))).catch((e) => e)).code).toBe('unreachable')
    // Sign in with Slack: only its OpenID Connect page
    expect((await client({ fetch: start(ok) }).startSignIn('r'.repeat(43), challengeOf('v'.repeat(64))).catch((e) => e)).code).toBe('unreachable')
  })

  test('which hosting service: MYCEL_SLACK_BROKER_URL, else the Drive broker\'s console; an origin, https or this machine', () => {
    expect(slackBrokerOrigin({})).toBeNull()
    // a hosted server that names no broker: the hosting service's console (a self-installed one: off); "off" still wins
    expect(slackBrokerOrigin({}, true)).toBe(`https://${SERVICE_HOSTS.accountHost}`)
    expect(slackBrokerOrigin({ MYCEL_GOOGLE_DRIVE_BROKER_URL: 'off' }, true)).toBe(`https://${SERVICE_HOSTS.accountHost}`)
    expect(slackBrokerOrigin({ MYCEL_SLACK_BROKER_URL: 'off' }, true)).toBeNull()
    expect(slackBrokerOrigin({ NODE_ENV: 'test' }, true)).toBeNull()
    expect(slackBrokerOrigin({ MYCEL_SLACK_BROKER_URL: 'https://account.example' }, true)).toBe('https://account.example')
    expect(slackBrokerOrigin({ MYCEL_SLACK_BROKER_URL: 'https://account.example' })).toBe('https://account.example')
    expect(slackBrokerOrigin({ MYCEL_GOOGLE_DRIVE_BROKER_URL: 'https://account.example/' })).toBe('https://account.example')
    expect(slackBrokerOrigin({ MYCEL_SLACK_BROKER_URL: 'off', MYCEL_GOOGLE_DRIVE_BROKER_URL: 'https://account.example' })).toBeNull()
    expect(slackBrokerOrigin({ MYCEL_SLACK_BROKER_URL: 'http://127.0.0.1:9000' })).toBe('http://127.0.0.1:9000')
    for (const bad of ['http://account.example', 'https://user:pw@account.example', 'https://account.example/path', 'https://account.example/?q=1', 'not a url'])
      expect(slackBrokerOrigin({ MYCEL_SLACK_BROKER_URL: bad })).toBeNull()
  })
})

describe('the long-poll feed', () => {
  test('connected within a round trip after it starts, not after a long poll\'s whole wait (QA TC-1415)', async () => {
    // a 20 s long poll: the first poll is answered at once, so the state does not sit at "connecting" for its wait
    const feed = new SlackBrokerFeed({ client: client(), log, waitMs: 20_000, retryMs: 20, onEvent: async () => {}, onInstall: () => {}, onState: () => {} })
    const t0 = Date.now()
    feed.start()
    await waitFor(() => feed.state === 'connected', { timeoutMs: 3000 })
    expect(Date.now() - t0).toBeLessThan(3000)
    feed.stop()
  })

  test('events handed on, acknowledged with the next poll; a failure backs off and comes back; stop cancels the held poll', async () => {
    const got: string[] = [], states: string[] = []
    const feed = new SlackBrokerFeed({ client: client(), log, waitMs: 200, retryMs: 20, onEvent: async (e) => { got.push(e.id) }, onInstall: () => {}, onState: (s, err) => states.push(`${s}:${err ?? ''}`) })
    feed.start()
    await waitFor(() => feed.state === 'connected')
    const a = broker.push('events_api', { type: 'event_callback' }), b = broker.push('interactive', { type: 'block_actions' })
    await waitFor(() => got.length === 2)
    await waitFor(() => broker.acks.includes(a) && broker.acks.includes(b))
    expect(broker.pending()).toEqual([])
    // the hosting service is down: error, then back by itself
    broker.serving = 'down'
    await waitFor(() => feed.state === 'error')
    expect(feed.lastError).toBe('broker_unreachable')
    broker.serving = true
    await waitFor(() => feed.state === 'connected')
    // not served (a suspended team, a removed server)
    broker.serving = false
    await waitFor(() => feed.lastError === 'not_served')
    broker.serving = true
    feed.stop()
    const polls = broker.of('poll').length
    await Bun.sleep(150)
    expect(broker.of('poll').length).toBe(polls)
    expect(states).toContain('connected:')
  })

  test('stopped while handling an answer: what it took is acknowledged at once, not handed out again later', async () => {
    const id = broker.push('lifecycle', { event: 'uninstalled' })
    let feed: SlackBrokerFeed | null = null
    feed = new SlackBrokerFeed({ client: client(), log, waitMs: 100, retryMs: 20, onEvent: async () => { feed!.stop() }, onInstall: () => {}, onState: () => {} })
    feed.start()
    await waitFor(() => broker.acks.includes(id))
    expect(broker.pending().map((e) => e.id)).not.toContain(id)
  })

  test('an event that fails is still taken (the connector handles an event id once); one not taken comes again', async () => {
    const id = broker.push('events_api', { type: 'event_callback' })
    let tries = 0
    const feed = new SlackBrokerFeed({ client: client(), log, waitMs: 100, retryMs: 20, onEvent: async () => { tries++; throw new Error('boom') }, onInstall: () => {}, onState: () => {} })
    feed.start()
    await waitFor(() => broker.acks.includes(id))
    feed.stop()
    expect(tries).toBe(1)
  })
})
