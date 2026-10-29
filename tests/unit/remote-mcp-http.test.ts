import fs from 'node:fs'
import path from 'node:path'
import { afterEach, expect, test } from 'bun:test'
import { buildApp } from '../../server/src/app'
import { remoteMcpRoutes } from '../../server/src/routes/remote-mcp'
import { remoteOAuthOf } from '../../server/src/connectors/remote-mcp/oauth'
import { challenge } from '../../server/src/connectors/remote-mcp/policy'
import { addMember, harness, withOwner, type Harness } from './a-lib'
const live: Harness[] = []
afterEach(async () => { for (const h of live.splice(0)) await h.close() })
const base = 'https://team.example', redirect = 'https://claude.ai/api/mcp/auth_callback', verifier = 'z'.repeat(43)
async function fixture(name: string) {
  const h = await harness('remote-http-' + name); live.push(h)
  const owner = await withOwner(h)
  for (const [key, module] of h.ctx.implemented) if (module === 'remote-mcp') h.ctx.implemented.delete(key)
  const app = await buildApp(h.ctx, [remoteMcpRoutes]), oauth = remoteOAuthOf(h.ctx, { origin: base })
  // The synthetic login is a dev HTTP cookie; canonical public issuer remains independently configured HTTPS.
  const fetch = (path: string, init: RequestInit = {}) => app.fetch(new Request('http://team.localhost' + path, init), { ip: '10.0.0.7', via: 'test' })
  const api = (method: string, path: string, data?: unknown, cookie = owner.cookie!, csrf = true) => fetch(path, { method, headers: { cookie, 'content-type': 'application/json', ...(csrf ? { 'x-mycel-csrf': '1' } : {}) }, body: data === undefined ? undefined : JSON.stringify(data) })
  const post = (path: string, data: unknown) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
  const register = await post('/oauth/register', { redirect_uris: [redirect], client_name: 'Synthetic Claude' }), client = await register.json() as any
  const authorize = () => fetch('/oauth/authorize?' + new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect, resource: base + '/mcp', response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge(verifier), scope: 'mcp:read offline_access' }))
  const issue = async () => {
    const a = await authorize(), id = new URL(a.headers.get('location')!).searchParams.get('id')!
    const approved = await api('POST', '/api/connectors/remote/requests/' + id, { allow: true }), approvedBody = await approved.json() as any
    const code = new URL(approvedBody.redirectUrl).searchParams.get('code')!
    const response = await post('/oauth/token', { client_id: client.client_id, code, grant_type: 'authorization_code', code_verifier: verifier, redirect_uri: redirect, resource: base + '/mcp' })
    return await response.json() as any
  }
  const rpc = (token: string, body: unknown, headers: Record<string, string> = {}) => fetch('/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + token, accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  return { h, owner, oauth, fetch, api, post, client, authorize, issue, rpc }
}

