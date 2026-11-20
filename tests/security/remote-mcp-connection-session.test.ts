// The MCP connector's own session row (migration 130, docs/decisions/20261120-mcp-connector-session.md) must
// not become a way in, and the longer-lived refresh tokens keep the protections that matter between people: a replay
// after the retry window ends the connection, a token works only for its app and its person, and guests get none.
import { afterEach, expect, test } from 'bun:test'
import { RemoteOAuth } from '../../server/src/connectors/remote-mcp/oauth'
import { REFRESH_REUSE_MS, challenge } from '../../server/src/connectors/remote-mcp/policy'
import { addMember, harness, withOwner, type Client, type Harness } from '../unit/a-lib'

const running: Harness[] = []
afterEach(async () => { for (const h of running.splice(0)) await h.close() })
const origin = 'https://team.example', redirect = 'https://claude.ai/api/mcp/auth_callback', verifier = 'w'.repeat(43)

async function setup(name: string) {
  const h = await harness('mcp-sess-' + name); running.push(h)
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const ben = await addMember(h, owner, { username: 'ben' })
  const svc = new RemoteOAuth(h.ctx.db, { origin })
  const client = svc.register({ client_name: 'Claude', redirect_uris: [redirect] })
  const authOf = async (c: Client) => (await h.auth.resolve(new Request('http://team.localhost', { headers: { cookie: c.cookie! } }), { ip: '10.0.0.7', via: 'test' }))!
  const connect = async (c: Client) => {
    const auth = await authOf(c)
    const id = new URL(svc.authorize({ client_id: client.client_id, redirect_uri: redirect, response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge(verifier), resource: origin + '/mcp', scope: 'mcp:read offline_access' })).searchParams.get('id')!
    const code = new URL(svc.decide(id, auth, true).redirectUrl).searchParams.get('code')!
    const tokens = svc.token({ client_id: client.client_id, grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirect, resource: origin + '/mcp' })
    return { tokens, grant: svc.authenticate(tokens.access_token) }
  }
  const refresh = (token: string, clientId = client.client_id) => svc.token({ client_id: clientId, grant_type: 'refresh_token', resource: origin + '/mcp', refresh_token: token })
  return { h, owner, mia, ben, svc, client, authOf, connect, refresh }
}

test('the connection\'s session row signs nobody in, is not a device, and another person cannot end it', async () => {
  const f = await setup('row')
  const { grant, tokens } = await f.connect(f.mia.client)
  const row = f.h.ctx.db.query('SELECT token_hash, connector FROM sessions WHERE id=?').get(grant.session_id) as { token_hash: string; connector: number }
  expect(row.connector).toBe(1)
  expect(row.token_hash).not.toMatch(/^[0-9a-f]{64}$/)
  // whatever is guessed from the row (its marker, the grant id, the row id) is no sign-in, as cookie or bearer
  for (const guess of [row.token_hash, grant.id, grant.session_id, 'connector-' + grant.id]) {
    for (const headers of [{ cookie: `__Host-sid=${guess}` }, { cookie: `mycel-dev-sid=${guess}` }, { authorization: `Bearer ${guess}` }] as Record<string, string>[])
      expect(await f.h.auth.resolve(new Request('http://team.localhost', { headers }), { ip: '10.0.0.7', via: 'test' })).toBeNull()
  }
  // not in either person's device list; Ben cannot sign it out, neither can Mia from there
  for (const c of [f.mia.client, f.ben.client]) {
    expect(((await c.call('GET', '/api/me/sessions')).items as { id: string }[]).map((s) => s.id)).not.toContain(grant.session_id)
    expect((await c.try('DELETE', `/api/me/sessions/${grant.session_id}`)).status).toBe(404)
  }
  // Ben cannot disconnect Mia's connection, nor see it; it still works for her
  const benAuth = await f.authOf(f.ben.client)
  expect(() => f.svc.disconnect(grant.id, benAuth)).toThrow()
  expect(f.svc.connections(benAuth).items).toHaveLength(0)
  expect(f.svc.authenticate(f.refresh(tokens.refresh_token!).access_token).user_id).toBe(f.mia.id)
})

