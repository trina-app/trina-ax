// Component A: Sign up with Google (server/src/auth/google-signup.ts; docs/AGENTS/plan/20261122-0756-google-signup.md).
// The first owner, invited people and team links make their account with Google and no password. Each start checks
// what its password form checks; Google's return runs the same write (bootstrapOwner, joinWithInvite, joinWithLink):
// single use, seats, the maker, link limits; a Google account already connected here signs that person in instead. A
// password sign-in of an account without a password answers like a wrong password.
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { SETUP_TOKEN_HEADER } from '@mycel/shared/api'
import { checkSetupToken } from '../../server/src/auth/accounts'
import { DEFAULT_LIMITS } from '../../server/src/auth/rate-limit'
import { getSetting, getTeamSettings } from '../../server/src/admin/settings'
import { WELCOME_SETTING } from '../../server/src/onboarding/welcome'
import { googleDriveOf } from '../../server/src/integrations/google-drive/oauth'
import { Plan, setPlanForTests } from '../../server/src/system/limits'
import { HttpError } from '../../server/src/http/errors'
import { OWNER_PW, SETUP_TOKEN, addMember, harness, withOwner, type Client, type Harness } from './a-lib'

setDefaultTimeout(60_000)

const CLIENT_ID = 'test-client.apps.googleusercontent.com'
const CALLBACK = '/api/integrations/google-drive/callback'
const GSI = 'mycel-dev-gsi'

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.c2ln`

/** Who the fake Google signs in as, per code (the account picked on Google's page) */
const accounts = new Map<string, { sub: string; email: string; name?: string }>()
const nonces = new Map<string, string>()
const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
  const code = new URLSearchParams(String(init?.body ?? '')).get('code') ?? ''
  const who = accounts.get(code)!
  const id_token = jwt({ iss: 'https://accounts.google.com', aud: CLIENT_ID, azp: CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 600, nonce: nonces.get(code) ?? '', sub: who.sub, email: who.email, email_verified: true, ...(who.name ? { name: who.name } : {}) })
  return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600, token_type: 'Bearer', id_token }), { status: 200, headers: { 'content-type': 'application/json' } })
}) as unknown as typeof fetch

const useGoogle = (h: Harness) => googleDriveOf(h.ctx, { config: { clientId: CLIENT_ID, clientSecret: 'secret', redirectUri: `http://team.localhost${CALLBACK}` }, fetch: fakeFetch, broker: null })

/** A start's Google address and binding cookie; Google will sign in as `who` */
async function started(res: Response, who: { sub: string; email: string; name?: string }) {
  expect(res.status).toBe(200)
  const u = new URL(((await res.json()) as { url: string }).url)
  const state = u.searchParams.get('state')!
  const code = `code-${state.slice(0, 12)}`
  nonces.set(code, u.searchParams.get('nonce')!)
  accounts.set(code, who)
  const gsi = res.headers.getSetCookie().find((c) => c.startsWith(`${GSI}=`))!.split(';')[0]!
  return { state, code, gsi }
}
/** Google sends the browser back */
const back = (h: Harness, s: { state: string; code: string; gsi: string }, ip?: string) =>
  h.fetch(`${CALLBACK}?${new URLSearchParams({ state: s.state, code: s.code })}`, { headers: { cookie: s.gsi }, ...(ip ? { ip } : {}) })
const sessionOf = (res: Response) => res.headers.getSetCookie().find((c) => c.startsWith('mycel-dev-sid=') && !c.startsWith('mycel-dev-sid=;'))?.split(';')[0]
const meOf = async (h: Harness, res: Response) => ((await (await h.fetch('/api/me', { headers: { cookie: sessionOf(res)! } })).json()) as any).user
const userRow = (h: Harness, username: string) => h.ctx.db.query('SELECT id, username, name, email, password_hash, role, locale FROM users WHERE lower(username) = lower(?)').get(username) as { id: string; username: string; name: string; email: string | null; password_hash: string | null; role: string; locale: string } | null
const identityOf = (h: Harness, userId: string) => h.ctx.db.query("SELECT subject, email, last_used_at FROM login_identities WHERE user_id = ? AND provider = 'google'").get(userId) as { subject: string; email: string; last_used_at: string | null } | null

