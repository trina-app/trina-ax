// The remote connector (Claude / ChatGPT reaching the team over MCP) is closed to guests (docs/DECISIONS.md "Guests:
// only what they were invited to"): it reaches the team's files, rooms and skills. Its routes skip the endpoint
// allow-list (raw /oauth/*, /mcp, /connector-uploads), so the connector checks itself: the consent page and the code
// refuse a guest (connectors/remote-mcp/oauth.ts browser), and every request's grant refuses a guest's account (grant).
// A member's connection works as before. Real guest.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { buildApp } from '../../server/src/app'
import { remoteMcpRoutes } from '../../server/src/routes/remote-mcp'
import { remoteOAuthOf } from '../../server/src/connectors/remote-mcp/oauth'
import { challenge } from '../../server/src/connectors/remote-mcp/policy'
import { addMember, harness, withOwner, type Harness } from './a-lib'
import { addGuest, groupChat } from './guest-lib'

setDefaultTimeout(60_000)
let h: Harness
afterEach(async () => { await h?.close() })
const base = 'https://team.example', redirect = 'https://claude.ai/api/mcp/auth_callback', verifier = 'z'.repeat(43)

async function fixture() {
  h = await harness('a-guests-mcp')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const room = await groupChat(owner, [mia.id, nora.id])
  const g = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'room', id: room } })
  for (const [key, module] of h.ctx.implemented) if (module === 'remote-mcp') h.ctx.implemented.delete(key)
  const app = await buildApp(h.ctx, [remoteMcpRoutes])
  remoteOAuthOf(h.ctx, { origin: base })
  const fetch = (path: string, init: RequestInit = {}) => app.fetch(new Request('http://team.localhost' + path, init), { ip: '10.0.0.7', via: 'test' })
  const api = (method: string, path: string, cookie: string, data?: unknown) => fetch(path, { method, headers: { cookie, 'content-type': 'application/json', 'x-mycel-csrf': '1' }, body: data === undefined ? undefined : JSON.stringify(data) })
  const post = (path: string, data: unknown) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
  const client = await (await post('/oauth/register', { redirect_uris: [redirect], client_name: 'Synthetic Claude' })).json() as { client_id: string }
  const authorize = async () => {
    const a = await fetch('/oauth/authorize?' + new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect, resource: base + '/mcp', response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge(verifier), scope: 'mcp:read offline_access' }))
    return new URL(a.headers.get('location')!).searchParams.get('id')!
  }
  const issue = async (cookie: string) => {
    const id = await authorize()
    const approved = await api('POST', '/api/connectors/remote/requests/' + id, cookie, { allow: true })
    if (approved.status !== 200) return { status: approved.status, token: null as string | null }
    const code = new URL((await approved.json() as { redirectUrl: string }).redirectUrl).searchParams.get('code')!
    const t = await (await post('/oauth/token', { client_id: client.client_id, code, grant_type: 'authorization_code', code_verifier: verifier, redirect_uri: redirect, resource: base + '/mcp' })).json() as { access_token: string }
    return { status: 200, token: t.access_token }
  }
  const rpc = (token: string, body: unknown) => fetch('/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + token, accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { mia, g, api, authorize, issue, rpc }
}

test('a guest gets no consent page and no code; a member does, and the member\'s token answers /mcp', async () => {
  const f = await fixture()
  const id = await f.authorize()
  expect((await f.api('GET', '/api/connectors/remote/requests/' + id, f.g.client.cookie!)).status).toBe(403)
  expect((await f.api('POST', '/api/connectors/remote/requests/' + id, f.g.client.cookie!, { allow: true })).status).toBe(403)
  expect((await f.issue(f.g.client.cookie!)).token).toBeNull()
  // behind the allow-list, the connector's own check refuses the guest's signed-in session too
  const sid = (h.ctx.db.query('SELECT id FROM sessions WHERE user_id = ?').get(f.g.id) as { id: string }).id
  const guestAuth = { user: { id: f.g.id, username: 'gus', name: 'GUS', role: 'guest', locale: 'ko', mustChangePassword: false }, session: { id: sid, client: 'web', expiresAt: new Date(Date.now() + 86400_000).toISOString() }, via: 'cookie' } as never
  expect(() => remoteOAuthOf(h.ctx).consent(id, guestAuth)).toThrow()
  expect(() => remoteOAuthOf(h.ctx).decide(id, guestAuth, true)).toThrow()
  const m = await f.issue(f.mia.client.cookie!)
  expect(m.status).toBe(200)
  const ok = await f.rpc(m.token!, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
  expect(ok.status).toBe(200)
})

test('every /mcp request checks the account again: a grant whose account is a guest answers 401', async () => {
  const f = await fixture()
  const m = await f.issue(f.mia.client.cookie!)
  expect((await f.rpc(m.token!, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(200)
  // (a member is never turned into a guest; the check holds whatever the account row says)
  h.ctx.db.query('UPDATE users SET guest = 1 WHERE id = ?').run(f.mia.id)
  expect((await f.rpc(m.token!, { jsonrpc: '2.0', id: 2, method: 'ping' })).status).toBe(401)
  h.ctx.db.query('UPDATE users SET guest = 0 WHERE id = ?').run(f.mia.id)
  expect((await f.rpc(m.token!, { jsonrpc: '2.0', id: 3, method: 'ping' })).status).toBe(200)
})
