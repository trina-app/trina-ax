import { afterEach, expect, test } from 'bun:test'
import { OAUTH_LIMITS, RemoteOAuth, connectorOrigin, ipKey, remoteOAuthOf } from '../../server/src/connectors/remote-mcp/oauth'
import { challenge, hash } from '../../server/src/connectors/remote-mcp/policy'
import { harness, withOwner, type Harness } from './a-lib'

const running: Harness[] = []
const limits = structuredClone(OAUTH_LIMITS)
afterEach(async () => { Object.assign(OAUTH_LIMITS, structuredClone(limits)); for (const h of running.splice(0)) await h.close() })
const origin = 'https://team.example', redirect = 'https://claude.ai/api/mcp/auth_callback', verifier = 'a'.repeat(43)
async function fixture(name: string) {
  const h = await harness('remote-' + name); running.push(h)
  const owner = await withOwner(h)
  const auth = (await h.auth.resolve(new Request('http://team.localhost', { headers: { cookie: owner.cookie! } }), { ip: '10.0.0.7', via: 'test' }))!
  const svc = new RemoteOAuth(h.ctx.db, { origin })
  const client = svc.register({ client_name: 'Test connector', redirect_uris: [redirect] })
  const request = (scope = 'mcp:read offline_access') => new URL(svc.authorize({ client_id: client.client_id, redirect_uri: redirect, response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge(verifier), resource: origin + '/mcp', scope, state: 'safe-state' })).searchParams.get('id')!
  const code = (scope?: string) => new URL(svc.decide(request(scope), auth, true).redirectUrl).searchParams.get('code')!
  const exchange = (value: string, extra = {}) => svc.token({ client_id: client.client_id, grant_type: 'authorization_code', code: value, code_verifier: verifier, redirect_uri: redirect, resource: origin + '/mcp', ...extra })
  return { h, owner, auth, svc, client, request, code, exchange }
}

test('consent is explicit, one-use, session-bound and credentials are stored only hashed', async () => {
  const f = await fixture('consent'), id = f.request()
  expect(f.svc.consent(id, f.auth).scopes).toEqual(['mcp:read', 'offline_access'])
  const otherSession = { ...f.auth, session: { ...f.auth.session, id: 'other' } }
  expect(() => f.svc.decide(id, otherSession, true)).toThrow()
  const result = new URL(f.svc.decide(id, f.auth, true).redirectUrl)
  expect(result.searchParams.get('state')).toBe('safe-state')
  expect(result.searchParams.get('iss')).toBe(origin)
  expect(() => f.svc.decide(id, f.auth, true)).toThrow()
  const token = f.exchange(result.searchParams.get('code')!)
  expect(f.svc.authenticate(token.access_token).user_id).toBe(f.auth.user.id)
  expect(JSON.stringify(f.h.ctx.db.query('SELECT * FROM remote_mcp_tokens').all())).not.toContain(token.access_token)
  expect(f.h.ctx.db.query('SELECT hash FROM remote_mcp_tokens WHERE hash=?').get(hash(token.access_token))).not.toBeNull()
  expect(JSON.stringify(f.h.ctx.db.query('SELECT * FROM audit_log').all())).not.toContain(token.access_token)
})

test('PKCE, resource and client binding cannot exchange or revoke another client grant', async () => {
  const f = await fixture('binding'), code = f.code()
  expect(() => f.exchange(code, { code_verifier: 'b'.repeat(43) })).toThrow('invalid_grant')
  expect(() => f.exchange(code, { resource: origin })).toThrow('invalid_target')
  const other = f.svc.register({ redirect_uris: [redirect] })
  expect(() => f.exchange(code, { client_id: other.client_id })).toThrow('invalid_grant')
  const token = f.exchange(code)
  f.svc.revoke({ client_id: other.client_id, token: token.refresh_token })
  expect(f.svc.authenticate(token.access_token)).toBeDefined()
  expect(() => f.svc.authenticate(f.owner.cookie!)).toThrow('invalid_token')
})

test('refresh rotation invalidates the old access token; replay revokes the whole family durably', async () => {
  const f = await fixture('refresh'), first = f.exchange(f.code('mcp:read mcp:write offline_access'))
  const refresh = { client_id: f.client.client_id, grant_type: 'refresh_token', resource: origin + '/mcp', refresh_token: first.refresh_token }
  const next = f.svc.token({ ...refresh, scope: 'mcp:read offline_access' })
  expect(next.scope).toBe('mcp:read offline_access')
  expect(() => f.svc.authenticate(first.access_token)).toThrow('invalid_token')
  expect(() => f.svc.token({ ...refresh, refresh_token: next.refresh_token, scope: 'mcp:read mcp:write offline_access' })).toThrow('invalid_scope')
  expect(f.svc.authenticate(next.access_token)).toBeDefined()
  expect(() => f.svc.token(refresh)).toThrow('invalid_grant')
  expect(() => new RemoteOAuth(f.h.ctx.db, { origin }).authenticate(next.access_token)).toThrow('invalid_token')
})

