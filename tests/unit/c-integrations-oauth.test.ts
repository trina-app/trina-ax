// Signing in at an MCP server (server/src/integrations/connections/oauth.ts + service.ts): discovery from the server's
// 401, dynamic client registration, PKCE S256 with the resource indicator, a flow bound to the person and session that
// started it (state stored hashed), a callback that needs the same person's live browser session, tokens never shown
// or logged, refresh (single flight, after a 401, refused -> sign in again), revocation when the connection goes.
import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import { addMember, harness, OWNER_PW, withOwner, type Client, type Harness } from './a-lib'
import { FakeServices, MCP_KEY } from '../lib/fake-services'
import { integrationsOf, type Integrations } from '../../server/src/integrations/connections/service'
import { getRow } from '../../server/src/integrations/connections/store'
import { createLogger } from '../../server/src/log'

setDefaultTimeout(30_000)

let h: Harness, olga: Client, bob: Client, fake: FakeServices, svc: Integrations
let logs: string[] = []
let seq = 0
beforeAll(() => { fake = new FakeServices() })
afterAll(() => fake?.stop())
beforeEach(async () => {
  logs = []
  h = await harness('int-oauth-' + ++seq, {}, { log: createLogger({ level: 'debug', sink: (l) => logs.push(l) }) })
  olga = await withOwner(h)
  bob = (await addMember(h, olga, { username: 'bob', role: 'member' })).client
  fake.now = Date.now(); fake.refreshCount = 0; fake.revoked = []; fake.delayRefresh = null
  svc = integrationsOf(h.ctx, { net: fake.net(), now: () => fake.now })
})
afterEach(async () => { await h?.close() })

const callback = (q: Record<string, string>) => '/api/integrations/oauth/callback?' + new URLSearchParams(q)
async function create(o: { scope?: 'personal' | 'team' } = {}) {
  return olga.call('POST', o.scope === 'team' ? '/api/admin/integrations' : '/api/integrations', { kind: 'mcp', name: 'Board', url: `${fake.base}/mcp-oauth`, auth: 'oauth', ...(o.scope === 'team' ? { access: { everyone: true, groups: [], users: [] } } : {}) })
}
async function connect() {
  const c = await create()
  const f = await olga.call('POST', `/api/integrations/${c.id}/authorize`, {})
  const cb = fake.authorize(f.authorizationUrl)
  expect((await olga.raw('GET', callback(cb))).status).toBe(200)
  return { id: c.id as string, flow: f, cb }
}
const everything = () => JSON.stringify(h.ctx.db.query('SELECT * FROM integrations').all()) + JSON.stringify(h.ctx.db.query('SELECT * FROM integration_oauth_flows').all())
  + JSON.stringify(h.ctx.db.query('SELECT * FROM audit_log').all()) + JSON.stringify(h.ctx.db.query('SELECT * FROM tool_events').all()) + logs.join('\n')

