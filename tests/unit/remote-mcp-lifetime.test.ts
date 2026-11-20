// The MCP connector's connection lifetime (docs/decisions/20261120-mcp-connector-session.md, QA TC-5592..5596):
// it no longer ends with the browser sign-in that allowed it; a refresh keeps it going (90 days from the last one);
// disconnect, removal, deactivation, a password change and signing out everywhere still end it.
import { afterEach, expect, test } from 'bun:test'
import { RemoteOAuth } from '../../server/src/connectors/remote-mcp/oauth'
import { GRANT_MS, challenge } from '../../server/src/connectors/remote-mcp/policy'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

const running: Harness[] = []
afterEach(async () => { for (const h of running.splice(0)) await h.close() })
const origin = 'https://team.example', redirect = 'https://claude.ai/api/mcp/auth_callback', verifier = 'v'.repeat(43)
const DAY = 86400_000

async function setup(name: string) {
  const h = await harness('mcp-life-' + name); running.push(h)
  const owner = await withOwner(h)
  const member = await addMember(h, owner, { username: 'mia' })
  const svc = new RemoteOAuth(h.ctx.db, { origin })
  const client = svc.register({ client_name: 'Claude', redirect_uris: [redirect] })
  /** a connection allowed in `browser` (a signed-in client) with offline_access, as Claude and Claude Code ask */
  const connect = async (browser: Client) => {
    const auth = (await h.auth.resolve(new Request('http://team.localhost', { headers: { cookie: browser.cookie! } }), { ip: '10.0.0.7', via: 'test' }))!
    const id = new URL(svc.authorize({ client_id: client.client_id, redirect_uri: redirect, response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge(verifier), resource: origin + '/mcp', scope: 'mcp:read mcp:write offline_access' })).searchParams.get('id')!
    const code = new URL(svc.decide(id, auth, true).redirectUrl).searchParams.get('code')!
    const tokens = svc.token({ client_id: client.client_id, grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirect, resource: origin + '/mcp' })
    return { auth, tokens, grant: svc.authenticate(tokens.access_token) }
  }
  const refresh = (token: string) => svc.token({ client_id: client.client_id, grant_type: 'refresh_token', resource: origin + '/mcp', refresh_token: token })
  return { h, owner, member, svc, client, connect, refresh }
}