test('write is the person\'s choice and group management the owner\'s role, whatever the app asked; the token says what was granted; refresh only narrows', async () => {
  const f = await fixture('choose')
  // `admin` stands for what an older page or a forged body sent: decide() does not read it
  const decided = (id: string, o: { write?: boolean; admin?: boolean }) => f.exchange(new URL(f.svc.decide(id, f.auth, true, o as { write?: boolean }).redirectUrl).searchParams.get('code')!)
  // an app that follows the 401 header asks for mcp:read only; the owner gets the write box, and group management
  const id = f.request('mcp:read offline_access')
  expect(f.svc.consent(id, f.auth)).toMatchObject({ scopes: ['mcp:read', 'offline_access'], optional: ['mcp:write', 'mcp:rooms', 'mcp:rooms.write'], admin: true })
  const first = decided(id, { write: true })
  expect(first.scope).toBe('mcp:read mcp:write mcp:admin offline_access')
  expect(JSON.parse(f.svc.authenticate(first.access_token).scopes)).toEqual(['mcp:read', 'mcp:write', 'mcp:admin', 'offline_access'])
  // a refresh keeps what was granted, narrowing sticks, and nothing widens again
  const refresh = { client_id: f.client.client_id, grant_type: 'refresh_token', resource: origin + '/mcp' }
  const same = f.svc.token({ ...refresh, refresh_token: first.refresh_token })
  expect(same.scope).toBe(first.scope)
  const narrow = f.svc.token({ ...refresh, refresh_token: same.refresh_token, scope: 'mcp:read offline_access' })
  expect(narrow.scope).toBe('mcp:read offline_access')
  for (const scope of ['mcp:read mcp:write offline_access', 'mcp:read mcp:admin offline_access']) expect(() => f.svc.token({ ...refresh, refresh_token: narrow.refresh_token, scope })).toThrow('invalid_scope')
  expect(f.svc.token({ ...refresh, refresh_token: narrow.refresh_token }).scope).toBe('mcp:read offline_access')
  // write unticked: no write, even when the app asked for it; admin: false changes nothing for an owner
  expect(decided(f.request('mcp:read mcp:write mcp:admin offline_access'), { write: false, admin: false }).scope).toBe('mcp:read mcp:admin offline_access')
  // offline_access only when asked: neither the box nor the role adds it, and then there is no refresh token
  const bare = decided(f.request('mcp:read'), { write: true })
  expect(bare.scope).toBe('mcp:read mcp:write mcp:admin'); expect(bare.refresh_token).toBeUndefined()
  // a body without the box (the page before this change): write follows the app's ask
  expect(decided(f.request('mcp:read mcp:write mcp:admin'), {}).scope).toBe('mcp:read mcp:write mcp:admin')
  expect(decided(f.request('mcp:read'), {}).scope).toBe('mcp:read mcp:admin')
  const connected = f.h.ctx.db.query("SELECT detail FROM audit_log WHERE action='remote_mcp.connected' ORDER BY id").all() as { detail: string }[]
  expect(JSON.parse(connected[0]!.detail)).toEqual({ scopes: ['mcp:read', 'mcp:write', 'mcp:admin', 'offline_access'], asked: ['mcp:read', 'offline_access'] })
})

test('authorization code replay revokes its issued family; user disconnect and logout stop access', async () => {
  const f = await fixture('revoke'), code = f.code(), first = f.exchange(code)
  expect(() => f.exchange(code)).toThrow('invalid_grant')
  expect(() => f.svc.authenticate(first.access_token)).toThrow()
  const second = f.exchange(f.code()), grant = f.svc.authenticate(second.access_token)
  f.svc.disconnect(grant.id, f.auth)
  expect(() => f.svc.authenticate(second.access_token)).toThrow()
  const third = f.exchange(f.code())
  await f.owner.call('POST', '/api/auth/logout', {})
  expect(() => f.svc.authenticate(third.access_token)).toThrow()
  expect(f.h.ctx.db.query('SELECT * FROM remote_mcp_grants').all()).toHaveLength(0)
})

