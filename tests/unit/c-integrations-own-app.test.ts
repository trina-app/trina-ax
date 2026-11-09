// Signing in through your own app at services that do not register apps themselves (docs/INTEGRATIONS.md "Your own
// app"; service.ts appOf / appAfter, oauth.ts ownClient / manualServer, templates.ts appAfter): Google's MCP servers and
// HTTP APIs such as NAVER WORKS. Checked here: without an app such a service says how to fix it; with one the sign-in
// uses its client ID, sends its secret only to the token address, and the secret never shows (responses, database
// outside the sealed columns, audit, flows, logs); a new app drops the sign-in; an HTTP API signs in with no resource
// indicator, reads expires_in written as text and refreshes after a 401; Google gets offline access; a template's app
// is used for its members' sign-ins without them ever seeing it, and a new app on the template drops their sign-ins.
// The review rounds: a stored secret never follows a new address (also the service address), the token address found is
// remembered after a sign-in that worked and forgotten when the secret is entered again, a member the template no
// longer covers cannot sign in through it, and an "iss" must name the sign-in address's server.
// Fake services only: no real Google or NAVER WORKS app exists here.
import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'
import { FakeServices } from '../lib/fake-services'
import { integrationsOf, type Integrations } from '../../server/src/integrations/connections/service'
import { getRow } from '../../server/src/integrations/connections/store'
import { createLogger } from '../../server/src/log'

setDefaultTimeout(30_000)

const SECRET = 'CANARY-client-secret-58Qz1v'
const SECRET2 = 'CANARY-client-secret-two-7Yx3'
const APP = 'own-app-1234.apps.example'
const REDIRECT = 'http://team.localhost/api/integrations/oauth/callback'

let h: Harness, olga: Client, bob: Client, bobId: string, fake: FakeServices, svc: Integrations
let logs: string[] = []
let seq = 0
beforeAll(() => { fake = new FakeServices() })
afterAll(() => fake?.stop())
beforeEach(async () => {
  logs = []
  h = await harness('int-own-app-' + ++seq, {}, { log: createLogger({ level: 'debug', sink: (l) => logs.push(l) }) })
  olga = await withOwner(h)
  const b = await addMember(h, olga, { username: 'bob', role: 'member' })
  bob = b.client; bobId = b.id
  fake.now = Date.now(); fake.refreshCount = 0; fake.revoked = []; fake.expiresAsText = false
  // the app made in the service's console: its ID, secret and this team's callback address
  fake.clients.set(APP, { redirectUris: [REDIRECT] })
  fake.secrets.set(APP, SECRET)
  svc = integrationsOf(h.ctx, { net: fake.net(), now: () => fake.now })
})
afterEach(async () => { await h?.close() })

const until = async (ok: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await Bun.sleep(20); return ok() }
const callback = (q: Record<string, string>) => '/api/integrations/oauth/callback?' + new URLSearchParams(q)
const everything = () => ['integrations', 'integration_templates', 'integration_oauth_flows', 'audit_log', 'tool_events']
  .map((t) => JSON.stringify(h.ctx.db.query(`SELECT * FROM ${t}`).all())).join('\n') + logs.join('\n')
const tokenCalls = (): Record<string, string | null>[] => fake.seen.filter((s) => s.path === '/as/token').map((s) => ({ ...Object.fromEntries(new URLSearchParams(s.body)), basic: s.headers.authorization ?? null }))
const ownMcp = (over: Record<string, unknown> = {}) => ({ kind: 'mcp', name: 'Mail', url: `${fake.base}/mcp-own`, auth: 'oauth', ...over })
const ownApi = (over: Record<string, unknown> = {}) => ({
  kind: 'http', name: 'Works', url: `${fake.base}/oauth-api/v1`, auth: 'oauth', notes: 'GET /tasks lists tasks.',
  oauthClient: { clientId: APP, clientSecret: SECRET, authorizationUrl: `${fake.base}/as/authorize`, tokenUrl: `${fake.base}/as/token`, scope: 'tasks tasks.read' }, ...over,
})

