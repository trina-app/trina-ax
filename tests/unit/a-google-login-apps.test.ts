// Component A: Sign in with Google from the desktop and phone apps (server/src/auth/google-login-apps.ts;
// docs/AGENTS/plan/20261122-0620-google-login-apps.md, docs/decisions/20261122-google-login-apps.md). The app's flow is
// bound to a secret its sign-in page keeps (only the hash at the start); Google's return in the system browser never
// signs that browser in: it makes a one-time code for the app (a page with the desktop app's link, or a redirect to the
// phone's auth session), and only the app's secret redeems it, once, within 5 minutes, as the client kind that started.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import { PRODUCT } from '@mycel/shared'
import { GOOGLE_APP_RETURN_PATH, googlePhoneReturn } from '@mycel/shared/api'
import { GOOGLE_APP_CODE_MS, sweepGoogleCodes } from '../../server/src/auth/google-login-apps'
import { googleDriveOf } from '../../server/src/integrations/google-drive/oauth'
import { OWNER_PW, addMember, harness, withOwner, type Client, type Harness } from './a-lib'

setDefaultTimeout(30_000)

const CLIENT_ID = 'test-client.apps.googleusercontent.com'
const CALLBACK = '/api/integrations/google-drive/callback'
const REDEEM = '/api/auth/google/redeem'
const GSI = 'mycel-dev-gsi'

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.c2ln`
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
const secret = () => crypto.randomBytes(32).toString('base64url')

/** the account the fake Google signs in next */
let nextAccount: { sub: string; email: string } = { sub: '100', email: 'olga@acme.test' }
const nonces = new Map<string, string>()

const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
  const body = new URLSearchParams(String(init?.body ?? ''))
  const nonce = nonces.get(body.get('code') ?? '') ?? ''
  const id_token = jwt({ iss: 'https://accounts.google.com', aud: CLIENT_ID, azp: CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 600, nonce, sub: nextAccount.sub, email: nextAccount.email, email_verified: true })
  return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600, token_type: 'Bearer', id_token }), { status: 200, headers: { 'content-type': 'application/json' } })
}) as unknown as typeof fetch

describe('Sign in with Google from the apps', () => {
  let h: Harness
  let owner: Client
  beforeAll(async () => {
    h = await harness('google-login-apps')
    owner = await withOwner(h)
    googleDriveOf(h.ctx, { config: { clientId: CLIENT_ID, clientSecret: 'secret', redirectUri: `http://team.localhost${CALLBACK}` }, fetch: fakeFetch, broker: null })
    // olga connects her Google account in a browser first (A1)
    const res = await owner.raw('POST', '/api/me/google/connect', { password: OWNER_PW })
    const u = new URL(((await res.json()) as { url: string }).url)
    const gsi = res.headers.getSetCookie().find((c) => c.startsWith(`${GSI}=`))!.split(';')[0]!
    const state = u.searchParams.get('state')!
    nonces.set(`code-${state.slice(0, 8)}`, u.searchParams.get('nonce')!)
    const back = await h.fetch(`${CALLBACK}?${new URLSearchParams({ state, code: `code-${state.slice(0, 8)}` })}`, { headers: { cookie: `${owner.cookie}; ${gsi}` } })
    expect(back.headers.get('location')).toBe('/settings/security?google=connected')
  })
  afterAll(() => h.close())

  /** an app's start: the Google address and its state; the fake Google will answer for it */
  const appStart = async (client: 'desktop' | 'mobile', key = secret(), c: Client = h.client()) => {
    const res = await c.raw('POST', '/api/auth/google/start', { client, appSecretHash: sha256(key) })
    expect(res.status).toBe(200)
    // no binding cookie: the system browser that comes back is not the app's window
    expect(res.headers.getSetCookie().some((x) => x.startsWith(`${GSI}=`))).toBe(false)
    const u = new URL(((await res.json()) as { url: string }).url)
    const state = u.searchParams.get('state')!
    nonces.set(`code-${state.slice(0, 8)}`, u.searchParams.get('nonce')!)
    return { state, key }
  }
  /** Google sends the system browser back (no cookie of the app) */
  const back = (state: string, o: { error?: string; cookie?: string } = {}) =>
    h.fetch(`${CALLBACK}?${new URLSearchParams({ state, ...(o.error ? { error: o.error } : { code: `code-${state.slice(0, 8)}` }) })}`, { headers: o.cookie ? { cookie: o.cookie } : {} })
  const noSession = (res: Response) => expect(res.headers.getSetCookie().some((x) => /^(mycel-dev-sid|__Host-sid)=[^;]/.test(x))).toBe(false)
  /** the code in the desktop page's link (`<scheme>://open?url=<team>/login/google#code=…`) */
  const desktopCode = async (res: Response) => {
    const html = await res.text()
    const link = `${PRODUCT.linkScheme}://open?${new URLSearchParams({ url: `http://team.localhost${GOOGLE_APP_RETURN_PATH}` })}#code=`
    const at = html.indexOf(link.replace(/&/g, '&#38;'))
    expect(at).toBeGreaterThan(-1)
    return { code: html.slice(at + link.length, at + link.length + 43), html }
  }
  const phoneCode = (res: Response) => {
    expect(res.status).toBe(302)
    const loc = res.headers.get('location')!
    expect(loc.startsWith(`${googlePhoneReturn(PRODUCT.linkScheme)}#code=`)).toBe(true)
    return loc.slice(loc.indexOf('#code=') + 6)
  }
  const sessionOf = (res: Response) => res.headers.getSetCookie().find((c) => c.startsWith('mycel-dev-sid=') && !c.startsWith('mycel-dev-sid=;'))?.split(';')[0]

  test('the sign-in page tells the apps they may offer it, at any address', async () => {
    const here = await h.client().call('GET', '/api/setup')
    expect(here.googleSignIn).toBe(true)
    expect(here.googleAppSignIn).toBe(true)
    // an office address: the browser's flow needs Google's return address, an app's does not
    const lan = await h.client({ base: 'http://other.localhost' }).call('GET', '/api/setup')
    expect(lan.googleSignIn).toBeUndefined()
    expect(lan.googleAppSignIn).toBe(true)
    expect((await h.client({ base: 'http://other.localhost' }).try('POST', '/api/auth/google/start', { client: 'desktop', appSecretHash: sha256(secret()) })).status).toBe(200)
  })

  test('a start needs the secret\'s hash for an app, and none for a browser', async () => {
    expect((await h.client().try('POST', '/api/auth/google/start', { client: 'desktop' })).status).toBe(400)
    expect((await h.client().try('POST', '/api/auth/google/start', { client: 'mobile', appSecretHash: 'not-hex' })).status).toBe(400)
    expect((await h.client().try('POST', '/api/auth/google/start', { appSecretHash: sha256('x') })).status).toBe(400)
    const { state, key } = await appStart('desktop')
    const row = h.ctx.db.query('SELECT client, binding_hash FROM google_signin_flows ORDER BY created_at DESC LIMIT 1').get() as { client: string; binding_hash: string }
    expect(row).toEqual({ client: 'desktop', binding_hash: sha256(key) })
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  test('desktop: the system browser gets a page with the app link, never a session; the app redeems once', async () => {
    nextAccount = { sub: '100', email: 'olga@acme.test' }
    const { state, key } = await appStart('desktop')
    const res = await back(state)
    expect(res.status).toBe(200)
    noSession(res)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
    const { code, html } = await desktopCode(res)
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/)
    // it names whose account, and says to open it only in one's own app
    expect(html).toContain('@olga')
    expect(html).toContain('data-testid="google-app-own"')
    expect(html).toContain('http-equiv="refresh"')
    // only the code's hash is kept
    const rows = h.ctx.db.query('SELECT code_hash, client, secret_hash FROM google_signin_codes').all() as { code_hash: string; client: string; secret_hash: string }[]
    expect(rows.some((r) => r.code_hash === code)).toBe(false)
    expect(rows.find((r) => r.code_hash === sha256(code))).toEqual({ code_hash: sha256(code), client: 'desktop', secret_hash: sha256(key) })

    const app = h.client()
    const ok = await app.raw('POST', REDEEM, { code, appSecret: key, client: 'desktop' })
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as any
    expect(body.token).toBeUndefined()
    expect(body.me.user.id).toBe('olga')
    expect(body.me.session.client).toBe('desktop')
    expect((await app.call('GET', '/api/me')).user.id).toBe('olga')
    expect((h.ctx.db.query("SELECT last_used_at FROM login_identities WHERE user_id = 'olga'").get() as { last_used_at: string | null }).last_used_at).toBeTruthy()
    // the audit names the person, the way and the app; never the code or the secret
    const audits = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'auth.login' AND detail LIKE '%google%'").all() as { detail: string }[]
    expect(audits.some((a) => JSON.parse(a.detail).client === 'desktop')).toBe(true)
    expect(JSON.stringify(audits)).not.toContain(code)
    expect(JSON.stringify(audits)).not.toContain(key)
    // the same link opened again
    expect((await h.client().try('POST', REDEEM, { code, appSecret: key, client: 'desktop' })).status).toBe(410)
  })

  test('phone: Google\'s return goes to the auth session\'s address; the WebView redeems as a phone session', async () => {
    const { state, key } = await appStart('mobile')
    const res = await back(state)
    noSession(res)
    const code = phoneCode(res)
    const phone = h.client()
    const r = await phone.raw('POST', REDEEM, { code, appSecret: key, client: 'mobile' })
    expect(r.status).toBe(200)
    expect(((await r.json()) as any).me.session.client).toBe('mobile')
    expect(sessionOf(r)).toBeTruthy()
  })

  test('a wrong secret spends the code', async () => {
    const { state, key } = await appStart('desktop')
    const { code } = await desktopCode(await back(state))
    expect((await h.client().try('POST', REDEEM, { code, appSecret: secret(), client: 'desktop' })).status).toBe(410)
    expect((await h.client().try('POST', REDEEM, { code, appSecret: key, client: 'desktop' })).status).toBe(410)
  })

  test('another client kind spends the code', async () => {
    const { state, key } = await appStart('desktop')
    const { code } = await desktopCode(await back(state))
    expect((await h.client().try('POST', REDEEM, { code, appSecret: key, client: 'mobile' })).status).toBe(410)
    expect((await h.client().try('POST', REDEEM, { code, appSecret: key, client: 'desktop' })).status).toBe(410)
  })

  test('a late code is gone', async () => {
    const { state, key } = await appStart('mobile')
    const code = phoneCode(await back(state))
    h.advance(GOOGLE_APP_CODE_MS + 1000)
    try {
      expect((await h.client().try('POST', REDEEM, { code, appSecret: key, client: 'mobile' })).status).toBe(410)
      // the sweeper takes it away
      expect(sweepGoogleCodes(h.ctx, Date.now() + GOOGLE_APP_CODE_MS + 1000)).toBeGreaterThan(0)
    } finally { h.advance(-(GOOGLE_APP_CODE_MS + 1000)) }
  })

  test('an app signed in as someone else is refused, and the code stays for after a sign-out', async () => {
    const m = await addMember(h, owner, { username: 'niko' })
    const { state, key } = await appStart('desktop')
    const { code } = await desktopCode(await back(state))
    const r = await m.client.try('POST', REDEEM, { code, appSecret: key, client: 'desktop' })
    expect(r.status).toBe(409)
    expect(r.body.error.params?.reason).toBe('signed_in_as_other')
    expect((await m.client.call('GET', '/api/me')).user.id).toBe(m.id)
    // the same person signed in already: fine
    const same = await owner.try('POST', REDEEM, { code, appSecret: key, client: 'desktop' })
    expect(same.status).toBe(200)
  })

  test('bad codes count against the address', async () => {
    const c = h.client({ ip: '10.8.8.8' })
    expect((await c.try('POST', REDEEM, { code: 'B'.repeat(43), appSecret: secret(), client: 'desktop' })).status).toBe(410)
    expect((await c.try('POST', REDEEM, { code: 'short', appSecret: secret(), client: 'mobile' })).status).toBe(410)
    const n = (h.ctx.db.query("SELECT COUNT(*) AS n FROM login_attempts WHERE key = 'token-ip:10.8.8.8'").get() as { n: number }).n
    expect(n).toBe(2)
  })

  test('a bearer header is refused: the session lands in the app\'s cookie', async () => {
    const { state, key } = await appStart('desktop')
    const { code } = await desktopCode(await back(state))
    expect((await h.client().try('POST', REDEEM, { code, appSecret: key, client: 'desktop' }, { authorization: 'Bearer x' })).status).toBe(400)
  })

  test('a Google account nobody connected, a cancel, and a disconnect before the redeem', async () => {
    nextAccount = { sub: '999', email: 'stranger@acme.test' }
    let s = await appStart('mobile')
    let res = await back(s.state)
    expect(res.headers.get('location')).toBe(`${googlePhoneReturn(PRODUCT.linkScheme)}#error=not_connected`)
    noSession(res)
    s = await appStart('desktop')
    res = await back(s.state)
    expect(res.status).toBe(400)
    expect(await res.text()).not.toContain('#code=')
    nextAccount = { sub: '100', email: 'olga@acme.test' }
    s = await appStart('mobile')
    expect((await back(s.state, { error: 'access_denied' })).headers.get('location')).toBe(`${googlePhoneReturn(PRODUCT.linkScheme)}#error=cancelled`)
    // a second return of the same state
    expect((await back(s.state)).headers.get('location')).toBe(`${googlePhoneReturn(PRODUCT.linkScheme)}#error=expired`)
    // disconnected between Google's return and the redeem: nobody
    const m = await addMember(h, owner, { username: 'rosa' })
    const con = await m.client.raw('POST', '/api/me/google/connect', { password: m.password })
    const cu = new URL(((await con.json()) as { url: string }).url)
    const gsi = con.headers.getSetCookie().find((c) => c.startsWith(`${GSI}=`))!.split(';')[0]!
    const cs = cu.searchParams.get('state')!
    nonces.set(`code-${cs.slice(0, 8)}`, cu.searchParams.get('nonce')!)
    nextAccount = { sub: '500', email: 'rosa@acme.test' }
    await h.fetch(`${CALLBACK}?${new URLSearchParams({ state: cs, code: `code-${cs.slice(0, 8)}` })}`, { headers: { cookie: `${m.client.cookie}; ${gsi}` } })
    const t = await appStart('mobile')
    const code = phoneCode(await back(t.state))
    await m.client.raw('DELETE', '/api/me/google')
    expect((await h.client().try('POST', REDEEM, { code, appSecret: t.key, client: 'mobile' })).status).toBe(410)
    nextAccount = { sub: '100', email: 'olga@acme.test' }
  })

  test('an account turned off after Google\'s return signs nobody in', async () => {
    const m = await addMember(h, owner, { username: 'quinn' })
    const con = await m.client.raw('POST', '/api/me/google/connect', { password: m.password })
    const cu = new URL(((await con.json()) as { url: string }).url)
    const gsi = con.headers.getSetCookie().find((c) => c.startsWith(`${GSI}=`))!.split(';')[0]!
    const cs = cu.searchParams.get('state')!
    nonces.set(`code-${cs.slice(0, 8)}`, cu.searchParams.get('nonce')!)
    nextAccount = { sub: '400', email: 'quinn@acme.test' }
    await h.fetch(`${CALLBACK}?${new URLSearchParams({ state: cs, code: `code-${cs.slice(0, 8)}` })}`, { headers: { cookie: `${m.client.cookie}; ${gsi}` } })
    const t = await appStart('desktop')
    const { code } = await desktopCode(await back(t.state))
    h.ctx.db.query("UPDATE users SET status = 'disabled' WHERE id = ?").run(m.id)
    try {
      expect((await h.client().try('POST', REDEEM, { code, appSecret: t.key, client: 'desktop' })).status).toBe(410)
      // and Google's return says so on the page right away
      const u = await appStart('desktop')
      const res = await back(u.state)
      expect(res.status).toBe(400)
    } finally { h.ctx.db.query("UPDATE users SET status = 'active' WHERE id = ?").run(m.id) }
    nextAccount = { sub: '100', email: 'olga@acme.test' }
  })

  test('a newer return voids the older code of the same Google account', async () => {
    const a = await appStart('mobile')
    const first = phoneCode(await back(a.state))
    const b = await appStart('mobile')
    const second = phoneCode(await back(b.state))
    expect((await h.client().try('POST', REDEEM, { code: first, appSecret: a.key, client: 'mobile' })).status).toBe(410)
    expect((await h.client().try('POST', REDEEM, { code: second, appSecret: b.key, client: 'mobile' })).status).toBe(200)
  })

  test('an app flow ignores a browser binding cookie, and a browser flow still needs its own', async () => {
    const { state, key } = await appStart('mobile')
    const code = phoneCode(await back(state, { cookie: `${GSI}=${'A'.repeat(43)}` }))
    expect((await h.client().try('POST', REDEEM, { code, appSecret: key, client: 'mobile' })).status).toBe(200)
    // the web flow (A1) is unchanged: no cookie, no sign-in
    const web = await h.client().raw('POST', '/api/auth/google/start', {})
    const ws = new URL(((await web.json()) as { url: string }).url).searchParams.get('state')!
    expect((await back(ws)).headers.get('location')).toBe('/login?google=expired')
  })
})