test('read-only default has no refresh; denial issues no code; active user and expiry checked per call', async () => {
  const f = await fixture('expiry')
  const denied = new URL(f.svc.decide(f.request(), f.auth, false).redirectUrl)
  expect(denied.searchParams.get('error')).toBe('access_denied')
  expect(denied.searchParams.has('code')).toBe(false)
  const first = f.exchange(f.code('mcp:read'))
  expect(first.refresh_token).toBeUndefined()
  f.h.ctx.db.query('UPDATE users SET must_change_password=1 WHERE id=?').run(f.auth.user.id)
  expect(() => f.svc.authenticate(first.access_token)).toThrow()
  f.h.ctx.db.query('UPDATE users SET must_change_password=0 WHERE id=?').run(f.auth.user.id)
  f.svc.now = () => Date.now() + 3600_001
  expect(() => f.svc.authenticate(first.access_token)).toThrow()
})

test('invalid configuration disables OAuth and durable rate limits reject excess without identity disclosure', async () => {
  const f = await fixture('limits')
  expect(() => new RemoteOAuth(f.h.ctx.db, { origin: 'http://unsafe' }).metadata()).toThrow('temporarily_unavailable')
  f.svc.rate('test', 'synthetic-address', 1)
  expect(() => f.svc.rate('test', 'synthetic-address', 1)).toThrow('slow_down')
  expect(JSON.stringify(f.h.ctx.db.query('SELECT * FROM remote_mcp_limits').all())).not.toContain('synthetic-address')
})

test('connector origin: MYCEL_REMOTE_MCP_ORIGIN first, then server.json appConnectors with tunnel.host, else off', () => {
  const tunnel = { host: 'team.example.com', allowFrom: [], countries: [] }
  expect(connectorOrigin({ appConnectors: true, tunnel }, {})).toBe('https://team.example.com')
  expect(connectorOrigin({ appConnectors: false, tunnel }, {})).toBeNull()
  expect(connectorOrigin({ appConnectors: true, tunnel: null }, {})).toBeNull()
  expect(connectorOrigin({ tunnel }, {})).toBeNull()
  expect(connectorOrigin({ appConnectors: false, tunnel: null }, { MYCEL_REMOTE_MCP_ORIGIN: 'https://env.example.com' })).toBe('https://env.example.com')
  expect(connectorOrigin({ appConnectors: true, tunnel }, { MYCEL_REMOTE_MCP_ORIGIN: 'https://env.example.com' })).toBe('https://env.example.com')
  // a set but invalid variable turns connectors off; it does not fall back to the config
  expect(connectorOrigin({ appConnectors: true, tunnel }, { MYCEL_REMOTE_MCP_ORIGIN: 'http://env.example.com' })).toBeNull()
  expect(connectorOrigin({ appConnectors: true, tunnel }, { MYCEL_REMOTE_MCP_ORIGIN: '' })).toBe('https://team.example.com')
})

test('remoteOAuthOf takes the origin from server.json appConnectors + tunnel.host when the variable is not set', async () => {
  const saved = process.env.MYCEL_REMOTE_MCP_ORIGIN; delete process.env.MYCEL_REMOTE_MCP_ORIGIN
  const h = await harness('remote-origin-config'); running.push(h)
  try {
    h.ctx.config.tunnel = { host: 'team.example.com', allowFrom: [], countries: [] }
    expect(remoteOAuthOf(h.ctx, {}).origin).toBeNull()
    h.ctx.config.appConnectors = true
    expect(remoteOAuthOf(h.ctx, {}).origin).toBe('https://team.example.com')
    expect(remoteOAuthOf(h.ctx, { origin: 'https://explicit.example.com' }).origin).toBe('https://explicit.example.com')
  } finally { if (saved !== undefined) process.env.MYCEL_REMOTE_MCP_ORIGIN = saved }
})

test('registered apps without a connection or a sign-in in progress are removed after a day; connected ones stay', async () => {
  const f = await fixture('idle-clients'), start = Date.now()
  const connected = f.client.client_id
  f.exchange(f.code())
  const idle = f.svc.register({ redirect_uris: [redirect] }).client_id
  const signingIn = f.svc.register({ redirect_uris: [redirect] }).client_id
  f.svc.now = () => start + 24 * 3600_000 - 5 * 60_000
  f.svc.authorize({ client_id: signingIn, redirect_uri: redirect, response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge(verifier), resource: origin + '/mcp' })
  f.svc.now = () => start + 24 * 3600_000 + 60_000
  f.svc.ingress('metadata', '192.0.2.1')
  const ids = () => (f.h.ctx.db.query('SELECT id FROM remote_mcp_clients').all() as { id: string }[]).map(r => r.id)
  expect(ids()).toContain(connected)
  expect(ids()).toContain(signingIn)
  expect(ids()).not.toContain(idle)
  // the sign-in expired unused (10 minutes): a day after its last use the app goes too
  f.svc.now = () => start + 26 * 3600_000
  f.svc.ingress('metadata', '192.0.2.1')
  expect(ids()).not.toContain(signingIn)
  expect(ids()).toContain(connected)
})