test('an MCP server that registers no apps: without one the sign-in says how; with the own app it signs in and its secret never shows', async () => {
  const c = await olga.call('POST', '/api/integrations', ownMcp())
  expect(c.oauthClient).toBeNull()
  const no = await olga.try('POST', `/api/integrations/${c.id}/authorize`, {})
  expect(no.status).toBe(400)
  expect(no.body.error.message).toContain('Client ID')
  expect(fake.seen.some((s) => s.path === '/as/register')).toBe(false)

  const set = await olga.call('PATCH', `/api/integrations/${c.id}`, { oauthClient: { clientId: APP, clientSecret: SECRET, scope: 'own.read' } })
  expect(set.oauthClient).toEqual({ clientId: APP, authorizationUrl: null, tokenUrl: null, scope: 'own.read', hasSecret: true })
  expect(JSON.stringify(set)).not.toContain(SECRET)
  const f = await olga.call('POST', `/api/integrations/${c.id}/authorize`, {})
  const u = new URL(f.authorizationUrl)
  // found from the server's address (its own authorization server), asked with the app's ID and its own scope
  expect(u.origin + u.pathname).toBe(`${fake.base}/as/authorize`)
  expect(Object.fromEntries(u.searchParams)).toMatchObject({ client_id: APP, scope: 'own.read', resource: `${fake.base}/mcp-own`, redirect_uri: REDIRECT, code_challenge_method: 'S256' })
  expect(u.searchParams.has('access_type')).toBe(false)
  expect(f.authorizationUrl).not.toContain(SECRET)
  // an "iss" from another server than the one found is refused (RFC 9207)
  const wrong = fake.authorize(f.authorizationUrl)
  expect((await olga.raw('GET', callback(wrong))).status).toBe(400)
  const f2 = await olga.call('POST', `/api/integrations/${c.id}/authorize`, {})
  expect((await olga.raw('GET', callback(fake.authorize(f2.authorizationUrl, `${fake.base}/as-own`)))).status).toBe(200)
  // the secret went to the token address only, in the body (the server lists client_secret_post)
  expect(tokenCalls().at(-1)).toMatchObject({ grant_type: 'authorization_code', client_id: APP, client_secret: SECRET, basic: null })
  const after = (await olga.call('GET', '/api/integrations')).items.find((i: any) => i.id === c.id)
  expect(after).toMatchObject({ status: 'connected', hasSecret: true })
  expect(after.tools.map((t: any) => t.name)).toContain('create_task')
  expect(fake.seen.filter((s) => s.path !== '/as/token').some((s) => JSON.stringify(s).includes(SECRET))).toBe(false)
  // the token runs out: refreshed with the app's secret
  fake.now += 3600_000 + 1
  await svc.callTool(getRow(h.ctx.db, c.id)!, 'search_tasks', { q: 'x' })
  expect(fake.refreshCount).toBe(1)
  expect(tokenCalls().at(-1)).toMatchObject({ grant_type: 'refresh_token', client_secret: SECRET })
  expect(everything()).not.toContain(SECRET)
  expect(everything()).not.toContain('CANARY-access-')
  const audit = (h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'integration.update' AND target = ?").all(c.id) as { detail: string }[]).map((d) => JSON.parse(d.detail))
  expect(audit[0]).toMatchObject({ changed: ['oauthClient'] })
})

test('the app is write-only: the same app keeps the sign-in, a new secret or scope drops it, null removes it', async () => {
  const c = await olga.call('POST', '/api/integrations', ownMcp({ oauthClient: { clientId: APP, clientSecret: SECRET } }))
  const f = await olga.call('POST', `/api/integrations/${c.id}/authorize`, {})
  expect((await olga.raw('GET', callback(fake.authorize(f.authorizationUrl, `${fake.base}/as-own`)))).status).toBe(200)
  // without a scope of its own, the scopes the server lists
  expect(new URL(f.authorizationUrl).searchParams.get('scope')).toBe('own.read own.write own.all')
  // the same ID without the secret, and the same secret typed again: nothing changed, still signed in
  for (const oauthClient of [{ clientId: APP }, { clientId: APP, clientSecret: SECRET }]) {
    const r = await olga.call('PATCH', `/api/integrations/${c.id}`, { oauthClient })
    expect(r).toMatchObject({ hasSecret: true, oauthClient: { clientId: APP, hasSecret: true } })
  }
  // another scope: a sign-in made for the old one goes (and is revoked)
  const scoped = await olga.call('PATCH', `/api/integrations/${c.id}`, { oauthClient: { clientId: APP, scope: 'own.read' } })
  expect(scoped).toMatchObject({ hasSecret: false, status: 'needs_auth', oauthClient: { scope: 'own.read', hasSecret: true } })
  // told after the local tokens are gone, without keeping the person waiting
  expect(await until(() => fake.revoked.length > 0)).toBe(true)
  // another ID without a secret: the old secret does not follow it
  const other = await olga.call('PATCH', `/api/integrations/${c.id}`, { oauthClient: { clientId: 'another-app' } })
  expect(other.oauthClient).toMatchObject({ clientId: 'another-app', hasSecret: false })
  // null: back to the service's own registration; leaving sign-in removes the app too
  expect((await olga.call('PATCH', `/api/integrations/${c.id}`, { oauthClient: null })).oauthClient).toBeNull()
  await olga.call('PATCH', `/api/integrations/${c.id}`, { oauthClient: { clientId: APP, clientSecret: SECRET } })
  const key = await olga.call('PATCH', `/api/integrations/${c.id}`, { auth: 'bearer', secret: 'CANARY-some-key-1' })
  expect(key.oauthClient).toBeNull()
  expect(getRow(h.ctx.db, c.id)).toMatchObject({ oauth_client: null, oauth_client_enc: null })
})

test('an HTTP API signs in with its own app: no resource, expires_in as text, a 401 refreshes once and sends again', async () => {
  // sign-in at an API needs the app and its addresses
  for (const body of [ownApi({ oauthClient: undefined }), ownApi({ oauthClient: { clientId: APP } }), ownApi({ oauthClient: { clientId: APP, tokenUrl: `${fake.base}/as/token` } })]) {
    const r = await olga.try('POST', '/api/integrations', body)
    expect(r.status, JSON.stringify(body.oauthClient)).toBe(400)
    expect(Object.keys(r.body.error.fields ?? {}).join()).toContain('body.oauthClient')
  }
  const c = await olga.call('POST', '/api/integrations', ownApi())
  expect(c).toMatchObject({ status: 'needs_auth', oauthClient: { clientId: APP, tokenUrl: `${fake.base}/as/token`, hasSecret: true } })
  const seen = fake.seen.length
  const f = await olga.call('POST', `/api/integrations/${c.id}/authorize`, {})
  // the addresses given: nothing looked up, and an API has no resource indicator
  expect(fake.seen.length).toBe(seen)
  const u = new URL(f.authorizationUrl)
  expect(Object.fromEntries(u.searchParams)).toMatchObject({ client_id: APP, scope: 'tasks tasks.read', response_type: 'code' })
  expect(u.searchParams.has('resource')).toBe(false)
  fake.expiresAsText = true
  // given addresses: an "iss" in the answer must be the sign-in address's server (its origin); another one is refused
  // before the code is exchanged (RFC 9207)
  const tokensBefore = tokenCalls().length
  expect((await olga.raw('GET', callback(fake.authorize(f.authorizationUrl, 'https://elsewhere.example')))).status).toBe(400)
  expect(tokenCalls().length).toBe(tokensBefore)
  const f2 = await olga.call('POST', `/api/integrations/${c.id}/authorize`, {})
  expect((await olga.raw('GET', callback(fake.authorize(f2.authorizationUrl, `${fake.base}/as`)))).status).toBe(200)
  expect(tokenCalls().at(-1)).toMatchObject({ grant_type: 'authorization_code', client_secret: SECRET })
  expect(tokenCalls().at(-1)!.resource).toBeUndefined()
  expect((await olga.call('GET', '/api/integrations')).items.find((i: any) => i.id === c.id)).toMatchObject({ status: 'connected', hasSecret: true })
  // the token was handed out with a text expires_in: it is refreshed ahead of its end, without a 401 first
  const url = `${fake.base}/oauth-api/v1/tasks`
  const get = () => svc.apiRequest(getRow(h.ctx.db, c.id)!, url, { method: 'GET', body: null, contentType: null })
  expect((await get()).status).toBe(200)
  fake.now += 3600_000 + 1
  const before401 = fake.seen.filter((s) => s.path.startsWith('/oauth-api')).length
  expect((await get()).status).toBe(200)
  expect(fake.refreshCount).toBe(1)
  expect(fake.seen.filter((s) => s.path.startsWith('/oauth-api')).length).toBe(before401 + 1)
  // the service forgot the token before its end: one refresh, the request sent again
  fake.access.clear()
  expect((await get()).status).toBe(200)
  expect(fake.refreshCount).toBe(2)
  expect(everything()).not.toContain(SECRET)
})

test('Google: offline access and consent are asked, so a refresh token comes', async () => {
  const c = await olga.call('POST', '/api/integrations', ownApi({ oauthClient: { clientId: APP, clientSecret: SECRET, authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token', scope: 'https://www.googleapis.com/auth/calendar.readonly' } }))
  const u = new URL((await olga.call('POST', `/api/integrations/${c.id}/authorize`, {})).authorizationUrl)
  expect(u.origin).toBe('https://accounts.google.com')
  expect(Object.fromEntries(u.searchParams)).toMatchObject({ access_type: 'offline', prompt: 'consent', client_id: APP, scope: 'https://www.googleapis.com/auth/calendar.readonly' })
})

test('an app is refused where it cannot be used, and its addresses follow the address rules', async () => {
  const bad = async (body: unknown, field = 'body.oauthClient') => {
    const r = await olga.try('POST', '/api/integrations', body)
    expect(r.status, JSON.stringify(body)).toBe(400)
    expect(Object.keys(r.body.error.fields ?? {}).join(), JSON.stringify(body)).toContain(field)
  }
  await bad(ownMcp({ auth: 'bearer', secret: 'CANARY-k-1', oauthClient: { clientId: APP } }))
  await bad(ownMcp({ oauthClient: { clientId: APP, authorizationUrl: `${fake.base}/as/authorize` } }))
  await bad(ownMcp({ oauthClient: { clientId: APP, authorizationUrl: 'https://10.0.0.5/authorize', tokenUrl: 'https://10.0.0.5/token' } }))
  await bad(ownMcp({ oauthClient: { clientId: APP, authorizationUrl: 'http://as.example/authorize', tokenUrl: 'https://as.example/token' } }))
  await bad(ownMcp({ oauthClient: { clientId: 'app​id' } }))
  await bad(ownMcp({ oauthClient: { clientId: APP, clientSecret: 'a\nb' } }))
  // an admin's request to one member stays with services that register apps (a template carries an app)
  const r = await olga.try('POST', '/api/admin/integration-requests', { userId: bobId, kind: 'http', name: 'Works', url: `${fake.base}/oauth-api/v1`, auth: 'oauth' })
  expect(r.status).toBe(400)
})

test('a template carries the team\'s app: members sign in through it and never see it; a new app drops their sign-ins', async () => {
  const everyone = { everyone: false, groups: [], users: [bobId] }
  expect((await olga.try('POST', '/api/admin/integration-templates', { ...ownApi({ oauthClient: undefined }), access: everyone })).status).toBe(400)
  const t = await olga.call('POST', '/api/admin/integration-templates', { ...ownMcp({ oauthClient: { clientId: APP, clientSecret: SECRET, scope: 'own.read' } }), access: everyone })
  expect(t.oauthClient).toEqual({ clientId: APP, authorizationUrl: null, tokenUrl: null, scope: 'own.read', hasSecret: true })
  // the member sees the service, not the app
  const shared = (await bob.call('GET', '/api/integration-templates')).items
  expect(JSON.stringify(shared)).not.toContain(APP)
  expect((await bob.try('GET', '/api/admin/integration-templates')).status).toBe(403)
  const mine = (await bob.try('POST', `/api/integration-templates/${t.id}/connect`, { version: shared[0].version })).body
  expect(mine).toMatchObject({ templateId: t.id, status: 'needs_auth', oauthClient: null })
  // a member cannot put an app of their own on it
  expect((await bob.try('PATCH', `/api/integrations/${mine.id}`, { oauthClient: { clientId: 'mine' } })).status).toBe(400)
  const f = await bob.call('POST', `/api/integrations/${mine.id}/authorize`, {})
  expect(new URL(f.authorizationUrl).searchParams.get('client_id')).toBe(APP)
  expect(f.authorizationUrl).not.toContain(SECRET)
  expect((await bob.raw('GET', callback(fake.authorize(f.authorizationUrl, `${fake.base}/as-own`)))).status).toBe(200)
  expect(tokenCalls().at(-1)).toMatchObject({ client_id: APP, client_secret: SECRET })
  const connected = (await bob.call('GET', '/api/integrations')).items.find((i: any) => i.id === mine.id)
  expect(connected).toMatchObject({ status: 'connected', hasSecret: true, oauthClient: null })
  expect(JSON.stringify(connected)).not.toContain(APP)
  // the same app again (no secret, the same secret): the members stay signed in
  for (const oauthClient of [{ clientId: APP, scope: 'own.read' }, { clientId: APP, clientSecret: SECRET, scope: 'own.read' }]) {
    expect((await olga.call('PATCH', `/api/admin/integration-templates/${t.id}`, { oauthClient })).connected).toBe(1)
  }
  // a new secret: every member's sign-in made with the old one goes, and the service is told
  fake.secrets.set(APP, SECRET2)
  const changed = await olga.call('PATCH', `/api/admin/integration-templates/${t.id}`, { oauthClient: { clientId: APP, clientSecret: SECRET2, scope: 'own.read' } })
  expect(changed.connected).toBe(0)
  expect(getRow(h.ctx.db, mine.id)).toBeNull()
  expect(fake.revoked.length).toBeGreaterThan(0)
  const tplAudit = (h.ctx.db.query("SELECT detail FROM audit_log WHERE action LIKE 'integration_template.%' AND target = ?").all(t.id) as { detail: string }[]).map((d) => JSON.parse(d.detail))
  expect(tplAudit[0]).toMatchObject({ ownApp: true })
  expect(tplAudit.at(-1)).toMatchObject({ changed: ['oauthClient'], keysDropped: true })
  expect(everything()).not.toContain(SECRET)
  expect(everything()).not.toContain(SECRET2)
})

test('security review: a stored client secret never goes to another address than before', async () => {
  const ann = (await addMember(h, olga, { username: 'ann', role: 'admin' })).client
  const access = { everyone: true, groups: [], users: [] }
  const api = await olga.call('POST', '/api/admin/integrations', { ...ownApi(), access })
  // another admin moves the token address without the secret: the secret does not follow it
  const moved = await ann.call('PATCH', `/api/integrations/${api.id}`, { oauthClient: { clientId: APP, authorizationUrl: `${fake.base}/as/authorize`, tokenUrl: `${fake.base}/evil/token`, scope: 'tasks tasks.read' } })
  expect(moved.oauthClient).toMatchObject({ tokenUrl: `${fake.base}/evil/token`, hasSecret: false })
  expect(getRow(h.ctx.db, api.id)!.oauth_client_enc).toBeNull()
  const f = await ann.call('POST', `/api/integrations/${api.id}/authorize`, {})
  await ann.raw('GET', callback(fake.authorize(f.authorizationUrl)))
  expect(fake.seen.filter((s) => s.path === '/evil/token').every((s) => !s.body.includes(SECRET))).toBe(true)
  // an API's app has its addresses: a new connection address drops the secret too (review 3: the tokens of whoever
  // signs in through it go to that address); typed again with the change, it stays
  const api2 = await olga.call('POST', '/api/integrations', ownApi({ name: 'Works2' }))
  expect((await olga.call('PATCH', `/api/integrations/${api2.id}`, { url: `${fake.base}/oauth-api/v1/team` })).oauthClient.hasSecret).toBe(false)
  const typedAgain = await olga.call('PATCH', `/api/integrations/${api2.id}`, { url: `${fake.base}/oauth-api/v1`, oauthClient: { ...ownApi().oauthClient } })
  expect(typedAgain.oauthClient.hasSecret).toBe(true)
  // an MCP server's app finds its addresses from the server: another server address drops the secret
  const mcp = await olga.call('POST', '/api/integrations', ownMcp({ oauthClient: { clientId: APP, clientSecret: SECRET } }))
  expect((await olga.call('PATCH', `/api/integrations/${mcp.id}`, { url: `${fake.base}/mcp-own?tenant=2` })).oauthClient).toMatchObject({ clientId: APP, hasSecret: false })
  // the same on a template
  const t = await olga.call('POST', '/api/admin/integration-templates', { ...ownMcp({ oauthClient: { clientId: APP, clientSecret: SECRET } }), access })
  expect((await ann.call('PATCH', `/api/admin/integration-templates/${t.id}`, { url: `${fake.base}/mcp-own/v2` })).oauthClient).toMatchObject({ hasSecret: false })
  const t2 = await olga.call('POST', '/api/admin/integration-templates', { ...ownApi({ name: 'Works3' }), access })
  expect((await ann.call('PATCH', `/api/admin/integration-templates/${t2.id}`, { oauthClient: { clientId: APP, authorizationUrl: `${fake.base}/as/authorize`, tokenUrl: `${fake.base}/evil/token` } })).oauthClient).toMatchObject({ hasSecret: false })
  expect(everything()).not.toContain(SECRET)
})

test('security review: the token address a sign-in that worked found is remembered; a server that names another one is refused until the secret is entered again', async () => {
  const c = await olga.call('POST', '/api/integrations', ownMcp({ oauthClient: { clientId: APP, clientSecret: SECRET } }))
  const found = () => JSON.parse(getRow(h.ctx.db, c.id)!.oauth_client!).foundTokenUrl
  // review 3: a sign-in started and never finished, or one whose code the service refused, remembers nothing
  const unfinished = await olga.call('POST', `/api/integrations/${c.id}/authorize`, {})
  expect(found()).toBeUndefined()
  const refused = fake.authorize(unfinished.authorizationUrl, `${fake.base}/as-own`)
  expect((await olga.raw('GET', callback({ ...refused, code: 'code-the-service-never-gave' }))).status).toBe(400)
  expect(found()).toBeUndefined()
  const f = await olga.call('POST', `/api/integrations/${c.id}/authorize`, {})
  expect((await olga.raw('GET', callback(fake.authorize(f.authorizationUrl, `${fake.base}/as-own`)))).status).toBe(200)
  expect(found()).toBe(`${fake.base}/as/token`)
  // never shown, and saving the same app keeps it (and the sign-in)
  const same = await olga.call('PATCH', `/api/integrations/${c.id}`, { oauthClient: { clientId: APP } })
  expect(JSON.stringify(same)).not.toContain('foundTokenUrl')
  expect(same.hasSecret).toBe(true)
  expect(found()).toBe(`${fake.base}/as/token`)
  // the server now names another token address: no sign-in starts, and nothing is sent there
  fake.ownTokenEndpoint = `${fake.base}/as/moved-token`
  try {
    const movedCalls = () => fake.seen.filter((s) => s.path === '/as/moved-token')
    const no = await olga.try('POST', `/api/integrations/${c.id}/authorize`, {})
    expect(no.status).toBe(400)
    expect(no.body.error.message).toContain('Client Secret')
    expect(movedCalls()).toHaveLength(0)
    // review 3: the admin trusts it and enters the same secret again, as the refusal says: the old address is forgotten,
    // and the sign-in made with this very app stays
    const again = await olga.call('PATCH', `/api/integrations/${c.id}`, { oauthClient: { clientId: APP, clientSecret: SECRET } })
    expect(again).toMatchObject({ hasSecret: true, status: 'connected', oauthClient: { hasSecret: true } })
    expect(found()).toBeUndefined()
    const moved = await olga.call('POST', `/api/integrations/${c.id}/authorize`, {})
    expect(found()).toBeUndefined()
    expect((await olga.raw('GET', callback(fake.authorize(moved.authorizationUrl, `${fake.base}/as-own`)))).status).toBe(200)
    expect(movedCalls().map((s) => Object.fromEntries(new URLSearchParams(s.body)))).toMatchObject([{ grant_type: 'authorization_code', client_secret: SECRET }])
    expect(found()).toBe(`${fake.base}/as/moved-token`)
    // a new secret forgets it as well
    await olga.call('PATCH', `/api/integrations/${c.id}`, { oauthClient: { clientId: APP, clientSecret: SECRET2 } })
    expect(found()).toBeUndefined()
  } finally { fake.ownTokenEndpoint = null }
})

test('review 3: of two sign-ins through a template\'s app, the first that works decides the token address; the other is refused before its secret goes', async () => {
  const carl = await addMember(h, olga, { username: 'carl', role: 'member' })
  const t = await olga.call('POST', '/api/admin/integration-templates', { ...ownMcp({ oauthClient: { clientId: APP, clientSecret: SECRET } }), access: { everyone: false, groups: [], users: [bobId, carl.id] } })
  const version = (await bob.call('GET', '/api/integration-templates')).items[0].version
  const bobs = (await bob.try('POST', `/api/integration-templates/${t.id}/connect`, { version })).body
  const carls = (await carl.client.try('POST', `/api/integration-templates/${t.id}/connect`, { version })).body
  const movedCalls = () => fake.seen.filter((s) => s.path === '/as/moved-token').length
  const movedBefore = movedCalls()
  // bob starts while the server names another token address; carl starts after it named its own again
  fake.ownTokenEndpoint = `${fake.base}/as/moved-token`
  let fb
  try { fb = await bob.call('POST', `/api/integrations/${bobs.id}/authorize`, {}) } finally { fake.ownTokenEndpoint = null }
  const fc = await carl.client.call('POST', `/api/integrations/${carls.id}/authorize`, {})
  expect((await carl.client.raw('GET', callback(fake.authorize(fc.authorizationUrl, `${fake.base}/as-own`)))).status).toBe(200)
  const pinned = () => JSON.parse((h.ctx.db.query('SELECT oauth_client FROM integration_templates WHERE id = ?').get(t.id) as { oauth_client: string }).oauth_client).foundTokenUrl
  expect(pinned()).toBe(`${fake.base}/as/token`)
  expect((await bob.raw('GET', callback(fake.authorize(fb.authorizationUrl, `${fake.base}/as-own`)))).status).toBe(400)
  expect(movedCalls()).toBe(movedBefore)
  expect(pinned()).toBe(`${fake.base}/as/token`)
})

test('review 3: a new service address on a template drops the team app\'s secret, also with given addresses, so members\' tokens never reach it', async () => {
  const ann = (await addMember(h, olga, { username: 'ann', role: 'admin' })).client
  const t = await olga.call('POST', '/api/admin/integration-templates', { ...ownApi(), access: { everyone: false, groups: [], users: [bobId] } })
  const connect = async () => (await bob.try('POST', `/api/integration-templates/${t.id}/connect`, { version: (await bob.call('GET', '/api/integration-templates')).items[0].version })).body
  const mine = await connect()
  const f = await bob.call('POST', `/api/integrations/${mine.id}/authorize`, {})
  expect((await bob.raw('GET', callback(fake.authorize(f.authorizationUrl)))).status).toBe(200)
  // a second admin, who never saw the secret, points the template at another address (here a service that repeats
  // whatever it gets); the app's sign-in and token addresses stay the real service's
  const moved = await ann.call('PATCH', `/api/admin/integration-templates/${t.id}`, { url: `${fake.base}/echo/v1` })
  expect(moved).toMatchObject({ connected: 0, oauthClient: { clientId: APP, tokenUrl: `${fake.base}/as/token`, hasSecret: false } })
  expect(getRow(h.ctx.db, mine.id)).toBeNull()
  // bob is told to connect again and signs in at the real consent screen: no secret goes with the code, so the service
  // hands out no token, and nothing reaches the new address
  const again = await connect()
  const f2 = await bob.call('POST', `/api/integrations/${again.id}/authorize`, {})
  expect((await bob.raw('GET', callback(fake.authorize(f2.authorizationUrl)))).status).toBe(400)
  expect(tokenCalls().at(-1)!.client_secret).toBeUndefined()
  expect(fake.seen.filter((s) => s.path.startsWith('/echo/v1')).every((s) => !s.headers.authorization)).toBe(true)
  // the same for the sign-in or token address alone; whoever enters the secret again chose the new address
  const t2 = await olga.call('POST', '/api/admin/integration-templates', { ...ownApi({ name: 'Works2' }), access: { everyone: false, groups: [], users: [bobId] } })
  expect((await ann.call('PATCH', `/api/admin/integration-templates/${t2.id}`, { oauthClient: { ...ownApi().oauthClient, clientSecret: undefined, authorizationUrl: `${fake.base}/as/authorize?x=1` } })).oauthClient.hasSecret).toBe(false)
  expect((await olga.call('PATCH', `/api/admin/integration-templates/${t.id}`, { oauthClient: ownApi().oauthClient })).oauthClient.hasSecret).toBe(true)
  expect(everything()).not.toContain(SECRET)
})

test('review 3: a member the template no longer covers can neither start nor finish a sign-in through the team\'s app', async () => {
  const t = await olga.call('POST', '/api/admin/integration-templates', { ...ownMcp({ oauthClient: { clientId: APP, clientSecret: SECRET } }), access: { everyone: false, groups: [], users: [bobId] } })
  const mine = (await bob.try('POST', `/api/integration-templates/${t.id}/connect`, { version: (await bob.call('GET', '/api/integration-templates')).items[0].version })).body
  const f = await bob.call('POST', `/api/integrations/${mine.id}/authorize`, {})
  // the rule changes while the browser is at the service (as a group change does: nothing sweeps until a list loads)
  h.ctx.db.query("UPDATE integration_template_access SET subject_id = ? WHERE template_id = ? AND subject_type = 'user'").run('someone-else', t.id)
  const tokensBefore = tokenCalls().length
  expect((await bob.raw('GET', callback(fake.authorize(f.authorizationUrl, `${fake.base}/as-own`)))).status).toBe(400)
  expect(tokenCalls().length).toBe(tokensBefore)
  expect(getRow(h.ctx.db, mine.id)!.secret_enc).toBeNull()
  const no = await bob.try('POST', `/api/integrations/${mine.id}/authorize`, {})
  expect(no.status).toBe(404)
})

test('review 3: an older build that moved a connection or template without dropping the client secret: it is not sent there', async () => {
  // an older build does not know the app's columns: it changes the address and leaves the secret
  const c = await olga.call('POST', '/api/integrations', ownMcp({ oauthClient: { clientId: APP, clientSecret: SECRET } }))
  h.ctx.db.query('UPDATE integrations SET url = ?, version = version + 1 WHERE id = ?').run(`${fake.base}/mcp-own?tenant=2`, c.id)
  const listed = (await olga.call('GET', '/api/integrations')).items.find((i: any) => i.id === c.id)
  expect(listed.oauthClient).toMatchObject({ clientId: APP, hasSecret: false })
  expect(svc.appOf(getRow(h.ctx.db, c.id)!)!.clientSecret).toBeNull()
  const f = await olga.call('POST', `/api/integrations/${c.id}/authorize`, {})
  expect((await olga.raw('GET', callback(fake.authorize(f.authorizationUrl, `${fake.base}/as-own`)))).status).toBe(400)
  expect(tokenCalls().at(-1)!.client_secret).toBeUndefined()
  // the next save drops it for good, unless it is entered again
  expect((await olga.call('PATCH', `/api/integrations/${c.id}`, { name: 'Mail 2' })).oauthClient.hasSecret).toBe(false)
  expect(getRow(h.ctx.db, c.id)!.oauth_client_enc).toBeNull()
  // a template: neither the admin's view nor a member's sign-in uses it
  const t = await olga.call('POST', '/api/admin/integration-templates', { ...ownMcp({ oauthClient: { clientId: APP, clientSecret: SECRET } }), access: { everyone: false, groups: [], users: [bobId] } })
  const mine = (await bob.try('POST', `/api/integration-templates/${t.id}/connect`, { version: (await bob.call('GET', '/api/integration-templates')).items[0].version })).body
  // (that build dropped the members' connections; bob connected again at the new address)
  h.ctx.db.query('UPDATE integration_templates SET url = ?, version = version + 1 WHERE id = ?').run(`${fake.base}/mcp-own?tenant=2`, t.id)
  h.ctx.db.query('UPDATE integrations SET url = ? WHERE id = ?').run(`${fake.base}/mcp-own?tenant=2`, mine.id)
  expect(svc.appOf(getRow(h.ctx.db, mine.id)!)!.clientSecret).toBeNull()
  expect((await olga.call('GET', '/api/admin/integration-templates')).items.find((x: any) => x.id === t.id).oauthClient).toMatchObject({ hasSecret: false })
})

test('a member of a template for a service that registers no apps is told to ask an admin', async () => {
  const t = await olga.call('POST', '/api/admin/integration-templates', { ...ownMcp(), access: { everyone: false, groups: [], users: [bobId] } })
  const shared = (await bob.call('GET', '/api/integration-templates')).items
  const mine = (await bob.try('POST', `/api/integration-templates/${t.id}/connect`, { version: shared[0].version })).body
  const no = await bob.try('POST', `/api/integrations/${mine.id}/authorize`, {})
  expect(no.status).toBe(400)
  expect(no.body.error.message).toContain('관리자')
  expect(no.body.error.message).not.toContain('내 앱으로 로그인')
})

test('security review 2: a change that leaves the app alone never opens its secret; a scope change keeps the found address', async () => {
  const t = await olga.call('POST', '/api/admin/integration-templates', { ...ownMcp({ oauthClient: { clientId: APP, clientSecret: SECRET } }), access: { everyone: false, groups: [], users: [bobId] } })
  const shared = (await bob.call('GET', '/api/integration-templates')).items
  const mine = (await bob.try('POST', `/api/integration-templates/${t.id}/connect`, { version: shared[0].version })).body
  const f = await bob.call('POST', `/api/integrations/${mine.id}/authorize`, {})
  expect((await bob.raw('GET', callback(fake.authorize(f.authorizationUrl, `${fake.base}/as-own`)))).status).toBe(200)
  // the key folder cannot be read for a moment: a rename keeps the secret and the member's connection
  const open = svc.box.open.bind(svc.box)
  svc.box.open = () => { throw new Error('unreadable') }
  try {
    const renamed = await olga.call('PATCH', `/api/admin/integration-templates/${t.id}`, { name: 'Mail renamed' })
    expect(renamed).toMatchObject({ connected: 1, oauthClient: { hasSecret: true } })
    expect(getRow(h.ctx.db, mine.id)).not.toBeNull()
  } finally { svc.box.open = open }
  // only the scope changes: the members sign in again, and the token address found before still holds
  const pinned = JSON.parse((h.ctx.db.query('SELECT oauth_client FROM integration_templates WHERE id = ?').get(t.id) as { oauth_client: string }).oauth_client).foundTokenUrl
  expect(pinned).toBe(`${fake.base}/as/token`)
  await olga.call('PATCH', `/api/admin/integration-templates/${t.id}`, { oauthClient: { clientId: APP, scope: 'own.read' } })
  expect(JSON.parse((h.ctx.db.query('SELECT oauth_client FROM integration_templates WHERE id = ?').get(t.id) as { oauth_client: string }).oauth_client).foundTokenUrl).toBe(pinned)
  // a member whose server moved its token address is told to ask the admin (they cannot enter the secret)
  const again = (await bob.try('POST', `/api/integration-templates/${t.id}/connect`, { version: (await bob.call('GET', '/api/integration-templates')).items[0].version })).body
  fake.ownTokenEndpoint = `${fake.base}/elsewhere/token`
  try {
    const no = await bob.try('POST', `/api/integrations/${again.id}/authorize`, {})
    expect(no.status).toBe(400)
    expect(no.body.error.message).toContain('관리자')
  } finally { fake.ownTokenEndpoint = null }
})

test('security review 2: a client secret is never sent to a revocation address on another server than the token address', async () => {
  const { revoke } = await import('../../server/src/integrations/connections/oauth')
  const server = { issuer: null, authorizationEndpoint: 'https://as.example/authorize', tokenEndpoint: 'https://as.example/token', registrationEndpoint: null, revocationEndpoint: 'https://elsewhere.example/revoke' }
  const client = { clientId: APP, clientSecret: SECRET, authMethod: 'client_secret_post' as const, redirectUri: REDIRECT }
  // refused before any request (the network options would fail any lookup)
  expect(await revoke({ server, client }, 'token', 'refresh_token', { lookup: async () => { throw new Error('no lookup expected') } })).toBe(false)
})