test('a stolen refresh token replayed after the retry window ends the victim\'s connection; another app cannot use it', async () => {
  const f = await setup('replay')
  const { tokens } = await f.connect(f.mia.client)
  const other = f.svc.register({ client_name: 'Other', redirect_uris: [redirect] })
  expect(() => f.refresh(tokens.refresh_token!, other.client_id)).toThrow('invalid_grant')
  const t0 = Date.now(); f.svc.now = () => t0
  const legit = f.refresh(tokens.refresh_token!)
  f.svc.now = () => t0 + REFRESH_REUSE_MS + 1
  expect(() => f.refresh(tokens.refresh_token!)).toThrow('invalid_grant')
  expect(() => f.svc.authenticate(legit.access_token)).toThrow('invalid_token')
  expect(() => f.refresh(legit.refresh_token!)).toThrow('invalid_grant')
})

test('a guest is never given a connection; a member made guest loses theirs at the next call', async () => {
  const f = await setup('guest')
  const { tokens } = await f.connect(f.mia.client)
  f.h.ctx.db.query('UPDATE users SET guest=1 WHERE id=?').run(f.mia.id)
  expect(() => f.svc.authenticate(tokens.access_token)).toThrow('invalid_token')
  expect(() => f.refresh(tokens.refresh_token!)).toThrow('invalid_grant')
  await expect(f.connect(f.mia.client)).rejects.toThrow('access_denied')
})

// review of #127: the retry window must not hand a thief a chain of their own, and a late replay must still be caught
test('a thief reusing a spent refresh token after its new pair was used ends the connection, even inside the window', async () => {
  const f = await setup('thief')
  const { tokens } = await f.connect(f.mia.client)
  const t0 = Date.now(); f.svc.now = () => t0
  const legit = f.refresh(tokens.refresh_token!)
  f.svc.authenticate(legit.access_token)
  f.svc.now = () => t0 + 4 * 60_000
  expect(() => f.refresh(tokens.refresh_token!)).toThrow('invalid_grant')
  expect(() => f.svc.authenticate(legit.access_token)).toThrow('invalid_token')
  expect(() => f.refresh(legit.refresh_token!)).toThrow('invalid_grant')
})

test('reusing one spent token many times inside the window never leaves more than one live chain', async () => {
  const f = await setup('chains')
  const { tokens, grant } = await f.connect(f.mia.client)
  const pairs = Array.from({ length: 20 }, () => f.refresh(tokens.refresh_token!))
  const live = f.h.ctx.db.query("SELECT count(*) AS n FROM remote_mcp_tokens WHERE grant_id=? AND kind='refresh' AND used_at IS NULL").get(grant.id) as { n: number }
  expect(live.n).toBe(1)
  for (const p of pairs.slice(0, -1)) {
    expect(() => f.svc.authenticate(p.access_token)).toThrow('invalid_token')
    expect(() => f.refresh(p.refresh_token!)).toThrow('invalid_grant')
  }
  const last = pairs.at(-1)!
  expect(f.svc.authenticate(last.access_token).id).toBe(grant.id)
  // and 30 days on the replaced ones still give nothing
  f.svc.now = () => Date.now() + 30 * 86400_000
  expect(() => f.refresh(pairs[0]!.refresh_token!)).toThrow('invalid_grant')
})

test('a replay of a refresh token spent 8 days ago still ends the connection', async () => {
  const f = await setup('late')
  const { tokens } = await f.connect(f.mia.client)
  const t0 = Date.now()
  let r = tokens.refresh_token!
  const spent = r
  // used every hour for 9 days
  for (let i = 1; i <= 9 * 24; i++) { f.svc.now = () => t0 + i * 3600_000; r = f.refresh(r).refresh_token! }
  const current = r
  expect(() => f.refresh(spent)).toThrow('invalid_grant')
  expect(() => f.refresh(current)).toThrow('invalid_grant')
})
