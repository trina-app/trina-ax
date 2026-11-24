// Component A: accounts without a password re-check with Google (server/src/auth/reauth.ts, auth/google-login.ts intent
// 'reauth'; docs/decisions/20261122-google-reauth.md). Every former password re-check takes a confirmed Google check of
// the same session instead, once, within 5 minutes, only for an account without a password; wrong ones count and lock
// like wrong passwords; Set a password needs one; Google cannot be disconnected from an account without a password; the
// team switch and the server's own Google client never lock such accounts out; W6 hands the team to such a person.
import { createHash } from 'node:crypto'
import { hashToken } from '../../server/src/auth/passwords'
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { DEFAULT_LIMITS, reauthKey } from '../../server/src/auth/rate-limit'
import { flowIpHash, GOOGLE_OPEN_FLOWS_MAX, GOOGLE_OPEN_FLOWS_RESERVE } from '../../server/src/auth/google-login'
import { setSetting } from '../../server/src/admin/settings'
import { GoogleClientInUse, guardOwnGoogleClient, refuseClientInUse } from '../../server/src/auth/google-login-admin'
import { HttpError } from '../../server/src/http/errors'
import { googleDriveOf } from '../../server/src/integrations/google-drive/oauth'
import { OWNER_PW, addMember, harness, withOwner, type Client, type Harness } from './a-lib'

setDefaultTimeout(60_000)

