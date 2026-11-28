// Services that let only apps they approved sign in (server/src/integrations/connections/oauth.ts chooseClient,
// preflight, clientMetadata): a refused registration (Figma's 403, Vercel's 400) or a sign-in page that refuses the
// registered app (Canva's "Invalid redirect URI.") is said plainly (oauth_approved_apps_only, never "try an API key"),
// unless the service takes a client metadata document, which this server publishes; the preflight lets a challenge
// page, a slow page or a network error through. A table over the listed services' recorded metadata (fixtures from
// unauthenticated probes, 2026-11-13). And sign-ins that never finished do not fill the personal connection limit.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { PRODUCT } from '@mycel/shared'
import { catalogAt, officialService, SERVICE_CATALOG, teamAppAt } from '../../shared/src/service-catalog'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'
import { FakeServices, MCP_KEY } from '../lib/fake-services'
import { integrationsOf, MAX_PERSONAL, personalCounts } from '../../server/src/integrations/connections/service'
import { connectRows } from '../../server/src/chat/connect-service'
import { getRow } from '../../server/src/integrations/connections/store'
import { authorizationUrl, chooseClient, register, CLIENT_METADATA_PATH, discover, documentOriginAt, documentOrigins, pageWords, preflight, publicOrigin, type OAuthClient } from '../../server/src/integrations/connections/oauth'
import type { NetOptions, NetRequest } from '../../server/src/integrations/connections/net'
import { reasonText, say, TEXT } from '../../server/src/integrations/connections/text'

setDefaultTimeout(30_000)

const TEAM = 'https://team.example.com'
const DOC = `${TEAM}${CLIENT_METADATA_PATH}`
const LOCALES = ['ko', 'en', 'id', 'ja', 'es'] as const
let h: Harness, olga: Client, fake: FakeServices
let seq = 0
beforeAll(() => { fake = new FakeServices() })
afterAll(() => fake?.stop())
beforeEach(async () => {
  h = await harness('int-approved-' + ++seq, { publicOrigins: [TEAM] })
  olga = await withOwner(h)
  fake.strict = {}
  fake.now = Date.now()
  integrationsOf(h.ctx, { net: fake.net(), now: () => fake.now })
})
afterEach(async () => { await h?.close() })

/** the person's browser on the team's public https address (a service can fetch the metadata document from it) */
const PUBLIC = { origin: TEAM }
const callback = (q: Record<string, string>) => '/api/integrations/oauth/callback?' + new URLSearchParams(q)
const strict = () => olga.call('POST', '/api/integrations', { kind: 'mcp', name: 'Strict', url: `${fake.base}/mcp-strict`, auth: 'oauth' }, PUBLIC)
const authorize = async (id: string, headers: Record<string, string> = PUBLIC) => olga.try('POST', `/api/integrations/${id}/authorize`, {}, headers)
const clientOf = (r: { body: any }) => new URL(r.body.authorizationUrl).searchParams.get('client_id')
const approvedOnly = TEXT.oauth_approved_apps_only

