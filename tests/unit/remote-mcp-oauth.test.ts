import { afterEach, expect, test } from 'bun:test'
import { RemoteOAuth } from '../../server/src/connectors/remote-mcp/oauth'
import { challenge, hash } from '../../server/src/connectors/remote-mcp/policy'
import { harness, withOwner, type Harness } from './a-lib'

const running: Harness[] = []
afterEach(async () => { for (const h of running.splice(0)) await h.close() })
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