const CLIENT_ID = 'test-client.apps.googleusercontent.com'
const CALLBACK = '/api/integrations/google-drive/callback'
const GSI = 'mycel-dev-gsi'
const NOT_A_FLOW = '019a0000-0000-7000-8000-000000000000'

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.c2ln`

/** the Google account the fake Google answers for next */
let nextSub = '100'
/** what the fake Google's id_token says about time, in seconds before now (iat: when it was issued; authTime: when
 * the person last signed in at Google, left out when null) */
let tokenAge = { iat: 0, authTime: null as number | null }
const nonces = new Map<string, string>()
const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
  const body = new URLSearchParams(String(init?.body ?? ''))
  const nonce = nonces.get(body.get('code') ?? '') ?? ''
  const now = Math.floor(Date.now() / 1000)
  const id_token = jwt({ iss: 'https://accounts.google.com', aud: CLIENT_ID, azp: CLIENT_ID, exp: now + 600, iat: now - tokenAge.iat, ...(tokenAge.authTime === null ? {} : { auth_time: now - tokenAge.authTime }), nonce, sub: nextSub, email: `${nextSub}@acme.test`, email_verified: true })
  return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600, token_type: 'Bearer', id_token }), { status: 200, headers: { 'content-type': 'application/json' } })
}) as unknown as typeof fetch

describe('Re-check with Google for accounts without a password', () => {
  let h: Harness
  let owner: Client
  /** pia: a member without a password, Google '201' connected */
  let pia: { client: Client; id: string }
  /** quinn: another one, Google '202' */
  let quinn: { client: Client; id: string }
  beforeAll(async () => {
    h = await harness('google-reauth')
    owner = await withOwner(h)
    googleDriveOf(h.ctx, { config: { clientId: CLIENT_ID, clientSecret: 'secret', redirectUri: `http://team.localhost${CALLBACK}` }, fetch: fakeFetch, broker: null })
    // many starts from one test address
    h.auth.limiter.limits = { ...DEFAULT_LIMITS, perGoogleStart: 10_000, perTokenIp: 10_000 }
    await connect(owner, OWNER_PW, '100')
    pia = await passwordless('pia', '201')
    quinn = await passwordless('quinn', '202')
  })
  afterAll(() => h.close())

  const started = (res: Response, body: { url: string }) => {
    const u = new URL(body.url)
    const state = u.searchParams.get('state')!
    const gsi = res.headers.getSetCookie().find((c) => c.startsWith(`${GSI}=`))!.split(';')[0]!
    const code = `code-${state.slice(0, 8)}`
    nonces.set(code, u.searchParams.get('nonce')!)
    return { u, state, gsi, code }
  }
  const back = (state: string, cookie: string, o: { error?: string } = {}) => {
    const q = new URLSearchParams({ state, ...(o.error ? { error: o.error } : { code: `code-${state.slice(0, 8)}` }) })
    return h.fetch(`${CALLBACK}?${q}`, { headers: cookie ? { cookie } : {} })
  }
  /** connect a Google account with the password (part A1) */
  async function connect(c: Client, password: string, sub: string) {
    const res = await c.raw('POST', '/api/me/google/connect', { password })
    expect(res.status).toBe(200)
    const s = started(res, await res.json() as { url: string })
    nextSub = sub
    expect((await back(s.state, `${c.cookie}; ${s.gsi}`)).headers.get('location')).toBe('/settings/security?google=connected')
  }
  /** a member whose account has no password (as one made with Google; the sign-up flows make them for real) */
  async function passwordless(username: string, sub: string) {
    const m = await addMember(h, owner, { username })
    await connect(m.client, m.password, sub)
    h.ctx.db.query('UPDATE users SET password_hash = NULL WHERE id = ?').run(m.id)
    return { client: m.client, id: m.id }
  }
  /** a Google check of this session; Google answers for `sub` */
  async function check(c: Client, sub: string, o: { error?: string } = {}) {
    const res = await c.raw('POST', '/api/me/google/reauth')
    expect(res.status).toBe(200)
    const body = await res.json() as { url: string; flow: string }
    const s = started(res, body)
    expect(s.u.searchParams.get('prompt')).toBe('select_account')
    // a new sign-in at Google, not the browser's open Google session
    expect(s.u.searchParams.get('max_age')).toBe('0')
    expect(JSON.parse(s.u.searchParams.get('claims')!)).toEqual({ id_token: { auth_time: { essential: true } } })
    expect(await state(c, body.flow)).toBe('waiting')
    nextSub = sub
    const page = await back(s.state, `${c.cookie}; ${s.gsi}`, o)
    return { flow: body.flow, page, html: await page.text() }
  }
  const state = async (c: Client, flow: string) => (await c.try('GET', `/api/me/google/reauth/${flow}`)).body?.state
  const confirmed = async (who: { client: Client }, sub: string) => {
    const r = await check(who.client, sub)
    expect(r.page.status).toBe(200)
    expect(await state(who.client, r.flow)).toBe('confirmed')
    return r.flow
  }
  const flowStatus = (flow: string) => (h.ctx.db.query('SELECT status FROM google_signin_flows WHERE id = ?').get(flow) as { status: string } | null)?.status
  /** the re-check let it through: whatever the endpoint answered next, it was not the check's refusal, and it was spent */
  const accepted = (r: { status: number; body: any }, flow: string) => {
    const f = r.body?.error?.fields ?? {}
    expect(f['body.reauthFlow']).toBeUndefined()
    expect(f['body.password']).toBeUndefined()
    expect(r.status).not.toBe(429)
    expect(flowStatus(flow)).toBe('used')
  }
  const refusedCheck = (r: { status: number; body: any }) => {
    expect(r.status).toBe(403)
    expect(r.body.error.fields['body.reauthFlow']).toBeTruthy()
  }
  const sessionFor = (id: string) => {
    const s = h.auth.createSession(id, 'web', null)
    const c = h.client()
    c.cookie = `mycel-dev-sid=${s.token}`
    return { c, id: s.id }
  }

  test('Me says whether the account has a password; a password sign-in of one without answers like a wrong password', async () => {
    expect((await owner.call('GET', '/api/me')).user.hasPassword).toBe(true)
    expect((await pia.client.call('GET', '/api/me')).user.hasPassword).toBe(false)
    const r = await h.client().try('POST', '/api/auth/login', { username: 'pia', password: 'river stone lamp 7' })
    expect(r.status).toBe(401)
  })

  test('a Google check starts only for an account without a password, with Google connected, from a cookie session', async () => {
    const own = await owner.try('POST', '/api/me/google/reauth')
    expect(own.status).toBe(409)
    expect(own.body.error.params.reason).toBe('has_password')
    const bare = await addMember(h, owner, { username: 'nogoogle' })
    h.ctx.db.query('UPDATE users SET password_hash = NULL WHERE id = ?').run(bare.id)
    expect((await bare.client.try('POST', '/api/me/google/reauth')).body.error.params.reason).toBe('no_google')
    h.ctx.db.query('UPDATE users SET status = \'disabled\' WHERE id = ?').run(bare.id)
    const app = h.client()
    app.token = h.auth.createSession(pia.id, 'mobile', null).token
    expect((await app.try('POST', '/api/me/google/reauth')).status).toBe(403)
  })

  test('the window at Google confirms, closes itself, and only the starting session reads it', async () => {
    const r = await check(pia.client, '201')
    expect(r.page.status).toBe(200)
    expect(r.html).toContain('window.close()')
    expect(r.page.headers.get('cache-control')).toBe('no-store')
    const res = await pia.client.raw('GET', `/api/me/google/reauth/${r.flow}`)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(((await res.json()) as { state: string }).state).toBe('confirmed')
    // pia's other session, and another person: nothing about it
    expect((await sessionFor(pia.id).c.try('GET', `/api/me/google/reauth/${r.flow}`)).status).toBe(404)
    expect((await quinn.client.try('GET', `/api/me/google/reauth/${r.flow}`)).status).toBe(404)
    // the Google account is never in the flow's answer or the audit
    expect(JSON.stringify(h.ctx.db.query("SELECT detail FROM audit_log WHERE action LIKE 'auth.%'").all())).not.toContain('201@acme.test')
  })

  test('a member: the own deletion request and connecting Google take a check', async () => {
    let flow = await confirmed(pia, '201')
    const del = await pia.client.try('POST', '/api/me/deletion-request', { confirm: true, reauthFlow: flow })
    expect(del.status).toBe(200)
    expect(del.body.state).toBe('pending')
    accepted(del, flow)
    await pia.client.call('DELETE', '/api/me/deletion-request')
  })

  test('attack: at an unlocked browser, a passwordless account\'s Google cannot be swapped for another one', async () => {
    const before = h.ctx.db.query("SELECT subject FROM login_identities WHERE user_id = ?").get(pia.id) as { subject: string }
    // the attacker passes the re-check with the victim's open Google session, then asks to connect their own Google
    const flow = await confirmed(pia, '201')
    const con = await pia.client.try('POST', '/api/me/google/connect', { reauthFlow: flow })
    expect(con.status).toBe(409)
    expect(con.body.error.params.reason).toBe('no_password')
    // refused before the check is spent, and nothing changed
    expect(flowStatus(flow)).toBe('confirmed')
    expect(h.ctx.db.query("SELECT subject FROM login_identities WHERE user_id = ?").get(pia.id)).toEqual(before)
  })

  test('a connect started with a password finds the password gone at Google\'s return: refused, the link stays', async () => {
    const m = await addMember(h, owner, { username: 'rita' })
    const res = await m.client.raw('POST', '/api/me/google/connect', { password: m.password })
    expect(res.status).toBe(200)
    const s = started(res, await res.json() as { url: string })
    h.ctx.db.query('UPDATE users SET password_hash = NULL WHERE id = ?').run(m.id)
    nextSub = '666'
    expect((await back(s.state, `${m.client.cookie}; ${s.gsi}`)).headers.get('location')).toBe('/settings/security?google=failed')
    expect(h.ctx.db.query("SELECT 1 FROM login_identities WHERE subject = '666'").get()).toBeNull()
    expect(h.ctx.db.query("SELECT 1 FROM audit_log WHERE action = 'auth.google_connect_refused' AND target = ?").get(m.id)).toBeTruthy()
    h.ctx.db.query("UPDATE users SET password_hash = 'x' WHERE id = ?").run(m.id)
  })

  test('a re-check needs a sign-in at Google now: an old id_token or an old Google sign-in is not confirmed', async () => {
    try {
      for (const age of [{ iat: 120, authTime: null }, { iat: 0, authTime: 20 * 60 }]) {
        tokenAge = age
        const r = await check(pia.client, '201')
        expect(r.page.status).toBe(400)
        expect(await state(pia.client, r.flow)).toBe('failed')
        refusedCheck(await pia.client.try('POST', '/api/me/password', { newPassword: 'quiet harbor 99 lamp', reauthFlow: r.flow }))
      }
      const n = h.ctx.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'auth.reauth_failed' AND target = ? AND detail = ?").get(pia.id, JSON.stringify({ method: 'google', reason: 'not_fresh' })) as { n: number }
      expect(n.n).toBe(2)
      // a Google sign-in a few seconds ago is fine
      tokenAge = { iat: 1, authTime: 20 }
      await confirmed(pia, '201')
    } finally {
      tokenAge = { iat: 0, authTime: null }
      h.auth.limiter.clear(reauthKey(pia.id))
    }
    expect((await pia.client.call('GET', '/api/me')).user.hasPassword).toBe(false)
  })

  test('re-checks are never stopped by a flood of sign-in starts; sign-in starts count per address', async () => {
    const now = Date.now()
    const ins = h.ctx.db.query("INSERT INTO google_signin_flows (id, state_hash, binding_hash, intent, config_key, created_at, expires_at, ip_hash) VALUES (?, ?, 'x', 'signin', 'k', ?, ?, ?)")
    h.ctx.db.transaction(() => {
      for (let i = 0; i < 500; i++) ins.run(crypto.randomUUID(), `flood-${i}`, new Date(now).toISOString(), new Date(now + 600_000).toISOString(), `ip-${i % 17}`)
    })()
    try {
      // the server-wide cap: a new sign-in waits
      expect((await h.client({ ip: '10.9.9.9' }).try('POST', '/api/auth/google/start', {})).status).toBe(429)
      // a signed-in person's re-check does not
      await confirmed(pia, '201')
    } finally { h.ctx.db.query("DELETE FROM google_signin_flows WHERE state_hash LIKE 'flood-%'").run() }
    // one address holds at most 10 open sign-ins; another address goes on
    const one = h.client({ ip: '10.8.8.8' })
    for (let i = 0; i < 10; i++) expect((await one.try('POST', '/api/auth/google/start', {})).status).toBe(200)
    expect((await one.try('POST', '/api/auth/google/start', {})).status).toBe(429)
    expect((await h.client({ ip: '10.8.8.9' }).try('POST', '/api/auth/google/start', {})).status).toBe(200)
    h.ctx.db.query("DELETE FROM google_signin_flows WHERE intent = 'signin' AND status = 'pending'").run()
  })

  test('the per-address count: an IPv6 /64 is one address, the stored key is keyed, no address means no per-address cap but a reserve', async () => {
    // many addresses of one /64 share the 10
    for (let i = 1; i <= 10; i++) expect((await h.client({ ip: `2001:db8:1:2::${i.toString(16)}` }).try('POST', '/api/auth/google/start', {})).status).toBe(200)
    expect((await h.client({ ip: '2001:db8:1:2:ffff::1' }).try('POST', '/api/auth/google/start', {})).status).toBe(429)
    expect((await h.client({ ip: '2001:db8:1:3::1' }).try('POST', '/api/auth/google/start', {})).status).toBe(200)
    // keyed: neither the address nor its plain SHA-256 is stored, and it is the limiter's id under this server's key
    const keys = (h.ctx.db.query("SELECT DISTINCT ip_hash FROM google_signin_flows WHERE intent = 'signin' AND status = 'pending'").all() as { ip_hash: string }[]).map((r) => r.ip_hash)
    expect(keys.sort()).toEqual([flowIpHash(h.ctx, '2001:db8:1:2::1'), flowIpHash(h.ctx, '2001:db8:1:3::1')].sort())
    for (const k of keys) for (const v of ['2001:db8:1:2::1', '2001:db8:1:2::/64', 'google-flow-ip:2001:db8:1:2::/64', 'google-flow-ip:2001:db8:1:2::1']) {
      for (const enc of ['hex', 'base64url'] as const) expect(k).not.toBe(createHash('sha256').update(v).digest(enc))
      expect(k).not.toBe(hashToken(v))
      expect(k).not.toContain('2001')
    }
    h.ctx.db.query("DELETE FROM google_signin_flows WHERE intent = 'signin' AND status = 'pending'").run()
    // no address known: no per-address cap, and no row key
    const none = h.client({ ip: null as unknown as string })
    for (let i = 0; i < 12; i++) expect((await none.try('POST', '/api/auth/google/start', {})).status).toBe(200)
    expect((h.ctx.db.query("SELECT COUNT(*) AS n FROM google_signin_flows WHERE ip_hash IS NULL AND intent = 'signin' AND status = 'pending'").get() as { n: number }).n).toBe(12)
    // ... but it stops GOOGLE_OPEN_FLOWS_RESERVE below the cap; a sign-in counted per address still gets a slot
    const now = Date.now()
    const ins = h.ctx.db.query("INSERT INTO google_signin_flows (id, state_hash, binding_hash, intent, config_key, created_at, expires_at) VALUES (?, ?, 'x', 'signin', 'k', ?, ?)")
    h.ctx.db.transaction(() => {
      for (let i = 0; i < GOOGLE_OPEN_FLOWS_MAX - GOOGLE_OPEN_FLOWS_RESERVE - 12; i++) ins.run(crypto.randomUUID(), `fill-${i}`, new Date(now).toISOString(), new Date(now + 600_000).toISOString())
    })()
    try {
      expect((await none.try('POST', '/api/auth/google/start', {})).status).toBe(429)
      expect((await h.client({ ip: '10.6.6.6' }).try('POST', '/api/auth/google/start', {})).status).toBe(200)
    } finally { h.ctx.db.query("DELETE FROM google_signin_flows WHERE intent = 'signin' AND status = 'pending'").run() }
  })

  test('a check works once, in its session, for its person, within 5 minutes', async () => {
    const flow = await confirmed(pia, '201')
    // another session of the same person, another person: refused, and the check stays for its own session
    refusedCheck(await sessionFor(pia.id).c.try('POST', '/api/me/deletion-request', { confirm: true, reauthFlow: flow }))
    refusedCheck(await quinn.client.try('POST', '/api/me/deletion-request', { confirm: true, reauthFlow: flow }))
    expect(flowStatus(flow)).toBe('confirmed')
    accepted(await pia.client.try('POST', '/api/me/deletion-request', { confirm: true, reauthFlow: flow }), flow)
    await pia.client.call('DELETE', '/api/me/deletion-request')
    // used
    refusedCheck(await pia.client.try('POST', '/api/me/deletion-request', { confirm: true, reauthFlow: flow }))
    // late
    const late = await confirmed(pia, '201')
    h.advance(5 * 60_000 + 1000)
    try {
      expect(await state(pia.client, late)).toBe('failed')
      refusedCheck(await pia.client.try('POST', '/api/me/deletion-request', { confirm: true, reauthFlow: late }))
    } finally { h.advance(-(5 * 60_000 + 1000)) }
    // made up, and both at once
    refusedCheck(await pia.client.try('POST', '/api/me/deletion-request', { confirm: true, reauthFlow: NOT_A_FLOW }))
    const both = await pia.client.try('POST', '/api/me/deletion-request', { confirm: true, reauthFlow: NOT_A_FLOW, password: 'x' })
    expect(both.status).toBe(400)
    h.auth.limiter.clear(reauthKey(pia.id))
  })

  test('a check of an account that got a password meanwhile no longer counts; people with a password type it', async () => {
    const flow = await confirmed(quinn, '202')
    h.ctx.db.query("UPDATE users SET password_hash = 'x' WHERE id = ?").run(quinn.id)
    refusedCheck(await quinn.client.try('POST', '/api/me/deletion-request', { confirm: true, reauthFlow: flow }))
    h.ctx.db.query('UPDATE users SET password_hash = NULL WHERE id = ?').run(quinn.id)
    h.auth.limiter.clear(reauthKey(quinn.id))
  })

  test('another Google account at Google is refused, audited without the account, and counts on the limit', async () => {
    h.auth.limiter.limits = { ...h.auth.limiter.limits, perReauth: 1 }
    const locked: string[] = []
    const prev = h.auth.onReauthLocked
    h.auth.onReauthLocked = (id) => { locked.push(id) }
    try {
      const r = await check(quinn.client, '999')
      expect(r.page.status).toBe(400)
      expect(r.html).not.toContain('window.close()')
      expect(await state(quinn.client, r.flow)).toBe('failed')
      const row = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'auth.reauth_failed' AND target = ? ORDER BY id DESC LIMIT 1").get(quinn.id) as { detail: string }
      expect(JSON.parse(row.detail)).toEqual({ method: 'google', reason: 'wrong_account' })
      expect(row.detail).not.toContain('999')
      expect(locked).toEqual([quinn.id])
      // locked: no new check starts, and the password way is locked too
      expect((await quinn.client.try('POST', '/api/me/google/reauth')).status).toBe(429)
      expect((await quinn.client.try('POST', '/api/me/deletion-request', { confirm: true, password: 'whatever it is' })).status).toBe(429)
    } finally {
      h.auth.onReauthLocked = prev
      h.auth.limiter.limits = { ...h.auth.limiter.limits, perReauth: DEFAULT_LIMITS.perReauth }
      h.auth.limiter.clear(reauthKey(quinn.id))
    }
  })

  test('wrong checks count and lock like wrong passwords; a locked limit refuses a good check too', async () => {
    h.auth.limiter.limits = { ...h.auth.limiter.limits, perReauth: 2 }
    const good = await confirmed(quinn, '202')
    try {
      refusedCheck(await quinn.client.try('POST', '/api/me/deletion-request', { confirm: true, reauthFlow: NOT_A_FLOW }))
      refusedCheck(await quinn.client.try('POST', '/api/me/deletion-request', { confirm: true, reauthFlow: NOT_A_FLOW }))
      expect((await quinn.client.try('POST', '/api/me/deletion-request', { confirm: true, reauthFlow: good })).status).toBe(429)
      expect(flowStatus(good)).toBe('confirmed')
      const fails = h.ctx.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'auth.reauth_failed' AND target = ? AND detail LIKE '%google%'").get(quinn.id) as { n: number }
      expect(fails.n).toBeGreaterThanOrEqual(2)
    } finally {
      h.auth.limiter.limits = { ...h.auth.limiter.limits, perReauth: DEFAULT_LIMITS.perReauth }
      h.auth.limiter.clear(reauthKey(quinn.id))
    }
  })

  test('an admin: the API engine, the voice key and removing a member take a check', async () => {
    await owner.call('PATCH', `/api/admin/users/${pia.id}`, { role: 'admin' })
    let flow = await confirmed(pia, '201')
    accepted(await pia.client.try('PUT', '/api/admin/engines/api-config', { baseUrl: 'https://api.example.com/v1', model: 'm', reauthFlow: flow }), flow)
    flow = await confirmed(pia, '201')
    const key = await pia.client.try('PUT', '/api/admin/speech-key', { sealed: null, reauthFlow: flow })
    expect(key.status).toBe(200)
    accepted(key, flow)
    const tom = await addMember(h, owner, { username: 'tom' })
    flow = await confirmed(pia, '201')
    const gone = await pia.client.try('DELETE', `/api/admin/users/${tom.id}`, { reauthFlow: flow })
    expect(gone.status).toBe(204)
    accepted(gone, flow)
    // without anything: as a missing password always was here
    const tim = await addMember(h, owner, { username: 'tim' })
    expect((await pia.client.try('DELETE', `/api/admin/users/${tim.id}`, {})).status).toBe(403)
  })

  test('W6: the owner hands the team to a person without a password, who re-checks the owner steps with Google', async () => {
    const t = await owner.try('POST', '/api/admin/transfer-ownership', { userId: pia.id, password: OWNER_PW })
    expect(t.status).toBe(200)
    expect((await pia.client.call('GET', '/api/me')).user.role).toBe('owner')
    // owner-reauth endpoints (http/route.ts) whose next step does nothing here: no such backup, no self-update in dev
    for (const [path, body] of [['/api/admin/restore', { backupId: 'nope' }], ['/api/admin/update', {}]] as const) {
      const flow = await confirmed(pia, '201')
      accepted(await pia.client.try('POST', path, { ...body, reauthFlow: flow }), flow)
      // used
      refusedCheck(await pia.client.try('POST', path, { ...body, reauthFlow: flow }))
      // no password to type: one never matches
      expect((await pia.client.try('POST', path, { ...body, password: 'river stone lamp 7' })).body.error.fields['body.password']).toBeTruthy()
    }
    h.auth.limiter.clear(reauthKey(pia.id))
    // and hands it back with a check
    const flow = await confirmed(pia, '201')
    const back = await pia.client.try('POST', '/api/admin/transfer-ownership', { userId: 'olga', reauthFlow: flow })
    expect(back.status).toBe(200)
    accepted(back, flow)
    expect((await owner.call('GET', '/api/me')).user.role).toBe('owner')
  })

  test('a made-up state on the Google return gets the sign-in page\'s words, not Drive\'s', async () => {
    const fake = 'A'.repeat(43)
    // a browser on its way back from a sign-in (its binding cookie), and one not signed in here: the sign-in page
    for (const cookie of [`${GSI}=${'B'.repeat(43)}`, '']) {
      const r = await h.fetch(`${CALLBACK}?state=${fake}&code=x`, { headers: cookie ? { cookie } : {}, ip: '10.7.7.7' })
      expect(r.status).toBe(302)
      expect(r.headers.get('location')).toBe('/login?google=expired')
    }
    // a signed-in person without a sign-in cookie: still Drive's page (a Drive connect of theirs)
    const r = await h.fetch(`${CALLBACK}?state=${fake}&code=x`, { headers: { cookie: owner.cookie! }, ip: '10.7.7.7' })
    expect(r.status).not.toBe(302)
  })

  test('every Google link change is told to the owners and admins; an admin\'s disconnect ends the person\'s sessions', async () => {
    const ownerId = (h.ctx.db.query("SELECT id FROM users WHERE role = 'owner'").get() as { id: string }).id
    // pia and quinn connected theirs (beforeAll): the owner was told for each, by name, never the Google address
    const rows = h.ctx.db.query("SELECT actor_name, subject FROM credential_change_notices WHERE user_id = ? AND action = 'signin_google_connected'").all(ownerId) as { actor_name: string; subject: string }[]
    expect(rows.length).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(rows)).not.toContain('@acme.test')
    const sam = await addMember(h, owner, { username: 'sam' })
    const res = await sam.client.raw('POST', '/api/me/google/connect', { password: sam.password })
    const s1 = started(res, await res.json() as { url: string })
    nextSub = '301'
    await back(s1.state, `${sam.client.cookie}; ${s1.gsi}`)
    // replaced with another Google account (with the password): told as a replacement
    const res2 = await sam.client.raw('POST', '/api/me/google/connect', { password: sam.password })
    const s2 = started(res2, await res2.json() as { url: string })
    nextSub = '302'
    expect((await back(s2.state, `${sam.client.cookie}; ${s2.gsi}`)).headers.get('location')).toBe('/settings/security?google=connected')
    expect(h.ctx.db.query("SELECT 1 FROM credential_change_notices WHERE user_id = ? AND action = 'signin_google_replaced'").get(ownerId)).toBeTruthy()
    const other = sessionFor(sam.id)
    expect((await owner.try('DELETE', `/api/admin/users/${sam.id}/google`)).status).toBe(204)
    expect((await other.c.try('GET', '/api/me')).status).toBe(401)
    expect((await sam.client.try('GET', '/api/me')).status).toBe(401)
    expect(h.ctx.db.query("SELECT 1 FROM credential_change_notices WHERE user_id = ? AND action = 'signin_google_disconnected'").get(sam.id)).toBeTruthy()
  })

  test('Google cannot be disconnected from an account without a password, by the person or an admin', async () => {
    const own = await quinn.client.try('DELETE', '/api/me/google')
    expect(own.status).toBe(409)
    expect(own.body.error.params.reason).toBe('no_password')
    const admin = await owner.try('DELETE', `/api/admin/users/${quinn.id}/google`)
    expect(admin.status).toBe(409)
    expect(h.ctx.db.query('SELECT 1 FROM login_identities WHERE user_id = ?').get(quinn.id)).toBeTruthy()
  })

  test('the team switch off: people without a password still sign in and re-check with Google, nobody else', async () => {
    setSetting(h.ctx.db, 'googleSignIn', false)
    try {
      expect((await h.client().call('GET', '/api/setup')).googleSignIn).toBe(true)
      // connecting is off
      expect((await owner.try('POST', '/api/me/google/connect', { password: OWNER_PW })).status).toBe(503)
      // quinn signs in with Google; the owner, who has a password, does not
      const signIn = async (sub: string) => {
        const res = await h.client().raw('POST', '/api/auth/google/start', {})
        expect(res.status).toBe(200)
        const s = started(res, await res.json() as { url: string })
        nextSub = sub
        return (await back(s.state, s.gsi)).headers.get('location')
      }
      expect(await signIn('202')).toBe('/')
      expect(await signIn('100')).toBe('/login?google=failed')
      await confirmed(quinn, '202')
    } finally { setSetting(h.ctx.db, 'googleSignIn', true) }
  })

  test('the server\'s own Google client is not removed or replaced while people sign in only with it', async () => {
    const n = (h.ctx.db.query("SELECT COUNT(*) AS n FROM users WHERE password_hash IS NULL AND status = 'active' AND deleted_at IS NULL AND guest = 0").get() as { n: number }).n
    expect(n).toBeGreaterThan(0)
    expect(() => guardOwnGoogleClient(h.ctx, null)).toThrow(GoogleClientInUse)
    expect(() => guardOwnGoogleClient(h.ctx, 'other.apps.googleusercontent.com')).toThrow(GoogleClientInUse)
    // the same client with a new secret is fine
    guardOwnGoogleClient(h.ctx, CLIENT_ID)
    let err: unknown
    try { await refuseClientInUse('en', () => guardOwnGoogleClient(h.ctx, null)) } catch (e) { err = e }
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).extra.params).toEqual({ reason: 'passwordless_accounts', count: n })
  })

  test('attack: a person without a password asks for deletion only with a Google check, a fresh sign-in is not enough', async () => {
    // signing in again with the browser's open Google session makes a new session: it proves nothing
    const fresh = sessionFor(quinn.id)
    const refused = await fresh.c.try('POST', '/api/me/deletion-request', { confirm: true })
    expect(refused.status).toBe(403)
    expect(refused.body.error.params.reason).toBe('google_check')
    expect((await quinn.client.call('GET', '/api/me/deletion-request')).state).toBe('none')
    // someone with a password still types it
    expect((await owner.try('POST', '/api/me/deletion-request', { confirm: true })).status).not.toBe(200)
  })

  test('Set a password: after a check, once, for an account without one; then Google can go', async () => {
    const without = await quinn.client.try('POST', '/api/me/password', { newPassword: 'quiet harbor 99 lamp' })
    expect(without.status).toBe(400)
    const flow = await confirmed(quinn, '202')
    // a weak one is refused before the check is spent
    expect((await quinn.client.try('POST', '/api/me/password', { newPassword: 'quinn', reauthFlow: flow })).status).toBe(400)
    expect(flowStatus(flow)).toBe('confirmed')
    const set = await quinn.client.try('POST', '/api/me/password', { newPassword: 'quiet harbor 99 lamp', reauthFlow: flow })
    expect(set.status).toBe(200)
    accepted(set, flow)
    expect((await quinn.client.call('GET', '/api/me')).user.hasPassword).toBe(true)
    expect(h.ctx.db.query("SELECT 1 FROM audit_log WHERE action = 'auth.password_set' AND target = ?").get(quinn.id)).toBeTruthy()
    expect(JSON.stringify(h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'auth.password_set'").all())).not.toContain('harbor')
    // the person, the owner and the admins learn of it (Activity), not only the person
    const told = (h.ctx.db.query("SELECT user_id, subject FROM credential_change_notices WHERE action = 'signin_password_set'").all() as { user_id: string; subject: string }[])
    const ownerId = (h.ctx.db.query("SELECT id FROM users WHERE role = 'owner'").get() as { id: string }).id
    expect(told.map((r) => r.user_id)).toEqual(expect.arrayContaining([quinn.id, ownerId]))
    const shown = (await owner.call('GET', '/api/notifications')).items.find((n: any) => n.credentialChange?.action === 'signin_password_set')
    expect(shown?.link).toBeNull()
    await h.client().login('quinn', 'quiet harbor 99 lamp')
    // once: now a password exists
    expect((await quinn.client.try('POST', '/api/me/password', { newPassword: 'another one 12345', reauthFlow: NOT_A_FLOW })).status).toBe(409)
    // and no more Google checks for this account: the password
    expect((await quinn.client.try('POST', '/api/me/google/reauth')).status).toBe(409)
    const other = sessionFor(quinn.id)
    expect((await other.c.try('GET', '/api/me')).status).toBe(200)
    expect((await quinn.client.try('DELETE', '/api/me/google')).status).toBe(204)
    // the person's other sessions end, this one stays; the owner is told
    expect((await other.c.try('GET', '/api/me')).status).toBe(401)
    expect((await quinn.client.try('GET', '/api/me')).status).toBe(200)
    expect(h.ctx.db.query("SELECT 1 FROM credential_change_notices WHERE action = 'signin_google_disconnected'").get()).toBeTruthy()
  })

  test('an admin\'s temporary password works for an account without one, and disconnects Google', async () => {
    const r = await owner.call('POST', `/api/admin/users/${pia.id}/reset-password`, {})
    expect(h.ctx.db.query('SELECT 1 FROM login_identities WHERE user_id = ?').get(pia.id)).toBeNull()
    await h.client().login('pia', r.temporaryPassword)
  })
})