describe('a service that lets only apps it approved sign in', () => {
  test('registration refused (Figma 403, Vercel 400) and no metadata document: the plain reason, never "try an API key"', async () => {
    for (const status of [403, 400]) {
      fake.strict = { register: status }
      const c = await strict()
      const r = await authorize(c.id)
      expect(r.status).toBe(400)
      expect(r.body.error.message).toBe(approvedOnly.ko)
      expect(r.body.error.message).not.toContain('API')
      expect(getRow(h.ctx.db, c.id)).toMatchObject({ status: 'needs_auth', last_error: 'oauth_approved_apps_only' })
      // the connection and the chat card say it in the reader's words
      const listed = (await olga.call('GET', '/api/integrations')).items.find((i: any) => i.id === c.id)
      expect(listed).toMatchObject({ status: 'needs_auth', lastErrorReason: 'oauth_approved_apps_only', lastError: approvedOnly.ko })
      await olga.call('DELETE', `/api/integrations/${c.id}`)
    }
  })

  test('registered, but the sign-in page refuses the app (Canva "Invalid redirect URI."): caught before the browser goes there', async () => {
    fake.strict = { refuseRegistered: true }
    const c = await strict()
    const r = await authorize(c.id)
    expect(r.status).toBe(400)
    expect(r.body.error.message).toBe(approvedOnly.ko)
    expect(fake.seen.some((s) => s.method === 'GET' && s.path.startsWith('/as-strict/authorize?'))).toBe(true)
    // no flow waits for a sign-in that cannot finish
    expect(h.ctx.db.query("SELECT count(*) AS n FROM integration_oauth_flows WHERE integration_id = ? AND state = 'pending'").get(c.id)).toEqual({ n: 0 })
    // the refused try is kept as a failed flow (it counts toward the tries of an hour)
    expect(h.ctx.db.query('SELECT state, reason, secret_enc FROM integration_oauth_flows WHERE integration_id = ?').all(c.id)).toEqual([{ state: 'failed', reason: 'refused', secret_enc: null }])
  })

  test('the service takes a metadata document: its address is the client, through the token exchange and every refresh', async () => {
    fake.strict = { refuseRegistered: true, metadata: true }
    const c = await strict()
    const r = await authorize(c.id)
    expect(r.status).toBe(200)
    expect(clientOf(r)).toBe(DOC)
    expect(new URL(r.body.authorizationUrl).searchParams.get('redirect_uri')).toBe(`${TEAM}/api/integrations/oauth/callback`)
    const cb = fake.authorize(r.body.authorizationUrl, `${fake.base}/as-strict`)
    expect((await olga.raw('GET', callback(cb))).status).toBe(200)
    const tokenCall = fake.seen.filter((s) => s.path === '/as/token').at(-1)!
    expect(new URLSearchParams(tokenCall.body).get('client_id')).toBe(DOC)
    expect(new URLSearchParams(tokenCall.body).get('client_secret')).toBeNull()
    expect((await olga.call('GET', '/api/integrations')).items.find((i: any) => i.id === c.id)).toMatchObject({ status: 'connected', hasSecret: true })
    // a refresh sends the same client ID (the fake refuses one it does not know)
    fake.refreshCount = 0
    fake.now += 3600_000 + 1
    await olga.call('POST', `/api/integrations/${c.id}/refresh`, {})
    expect(fake.refreshCount).toBe(1)
    expect(new URLSearchParams(fake.seen.filter((s) => s.path === '/as/token').at(-1)!.body).get('client_id')).toBe(DOC)
    // signing in again uses the stored client, no new registration
    const regs = fake.seen.filter((s) => s.path === '/as-strict/register').length
    const again = await authorize(c.id)
    expect(clientOf(again)).toBe(DOC)
    expect(fake.seen.filter((s) => s.path === '/as-strict/register').length).toBe(regs)
  })

  test('registration refused (Vercel 400, Railway 403) or none at all, with a metadata document: the document', async () => {
    for (const s of [{ register: 400 }, { register: 403 }, { noRegistration: true }]) {
      fake.strict = { ...s, metadata: true }
      const c = await strict()
      const r = await authorize(c.id)
      expect(r.status).toBe(200)
      expect(clientOf(r)).toBe(DOC)
      await olga.call('DELETE', `/api/integrations/${c.id}`)
    }
  })

  test('a document is never offered from an address a service cannot reach: localhost or plain http say the https address fixes it', async () => {
    fake.strict = { refuseRegistered: true, metadata: true }
    const c = await strict()
    // the browser on the harness's own address, http://team.localhost (a WSL server at 127.0.0.1, WSL QA 2026-11-28
    // with Indeed): not "only the service can change that", but the team's https address
    const r = await authorize(c.id, { origin: 'http://team.localhost' })
    expect(r.status).toBe(400)
    expect(r.body.error.message).toBe(say('oauth_needs_https', 'ko', { name: 'Strict' }))
    expect(r.body.error.message).not.toBe(approvedOnly.ko)
    // a service that takes no document keeps the plain reason from such an address too
    fake.strict = { refuseRegistered: true }
    const plain = await authorize(c.id, { origin: 'http://team.localhost' })
    expect(plain.body.error.message).toBe(approvedOnly.ko)
    expect(publicOrigin(TEAM)).toBe(true)
    for (const o of ['http://team.example.com', 'https://localhost', 'https://team.localhost', 'https://10.0.0.5', 'https://[::1]', 'https://office', 'https://nas.local']) expect(publicOrigin(o), o).toBe(false)
  })

  test('the document is refused too: the plain reason', async () => {
    fake.strict = { register: 403, metadataRefused: true }
    const c = await strict()
    const r = await authorize(c.id)
    expect(r.status).toBe(400)
    expect(r.body.error.message).toBe(approvedOnly.ko)
  })

  test('the preflight lets through a Cloudflare challenge (Ahrefs), a sign-in page, a redirect, a slow page and a network error', async () => {
    const pages: (() => Promise<Response>)[] = [
      async () => new Response('<!DOCTYPE html><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/x.js"></script>', { status: 403, headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' } }),
      async () => new Response('<html><script>var clientId = "x"; var redirect_uri = "y"</script><body>Log in</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      async () => new Response(null, { status: 302, headers: { location: 'https://login.example.com/' } }),
      async () => new Response('<html><script>const client_id = 1</script>Not here</html>', { status: 404, headers: { 'content-type': 'text/html' } }),
    ]
    for (const page of pages) {
      fake.strict = { page }
      const c = await strict()
      const r = await authorize(c.id)
      expect(r.status).toBe(200)
      expect(clientOf(r)).toMatch(/^client-/)
      await olga.call('DELETE', `/api/integrations/${c.id}`)
    }
    // a slow sign-in page: let through once the preflight's time is up
    const net = { ...fake.net(), timeoutMs: 800 }
    fake.strict = { page: async () => { await Bun.sleep(1500); return new Response('late') } }
    const url = `${fake.base}/as-strict/authorize?client_id=x`
    const t = Date.now()
    expect(await preflight(url, net)).toBe('pass')
    expect(Date.now() - t).toBeLessThan(1400)
    // a name that does not resolve
    expect(await preflight('https://nowhere.test/authorize', net)).toBe('pass')
    // and what counts as a refusal: only one that names the redirect address or the client is clear
    for (const [status, body, said] of [[400, 'Invalid redirect URI.', 'refused'], [400, 'Bad Request', 'unclear'], [401, '{"error":"invalid_client"}', 'refused'], [403, 'redirect_uri is not registered', 'refused'],
      [403, 'Forbidden', 'pass'], [500, 'Invalid redirect URI', 'pass']] as const) {
      fake.strict = { page: async () => new Response(body, { status }) }
      expect(await preflight(url, fake.net()), `${status} ${body}`).toBe(said)
    }
  })

  test('a plain 400 that names neither the redirect address nor the client: the sign-in goes on, or the document is offered', async () => {
    fake.strict = { page: async () => new Response('Bad Request', { status: 400 }) }
    const c = await strict()
    const r = await authorize(c.id)
    expect(r.status).toBe(200)
    expect(clientOf(r)).toMatch(/^client-/)
    // a service that takes a document gets it instead (its page takes the document)
    fake.strict = { metadata: true }
    let calls = 0
    fake.strict.page = async () => (++calls === 1 ? new Response('Bad Request', { status: 400 }) : new Response('<html>Sign in</html>'))
    const d = await olga.call('POST', '/api/integrations', { kind: 'mcp', name: 'Doc', url: `${fake.base}/mcp-strict?doc=1`, auth: 'oauth' }, PUBLIC)
    expect(clientOf(await authorize(d.id))).toBe(DOC)
  })

  test('a stored app the sign-in page stops accepting: one fresh registration before giving up', async () => {
    const c = await strict()
    const r = await authorize(c.id, PUBLIC)
    const cb = fake.authorize(r.body.authorizationUrl, `${fake.base}/as-strict`)
    expect((await olga.raw('GET', callback(cb))).status).toBe(200)
    const stored = clientOf(r)!
    fake.strict = { refuseClients: new Set([stored]) }
    const regs = fake.seen.filter((s) => s.path === '/as-strict/register').length
    const again = await authorize(c.id)
    expect(again.status).toBe(200)
    expect(clientOf(again)).not.toBe(stored)
    expect(fake.seen.filter((s) => s.path === '/as-strict/register').length).toBe(regs + 1)
  })

  test('registration answers: 400 and 403 (and an invalid_redirect_uri or invalid_client_metadata error) refuse the app; 429 is busy; others keep the old reason', async () => {
    for (const [status, error, reason] of [[400, 'x', 'oauth_approved_apps_only'], [403, 'x', 'oauth_approved_apps_only'], [422, 'invalid_client_metadata', 'oauth_approved_apps_only'],
      [404, 'invalid_redirect_uri', 'oauth_approved_apps_only'], [429, 'slow_down', 'oauth_busy'], [404, 'not_found', 'oauth_unsupported'], [401, 'unauthorized', 'oauth_unsupported']] as const) {
      fake.strict = { register: status, registerError: error }
      const c = await strict()
      const r = await authorize(c.id)
      expect(r.status, `${status} ${error}`).toBe(400)
      expect(getRow(h.ctx.db, c.id)!.last_error, `${status} ${error}`).toBe(reason)
      expect(r.body.error.message).toBe(TEXT[reason].ko)
      await olga.call('DELETE', `/api/integrations/${c.id}`)
    }
    expect(TEXT.oauth_busy.en).toContain('minutes')
  })

  test('a hostile sign-in page (64 KB of "<", unclosed tags and scripts) is read in a few ms', async () => {
    for (const body of ['<'.repeat(65_536), '<script'.repeat(9_400), '<a '.repeat(21_000) + 'redirect_uri', '<style>'.repeat(9_000)]) {
      const t = performance.now()
      pageWords(body)
      expect(performance.now() - t, body.slice(0, 10)).toBeLessThan(50)
    }
    fake.strict = { page: async () => new Response('<'.repeat(65_536), { status: 403 }) }
    const t = performance.now()
    expect(await preflight(`${fake.base}/as-strict/authorize?client_id=x`, fake.net())).toBe('pass')
    expect(performance.now() - t).toBeLessThan(1000)
  })

  test('only refusals count toward the sign-in tries: a service that is down or busy never locks anyone out', async () => {
    // an address with no sign-in to find (unreachable metadata), then a busy registration (429): 25 tries each
    const down = await olga.call('POST', '/api/integrations', { kind: 'mcp', name: 'Down', url: 'https://nowhere.test/mcp', auth: 'oauth' })
    for (let i = 0; i < 25; i++) expect((await authorize(down.id)).status).toBe(400)
    fake.strict = { register: 429 }
    const busy = await strict()
    for (let i = 0; i < 25; i++) expect((await authorize(busy.id)).status).toBe(400)
    expect(h.ctx.db.query('SELECT count(*) AS n FROM integration_oauth_flows').get()).toEqual({ n: 0 })
    // signing in still works
    fake.strict = {}
    const ok = await olga.call('POST', '/api/integrations', { kind: 'mcp', name: 'Fine', url: `${fake.base}/mcp-strict?fine=1`, auth: 'oauth' })
    expect((await authorize(ok.id)).status).toBe(200)
  })

  test('the document is offered only at an address this server serves it at (a configured public address or the tunnel)', async () => {
    fake.strict = { refuseRegistered: true, metadata: true }
    const found = await discover(`${fake.base}/mcp-strict`, fake.net(), `Bearer resource_metadata="${fake.base}/.well-known/oauth-protected-resource/mcp-strict"`)
    const urlFor = (c: OAuthClient) => authorizationUrl({ ...found, client: c }, 'S'.repeat(43), 'C'.repeat(43))
    const redirect = `${TEAM}/api/integrations/oauth/callback`
    // no public address configured (no MYCEL_PUBLIC_ORIGINS): the route would answer 404, so no document is offered
    await expect(chooseClient(found, TEAM, redirect, fake.net(), urlFor, null, [])).rejects.toMatchObject({ reason: 'oauth_approved_apps_only' })
    await expect(chooseClient(found, TEAM, redirect, fake.net(), urlFor, null, ['https://other.example.com'])).rejects.toMatchObject({ reason: 'oauth_approved_apps_only' })
    expect((await chooseClient(found, TEAM, redirect, fake.net(), urlFor, null, [TEAM + '/'])).clientId).toBe(DOC)
    // the route and the sign-in read the same list
    expect(documentOrigins({ publicOrigins: [TEAM], tunnel: { host: 'office.example.org' } })).toEqual([TEAM, 'https://office.example.org'])
    expect(documentOriginAt([TEAM], 'TEAM.example.com')).toBe(TEAM)
    expect(documentOriginAt([TEAM], 'evil.example.net')).toBeUndefined()
  })

  test('refused sign-ins count toward the 20 sign-in tries an hour', async () => {
    fake.strict = { register: 403 }
    const c = await strict()
    for (let i = 0; i < 20; i++) expect((await authorize(c.id)).status).toBe(400)
    const regs = fake.seen.filter((s) => s.path === '/as-strict/register').length
    expect((await authorize(c.id)).status).toBe(429)
    expect(fake.seen.filter((s) => s.path === '/as-strict/register').length).toBe(regs)
  })

  test('the metadata document: public JSON at its own address, the product name and this team\'s callback', async () => {
    const res = await h.fetch(CLIENT_METADATA_PATH, { base: TEAM, via: 'direct' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual({
      client_id: DOC, client_name: PRODUCT.displayName, redirect_uris: [`${TEAM}/api/integrations/oauth/callback`],
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
    })
    expect(res.headers.get('cache-control')).toStartWith('private')
    // through a tunnel the request reaches the server as plain http with the public host: the public https address
    const tunneled = await h.fetch(CLIENT_METADATA_PATH, { base: 'http://team.example.com', via: 'direct' })
    expect((await tunneled.json()).client_id).toBe(DOC)
    // a host that is not one of the team's public addresses: no document naming it
    expect((await h.fetch(CLIENT_METADATA_PATH, { base: 'https://evil.example.net', via: 'direct' })).status).toBe(404)
    expect((await h.fetch(CLIENT_METADATA_PATH)).status).toBe(404)
  })
})

describe('words', () => {
  test('the reason in five languages, said to a member as "tell your admin"', () => {
    for (const l of LOCALES) {
      expect(TEXT.oauth_approved_apps_only[l].length).toBeGreaterThan(20)
      expect(reasonText('oauth_approved_apps_only', l)).toBe(TEXT.oauth_approved_apps_only[l])
      expect(reasonText('oauth_approved_apps_only', l, { address: true, key: false })).toBe(TEXT.keyMember[l])
    }
    expect(TEXT.oauth_approved_apps_only.en).not.toMatch(/API|client|OAuth|registration/i)
    // the https address as the fix, in every language, naming the service and where the relay is turned on
    for (const l of LOCALES) {
      const w = say('oauth_needs_https', l, { name: 'Indeed' })
      expect(w).toContain('Indeed')
      expect(w).toContain('https')
      expect(w).not.toContain('{name}')
    }
  })
})

describe('sign-ins that never finished', () => {
  const insert = (id: string, url: string, auth: string, secret: string | null) => h.ctx.db.query(`INSERT INTO integrations (id, scope, owner_user_id, created_by, kind, name, slug, url, auth, status, secret_enc, created_at, updated_at)
    VALUES (?, 'personal', ?, ?, 'mcp', 'n', ?, ?, ?, 'connected', ?, ?, ?)`).run(id, ownerId(), ownerId(), id, url, auth, secret, new Date().toISOString(), new Date().toISOString())
  const ownerId = () => (h.ctx.db.query("SELECT id FROM users WHERE username = 'olga'").get() as { id: string }).id
  const sessionId = () => (h.ctx.db.query('SELECT id FROM sessions WHERE user_id = ? LIMIT 1').get(ownerId()) as { id: string }).id
  /** a refused sign-in try of that connection, `age` ms before the service's clock */
  const tried = (id: string, age: number) => h.ctx.db.query(`INSERT INTO integration_oauth_flows (id, integration_id, integration_version, user_id, session_id, state_hash, state, secret_enc, key_version, reason, expires_at, created_at)
    VALUES (?, ?, 1, ?, ?, ?, 'failed', NULL, 1, 'refused', ?, ?)`).run(`flow-${id}-${age}`, id, ownerId(), sessionId(), `hash-${id}-${age}`, new Date(fake.now - age).toISOString(), new Date(fake.now - age).toISOString())
  const waitingIds = () => (h.ctx.db.query(`SELECT id FROM integrations WHERE owner_user_id = ? AND auth = 'oauth' AND secret_enc IS NULL ORDER BY created_at, id`).all(ownerId()) as { id: string }[]).map((r) => r.id)

  test('a failed or closed sign-in does not count toward the limit; Connect again at the same address picks it up', async () => {
    // 19 that work, and three failed tries at the same service plus two at other ones
    for (let i = 0; i < MAX_PERSONAL - 1; i++) insert(`ok-${i}`, `${fake.base}/mcp-open?n=${i}`, 'none', null)
    fake.strict = { register: 403 }
    const first = await strict()
    expect((await authorize(first.id)).status).toBe(400)
    const second = await strict()
    expect(second.id).toBe(first.id) // the same waiting connection, not another
    expect((await authorize(second.id)).status).toBe(400)
    for (const n of [1, 2]) await olga.call('POST', '/api/integrations', { kind: 'mcp', name: `Other ${n}`, url: `${fake.base}/mcp-strict?other=${n}`, auth: 'oauth' })
    // the 20th connection that works is still allowed
    const twentieth = await olga.call('POST', '/api/integrations', { kind: 'mcp', name: 'Key', url: `${fake.base}/mcp-key`, auth: 'bearer', secret: MCP_KEY })
    expect(twentieth.status).toBe('connected')
    // and the limit itself holds for the 21st
    const more = await olga.try('POST', '/api/integrations', { kind: 'mcp', name: 'Open', url: `${fake.base}/mcp-open`, auth: 'none' })
    expect(more.status).toBe(409)
    // at the limit no new connection is saved, a sign-in one neither (it could only be finished over the limit)
    expect((await olga.try('POST', '/api/integrations', { kind: 'mcp', name: 'Third', url: `${fake.base}/mcp-strict?other=3`, auth: 'oauth' })).status).toBe(409)
    // Connect again at an address that is waiting still picks that one up
    expect((await olga.call('POST', '/api/integrations', { kind: 'mcp', name: 'Strict', url: `${fake.base}/mcp-strict`, auth: 'oauth' })).id).toBe(first.id)
  })

  test('the limit holds for sign-in connections: 20 signed in, the 21st is refused', async () => {
    for (let i = 0; i < MAX_PERSONAL; i++) insert(`signed-${i}`, `${fake.base}/mcp-strict?s=${i}`, 'oauth', 'sealed')
    expect(personalCounts(h.ctx.db, ownerId())).toEqual({ settled: MAX_PERSONAL, waiting: 0 })
    const more = await olga.try('POST', '/api/integrations', { kind: 'mcp', name: 'One more', url: `${fake.base}/mcp-strict?s=new`, auth: 'oauth' })
    expect(more.status).toBe(409)
    expect(more.body.error.message).toBe(TEXT.tooManyWorking.ko.replace('{n}', String(MAX_PERSONAL)))
    expect(TEXT.tooManyWorking.en).toBe('You can have at most {n} working connections of your own.')
    // a key one too
    expect((await olga.try('POST', '/api/integrations', { kind: 'mcp', name: 'Key', url: `${fake.base}/mcp-key`, auth: 'bearer', secret: MCP_KEY })).status).toBe(409)
  })

  test('20 sign-ins finished through the callback, then the 21st is refused at create', async () => {
    for (let i = 0; i < MAX_PERSONAL; i++) {
      const c = await olga.call('POST', '/api/integrations', { kind: 'mcp', name: `S${i}`, url: `${fake.base}/mcp-strict?f=${i}`, auth: 'oauth' })
      const r = await authorize(c.id)
      expect((await olga.raw('GET', callback(fake.authorize(r.body.authorizationUrl, `${fake.base}/as-strict`)))).status).toBe(200)
      // the sign-in tries of an hour: start again (the cap is tested on its own)
      h.ctx.db.query('DELETE FROM integration_oauth_flows').run()
    }
    expect(personalCounts(h.ctx.db, ownerId())).toEqual({ settled: MAX_PERSONAL, waiting: 0 })
    expect((await olga.try('POST', '/api/integrations', { kind: 'mcp', name: 'S21', url: `${fake.base}/mcp-strict?f=21`, auth: 'oauth' })).status).toBe(409)
  })

  test('the callback refuses a first sign-in that would go over the limit; a key changed to sign-in frees its slot only until then', async () => {
    for (let i = 0; i < MAX_PERSONAL - 2; i++) insert(`ok-${i}`, `${fake.base}/mcp-open?n=${i}`, 'none', null)
    const key = await olga.call('POST', '/api/integrations', { kind: 'mcp', name: 'Key', url: `${fake.base}/mcp-key`, auth: 'bearer', secret: MCP_KEY })
    const waiting = await strict()
    // the key connection becomes a sign-in one: it waits now and frees its slot, which another connection takes
    await olga.call('PATCH', `/api/integrations/${key.id}`, { auth: 'oauth' })
    expect(personalCounts(h.ctx.db, ownerId())).toEqual({ settled: MAX_PERSONAL - 2, waiting: 2 })
    for (const n of [1, 2]) await olga.call('POST', '/api/integrations', { kind: 'mcp', name: `Open ${n}`, url: `${fake.base}/mcp-open?x=${n}`, auth: 'none' })
    // at the limit: finishing the waiting one's sign-in is refused and stores nothing
    const r = await authorize(waiting.id)
    expect(r.status).toBe(200)
    const page = await olga.raw('GET', callback(fake.authorize(r.body.authorizationUrl, `${fake.base}/as-strict`)))
    expect(page.status).toBe(400)
    expect(await page.text()).toContain(TEXT.callbackLimit.ko.replace('{n}', String(MAX_PERSONAL)))
    expect(await olga.call('GET', `/api/integrations/flows/${r.body.flowId}`)).toMatchObject({ state: 'failed', reason: 'limit' })
    expect(getRow(h.ctx.db, waiting.id)!.secret_enc).toBeNull()
    // and a waiting one cannot become a key connection over the limit either
    expect((await olga.try('PATCH', `/api/integrations/${key.id}`, { auth: 'bearer', secret: MCP_KEY })).status).toBe(409)
  })

  test('the chat card counts like Settings: waiting ones do not fill the limit; at their cap one may make room', async () => {
    const svc = integrationsOf(h.ctx)
    for (let i = 0; i < MAX_PERSONAL; i++) insert(`wait-${i}`, `${fake.base}/mcp-strict?w=${i}`, 'oauth', null)
    expect(connectRows(h.ctx.db, ownerId(), 'personal').count).toBe(0)
    expect(svc.personalRoom(ownerId(), 'bearer')).toBe('ok')
    // never tried: the oldest may go
    expect(svc.personalRoom(ownerId(), 'oauth')).toBe('ok')
    // every one tried in the last hour: none may go
    for (let i = 0; i < MAX_PERSONAL; i++) tried(`wait-${i}`, 30 * 60_000)
    expect(svc.personalRoom(ownerId(), 'oauth')).toBe('waiting')
    expect(svc.personalRoom(ownerId(), 'bearer')).toBe('ok')
    h.ctx.db.query("DELETE FROM integrations WHERE id LIKE 'wait-%'").run()
    for (let i = 0; i < MAX_PERSONAL; i++) insert(`ok-${i}`, `${fake.base}/mcp-open?n=${i}`, 'none', null)
    expect(connectRows(h.ctx.db, ownerId(), 'personal').count).toBe(MAX_PERSONAL)
    expect(svc.personalRoom(ownerId(), 'oauth')).toBe('working')
    expect(svc.personalRoom(ownerId(), 'none')).toBe('working')
  })

  test('Connect again at a waiting address takes the new name, notes and write rule; another short name makes a new one', async () => {
    const a = await strict()
    const b = await olga.call('POST', '/api/integrations', { kind: 'mcp', name: 'Renamed', url: `${fake.base}/mcp-strict`, auth: 'oauth', notes: 'for the design team', writePolicy: 'deny' })
    expect(b.id).toBe(a.id)
    expect(getRow(h.ctx.db, a.id)).toMatchObject({ name: 'Renamed', notes: 'for the design team', write_policy: 'deny' })
    const c = await olga.call('POST', '/api/integrations', { kind: 'mcp', name: 'Other', slug: 'othershort', url: `${fake.base}/mcp-strict`, auth: 'oauth' })
    expect(c.id).not.toBe(a.id)
    expect(c.slug).toBe('othershort')
  })

  test('connections waiting for a sign-in have a cap of their own; one with a stored sign-in is never reused', async () => {
    for (let i = 0; i < MAX_PERSONAL; i++) { insert(`wait-${i}`, `${fake.base}/mcp-strict?w=${i}`, 'oauth', null); tried(`wait-${i}`, 10 * 60_000) }
    // every one tried within the hour: none may go, said as waiting ones (not as the limit of working ones)
    const over = await olga.try('POST', '/api/integrations', { kind: 'mcp', name: 'One more', url: `${fake.base}/mcp-strict?w=new`, auth: 'oauth' })
    expect(over.status).toBe(409)
    expect(over.body.error.message).toBe(TEXT.tooManyWaiting.ko.replace('{n}', String(MAX_PERSONAL)))
    expect(personalCounts(h.ctx.db, ownerId()).waiting).toBe(MAX_PERSONAL)
    // Connect for an address that has one waiting still works (it is the same one)
    expect((await olga.call('POST', '/api/integrations', { kind: 'mcp', name: 'Again', url: `${fake.base}/mcp-strict?w=3`, auth: 'oauth' })).id).toBe('wait-3')
    h.ctx.db.query("DELETE FROM integrations WHERE id LIKE 'wait-%'").run()
    // signed in once (a stored sign-in): a new Connect makes its own
    insert('signed', `${fake.base}/mcp-strict`, 'oauth', 'sealed')
    expect((await strict()).id).not.toBe('signed')
  })
})

describe('waiting connections never block adding a connector (QA TC-3048)', () => {
  const ownerId = () => (h.ctx.db.query("SELECT id FROM users WHERE username = 'olga'").get() as { id: string }).id
  const at = () => new Date(fake.now).toISOString()
  const insert = (id: string, auth: string, secret: string | null, more: { template_id?: string; oauth_client?: string } = {}) => h.ctx.db.query(`INSERT INTO integrations (id, scope, owner_user_id, created_by, kind, name, slug, url, auth, status, secret_enc, template_id, oauth_client, created_at, updated_at)
    VALUES (?, 'personal', ?, ?, 'mcp', 'n', ?, ?, ?, 'needs_auth', ?, ?, ?, ?, ?)`).run(id, ownerId(), ownerId(), id, `${fake.base}/mcp-strict?keep=${id}`, auth, secret, more.template_id ?? null, more.oauth_client ?? null, at(), at())
  const exists = (id: string) => !!h.ctx.db.query('SELECT 1 FROM integrations WHERE id = ?').get(id)
  const connect = (url: string) => olga.call('POST', '/api/integrations', { kind: 'mcp', name: 'Try', url, auth: 'oauth' }, PUBLIC)

  test('25 tries at services that refuse or windows closed, over two hours, then a 26th Connect at a service that works connects', async () => {
    const ids: string[] = []
    for (let i = 0; i < 25; i++) {
      // most refuse the app (Canva, Figma, Intercom, Square); every fifth window is closed without signing in
      const closed = i % 5 === 4
      fake.strict = closed ? {} : { register: 403 }
      const c = await connect(`${fake.base}/mcp-strict?try=${i}`)
      ids.push(c.id)
      expect((await authorize(c.id)).status, `try ${i}`).toBe(closed ? 200 : 400)
      fake.now += 4 * 60_000
    }
    expect(personalCounts(h.ctx.db, ownerId())).toEqual({ settled: 0, waiting: MAX_PERSONAL })
    fake.strict = {}
    const ok = await connect(`${fake.base}/mcp-strict?fine=1`)
    const r = await authorize(ok.id)
    expect(r.status).toBe(200)
    expect((await olga.raw('GET', callback(fake.authorize(r.body.authorizationUrl, `${fake.base}/as-strict`)))).status).toBe(200)
    const listed = (await olga.call('GET', '/api/integrations')).items
    expect(listed.find((i: any) => i.id === ok.id)).toMatchObject({ status: 'connected' })
    // the six oldest tries made room, oldest first; the rest stay
    for (const [n, id] of ids.entries()) {
      expect(exists(id), `try ${n}`).toBe(n >= 6)
      expect(listed.some((i: any) => i.id === id), `try ${n} listed`).toBe(n >= 6)
    }
    expect(personalCounts(h.ctx.db, ownerId())).toEqual({ settled: 1, waiting: MAX_PERSONAL - 1 })
    // each removal is logged like a delete
    expect(h.ctx.db.query("SELECT count(*) AS n FROM audit_log WHERE action = 'integration.delete' AND detail LIKE '%\"replaced\":\"waiting\"%'").get()).toEqual({ n: 6 })
  })

  test('the oldest that may go is removed: its sign-in had ended and cannot finish later; one tried in the last hour stays and still signs in', async () => {
    fake.strict = {}
    const ids: string[] = []
    for (let i = 0; i < MAX_PERSONAL; i++) { ids.push((await connect(`${fake.base}/mcp-strict?o=${i}`)).id); fake.now += 60_000 }
    // the oldest: a sign-in started and its window left open
    const old = await authorize(ids[0]!)
    expect(old.status).toBe(200)
    fake.now += 61 * 60_000
    expect(await olga.call('GET', `/api/integrations/flows/${old.body.flowId}`)).toMatchObject({ state: 'expired' })
    // the second oldest: a sign-in going on now
    const now = await authorize(ids[1]!)
    expect(now.status).toBe(200)
    const a = await connect(`${fake.base}/mcp-strict?o=new1`)
    expect(exists(ids[0]!)).toBe(false)
    expect(exists(a.id)).toBe(true)
    // its flow went with it, and the window left open cannot connect anything
    expect((await olga.try('GET', `/api/integrations/flows/${old.body.flowId}`)).status).toBe(404)
    expect((await olga.raw('GET', callback(fake.authorize(old.body.authorizationUrl, `${fake.base}/as-strict`)))).status).not.toBe(200)
    expect(exists(ids[0]!)).toBe(false)
    // the next one skips the connection tried in the last hour
    await connect(`${fake.base}/mcp-strict?o=new2`)
    expect(exists(ids[1]!)).toBe(true)
    expect(exists(ids[2]!)).toBe(false)
    expect(personalCounts(h.ctx.db, ownerId()).waiting).toBe(MAX_PERSONAL)
    // and that sign-in still finishes
    expect((await olga.raw('GET', callback(fake.authorize(now.body.authorizationUrl, `${fake.base}/as-strict`)))).status).toBe(200)
    expect(getRow(h.ctx.db, ids[1]!)!.secret_enc).not.toBeNull()
  })

  test('never removed: a stored sign-in, a key, one from a template, one with its own app', async () => {
    insert('signed', 'oauth', 'sealed')
    insert('keyed', 'bearer', 'sealed')
    insert('from-template', 'oauth', null, { template_id: 'tpl-1' })
    for (let i = 0; i < MAX_PERSONAL - 1; i++) insert(`own-app-${i}`, 'oauth', null, { oauth_client: JSON.stringify({ clientId: 'mine' }) })
    fake.now += 60_000
    insert('plain', 'oauth', null)
    expect(personalCounts(h.ctx.db, ownerId())).toEqual({ settled: 2, waiting: MAX_PERSONAL })
    // the only one that may go is the newest
    fake.strict = {}
    const a = await connect(`${fake.base}/mcp-strict?n=1`)
    expect(exists('plain')).toBe(false)
    // then only the new one may go (it was never tried)
    await connect(`${fake.base}/mcp-strict?n=2`)
    expect(exists(a.id)).toBe(false)
    // with a sign-in try on the newest, none may go: refused, saying so, nothing removed
    const n2 = (h.ctx.db.query("SELECT id FROM integrations WHERE url LIKE '%?n=2'").get() as { id: string }).id
    expect((await authorize(n2)).status).toBe(200)
    const over = await olga.try('POST', '/api/integrations', { kind: 'mcp', name: 'More', url: `${fake.base}/mcp-strict?n=3`, auth: 'oauth' })
    expect(over.status).toBe(409)
    expect(over.body.error.message).toBe(TEXT.tooManyWaiting.ko.replace('{n}', String(MAX_PERSONAL)))
    for (const id of ['signed', 'keyed', 'from-template', n2, ...Array.from({ length: MAX_PERSONAL - 1 }, (_, i) => `own-app-${i}`)]) expect(exists(id), id).toBe(true)
    // a key connection is never held up by waiting ones
    expect((await olga.call('POST', '/api/integrations', { kind: 'mcp', name: 'Key', url: `${fake.base}/mcp-key`, auth: 'bearer', secret: MCP_KEY })).status).toBe('connected')
  })

  test('a key changed to sign-in at the waiting cap replaces the oldest waiting one', async () => {
    for (let i = 0; i < MAX_PERSONAL; i++) insert(`wait-${i}`, 'oauth', null)
    fake.now += 60_000
    const key = await olga.call('POST', '/api/integrations', { kind: 'mcp', name: 'Key', url: `${fake.base}/mcp-key`, auth: 'bearer', secret: MCP_KEY })
    await olga.call('PATCH', `/api/integrations/${key.id}`, { auth: 'oauth' })
    expect(getRow(h.ctx.db, key.id)).toMatchObject({ auth: 'oauth', secret_enc: null })
    expect(personalCounts(h.ctx.db, ownerId())).toEqual({ settled: 0, waiting: MAX_PERSONAL })
    expect(Array.from({ length: MAX_PERSONAL }, (_, i) => exists(`wait-${i}`)).filter((x) => !x).length).toBe(1)
  })

  test('a save that fails removes nothing: the replacement is in the write\'s transaction (create and a key changed to sign-in)', async () => {
    for (let i = 0; i < MAX_PERSONAL; i++) insert(`wait-${i}`, 'oauth', null)
    fake.now += 60_000
    const key = await olga.call('POST', '/api/integrations', { kind: 'mcp', name: 'Key', url: `${fake.base}/mcp-key`, auth: 'bearer', secret: MCP_KEY })
    const deletes = () => (h.ctx.db.query("SELECT count(*) AS n FROM audit_log WHERE action = 'integration.delete'").get() as { n: number }).n
    // the write itself fails (a trigger stands in for a failure in the database)
    h.ctx.db.exec("CREATE TRIGGER tc3048_insert BEFORE INSERT ON integrations WHEN NEW.name = 'Boom' BEGIN SELECT RAISE(ABORT, 'boom'); END")
    h.ctx.db.exec("CREATE TRIGGER tc3048_update BEFORE UPDATE ON integrations WHEN NEW.id = '" + key.id + "' AND NEW.auth = 'oauth' BEGIN SELECT RAISE(ABORT, 'boom'); END")
    try {
      const made = await olga.try('POST', '/api/integrations', { kind: 'mcp', name: 'Boom', url: `${fake.base}/mcp-strict?boom=1`, auth: 'oauth' })
      expect(made.status).toBeGreaterThanOrEqual(500)
      const changed = await olga.try('PATCH', `/api/integrations/${key.id}`, { auth: 'oauth' })
      expect(changed.status).toBeGreaterThanOrEqual(500)
      for (let i = 0; i < MAX_PERSONAL; i++) expect(exists(`wait-${i}`), `wait-${i}`).toBe(true)
      expect(deletes()).toBe(0)
      expect(getRow(h.ctx.db, key.id)).toMatchObject({ auth: 'bearer' })
    } finally { h.ctx.db.exec('DROP TRIGGER tc3048_insert; DROP TRIGGER tc3048_update') }
    // the same saves without the failure replace one each
    await connect(`${fake.base}/mcp-strict?boom=2`)
    await olga.call('PATCH', `/api/integrations/${key.id}`, { auth: 'oauth' })
    expect(deletes()).toBe(2)
    expect(personalCounts(h.ctx.db, ownerId()).waiting).toBe(MAX_PERSONAL)
  })

  test('other people\'s waiting connections and waiting team connections are never touched', async () => {
    const mia = await addMember(h, olga, { username: 'mia' })
    const other = (id: string, scope: 'personal' | 'team', owner: string | null) => h.ctx.db.query(`INSERT INTO integrations (id, scope, owner_user_id, created_by, kind, name, slug, url, auth, status, secret_enc, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'mcp', 'n', ?, ?, 'oauth', 'needs_auth', NULL, ?, ?)`).run(id, scope, owner, owner ?? ownerId(), id, `${fake.base}/mcp-strict?other=${id}`, at(), at())
    // theirs are older than every one of olga's
    for (let i = 0; i < MAX_PERSONAL; i++) other(`mia-${i}`, 'personal', mia.id)
    for (let i = 0; i < 3; i++) other(`team-${i}`, 'team', null)
    fake.now += 60_000
    for (let i = 0; i < MAX_PERSONAL; i++) insert(`wait-${i}`, 'oauth', null)
    fake.strict = {}
    for (let n = 0; n < 3; n++) { fake.now += 60_000; await connect(`${fake.base}/mcp-strict?olga=${n}`) }
    for (let i = 0; i < MAX_PERSONAL; i++) expect(exists(`mia-${i}`), `mia-${i}`).toBe(true)
    for (let i = 0; i < 3; i++) expect(exists(`team-${i}`), `team-${i}`).toBe(true)
    expect(Array.from({ length: MAX_PERSONAL }, (_, i) => exists(`wait-${i}`)).filter((x) => !x).length).toBe(3)
    expect(personalCounts(h.ctx.db, mia.id)).toEqual({ settled: 0, waiting: MAX_PERSONAL })
  })

  test('the words: "working connections" for the limit, the waiting cap in plain words, six languages', () => {
    for (const k of ['tooManyWorking', 'tooManyWaiting'] as const) for (const l of [...LOCALES, 'zh'] as const) expect(TEXT[k][l], `${k} ${l}`).toContain('{n}')
    expect(TEXT.tooManyWorking.en).toContain('working connections')
    expect(TEXT.tooManyWaiting.en).not.toMatch(/OAuth|flow|record|token|hour/i)
  })
})

describe('catalog', () => {
  test('Netlify: the documented address and the one listed before are both official', () => {
    for (const u of ['https://mcp.netlify.com/mcp', 'https://netlify-mcp.netlify.app/mcp']) {
      expect(officialService(u)?.id, u).toBe('netlify')
      expect(catalogAt(u)?.id, u).toBe('netlify')
    }
    expect(SERVICE_CATALOG.find((c) => c.id === 'netlify')!.url).toBe('https://mcp.netlify.com/mcp')
  })
})

// ---- the listed services' recorded metadata ----
interface Answer { status: number; headers?: Record<string, string>; json?: unknown; body?: string }
interface Recorded { id: string; mcpUrl: string; initialize: Answer; get: Record<string, Answer>; register?: Answer; authorize?: Answer }
const RECORDED: Recorded[] = JSON.parse(fs.readFileSync(path.join(import.meta.dir, '../fixtures/connectors/sign-in-metadata.json'), 'utf8')).services
/** What a sign-in from a public https address comes to with each service's recorded answers. A metadata document's
 * sign-in page was not recorded (it needs this server reachable): it is assumed to take the document, so "metadata"
 * says only that the server will offer it. Only the deployed server shows whether the service then accepts it. */
const EXPECTED: Record<string, 'registered' | 'metadata' | 'approved_only' | 'no_registration'> = {
  canva: 'metadata', indeed: 'metadata', railway: 'metadata', vercel: 'metadata',
  figma: 'approved_only', intercom: 'approved_only', square: 'approved_only',
  // registers no apps: it signs in through the server's GitHub App (c-integrations-github.test.ts)
  github: 'no_registration',
  // register no apps and take no metadata document: the team's own app, set up as a template (service-catalog.ts teamApp)
  asana: 'no_registration', hubspot: 'no_registration', box: 'no_registration',
}
/** the second probe of an address (Canva's documented api.canva.com, Atlassian's v1) */
const expectedFor = (r: Recorded) => (r.mcpUrl === 'https://api.canva.com/connect/v1/mcp' ? 'no_registration' : EXPECTED[r.id] ?? 'registered')

function recordedNet(r: Recorded, server: { registration?: string; authorization?: string }): NetOptions {
  const reply = (a: Answer) => ({ status: a.status, headers: a.headers ?? {}, body: a.json !== undefined ? JSON.stringify(a.json) : a.body ?? '' })
  return {
    answer: async (url: string, req: NetRequest) => {
      if (req.method === 'POST' && server.registration && url === server.registration) return r.register ? reply(r.register) : { status: 404 }
      if (req.method === 'GET' && server.authorization && url.startsWith(server.authorization + '?')) {
        if (new URL(url).searchParams.get('client_id') === DOC) return { status: 200, body: '<html>Sign in</html>' }
        return r.authorize ? reply(r.authorize) : { status: 404 }
      }
      const a = r.get[url]
      return a && a.status ? reply(a) : { status: 404 }
    },
  }
}

describe('the listed services, from their recorded metadata', () => {
  test('every listed service has a recording', () => {
    const ids = new Set(RECORDED.map((r) => r.id))
    // Microsoft 365's address is reserved and never contacted (its MCP server is this server's own, signed in at
    // Microsoft's fixed addresses: c-integrations-microsoft.test.ts): nothing to record
    for (const c of SERVICE_CATALOG) if (c.id !== 'microsoft365') expect(ids.has(c.id), c.id).toBe(true)
  })
  for (const r of RECORDED) {
    test(`${r.id} (${new URL(r.mcpUrl).host}): ${expectedFor(r)}`, async () => {
      const found = await discover(r.mcpUrl, recordedNet(r, {}), r.initialize.headers?.['www-authenticate'] ?? '')
      expect(found.server.authorizationEndpoint).toMatch(/^https:\/\//)
      const net = recordedNet(r, { registration: found.server.registrationEndpoint ?? undefined, authorization: found.server.authorizationEndpoint })
      const redirect = `${TEAM}/api/integrations/oauth/callback`
      const urlFor = (c: OAuthClient) => authorizationUrl({ ...found, client: c }, 'S'.repeat(43), 'C'.repeat(43))
      let outcome: string
      try {
        const c = await chooseClient(found, TEAM, redirect, net, urlFor, null, [TEAM])
        outcome = c.clientId === DOC ? 'metadata' : 'registered'
      } catch (e: any) { outcome = e?.reason === 'oauth_no_registration' ? 'no_registration' : e?.reason === 'oauth_approved_apps_only' ? 'approved_only' : String(e) }
      expect(outcome).toBe(expectedFor(r))
    })
  }
})

describe('registration names the scope the sign-in asks for (Calendly, QA 2026-11-24)', () => {
  test('the scope goes with the registration and is kept on the client; without one, nothing is sent', async () => {
    const server = { issuer: `${fake.base}/as`, authorizationEndpoint: `${fake.base}/as/authorize`, tokenEndpoint: `${fake.base}/as/token`, registrationEndpoint: `${fake.base}/as/register`, revocationEndpoint: null }
    const n = fake.registrations.length
    const c = await register(server, 'https://team.example/api/integrations/oauth/callback', fake.net(), 'mcp:notetaker:read mcp:scheduling:read')
    expect(fake.registrations[n]).toMatchObject({ scope: 'mcp:notetaker:read mcp:scheduling:read' })
    expect(c.registeredScope).toBe('mcp:notetaker:read mcp:scheduling:read')
    const plain = await register(server, 'https://team.example/api/integrations/oauth/callback', fake.net())
    expect(fake.registrations[n + 1]).not.toHaveProperty('scope')
    expect(plain.registeredScope).toBeUndefined()
  })

  test('chooseClient registers with the setup scope', async () => {
    const found = { server: { issuer: `${fake.base}/as`, authorizationEndpoint: `${fake.base}/as/authorize`, tokenEndpoint: `${fake.base}/as/token`, registrationEndpoint: `${fake.base}/as/register`, revocationEndpoint: null } }
    const n = fake.registrations.length
    const c = await chooseClient({ server: found.server, scope: 'read write' }, 'https://team.example', 'https://team.example/api/integrations/oauth/callback', fake.net(), (x) => authorizationUrl({ server: found.server, client: x, resource: null, scope: 'read write' }, 's', 'c'))
    expect(fake.registrations[n]).toMatchObject({ scope: 'read write' })
    expect(c.registeredScope).toBe('read write')
  })
})


// Asana, HubSpot and Box register no apps for others and take no metadata document: they sign in only through the
// team's own app (shared/src/service-catalog.ts teamApp, docs/INTEGRATIONS.md "Services that need the team's own app").
// Connected by their address without one, the sign-in stops before anything is registered or opened, in words that
// say an admin sets it up; with the team's app (a template) the sign-in goes to the service with that app.
describe('a listed service that signs in only through the team\'s own app', () => {
  const recorded = (id: string) => RECORDED.find((r) => r.id === id)!
  /** the recorded answers, and every request that reached past them */
  function netFor(r: Recorded) {
    const sent: { method: string; url: string }[] = []
    const inner = recordedNet(r, {})
    // the MCP address answers as recorded (401 naming its metadata); the rest from the recorded GETs
    const init = { status: r.initialize.status, headers: r.initialize.headers ?? {}, body: '' }
    return { sent, net: { answer: async (url: string, req: NetRequest) => { sent.push({ method: req.method, url }); return req.method === 'POST' && url === r.mcpUrl ? init : inner.answer!(url, req) } } satisfies NetOptions }
  }

  test('Granola registers itself: it is listed like any other, with no team app', () => {
    expect(SERVICE_CATALOG.find((c) => c.id === 'granola')).toBeTruthy()
    expect(teamAppAt('https://mcp.granola.ai/mcp')).toBeNull()
    expect(expectedFor(recorded('granola'))).toBe('registered')
  })

  test('only at the exact official address: Asana asks for scope "default", HubSpot and Box for none', () => {
    expect(teamAppAt('https://mcp.asana.com/v2/mcp')).toMatchObject({ scope: 'default' })
    expect(teamAppAt('https://mcp.hubspot.com')?.scope).toBeUndefined()
    expect(teamAppAt('https://mcp.box.com/')?.guide).toMatch(/^https:\/\/developer\.box\.com\//)
    for (const u of ['https://mcp.asana.com.example.com/v2/mcp', 'http://mcp.asana.com/v2/mcp', 'https://mcp.asana.com/v2/mcp?x=1']) expect(teamAppAt(u), u).toBeNull()
  })

  for (const id of ['asana', 'hubspot', 'box'] as const) {
    test(`${id}: without the team's app the sign-in says an admin sets it up, and nothing is registered`, async () => {
      const r = recorded(id)
      const c = await olga.call('POST', '/api/integrations', { kind: 'mcp', name: r.id, url: r.mcpUrl, auth: 'oauth' }, PUBLIC)
      const before = fake.seen.length
      const name = SERVICE_CATALOG.find((x) => x.id === id)!.name
      const a = await authorize(c.id)
      expect(a.status).toBe(400)
      expect(a.body.error.message).toBe(say('oauth_needs_team_app', 'ko', { name }))
      expect(a.body.error.message).toContain(name)
      expect(getRow(h.ctx.db, c.id)).toMatchObject({ status: 'needs_auth', last_error: 'oauth_needs_team_app' })
      // nothing was looked up, registered or opened anywhere
      expect(fake.seen.length).toBe(before)
    })
  }

  test('every language says it, with the service\'s name', () => {
    for (const l of [...LOCALES, 'zh'] as const) expect(say('oauth_needs_team_app', l, { name: 'Asana' }), l).toContain('Asana')
    expect(say('oauth_needs_team_app', 'ko', { name: 'Asana' })).toContain('Asana는')
    expect(say('oauth_needs_team_app', 'ko', { name: 'HubSpot' })).toContain('HubSpot은')
  })

  test('with the team\'s own app on a template, a member signs in through it at the service, with Asana\'s scope', async () => {
    const r = recorded('asana')
    const { net } = netFor(r)
    integrationsOf(h.ctx, { net, now: () => fake.now })
    const tpl = await olga.call('POST', '/api/admin/integration-templates', {
      kind: 'mcp', name: 'Asana', url: r.mcpUrl, auth: 'oauth', authHeader: null, notes: null, access: { everyone: true, groups: [], users: [] },
      oauthClient: { clientId: 'team-asana-app', clientSecret: 'CANARY-asana-secret', scope: 'default' },
    }, PUBLIC)
    const version = (await olga.call('GET', '/api/integration-templates')).items.find((x: any) => x.id === tpl.id).version
    const mine = await olga.call('POST', `/api/integration-templates/${tpl.id}/connect`, { version }, PUBLIC)
    const a = await authorize(mine.id)
    expect(a.status).toBe(200)
    const u = new URL(a.body.authorizationUrl)
    expect(u.origin + u.pathname).toBe('https://app.asana.com/-/oauth_authorize')
    expect(u.searchParams.get('client_id')).toBe('team-asana-app')
    expect(u.searchParams.get('scope')).toBe('default')
    expect(a.body.authorizationUrl).not.toContain('CANARY')
  })
})
