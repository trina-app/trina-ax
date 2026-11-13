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
import { catalogAt, officialService, SERVICE_CATALOG } from '../../shared/src/service-catalog'
import { harness, withOwner, type Client, type Harness } from './a-lib'
import { FakeServices, MCP_KEY } from '../lib/fake-services'
import { integrationsOf, MAX_PERSONAL, personalCounts, personalFull } from '../../server/src/integrations/connections/service'
import { connectRows } from '../../server/src/chat/connect-service'
import { getRow } from '../../server/src/integrations/connections/store'
import { authorizationUrl, chooseClient, CLIENT_METADATA_PATH, discover, documentOriginAt, documentOrigins, pageWords, preflight, publicOrigin, type OAuthClient } from '../../server/src/integrations/connections/oauth'
import type { NetOptions, NetRequest } from '../../server/src/integrations/connections/net'
import { reasonText, TEXT } from '../../server/src/integrations/connections/text'

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

  test('a document is never offered from an address a service cannot reach: localhost or plain http keep the plain reason', async () => {
    fake.strict = { refuseRegistered: true, metadata: true }
    const c = await strict()
    // the browser on the harness's own address, http://team.localhost
    const r = await authorize(c.id, { origin: 'http://team.localhost' })
    expect(r.status).toBe(400)
    expect(r.body.error.message).toBe(approvedOnly.ko)
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
  })
})

describe('sign-ins that never finished', () => {
  const insert = (id: string, url: string, auth: string, secret: string | null) => h.ctx.db.query(`INSERT INTO integrations (id, scope, owner_user_id, created_by, kind, name, slug, url, auth, status, secret_enc, created_at, updated_at)
    VALUES (?, 'personal', ?, ?, 'mcp', 'n', ?, ?, ?, 'connected', ?, ?, ?)`).run(id, ownerId(), ownerId(), id, url, auth, secret, new Date().toISOString(), new Date().toISOString())
  const ownerId = () => (h.ctx.db.query("SELECT id FROM users WHERE username = 'olga'").get() as { id: string }).id

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
    expect(more.body.error.message).toContain(String(MAX_PERSONAL))
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

  test('the chat card counts like Settings: waiting ones do not fill the limit, and have their own cap', async () => {
    for (let i = 0; i < MAX_PERSONAL; i++) insert(`wait-${i}`, `${fake.base}/mcp-strict?w=${i}`, 'oauth', null)
    expect(connectRows(h.ctx.db, ownerId(), 'personal').count).toBe(0)
    expect(personalFull(h.ctx.db, ownerId(), 'bearer')).toBe(false)
    expect(personalFull(h.ctx.db, ownerId(), 'oauth')).toBe(true)
    h.ctx.db.query("DELETE FROM integrations WHERE id LIKE 'wait-%'").run()
    for (let i = 0; i < MAX_PERSONAL; i++) insert(`ok-${i}`, `${fake.base}/mcp-open?n=${i}`, 'none', null)
    expect(connectRows(h.ctx.db, ownerId(), 'personal').count).toBe(MAX_PERSONAL)
    expect(personalFull(h.ctx.db, ownerId(), 'oauth')).toBe(true)
    expect(personalFull(h.ctx.db, ownerId(), 'none')).toBe(true)
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
    for (let i = 0; i < MAX_PERSONAL; i++) insert(`wait-${i}`, `${fake.base}/mcp-strict?w=${i}`, 'oauth', null)
    const over = await olga.try('POST', '/api/integrations', { kind: 'mcp', name: 'One more', url: `${fake.base}/mcp-strict?w=new`, auth: 'oauth' })
    expect(over.status).toBe(409)
    // Connect for an address that has one waiting still works (it is the same one)
    expect((await olga.call('POST', '/api/integrations', { kind: 'mcp', name: 'Again', url: `${fake.base}/mcp-strict?w=3`, auth: 'oauth' })).id).toBe('wait-3')
    h.ctx.db.query("DELETE FROM integrations WHERE id LIKE 'wait-%'").run()
    // signed in once (a stored sign-in): a new Connect makes its own
    insert('signed', `${fake.base}/mcp-strict`, 'oauth', 'sealed')
    expect((await strict()).id).not.toBe('signed')
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
}
/** the second probe of an address (Canva's documented api.canva.com, Atlassian's v1) */
const expectedFor = (r: Recorded) => (r.mcpUrl === 'https://api.canva.com/connect/v1/mcp' ? 'no_registration' : EXPECTED[r.id] ?? 'registered')

function recordedNet(r: Recorded, server: { registration?: string; authorization?: string }): NetOptions {
  const reply = (a: Answer) => ({ status: a.status, headers: a.headers ?? {}, body: a.json !== undefined ? JSON.stringify(a.json) : a.body ?? '' })
  return {
    answerForTests: async (url: string, req: NetRequest) => {
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
    for (const c of SERVICE_CATALOG) expect(ids.has(c.id), c.id).toBe(true)
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
