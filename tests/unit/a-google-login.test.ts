// Component A: Sign in with Google (server/src/auth/google-login.ts; docs/AGENTS/plan/20261122-0454-google-login.md).
// A person connects their Google account with their current password, then signs in with it. Accounts are matched by
// Google's `sub` only; a flow works once, only in the browser that started it; a connect only in the session that
// started it; resets disconnect Google; the Drive callback address still serves Drive.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { DEFAULT_LIMITS } from '../../server/src/auth/rate-limit'
import { googleClaims } from '../../server/src/auth/google-login'
import { googleDriveOf } from '../../server/src/integrations/google-drive/oauth'
import { OWNER_PW, addMember, harness, withOwner, type Client, type Harness } from './a-lib'

setDefaultTimeout(30_000)

const CLIENT_ID = 'test-client.apps.googleusercontent.com'
const CALLBACK = '/api/integrations/google-drive/callback'
const GSI = 'mycel-dev-gsi'

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.c2ln`

/** What the fake Google answers next: the account that signs in (its sub and e-mail) or a refusal */
let nextAccount: { sub: string; email: string; verified?: boolean } = { sub: '100', email: 'olga@acme.test' }
/** the token requests the fake Google got */
const tokenCalls: URLSearchParams[] = []
/** nonce of each authorization address, by its state (the fake Google echoes it in the id_token) */
const nonces = new Map<string, string>()
let lastCode = ''

const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const body = new URLSearchParams(String(init?.body ?? ''))
  tokenCalls.push(body)
  const nonce = nonces.get(body.get('code') ?? '') ?? ''
  const id_token = jwt({ iss: 'https://accounts.google.com', aud: CLIENT_ID, azp: CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 600, nonce, sub: nextAccount.sub, email: nextAccount.email, email_verified: nextAccount.verified ?? true })
  return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600, token_type: 'Bearer', id_token }), { status: 200, headers: { 'content-type': 'application/json' } })
}) as unknown as typeof fetch

describe('Sign in with Google', () => {
  let h: Harness
  let owner: Client
  beforeAll(async () => {
    h = await harness('google-login')
    owner = await withOwner(h)
    googleDriveOf(h.ctx, { config: { clientId: CLIENT_ID, clientSecret: 'secret', redirectUri: `http://team.localhost${CALLBACK}` }, fetch: fakeFetch, broker: null })
  })
  afterAll(() => h.close())

  /** a start's Google address, binding cookie and state; the fake Google will answer `code` for it */
  const started = (res: Response, body: { url: string }) => {
    const u = new URL(body.url)
    const state = u.searchParams.get('state')!
    const gsi = res.headers.getSetCookie().find((c) => c.startsWith(`${GSI}=`))!.split(';')[0]!
    lastCode = `code-${state.slice(0, 8)}`
    nonces.set(lastCode, u.searchParams.get('nonce')!)
    return { u, state, gsi, code: lastCode }
  }
  /** Google sends the browser back: the cookies it holds, the state and the code (or an error) */
  const back = (state: string, cookie: string, o: { code?: string; error?: string } = {}) => {
    const q = new URLSearchParams({ state, ...(o.error ? { error: o.error } : { code: o.code ?? `code-${state.slice(0, 8)}` }) })
    return h.fetch(`${CALLBACK}?${q}`, { headers: cookie ? { cookie } : {} })
  }
  const connect = async (c: Client, password = OWNER_PW) => {
    const res = await c.raw('POST', '/api/me/google/connect', { password })
    expect(res.status).toBe(200)
    return started(res, await res.json() as { url: string })
  }
  const signInStart = async (c: Client, next?: string) => {
    const res = await c.raw('POST', '/api/auth/google/start', next ? { next } : {})
    expect(res.status).toBe(200)
    return started(res, await res.json() as { url: string })
  }
  const sessionOf = (res: Response) => res.headers.getSetCookie().find((c) => c.startsWith('mycel-dev-sid=') && !c.startsWith('mycel-dev-sid=;'))?.split(';')[0]

  test('the sign-in page offers it only with a Google client, at the address Google returns to', async () => {
    expect((await h.client().call('GET', '/api/setup')).googleSignIn).toBe(true)
    expect((await h.client({ base: 'http://other.localhost' }).call('GET', '/api/setup')).googleSignIn).toBeUndefined()
    const mine = await owner.call('GET', '/api/me/google')
    expect(mine).toEqual({ available: true, account: null })
  })

  test('connect needs the current password and a cookie session', async () => {
    const wrong = await owner.try('POST', '/api/me/google/connect', { password: 'not it at all' })
    expect(wrong.status).toBe(403)
    expect(wrong.body.error.fields['body.password']).toBeTruthy()
    const app = h.client()
    await app.login('olga', OWNER_PW, 'bearer')
    expect((await app.try('POST', '/api/me/google/connect', { password: OWNER_PW })).status).toBe(403)
  })

  test('the Google address asks only for identity, with PKCE, a nonce and the registered return address', async () => {
    const { u } = await connect(owner)
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(u.searchParams.get('scope')).toBe('openid email profile')
    expect(u.searchParams.get('redirect_uri')).toBe(`http://team.localhost${CALLBACK}`)
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    expect(u.searchParams.get('access_type')).toBeNull()
    expect(u.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  test('connect, then sign in with it in a fresh browser; next is kept', async () => {
    nextAccount = { sub: '100', email: 'olga@acme.test' }
    const c = await connect(owner)
    const res = await back(c.state, `${owner.cookie}; ${c.gsi}`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/settings/security?google=connected')
    // the binding cookie is spent
    expect(res.headers.getSetCookie().some((x) => x.startsWith(`${GSI}=;`))).toBe(true)
    const tok = tokenCalls.at(-1)!
    expect(tok.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{64}$/)
    expect(tok.get('client_secret')).toBe('secret')
    const row = h.ctx.db.query("SELECT user_id, subject, email FROM login_identities WHERE provider = 'google'").get() as { user_id: string; subject: string; email: string }
    expect(row).toEqual({ user_id: 'olga', subject: '100', email: 'olga@acme.test' })
    expect((await owner.call('GET', '/api/me/google')).account.email).toBe('olga@acme.test')
    // the audit names who, never the address
    const audits = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'auth.google_connected'").all() as { detail: string | null }[]
    expect(audits.length).toBe(1)
    expect(JSON.stringify(audits)).not.toContain('acme.test')

    const browser = h.client()
    const s = await signInStart(browser, '/rooms')
    const done = await back(s.state, s.gsi)
    expect(done.status).toBe(302)
    expect(done.headers.get('location')).toBe('/rooms')
    const sid = sessionOf(done)!
    expect(sid).toBeTruthy()
    const me = await h.fetch('/api/me', { headers: { cookie: sid } })
    expect(((await me.json()) as any).user.id).toBe('olga')
    expect((h.ctx.db.query("SELECT last_used_at FROM login_identities WHERE user_id = 'olga'").get() as { last_used_at: string | null }).last_used_at).toBeTruthy()
  })

  test('only the browser that started it finishes it, once', async () => {
    const s = await signInStart(h.client())
    // no binding cookie, another one: refused, and the right browser can still finish it
    expect((await back(s.state, '')).headers.get('location')).toBe('/login?google=expired')
    expect((await back(s.state, `${GSI}=${'A'.repeat(43)}`)).headers.get('location')).toBe('/login?google=expired')
    const ok = await back(s.state, s.gsi)
    expect(ok.headers.get('location')).toBe('/')
    // a second return of the same state
    expect((await back(s.state, s.gsi)).headers.get('location')).toBe('/login?google=expired')
  })

  test('an expired flow and a cancel at Google', async () => {
    const s = await signInStart(h.client())
    h.advance(11 * 60_000)
    try { expect((await back(s.state, s.gsi)).headers.get('location')).toBe('/login?google=expired') } finally { h.advance(-11 * 60_000) }
    const t = await signInStart(h.client())
    expect((await back(t.state, t.gsi, { error: 'access_denied' })).headers.get('location')).toBe('/login?google=cancelled')
  })

  test('a Google account nobody connected signs nobody in, whatever e-mail it has', async () => {
    const m = await addMember(h, owner, { username: 'mina' })
    h.ctx.db.query("UPDATE users SET email = 'mina@acme.test' WHERE id = ?").run(m.id)
    nextAccount = { sub: '200', email: 'mina@acme.test' }
    const s = await signInStart(h.client(), '/rooms')
    const res = await back(s.state, s.gsi)
    expect(res.headers.get('location')).toBe('/login?google=not_connected&next=%2Frooms')
    expect(sessionOf(res)).toBeUndefined()
    // an address Google did not verify is refused before anything
    nextAccount = { sub: '100', email: 'olga@acme.test', verified: false }
    const t = await signInStart(h.client())
    expect((await back(t.state, t.gsi)).headers.get('location')).toBe('/login?google=failed')
    nextAccount = { sub: '100', email: 'olga@acme.test' }
  })

  test('one Google account signs one person in', async () => {
    const m = await addMember(h, owner, { username: 'niko' })
    nextAccount = { sub: '100', email: 'olga@acme.test' }
    const c = await connect(m.client, m.password)
    expect((await back(c.state, `${m.client.cookie}; ${c.gsi}`)).headers.get('location')).toBe('/settings/security?google=in_use')
    expect((h.ctx.db.query("SELECT user_id FROM login_identities WHERE subject = '100'").get() as { user_id: string }).user_id).toBe('olga')
  })

  test('a connect finishes only in the session that started it', async () => {
    const m = await addMember(h, owner, { username: 'pia' })
    const other = h.client()
    await other.login('pia', m.password)
    nextAccount = { sub: '300', email: 'pia@acme.test' }
    const c = await connect(m.client, m.password)
    expect((await back(c.state, `${other.cookie}; ${c.gsi}`)).headers.get('location')).toBe('/settings/security?google=expired')
    expect(h.ctx.db.query("SELECT 1 FROM login_identities WHERE user_id = ?").get(m.id)).toBeNull()
  })

  test('a turned-off account and an admin reset', async () => {
    const m = await addMember(h, owner, { username: 'quinn' })
    nextAccount = { sub: '400', email: 'quinn@acme.test' }
    const c = await connect(m.client, m.password)
    expect((await back(c.state, `${m.client.cookie}; ${c.gsi}`)).headers.get('location')).toBe('/settings/security?google=connected')
    h.ctx.db.query("UPDATE users SET status = 'disabled' WHERE id = ?").run(m.id)
    let s = await signInStart(h.client())
    expect((await back(s.state, s.gsi)).headers.get('location')).toBe('/login?google=account_off')
    h.ctx.db.query("UPDATE users SET status = 'active' WHERE id = ?").run(m.id)
    // an admin's temporary password disconnects Google: the reset locks every old way in out
    await owner.call('POST', `/api/admin/users/${m.id}/reset-password`, {})
    expect(h.ctx.db.query('SELECT 1 FROM login_identities WHERE user_id = ?').get(m.id)).toBeNull()
    s = await signInStart(h.client())
    expect((await back(s.state, s.gsi)).headers.get('location')).toBe('/login?google=not_connected')
  })

  test('disconnect', async () => {
    const m = await addMember(h, owner, { username: 'rosa' })
    nextAccount = { sub: '500', email: 'rosa@acme.test' }
    const c = await connect(m.client, m.password)
    await back(c.state, `${m.client.cookie}; ${c.gsi}`)
    expect((await m.client.raw('DELETE', '/api/me/google')).status).toBe(204)
    expect((await m.client.call('GET', '/api/me/google')).account).toBeNull()
    expect(h.ctx.db.query("SELECT 1 FROM audit_log WHERE action = 'auth.google_disconnected' AND actor_id = ?").get(m.id)).toBeTruthy()
  })

  test('the Drive callback still answers Drive for a state that is not a sign-in', async () => {
    const res = await back('B'.repeat(43), '')
    expect(res.status).not.toBe(302)
    expect(res.headers.get('content-type')).toContain('text/html')
  })

  test('starts are limited per address', async () => {
    h.auth.limiter.limits = { ...DEFAULT_LIMITS, perGoogleStart: 2 }
    try {
      const c = h.client({ ip: '10.5.5.5' })
      expect((await c.try('POST', '/api/auth/google/start', {})).status).toBe(200)
      expect((await c.try('POST', '/api/auth/google/start', {})).status).toBe(200)
      expect((await c.try('POST', '/api/auth/google/start', {})).status).toBe(429)
    } finally { h.auth.limiter.limits = DEFAULT_LIMITS }
  })

  test('next must be a path of this site', async () => {
    for (const next of ['https://evil.test/', '//evil.test', '/\\evil.test']) {
      const s = await signInStart(h.client(), next)
      nextAccount = { sub: '100', email: 'olga@acme.test' }
      expect((await back(s.state, s.gsi)).headers.get('location')).toBe('/')
    }
  })
})

describe('googleClaims', () => {
  const now = Date.now()
  const base = { iss: 'https://accounts.google.com', aud: CLIENT_ID, azp: CLIENT_ID, exp: Math.floor(now / 1000) + 60, nonce: 'n'.repeat(43), sub: '42', email: 'a@b.test', email_verified: true }
  const check = (over: Record<string, unknown>) => googleClaims(jwt({ ...base, ...over }), CLIENT_ID, 'n'.repeat(43), now)
  test('Google, this client, live, this nonce, a verified address', () => {
    expect(check({})).toEqual({ sub: '42', email: 'a@b.test', hd: null })
    expect(check({ iss: 'https://evil.test' })).toBeNull()
    expect(check({ aud: 'other' })).toBeNull()
    expect(check({ aud: [CLIENT_ID, 'other'], azp: 'other' })).toBeNull()
    expect(check({ exp: Math.floor(now / 1000) - 1 })).toBeNull()
    expect(check({ nonce: 'm'.repeat(43) })).toBeNull()
    expect(check({ email_verified: false })).toBeNull()
    expect(check({ sub: '' })).toBeNull()
    expect(googleClaims('not.a.jwt', CLIENT_ID, 'n', now)).toBeNull()
    expect(googleClaims(undefined, CLIENT_ID, 'n', now)).toBeNull()
  })
})