test('refresh works after the browser sign-in that allowed it signed out or expired', async () => {
  const f = await setup('logout')
  const { tokens, grant, auth } = await f.connect(f.member.client)
  expect(grant.session_id).not.toBe(auth.session.id)
  // the connection's end is 90 days out, not the browser sign-in's (30 days)
  expect(grant.expires_at - Date.now()).toBeGreaterThan(GRANT_MS - 60_000)
  await f.member.client.call('POST', '/api/auth/logout', {})
  expect(f.svc.authenticate(tokens.access_token).user_id).toBe(f.member.id)
  const next = f.refresh(tokens.refresh_token!)
  expect(f.svc.authenticate(next.access_token).id).toBe(grant.id)

  // a second connection; its browser sign-in then expires and is swept
  const browser = f.h.client({ ip: '10.0.0.7' }); await browser.login('mia', f.member.password)
  const second = await f.connect(browser)
  f.h.ctx.db.query('UPDATE sessions SET expires_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), second.auth.session.id)
  f.h.auth.sweepSessions()
  expect(f.h.ctx.db.query('SELECT 1 FROM sessions WHERE id=?').get(second.auth.session.id)).toBeNull()
  expect(f.refresh(second.tokens.refresh_token!).access_token).toMatch(/^tax_mcp_a_/)

  // the connections are not the person's devices: not listed, cannot be signed out one by one from there
  const again = f.h.client({ ip: '10.0.0.7' }); await again.login('mia', f.member.password)
  const sessions = (await again.call('GET', '/api/me/sessions')).items as { id: string }[]
  expect(sessions).toHaveLength(1)
  expect((await again.try('DELETE', `/api/me/sessions/${grant.session_id}`)).status).toBe(404)
  // Settings lists both, with the moved end
  const listed = f.svc.connections((await f.h.auth.resolve(new Request('http://team.localhost', { headers: { cookie: again.cookie! } }), { ip: '10.0.0.7', via: 'test' }))!)
  expect(listed.items.map((i) => i.id).sort()).toEqual([grant.id, second.grant.id].sort())
  expect(listed.items[0]).not.toHaveProperty('currentSession')
})

test('a refresh moves the end 90 days on; unused for 90 days, the refresh token is refused', async () => {
  const f = await setup('slide')
  const { tokens, grant } = await f.connect(f.member.client)
  const t0 = Date.now()
  // used every 60 days: alive after 180 days
  let r = tokens.refresh_token!
  for (let i = 1; i <= 3; i++) {
    f.svc.now = () => t0 + i * 60 * DAY
    const next = f.refresh(r); r = next.refresh_token!
    expect(f.svc.authenticate(next.access_token).expires_at).toBe(t0 + i * 60 * DAY + GRANT_MS)
    const anchor = f.h.ctx.db.query('SELECT expires_at, connector FROM sessions WHERE id=?').get(grant.session_id) as { expires_at: string; connector: number }
    expect(anchor).toEqual({ expires_at: new Date(t0 + i * 60 * DAY + GRANT_MS).toISOString(), connector: 1 })
  }
  // then 90 days and a minute without use
  f.svc.now = () => t0 + 180 * DAY + GRANT_MS + 60_000
  expect(() => f.refresh(r)).toThrow('invalid_grant')
  // a connection refreshed every hour for 200 days stays under the cap
  f.svc.now = () => t0
  const g2 = await f.connect(f.member.client)
  let r2 = g2.tokens.refresh_token!
  for (let i = 1; i <= 200 * 24; i += 1) { f.svc.now = () => t0 + i * 3600_000; r2 = f.refresh(r2).refresh_token! }
  // the cap counts live tokens only (one chain); spent refresh tokens stay to recognise a replay; old access tokens go
  const live = (f.h.ctx.db.query('SELECT count(*) AS n FROM remote_mcp_tokens WHERE grant_id=? AND used_at IS NULL').get(g2.grant.id) as { n: number }).n
  const access = (f.h.ctx.db.query("SELECT count(*) AS n FROM remote_mcp_tokens WHERE grant_id=? AND kind='access'").get(g2.grant.id) as { n: number }).n
  expect(live).toBe(2)
  expect(access).toBeLessThanOrEqual(2)
  expect(f.refresh(r2).access_token).toMatch(/^tax_mcp_a_/)
})

test('two processes of one app refreshing with the same token at once: one chain, the loser gets nothing and ends nothing', async () => {
  const f = await setup('race')
  const { tokens } = await f.connect(f.member.client)
  const a = f.refresh(tokens.refresh_token!)
  const b = f.refresh(tokens.refresh_token!)
  // b replaced a before a was used: a is gone, b goes on
  expect(() => f.svc.authenticate(a.access_token)).toThrow('invalid_token')
  expect(() => f.refresh(a.refresh_token!)).toThrow('invalid_grant')
  expect(f.svc.authenticate(b.access_token)).toBeDefined()
  const b2 = f.refresh(b.refresh_token!)
  expect(f.svc.authenticate(b2.access_token)).toBeDefined()
  // a process that read the shared store again (b2) carries on
  expect(f.svc.authenticate(f.refresh(b2.refresh_token!).access_token)).toBeDefined()
})

test('disconnect, removal, deactivation, a password change and signing out everywhere end the connection', async () => {
  const f = await setup('revoke')
  const ended = (t: { access_token: string; refresh_token?: string }) => {
    expect(() => f.svc.authenticate(t.access_token)).toThrow('invalid_token')
    expect(() => f.refresh(t.refresh_token!)).toThrow('invalid_grant')
  }
  // disconnect in Settings
  const one = await f.connect(f.member.client)
  f.svc.disconnect(one.grant.id, one.auth)
  ended(one.tokens)
  // a password change ends the other sign-ins and every connection, the browser that changed it stays
  const two = await f.connect(f.member.client)
  await f.member.client.call('POST', '/api/auth/password', { currentPassword: f.member.password, newPassword: 'meadow pine kettle 9' })
  ended(two.tokens)
  expect((await f.member.client.try('GET', '/api/me/sessions')).status).toBe(200)
  // an admin signs the person out everywhere (endUserSessions 'revoked', as removal does)
  const three = await f.connect(f.member.client)
  f.h.auth.endUserSessions(f.member.id, 'revoked')
  ended(three.tokens)
  // deactivated
  await f.member.client.login('mia', 'meadow pine kettle 9')
  const four = await f.connect(f.member.client)
  await f.owner.call('PATCH', `/api/admin/users/${f.member.id}`, { status: 'disabled' })
  ended(four.tokens)
  // a disabled person turned back on does not get the old connection back
  await f.owner.call('PATCH', `/api/admin/users/${f.member.id}`, { status: 'active' })
  ended(four.tokens)
  // removed from the team
  await f.member.client.login('mia', 'meadow pine kettle 9')
  const five = await f.connect(f.member.client)
  await f.owner.call('DELETE', `/api/admin/users/${f.member.id}`, {})
  ended(five.tokens)
  expect(f.h.ctx.db.query('SELECT 1 FROM remote_mcp_grants WHERE user_id=?').get(f.member.id)).toBeNull()
})

test('the 51st connection of a person ends their oldest one instead of refusing', async () => {
  const f = await setup('cap')
  // a minute apart (consent is rate-limited per person)
  const t0 = Date.now(); let i = 0
  f.svc.now = () => t0 + i * 61_000
  const first = await f.connect(f.member.client)
  for (i = 1; i < 50; i++) await f.connect(f.member.client)
  expect(f.svc.authenticate(first.tokens.access_token)).toBeDefined()
  const last = await f.connect(f.member.client)
  expect(f.svc.authenticate(last.tokens.access_token)).toBeDefined()
  expect(() => f.svc.authenticate(first.tokens.access_token)).toThrow('invalid_token')
  const audit = f.h.ctx.db.query("SELECT detail FROM audit_log WHERE action='remote_mcp.disconnected' AND target=?").get(first.grant.id) as { detail: string }
  expect(JSON.parse(audit.detail)).toEqual({ app: 'Claude', reason: 'too_many' })
})

test('migration 130 moves a live connection off its browser sign-in; a revoked one or one of an ended sign-in stays', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path')
  const { MIGRATIONS_DIR, migrate, openDb } = await import('../../server/src/db')
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'mig130-'))
  for (const f of fs.readdirSync(MIGRATIONS_DIR)) if (/^\d{3}_/.test(f) && !f.startsWith('130_')) fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(old, f))
  const db = openDb(':memory:', { migrationsDir: old })
  try {
    const now = Date.now(), iso = (v: number) => new Date(v).toISOString()
    db.exec("INSERT INTO users (id, username, name, role) VALUES ('u','u','U','member')")
    const s = db.query("INSERT INTO sessions (id, user_id, token_hash, client, created_at, last_seen_at, expires_at) VALUES (?, 'u', ?, 'web', ?, ?, ?)")
    s.run('live', 'h1', iso(now), iso(now), iso(now + 10 * DAY))
    s.run('ended', 'h2', iso(now - 40 * DAY), iso(now), iso(now - 1000))
    db.query("INSERT INTO remote_mcp_clients VALUES ('c', 'Claude', '[]', ?, ?)").run(now, now)
    const g = db.query("INSERT INTO remote_mcp_grants (id, client_id, user_id, session_id, resource, scopes, created_at, expires_at, revoked_at) VALUES (?, 'c', 'u', ?, 'r', '[]', ?, ?, ?)")
    g.run('g1', 'live', now, now + 10 * DAY, null)
    g.run('g2', 'live', now, now + 10 * DAY, now)
    g.run('g3', 'ended', now, now + 10 * DAY, null)
    migrate(db)
    expect(db.query('SELECT id, session_id FROM remote_mcp_grants ORDER BY id').all()).toEqual([
      { id: 'g1', session_id: 'connector-g1' }, { id: 'g2', session_id: 'live' }, { id: 'g3', session_id: 'ended' }])
    const row = db.query("SELECT user_id, token_hash, connector, expires_at FROM sessions WHERE id='connector-g1'").get() as Record<string, unknown>
    expect(row).toEqual({ user_id: 'u', token_hash: 'connector:g1', connector: 1, expires_at: iso(now + 10 * DAY) })
    // signing out of the browser no longer takes it along
    db.query("DELETE FROM sessions WHERE id='live'").run()
    expect(db.query("SELECT id FROM remote_mcp_grants").all()).toEqual([{ id: 'g1' }, { id: 'g3' }])
  } finally { db.close(); fs.rmSync(old, { recursive: true, force: true }) }
})