test('discovery uses configured issuer, never hostile host; public responses and authorization redirects are no-store', async () => {
  const f = await fixture('discovery')
  for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server']) {
    const res = await f.fetch(p, { headers: { 'x-forwarded-host': 'evil.invalid', 'x-forwarded-proto': 'http' } })
    expect(res.status).toBe(200); expect(res.headers.get('cache-control')).toBe('no-store')
    const text = await res.text(); expect(text).toContain(base); expect(text).not.toContain('evil.invalid')
  }
  const response = await f.authorize()
  expect(response.status).toBe(302); expect(response.headers.get('location')).toStartWith(base + '/connectors/authorize?id=')
  expect(response.headers.get('referrer-policy')).toBe('no-referrer')
})
test('consent requires core login and CSRF; another user cannot inspect a claimed request or revoke its connection', async () => {
  const f = await fixture('consent'), other = await addMember(f.h, f.owner, { username: 'outsider' })
  const response = await f.authorize(), id = new URL(response.headers.get('location')!).searchParams.get('id')!, url = '/api/connectors/remote/requests/' + id
  expect((await f.api('GET', url, undefined, '')).status).toBe(401)
  expect((await f.api('GET', url)).status).toBe(200)
  expect((await f.api('GET', url, undefined, other.client.cookie!)).status).toBe(404)
  expect((await f.api('POST', url, { allow: true }, f.owner.cookie!, false)).status).toBe(403)
  const tokens = await f.issue(), grant = f.oauth.authenticate(tokens.access_token)
  expect((await f.api('DELETE', '/api/connectors/remote/' + grant.id, undefined, other.client.cookie!)).status).toBe(404)
  const list = await (await f.api('GET', '/api/connectors/remote', undefined, other.client.cookie!)).json() as any
  expect(list.items).toEqual([])
  f.h.ctx.db.query('UPDATE users SET must_change_password=1 WHERE id=?').run(other.id)
  expect((await f.api('GET', '/api/connectors/remote', undefined, other.client.cookie!)).status).toBe(403)
})
test('MCP accepts only its bearer audience; Origin and token-in-query are rejected and unsupported transports require authentication', async () => {
  const f = await fixture('audience'), tokens = await f.issue()
  for (const method of ['GET', 'POST', 'DELETE']) {
    const res = await f.fetch('/mcp', { method, headers: { cookie: f.owner.cookie! } })
    expect(res.status).toBe(401); expect(res.headers.get('www-authenticate')).toContain('resource_metadata="' + base)
  }
  expect((await f.fetch('/mcp', { headers: { authorization: 'Bearer ' + tokens.access_token } })).status).toBe(405)
  expect((await f.rpc(tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://evil.invalid' })).status).toBe(403)
  expect((await f.fetch('/mcp?access_token=' + tokens.access_token, { headers: { authorization: 'Bearer ' + tokens.access_token } })).status).toBe(400)
  expect((await f.api('GET', '/api/connectors/remote', undefined, '', true)).status).toBe(401)
  const ordinary = await f.h.fetch('/api/me', { headers: { authorization: 'Bearer ' + tokens.access_token } })
  expect(ordinary.status).toBe(401)
})
test('stateless JSON MCP negotiation, notifications, tools and malformed message boundaries', async () => {
  const f = await fixture('rpc'), { access_token: token } = await f.issue()
  const init = await (await f.rpc(token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } })).json() as any
  expect(init.result.protocolVersion).toBe('2025-11-25')
  const list = await (await f.rpc(token, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json() as any
  expect(list.result.tools.map((t: any) => t.name)).toEqual(['list', 'glob', 'grep', 'read', 'skills_list'])
  expect((await f.rpc(token, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202)
  expect((await f.rpc(token, [{ jsonrpc: '2.0', id: 1, method: 'ping' }])).status).toBe(400)
  expect((await f.rpc(token, { jsonrpc: '2.0', id: 1, method: 'ping' }, { accept: 'application/json' })).status).toBe(406)
  expect((await f.rpc(token, { jsonrpc: '2.0', id: 1, method: 'ping' }, { 'mcp-protocol-version': 'invalid' })).status).toBe(400)
  expect((await f.rpc(token, { jsonrpc: '2.0', id: {}, method: 'ping' })).status).toBe(400)
  expect((await f.rpc(token, { jsonrpc: '2.0', id: 1, method: 'ping', params: { huge: 'x'.repeat(1024 * 1024) } })).status).toBe(413)
  // only an upload_file call may be larger than 1 MiB (here refused for scope, but the body is accepted)
  const upload = await f.rpc(token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'upload_file', arguments: { path: 'shared/big.bin', content_base64: 'A'.repeat(4 * 1024 * 1024) } } })
  expect(upload.status).toBe(200); expect(((await upload.json()) as any).result.isError).toBe(true)
  expect((await f.rpc(token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'write', arguments: { file_path: 'x', content: 'x'.repeat(2 * 1024 * 1024) } } })).status).toBe(413)
})
test('OAuth duplicate form parameters, bad JSON and oversized body are bounded without reflection', async () => {
  const f = await fixture('bodies')
  const repeated = await f.fetch('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'client_id=a&client_id=b' })
  expect(repeated.status).toBe(400)
  const oversized = await f.post('/oauth/register', { redirect_uris: [redirect], client_name: 'x'.repeat(17000) })
  expect(oversized.status).toBe(413)
  const invalid = await f.post('/oauth/register', { redirect_uris: ['https://evil.invalid/callback?secret=do-not-reflect'] })
  expect(invalid.status).toBe(400); expect(await invalid.text()).not.toContain('do-not-reflect')
  const unknown = await f.post('/oauth/revoke', { client_id: f.client.client_id, token: 'unknown' })
  expect(unknown.status).toBe(200)
})

test('session revocation while a request body streams cannot release an authenticated MCP response', async () => {
  const f = await fixture('stream-revocation'), { access_token: token } = await f.issue()
  let close!: () => void, started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const body = new ReadableStream<Uint8Array>({ pull(controller) { started(); close = () => { controller.enqueue(new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))); controller.close() } } }, { highWaterMark: 0 })
  const pending = f.fetch('/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + token, accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, body })
  await ready
  f.oauth.revokeGrant(f.oauth.authenticate(token).id)
  close()
  expect((await pending).status).toBe(401)
})

test('an upload link from tools/call works through the app with curl-like PUT: no cookie, no CSRF header, once', async () => {
  const f = await fixture('upload-link'), { access_token: token } = await f.issue()
  f.h.ctx.db.query('UPDATE remote_mcp_grants SET scopes=?').run(JSON.stringify(['mcp:read', 'mcp:write', 'offline_access']))
  fs.mkdirSync(path.join(f.h.ctx.config.teamRoot, 'shared'), { recursive: true })
  const call = await (await f.rpc(token, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'create_upload_link', arguments: { path: 'shared/big.bin' } } })).json() as any
  const link = JSON.parse(call.result.content[0].text), url = new URL(link.url)
  expect(url.origin).toBe(base)
  const data = Buffer.from(Array.from({ length: 300_000 }, (_, i) => i & 0xff))
  const put = () => f.fetch(url.pathname, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'content-length': String(data.length) }, body: data })
  const res = await put()
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ path: 'shared/big.bin', size: data.length, conflictCopy: false, replaced: false })
  expect(Buffer.compare(fs.readFileSync(path.join(f.h.ctx.config.teamRoot, 'shared/big.bin')), data)).toBe(0)
  expect((await put()).status).toBe(404)
})