test('a full client table makes room from the longest-idle unused apps instead of refusing every new app', async () => {
  const f = await fixture('client-cap'), start = Date.now()
  OAUTH_LIMITS.clients = 5
  f.exchange(f.code()) // the fixture's app is connected: never evicted
  const junk: string[] = []
  for (let i = 0; i < 4; i++) { f.svc.now = () => start + i * 1000; junk.push(f.svc.register({ redirect_uris: [redirect] }).client_id) }
  // a sign-in nobody opened does not keep an app (anyone can start one); one a person opened does
  const ask = (client: string) => new URL(f.svc.authorize({ client_id: client, redirect_uri: redirect, response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge(verifier), resource: origin + '/mcp' })).searchParams.get('id')!
  ask(junk[0]!)
  f.svc.consent(ask(junk[1]!), f.auth)
  f.svc.now = () => start + 10_000
  const fresh = f.svc.register({ redirect_uris: [redirect] }).client_id
  const ids = (f.h.ctx.db.query('SELECT id FROM remote_mcp_clients').all() as { id: string }[]).map(r => r.id)
  expect(ids).toHaveLength(5)
  expect(ids).toContain(f.client.client_id)
  expect(ids).toContain(fresh)
  expect(ids).not.toContain(junk[0])
  expect(ids).toContain(junk[1])
  f.svc.now = () => start + 11_000
  f.svc.register({ redirect_uris: [redirect] })
  const after = (f.h.ctx.db.query('SELECT id FROM remote_mcp_clients').all() as { id: string }[]).map(r => r.id)
  expect(after).toContain(junk[1])
  expect(after).not.toContain(junk[2])
  // nothing left to evict: then, and only then, 503
  f.h.ctx.db.query('DELETE FROM remote_mcp_clients WHERE id<>?').run(f.client.client_id)
  OAUTH_LIMITS.clients = 1
  expect(() => f.svc.register({ redirect_uris: [redirect] })).toThrow('temporarily_unavailable')
})

test('pending sign-ins: at most 10 per app from one address, and a full table makes room from the oldest unopened ones', async () => {
  const f = await fixture('pending'), start = Date.now()
  const ask = (client = f.client.client_id) => new URL(f.svc.authorize({ client_id: client, redirect_uri: redirect, response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge(verifier), resource: origin + '/mcp' })).searchParams.get('id')!
  const from = (ip: string) => f.svc.authorize({ client_id: f.client.client_id, redirect_uri: redirect, response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge(verifier), resource: origin + '/mcp' }, ip)
  for (let i = 0; i < 10; i++) from('192.0.2.7')
  expect(() => from('192.0.2.7')).toThrow('slow_down')
  // the app's id is public: another address still signs in with it
  expect(from('198.51.100.7')).toStartWith(origin + '/connectors/authorize?id=')
  f.h.ctx.db.query('DELETE FROM remote_mcp_requests').run()
  OAUTH_LIMITS.pending = 3
  const other = f.svc.register({ redirect_uris: [redirect] }).client_id
  f.svc.now = () => start; const opened = ask(); f.svc.consent(opened, f.auth)
  f.svc.now = () => start + 1000; const oldest = ask(other)
  f.svc.now = () => start + 2000; ask(other)
  f.svc.now = () => start + 3000; const real = ask()
  const ids = (f.h.ctx.db.query('SELECT id FROM remote_mcp_requests').all() as { id: string }[]).map(r => r.id)
  expect(ids).toHaveLength(3)
  expect(ids).toContain(opened) // a person has it open: kept
  expect(ids).toContain(real)
  expect(ids).not.toContain(oldest)
})

test('rate keys: IPv4 as is, IPv4-mapped as IPv4, IPv6 by its /64', () => {
  expect(ipKey(null)).toBe('unknown')
  expect(ipKey('203.0.113.9')).toBe('203.0.113.9')
  expect(ipKey('::ffff:203.0.113.9')).toBe('203.0.113.9')
  expect(ipKey('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64')
  expect(ipKey('2001:DB8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64')
  expect(ipKey('2001:db8::1')).toBe('2001:db8:0:0::/64')
  expect(ipKey('fe80::1%en0')).toBe('fe80:0:0:0::/64')
  expect(ipKey('::1')).toBe('0:0:0:0::/64')
})