test('sign-in: PKCE S256 and the resource; only the same person\'s live browser completes it; tokens never shown, stored or logged in clear', async () => {
  const c = await create()
  expect(c).toMatchObject({ status: 'needs_auth', hasSecret: false, auth: 'oauth' })
  expect(c.lastError).toContain('로그인') // the team's language
  const f = await olga.call('POST', `/api/integrations/${c.id}/authorize`, {})
  const u = new URL(f.authorizationUrl)
  expect(u.origin + u.pathname).toBe(`${fake.base}/as/authorize`)
  expect(Object.fromEntries(u.searchParams)).toMatchObject({ response_type: 'code', code_challenge_method: 'S256', resource: `${fake.base}/mcp-oauth`, scope: 'tasks', redirect_uri: 'http://team.localhost/api/integrations/oauth/callback' })
  expect(u.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(fake.clients.size).toBeGreaterThan(0) // registered on its own (RFC 7591)
  expect(await olga.call('GET', `/api/integrations/flows/${f.flowId}`)).toMatchObject({ state: 'pending', reason: null })
  const cb = fake.authorize(f.authorizationUrl)
  // no browser session, or another person's: nothing is exchanged and the flow stays open
  expect((await h.fetch(callback(cb))).status).toBe(400)
  expect((await bob.raw('GET', callback(cb))).status).toBe(400)
  expect((await bob.try('GET', `/api/integrations/flows/${f.flowId}`)).status).toBe(404)
  expect(fake.seen.some((s) => s.path === '/as/token')).toBe(false)
  expect((await olga.call('GET', `/api/integrations/flows/${f.flowId}`)).state).toBe('pending')
  // the flow belongs to the session that started it; another session of the same person may finish it in its browser
  const olga2 = h.client()
  await olga2.login('olga', OWNER_PW)
  expect((await olga2.try('GET', `/api/integrations/flows/${f.flowId}`)).status).toBe(404)
  const res = await olga2.raw('GET', callback(cb))
  expect(res.status).toBe(200)
  expect(res.headers.get('cache-control')).toBe('no-store')
  expect(res.headers.get('referrer-policy')).toBe('no-referrer')
  expect(res.headers.get('content-security-policy')).toMatch(/^default-src 'none'; script-src 'sha256-[A-Za-z0-9+/=]+'; frame-ancestors 'none'$/)
  const page = await res.text()
  expect(page).not.toContain(cb.code)
  expect(page).toContain('이 창을 닫고') // the person's language: they can close the window
  expect(page).toContain('<script>window.close()</script>')
  expect(await olga.call('GET', `/api/integrations/flows/${f.flowId}`)).toMatchObject({ state: 'completed' })
  const tokenCall = fake.seen.find((s) => s.path === '/as/token')!
  expect(Object.fromEntries(new URLSearchParams(tokenCall.body))).toMatchObject({ grant_type: 'authorization_code', resource: `${fake.base}/mcp-oauth` })
  const after = (await olga.call('GET', '/api/integrations')).items.find((i: any) => i.id === c.id)
  expect(after).toMatchObject({ status: 'connected', hasSecret: true })
  expect(after.tools.map((t: any) => t.name)).toContain('create_task')
  // the same answer twice: refused
  expect((await olga.raw('GET', callback(cb))).status).toBe(400)
  expect(JSON.stringify(after)).not.toContain('CANARY-')
  expect(everything()).not.toContain('CANARY-')
  expect(everything()).not.toContain(cb.state)
  const signedIn = (h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'integration.update' AND target = ?").all(c.id) as { detail: string }[]).map((d) => JSON.parse(d.detail))
  expect(signedIn).toEqual([{ scope: 'personal', kind: 'mcp', auth: 'oauth', changed: ['signIn'], secret: 'replaced' }])
  expect(fs.statSync(svc.box.vault.keyPath()).mode & 0o777).toBe(0o600)
})

test('a code exchanged without the matching verifier fails; expired flows and changed connections cannot complete', async () => {
  const c = await create()
  let f = await olga.call('POST', `/api/integrations/${c.id}/authorize`, {})
  let cb = fake.authorize(f.authorizationUrl)
  fake.codes.get(cb.code)!.challenge = 'not-the-challenge'
  expect((await olga.raw('GET', callback(cb))).status).toBe(400)
  expect(await olga.call('GET', `/api/integrations/flows/${f.flowId}`)).toMatchObject({ state: 'failed', reason: 'exchange' })
  f = await olga.call('POST', `/api/integrations/${c.id}/authorize`, {})
  cb = fake.authorize(f.authorizationUrl)
  fake.now += 10 * 60_000 + 1
  expect((await olga.raw('GET', callback(cb))).status).toBe(400)
  expect((await olga.call('GET', `/api/integrations/flows/${f.flowId}`)).state).toBe('expired')
  f = await olga.call('POST', `/api/integrations/${c.id}/authorize`, {})
  cb = fake.authorize(f.authorizationUrl)
  await olga.call('PATCH', `/api/integrations/${c.id}`, { url: `${fake.base}/mcp-oauth?tenant=2` })
  expect((await olga.raw('GET', callback(cb))).status).toBe(400)
  expect(await olga.call('GET', `/api/integrations/flows/${f.flowId}`)).toMatchObject({ state: 'failed', reason: 'changed' })
  expect(getRow(h.ctx.db, c.id)!.secret_enc).toBeNull()
  // sign-in is only for connections set to it; a team connection's sign-in is an admin's
  const key = await olga.call('POST', '/api/integrations', { kind: 'mcp', name: 'Key', url: `${fake.base}/mcp-key`, auth: 'bearer', secret: MCP_KEY })
  expect((await olga.try('POST', `/api/integrations/${key.id}/authorize`, {})).status).toBe(400)
  const team = await create({ scope: 'team' })
  expect((await bob.try('POST', `/api/integrations/${team.id}/authorize`, {})).status).toBe(403)
  expect(everything()).not.toContain(MCP_KEY)
})

test('refresh: ahead of expiry and once for many calls; after a 401; a refused refresh asks to sign in again', async () => {
  const { id } = await connect()
  const row = () => getRow(h.ctx.db, id)!
  fake.now += 3_600_000 + 1
  let release!: () => void
  fake.delayRefresh = () => new Promise<void>((r) => { release = r })
  const one = svc.callTool(row(), 'search_tasks', { q: 1 }), two = svc.callTool(row(), 'search_tasks', { q: 2 })
  await new Promise((r) => setTimeout(r, 100))
  fake.delayRefresh = null
  release()
  await Promise.all([one, two])
  expect(fake.refreshCount).toBe(1)
  // the service forgot the token before its time: one refresh, then the call goes through
  fake.access.clear()
  await svc.callTool(row(), 'search_tasks', { q: 3 })
  expect(fake.refreshCount).toBe(2)
  expect(fake.calls.at(-1)!.auth).toStartWith('Bearer CANARY-access-')
  fake.access.clear(); fake.refresh.clear()
  await expect(svc.callTool(row(), 'search_tasks', {})).rejects.toThrow(/sign-in/)
  expect(row()).toMatchObject({ status: 'needs_auth', last_error: 'sign_in' })
  expect(everything()).not.toContain('CANARY-')
})

test('deleting: the local tokens go first, then the service is asked to revoke them', async () => {
  const { id } = await connect()
  expect(fake.revoked).toHaveLength(0)
  await olga.call('DELETE', `/api/integrations/${id}`)
  expect(getRow(h.ctx.db, id)).toBeNull()
  expect(h.ctx.db.query('SELECT count(*) AS n FROM integration_oauth_flows WHERE integration_id = ?').get(id)).toEqual({ n: 0 })
  expect(fake.revoked).toHaveLength(1)
  expect(fake.revoked[0]).toStartWith('CANARY-refresh-')
})

test('a deleted member\'s personal connections and team rules go with the account', async () => {
  const m = await addMember(h, olga, { username: 'mina', role: 'member' })
  const own = await m.client.call('POST', '/api/integrations', { kind: 'mcp', name: 'Mine', url: `${fake.base}/mcp-key`, auth: 'bearer', secret: MCP_KEY })
  const team = await olga.call('POST', '/api/admin/integrations', { kind: 'mcp', name: 'Shared', url: `${fake.base}/mcp-open`, auth: 'none', access: { everyone: false, groups: [], users: [m.id] } })
  expect(own.status).toBe('connected')
  const r = await olga.raw('DELETE', `/api/admin/users/${m.id}?personalFolder=delete`)
  expect(r.status).toBe(204)
  expect(getRow(h.ctx.db, own.id)).toBeNull()
  expect(h.ctx.db.query('SELECT count(*) AS n FROM integration_access WHERE integration_id = ?').get(team.id)).toEqual({ n: 0 })
})