describe('the first owner with Google', () => {
  let h: Harness
  beforeAll(async () => { h = await harness('google-signup-setup'); useGoogle(h) })
  afterAll(() => h.close())
  const setupBody = (o: Record<string, unknown> = {}) => ({ setupToken: SETUP_TOKEN, teamName: 'Acme', locale: 'en', timeZone: 'Asia/Seoul', site: 'acme.example', next: '/welcome', ...o })

  test('the setup page offers it only while setup is needed and only to a visitor the relay tells so', async () => {
    expect((await h.client().call('GET', '/api/setup')).googleSignUp).toBe(true)
    // another address of the server (Google does not come back there): no button
    expect((await h.client({ base: 'http://other.localhost' }).call('GET', '/api/setup')).googleSignUp).toBeUndefined()
    // through the relay without the setup token: not even that setup is needed
    const relay = h.client({ via: 'relay', ip: '198.51.100.20' })
    const blind = await relay.call('GET', '/api/setup')
    expect(blind.needed).toBe(false)
    expect(blind.googleSignUp).toBeUndefined()
    expect((await relay.call('GET', '/api/setup', undefined, { [SETUP_TOKEN_HEADER]: SETUP_TOKEN })).googleSignUp).toBe(true)
  })

  test('the start checks the setup token as POST /api/setup does', async () => {
    const wrong = await h.client().try('POST', '/api/setup/google', setupBody({ setupToken: 'x'.repeat(32) }))
    expect(wrong.status).toBe(403)
    // through the relay too: the counted 403
    const relayWrong = await h.client({ via: 'relay', ip: '198.51.100.21' }).try('POST', '/api/setup/google', setupBody({ setupToken: 'y'.repeat(32) }))
    expect(relayWrong.status).toBe(403)
    // never from the office internet or Tailscale address, whatever the token (the same gate as the password form)
    const c = { get: (k: string) => (k === 'info' ? { ip: '203.0.113.5', via: 'direct', tunnel: true } : 'en') } as never
    expect(() => checkSetupToken(c, h.ctx, SETUP_TOKEN)).toThrow(HttpError)
    try { checkSetupToken(c, h.ctx, SETUP_TOKEN) } catch (e) { expect((e as HttpError).status).toBe(403) }
    // nothing was made
    expect((h.ctx.db.query('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(0)
  })

  test('Google\'s return makes the team and its owner with no password, spends the token and signs in', async () => {
    const browser = h.client()
    const s = await started(await browser.raw('POST', '/api/setup/google', setupBody()), { sub: 'g-owner', email: 'Olga.Owner+trina@acme.example', name: 'Olga Owner' })
    // a second browser starts too (it will find the team made)
    const late = await started(await h.client({ ip: '10.0.0.8' }).raw('POST', '/api/setup/google', setupBody()), { sub: 'g-other', email: 'other@acme.example' })
    const res = await back(h, s)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/welcome')
    const me = await meOf(h, res)
    expect(me).toMatchObject({ username: 'olga.owner', name: 'Olga Owner', email: 'Olga.Owner+trina@acme.example', role: 'owner' })
    const u = userRow(h, 'olga.owner')!
    expect(u.password_hash).toBeNull()
    expect(identityOf(h, u.id)).toMatchObject({ subject: 'g-owner', email: 'Olga.Owner+trina@acme.example' })
    // the team as typed, the token spent, the welcome steps started with the website
    expect(getTeamSettings(h.ctx.db)).toMatchObject({ teamName: 'Acme', defaultLocale: 'en', timeZone: 'Asia/Seoul' })
    expect(h.ctx.config.setupToken).toBeNull()
    expect(JSON.stringify(getSetting(h.ctx.db, WELCOME_SETTING))).toContain('acme.example')
    // the audit says it was Google, never the address
    const audit = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'setup'").get() as { detail: string }
    expect(JSON.parse(audit.detail)).toMatchObject({ teamName: 'Acme', method: 'google' })
    expect(audit.detail).not.toContain('acme.example')
    // the other flow comes back to the setup page: the team is made
    expect((await back(h, late, '10.0.0.8')).headers.get('location')).toBe('/setup?google=gone')
    expect((h.ctx.db.query('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(1)
    // and no new start
    expect((await h.client().try('POST', '/api/setup/google', setupBody())).status).toBe(409)
    expect((await h.client().call('GET', '/api/setup')).googleSignUp).toBeUndefined()
  })

  test('a password sign-in of an account without a password answers like a wrong password', async () => {
    const none = await h.client({ ip: '10.0.0.30' }).try('POST', '/api/auth/login', { username: 'olga.owner', password: 'anything at all 1' })
    const unknown = await h.client({ ip: '10.0.0.31' }).try('POST', '/api/auth/login', { username: 'nobody-here', password: 'anything at all 1' })
    expect(none.status).toBe(401)
    expect({ code: none.body.error.code, message: none.body.error.message }).toEqual({ code: unknown.body.error.code, message: unknown.body.error.message })
  })
})

describe('joining with Google', () => {
  let h: Harness
  let owner: Client
  beforeAll(async () => { h = await harness('google-signup-join'); owner = await withOwner(h); useGoogle(h) })
  afterAll(() => h.close())
  afterEach(() => { setPlanForTests(undefined); h.auth.limiter.limits = DEFAULT_LIMITS })

  const invite = async (by: Client = owner, role: 'member' | 'admin' = 'member', groupIds: string[] = []) => {
    const r = await by.call('POST', '/api/admin/invites', { role, groupIds })
    return { id: r.invite.id as string, token: r.url.split('/invite/')[1] as string }
  }
  const startInvite = async (token: string, username: string, who: { sub: string; email: string; name?: string }, ip = '10.0.1.1') =>
    started(await h.client({ ip }).raw('POST', '/api/invites/google', { token, username, name: username.toUpperCase(), locale: 'ja' }), who)
  const used = (id: string) => (h.ctx.db.query('SELECT used_at FROM invites WHERE id = ?').get(id) as { used_at: string | null }).used_at
  const link = async (o: Record<string, unknown> = {}) => {
    const r = await owner.call('POST', '/api/admin/team-link', o)
    return { id: r.link.id as string, token: new URL(r.link.url).hash.replace(/^#t=/, '') }
  }
  const linkAttempts = (id: string) => (h.ctx.db.query("SELECT COUNT(*) AS n FROM login_attempts WHERE key LIKE ?").get(`%${id}%`) as { n: number }).n

  test('the invite page offers it for a member invite, not a guest invite, and a guest invite cannot start it', async () => {
    const inv = await invite()
    expect((await h.client().call('GET', `/api/invites/${inv.token}`)).googleSignUp).toBe(true)
    const project = await owner.call('POST', '/api/projects', { name: 'Quotes', scope: 'team' })
    const g = await owner.call('POST', '/api/guest-invites', { place: { kind: 'project', id: project.id }, name: 'Gina' })
    const gToken = g.url.split('/invite/')[1]
    expect((await h.client().call('GET', `/api/invites/${gToken}`)).googleSignUp).toBeUndefined()
    const refused = await h.client().try('POST', '/api/invites/google', { token: gToken, username: 'gina', name: 'Gina' })
    expect(refused.status).toBe(403)
    expect(refused.body.error.params.reason).toBe('guest_password_only')
    // the token goes only in the body: a made-up one counts like any made-up token
    expect((await h.client().try('POST', '/api/invites/google', { token: 'Z'.repeat(43), username: 'zed', name: 'Zed' })).status).toBe(404)
  })

  test('an invite makes the account with no password, in its groups, used once, everyone told after the write', async () => {
    const group = await owner.call('POST', '/api/admin/groups', { name: 'Sales' })
    const inv = await invite(owner, 'member', [group.id])
    const s = await startInvite(inv.token, 'mina', { sub: 'g-mina', email: 'mina@acme.example' })
    // a second flow of the same invite, another Google account
    const t = await startInvite(inv.token, 'mona', { sub: 'g-mona', email: 'mona@acme.example' }, '10.0.1.2')
    const res = await back(h, s)
    expect(res.headers.get('location')).toBe('/')
    expect(await meOf(h, res)).toMatchObject({ username: 'mina', name: 'MINA', email: 'mina@acme.example', role: 'member', localeChoice: 'ja' })
    const u = userRow(h, 'mina')!
    expect(u.password_hash).toBeNull()
    expect(identityOf(h, u.id)?.subject).toBe('g-mina')
    expect(used(inv.id)).toBeTruthy()
    expect(h.ctx.db.query('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(group.id, u.id)).toBeTruthy()
    // what follows a join: the welcome card's row, the owner's notice
    expect(h.ctx.db.query("SELECT via FROM member_welcome WHERE user_id = ?").get(u.id)).toEqual({ via: 'invite' })
    const audit = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'invite.accept' AND target = ?").get(inv.id) as { detail: string }
    expect(JSON.parse(audit.detail)).toMatchObject({ userId: u.id, method: 'google' })
    expect(audit.detail).not.toContain('acme.example')
    // single use: the other flow comes back to the invite page
    expect((await back(h, t, '10.0.1.2')).headers.get('location')).toBe('/invite?google=gone')
    expect(userRow(h, 'mona')).toBeNull()
    // the invite's start count was given back for the join that worked; the refused one stays
    expect(linkAttempts(inv.id)).toBe(1)
  })

  test('a Google account already connected here signs that person in: the invite stays unused, nothing changes', async () => {
    const inv = await invite(owner, 'admin')
    const s = await startInvite(inv.token, 'mina-two', { sub: 'g-mina', email: 'mina@acme.example' })
    const res = await back(h, s)
    expect(res.headers.get('location')).toBe('/')
    expect((await meOf(h, res)).username).toBe('mina')
    expect(userRow(h, 'mina')!.role).toBe('member')
    expect(userRow(h, 'mina-two')).toBeNull()
    expect(used(inv.id)).toBeNull()
    // the same refusals as a Google sign-in: a turned-off account is told so on the invite page
    h.ctx.db.query("UPDATE users SET status = 'disabled' WHERE username = 'mina'").run()
    const off = await startInvite(inv.token, 'mina-three', { sub: 'g-mina', email: 'mina@acme.example' })
    expect((await back(h, off)).headers.get('location')).toBe('/invite?google=account_off')
    h.ctx.db.query("UPDATE users SET status = 'active' WHERE username = 'mina'").run()
    expect(used(inv.id)).toBeNull()
  })

  test('a username taken meanwhile comes back to pick another; the invite stays unused', async () => {
    const inv = await invite()
    const s = await startInvite(inv.token, 'nico', { sub: 'g-nico', email: 'nico@acme.example' })
    await addMember(h, owner, { username: 'nico' })
    expect((await back(h, s)).headers.get('location')).toBe('/invite?google=username_taken')
    expect(used(inv.id)).toBeNull()
    // a taken username is refused at the start already
    expect((await h.client().try('POST', '/api/invites/google', { token: inv.token, username: 'NICO', name: 'Nico' })).status).toBe(409)
    // then with another one it works
    const again = await startInvite(inv.token, 'nico.g', { sub: 'g-nico', email: 'nico@acme.example' })
    expect((await back(h, again)).headers.get('location')).toBe('/')
    expect(userRow(h, 'nico.g')!.password_hash).toBeNull()
  })

  test('seats full at the start and at the return', async () => {
    const inv = await invite()
    const s = await startInvite(inv.token, 'pia', { sub: 'g-pia', email: 'pia@acme.example' })
    const used0 = (await owner.call('GET', '/api/admin/team-link')).seats.used as number
    setPlanForTests(Plan.parse({ format: 1, plan: 'team', maxConcurrency: 3, memoryMiB: 4096, cpuCores: 2, diskGiB: 50, maxActiveMembers: used0 }))
    expect((await back(h, s)).headers.get('location')).toBe('/invite?google=full')
    expect(used(inv.id)).toBeNull()
    const full = await h.client().try('POST', '/api/invites/google', { token: inv.token, username: 'pia', name: 'Pia' })
    expect(full.status).toBe(409)
    expect(full.body.error.params.reason).toBe('seat_limit')
  })

  test('the maker can no longer invite by the return: nothing is made', async () => {
    const admin = await addMember(h, owner, { username: 'ada', role: 'admin' })
    const inv = await invite(admin.client)
    const s = await startInvite(inv.token, 'quinn', { sub: 'g-quinn', email: 'quinn@acme.example' })
    h.ctx.db.query("UPDATE users SET role = 'member' WHERE id = ?").run(admin.id)
    expect((await back(h, s)).headers.get('location')).toBe('/invite?google=gone')
    expect(userRow(h, 'quinn')).toBeNull()
  })

  test('the team link: a member in its groups, a use taken, the start\'s count given back', async () => {
    const group = await owner.call('POST', '/api/admin/groups', { name: 'Ops' })
    const l = await link({ groupIds: [group.id], maxUses: 2 })
    expect((await h.client().call('POST', '/api/team-link/info', { token: l.token })).googleSignUp).toBe(true)
    const s = await started(await h.client({ ip: '10.0.2.1' }).raw('POST', '/api/team-link/google', { token: l.token, username: 'rosa', name: 'Rosa' }), { sub: 'g-rosa', email: 'rosa@acme.example', name: 'Not Used' })
    expect(linkAttempts(l.id)).toBe(1)
    const res = await back(h, s)
    expect(res.headers.get('location')).toBe('/')
    const u = userRow(h, 'rosa')!
    expect(u).toMatchObject({ name: 'Rosa', role: 'member', password_hash: null })
    expect(h.ctx.db.query('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(group.id, u.id)).toBeTruthy()
    expect((h.ctx.db.query('SELECT uses FROM team_links WHERE id = ?').get(l.id) as { uses: number }).uses).toBe(1)
    expect(h.ctx.db.query("SELECT via FROM member_welcome WHERE user_id = ?").get(u.id)).toEqual({ via: 'team_link' })
    expect(linkAttempts(l.id)).toBe(0)
  })

  test('the team link: used up and a taken username come back to the join page, nothing used', async () => {
    const l = await link({ maxUses: 1 })
    const a = await started(await h.client({ ip: '10.0.3.1' }).raw('POST', '/api/team-link/google', { token: l.token, username: 'sam', name: 'Sam' }), { sub: 'g-sam', email: 'sam@acme.example' })
    const b = await started(await h.client({ ip: '10.0.3.2' }).raw('POST', '/api/team-link/google', { token: l.token, username: 'sue', name: 'Sue' }), { sub: 'g-sue', email: 'sue@acme.example' })
    const c = await started(await h.client({ ip: '10.0.3.3' }).raw('POST', '/api/team-link/google', { token: l.token, username: 'tom', name: 'Tom' }), { sub: 'g-tom', email: 'tom@acme.example' })
    await addMember(h, owner, { username: 'tom' })
    expect((await back(h, c, '10.0.3.3')).headers.get('location')).toBe('/join?google=username_taken')
    expect((h.ctx.db.query('SELECT uses FROM team_links WHERE id = ?').get(l.id) as { uses: number }).uses).toBe(0)
    expect((await back(h, a, '10.0.3.1')).headers.get('location')).toBe('/')
    expect((await back(h, b, '10.0.3.2')).headers.get('location')).toBe('/join?google=gone')
    expect(userRow(h, 'sue')).toBeNull()
    // refused returns keep their count on the link's limit
    expect(linkAttempts(l.id)).toBe(2)
  })

  test('join starts are not stopped by the per-address Google start limit (an office joins from one address)', async () => {
    h.auth.limiter.limits = { ...DEFAULT_LIMITS, perGoogleStart: 1 }
    const l = await link({ maxUses: 5 })
    for (const name of ['uma', 'uli', 'ute']) {
      const r = await h.client({ ip: '10.0.4.1' }).try('POST', '/api/team-link/google', { token: l.token, username: name, name })
      expect(r.status).toBe(200)
    }
    // a sign-in start still is
    expect((await h.client({ ip: '10.0.4.1' }).try('POST', '/api/auth/google/start', {})).status).toBe(200)
    expect((await h.client({ ip: '10.0.4.1' }).try('POST', '/api/auth/google/start', {})).status).toBe(429)
  })

  test('an invite without a username: the server picks a free one from the Google address ("+tag" dropped), the name from Google', async () => {
    await addMember(h, owner, { username: 'vera' })
    const inv = await invite()
    // the pages send only the token and the language now
    const s = await started(await h.client({ ip: '10.0.5.1' }).raw('POST', '/api/invites/google', { token: inv.token, locale: 'ko' }), { sub: 'g-vera', email: 'Vera+work@acme.example', name: 'Vera Lind' })
    const res = await back(h, s, '10.0.5.1')
    expect(res.headers.get('location')).toBe('/')
    expect(await meOf(h, res)).toMatchObject({ username: 'vera-2', name: 'Vera Lind', email: 'Vera+work@acme.example', role: 'member', localeChoice: 'ko' })
    expect(userRow(h, 'vera-2')!.password_hash).toBeNull()
    expect(used(inv.id)).toBeTruthy()
    // no name from Google: the username stands in
    const inv2 = await invite()
    const t = await started(await h.client({ ip: '10.0.5.2' }).raw('POST', '/api/invites/google', { token: inv2.token }), { sub: 'g-wim', email: 'wim@acme.example' })
    expect((await back(h, t, '10.0.5.2')).headers.get('location')).toBe('/')
    expect(userRow(h, 'wim')).toMatchObject({ name: 'wim', password_hash: null })
  })

  test('the team link without a username: one from the Google address, made unique', async () => {
    const l = await link({ maxUses: 3 })
    await addMember(h, owner, { username: 'xena' })
    const s = await started(await h.client({ ip: '10.0.6.1' }).raw('POST', '/api/team-link/google', { token: l.token }), { sub: 'g-xena', email: 'xena+team@acme.example', name: 'Xena Ott' })
    expect((await back(h, s, '10.0.6.1')).headers.get('location')).toBe('/')
    expect(userRow(h, 'xena-2')).toMatchObject({ name: 'Xena Ott', role: 'member', password_hash: null })
    expect((h.ctx.db.query('SELECT uses FROM team_links WHERE id = ?').get(l.id) as { uses: number }).uses).toBe(1)
    // a second person with the same address part gets the next free one
    const t = await started(await h.client({ ip: '10.0.6.2' }).raw('POST', '/api/team-link/google', { token: l.token }), { sub: 'g-xena-b', email: 'xena@other.example', name: 'Xena B' })
    expect((await back(h, t, '10.0.6.2')).headers.get('location')).toBe('/')
    expect(userRow(h, 'xena-3')?.name).toBe('Xena B')
  })

  test('a guest invite is refused without a username too', async () => {
    const project = await owner.call('POST', '/api/projects', { name: 'Specs', scope: 'team' })
    const g = await owner.call('POST', '/api/guest-invites', { place: { kind: 'project', id: project.id }, name: 'Gus' })
    const refused = await h.client().try('POST', '/api/invites/google', { token: g.url.split('/invite/')[1] })
    expect(refused.status).toBe(403)
    expect(refused.body.error.params.reason).toBe('guest_password_only')
  })

  test('the owner who signs in with a password is unchanged', async () => {
    expect((await h.client().login('olga', OWNER_PW)).me.user.username).toBe('olga')
  })
})
