// Sign in with Google through the hosting service (part B: server/src/auth/google-login-broker.ts, google-id-token.ts,
// shared/src/cloud-protocol/google-signin.ts). A hosted team server without a Google client of its own signs people in
// with the console's client: the console answers Google's address and later Google's raw id_token, and the team server
// checks that id_token itself against Google's keys (here a local RSA key stands in for Google's). Covers: when the
// button shows; the start (signed with the team key over the contract's own string, our nonce in Google's address, the
// console's answer checked); connect and sign in end to end; the id_token's signature, aud, nonce, exp, email_verified
// and alg; binding, once and expiry; a flow comes back only the way it went; the console's errors; Google's keys
// cached by kid; a self-installed server never uses it; the contract's parsers and signing string.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import type { AppConfig } from '../../server/src/app-config'
import { googleDriveOf } from '../../server/src/integrations/google-drive/oauth'
import { GOOGLE_CERTS } from '../../server/src/integrations/google-drive/client'
import { googleSigninBrokerOf } from '../../server/src/auth/google-login-broker'
import { GoogleKeys, verifyGoogleIdToken } from '../../server/src/auth/google-id-token'
import { GoogleTransport } from '../../server/src/integrations/google-drive/client'
import {
  GOOGLE_SIGNIN_CALLBACK_PATH, GOOGLE_SIGNIN_PATHS, GOOGLE_SIGNIN_TEAM_RETURN_PATH, googleSigninAuthorizeUrl, googleSigninReturnUrl, googleSigninSigningString,
  parseGoogleSigninAuthorization, parseGoogleSigninRedeem, parseGoogleSigninStart, parseGoogleSigninStatus,
} from '../../shared/src/cloud-protocol/google-signin'
import { DRIVE_BROKER_PATHS, driveBrokerSigningString } from '../../shared/src/cloud-protocol/drive-broker'
import { DEFAULT_LIMITS } from '../../server/src/auth/rate-limit'
import { OWNER_PW, addMember, harness, withOwner, type Client, type Harness } from './a-lib'

setDefaultTimeout(30_000)

const TEAM = 'https://acme.trina.test'
const ORIGIN = 'https://account.cp.test'
const CLIENT_ID = '123456789-signin.apps.googleusercontent.com'
const GSI = '__Host-gsi'
const s256 = (v: string) => crypto.createHash('sha256').update(v).digest('base64url')
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')

/** Google's signing key (a local one) and another key that Google never published */
const GOOGLE = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const OTHER = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const KID = 'google-key-1'
const jwk = { ...GOOGLE.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }

function signJwt(claims: Record<string, unknown>, o: { key?: crypto.KeyObject; kid?: string; alg?: string } = {}): string {
  const head = b64({ alg: o.alg ?? 'RS256', kid: o.kid ?? KID, typ: 'JWT' }), body = b64(claims)
  const sig = o.alg === 'none' ? '' : crypto.sign('sha256', Buffer.from(`${head}.${body}`), o.key ?? GOOGLE.privateKey).toString('base64url')
  return `${head}.${body}.${sig || 'AA'}`
}

/** A stand-in for the hosting service's console and Google's key list. It checks every call the way the control plane
 * does (the team key it knows, the contract's signing string, strict bodies, nonce once) and answers Google's raw
 * id_token for the account that "signed in" at Google. */
class FakeConsole {
  readonly key = crypto.generateKeyPairSync('ed25519').privateKey
  readonly publicKey = crypto.createPublicKey(this.key).export({ format: 'der', type: 'spki' }).toString('base64')
  configured = true
  seen = new Set<string>()
  calls: { path: string; body: string; authorization: string }[] = []
  starts = new Map<string, { returnState: string; challenge: string; nonce: string }>()
  handoffs = new Map<string, { challenge: string; nonce: string }>()
  certsCalls = 0
  /** who signs in at Google next, and what is wrong with the id_token the console hands back */
  account: { sub: string; email: string; verified?: boolean } = { sub: '900', email: 'olga@acme.test' }
  tamper: ((claims: Record<string, unknown>) => Record<string, unknown>) | null = null
  signer: { key?: crypto.KeyObject; kid?: string; alg?: string } = {}
  /** the start answer's Google address, changed by a test */
  bendUrl: ((u: URL) => void) | null = null
  now = () => Date.now()

  fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    if (url === GOOGLE_CERTS) { this.certsCalls++; return Response.json({ keys: [jwk] }) }
    if (!url.startsWith(ORIGIN + '/')) return new Response('no', { status: 599 })
    const path = new URL(url).pathname, body = String(init.body ?? ''), authorization = new Headers(init.headers).get('authorization') ?? ''
    this.calls.push({ path, body, authorization })
    const err = (code: string, status: number) => Response.json({ error: { code, message: code } }, { status })
    const auth = parseGoogleSigninAuthorization(authorization)
    if (!auth || init.method !== 'POST') return err('unauthorized', 401)
    let ok = false
    try { ok = crypto.verify(null, Buffer.from(googleSigninSigningString(path, auth.ts, auth.nonce, crypto.createHash('sha256').update(body).digest('hex'))), crypto.createPublicKey({ key: Buffer.from(auth.key, 'base64'), format: 'der', type: 'spki' }), Buffer.from(auth.sig, 'base64')) } catch {}
    if (!ok || this.seen.has(auth.nonce)) return err('unauthorized', 401)
    this.seen.add(auth.nonce)
    if (auth.key !== this.publicKey) return err('not_hosted', 403)
    if (!this.configured) return err('not_configured', 503)
    let json: unknown
    try { json = JSON.parse(body) } catch { return err('invalid_request', 400) }
    if (path === GOOGLE_SIGNIN_PATHS.status) return parseGoogleSigninStatus(json) ? Response.json({ ok: true, clientId: CLIENT_ID }) : err('invalid_request', 400)
    if (path === GOOGLE_SIGNIN_PATHS.start) {
      const b = parseGoogleSigninStart(json)
      if (!b) return err('invalid_request', 400)
      const state = crypto.randomBytes(32).toString('base64url'), verifier = crypto.randomBytes(48).toString('base64url')
      this.starts.set(state, { returnState: b.returnState, challenge: b.codeChallenge, nonce: b.nonce })
      const u = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      for (const [k, v] of Object.entries({ client_id: CLIENT_ID, redirect_uri: ORIGIN + GOOGLE_SIGNIN_CALLBACK_PATH, response_type: 'code', scope: 'openid email profile', state, nonce: b.nonce, code_challenge: s256(verifier), code_challenge_method: 'S256', prompt: 'select_account' })) u.searchParams.set(k, v)
      this.bendUrl?.(u)
      return Response.json({ authorizationUrl: u.href, clientId: CLIENT_ID, expiresAt: new Date(Date.now() + 600_000).toISOString() })
    }
    if (path === GOOGLE_SIGNIN_PATHS.redeem) {
      const b = parseGoogleSigninRedeem(json)
      if (!b) return err('invalid_request', 400)
      const h = this.handoffs.get(b.handoff)
      this.handoffs.delete(b.handoff)
      if (!h || s256(b.codeVerifier) !== h.challenge) return err('invalid_handoff', 400)
      let claims: Record<string, unknown> = {
        iss: 'https://accounts.google.com', aud: CLIENT_ID, azp: CLIENT_ID, iat: Math.floor(this.now() / 1000), exp: Math.floor(this.now() / 1000) + 3600,
        nonce: h.nonce, sub: this.account.sub, email: this.account.email, email_verified: this.account.verified ?? true,
      }
      if (this.tamper) claims = this.tamper(claims)
      return Response.json({ idToken: signJwt(claims, this.signer) })
    }
    return err('invalid_request', 404)
  }

  /** The browser at Google and back at the console: the team's return address with a handoff (or an error). */
  browserReturn(authorizationUrl: string, error?: 'consent_denied' | 'provider_error'): string {
    const state = new URL(authorizationUrl).searchParams.get('state')!
    const s = this.starts.get(state)
    if (!s) throw new Error('unknown console state')
    this.starts.delete(state)
    if (error) return googleSigninReturnUrl(TEAM, s.returnState, { error })
    const handoff = crypto.randomBytes(32).toString('base64url')
    this.handoffs.set(handoff, { challenge: s.challenge, nonce: s.nonce })
    return googleSigninReturnUrl(TEAM, s.returnState, { handoff })
  }
}

describe('Sign in with Google through the hosting service', () => {
  let h: Harness
  let owner: Client
  const cp = new FakeConsole()
  beforeAll(async () => {
    h = await harness('google-login-broker', { deployment: 'hosted', publicOrigins: [TEAM] } as Partial<AppConfig>)
    await withOwner(h)
    // every test browser comes from one address: the per-address start limit (a-google-login.test.ts tests it) stays out of the way
    h.auth.limiter.limits = { ...DEFAULT_LIMITS, perGoogleStart: 1000 }
    owner = h.client({ base: TEAM })
    await owner.login('olga', OWNER_PW)
    cp.now = () => h.auth.now()
    googleDriveOf(h.ctx, { config: null, broker: null, fetch: cp.fetch })
    const broker = googleSigninBrokerOf(h.ctx, { origin: ORIGIN, identity: () => ({ key: cp.key, publicKey: cp.publicKey }), fetch: cp.fetch, now: () => h.auth.now() })!
    await broker.check()
  })
  afterAll(() => h.close())

  const browser = () => h.client({ base: TEAM })
  /** a start's answer: Google's address and the binding cookie */
  const started = async (res: Response) => {
    expect(res.status).toBe(200)
    const { url } = await res.json() as { url: string }
    const gsi = res.headers.getSetCookie().find((c) => c.startsWith(`${GSI}=`))!.split(';')[0]!
    return { url, gsi }
  }
  const signInStart = async (c: Client, next?: string) => started(await c.raw('POST', '/api/auth/google/start', next ? { next } : {}))
  const connectStart = async (c: Client, password = OWNER_PW) => started(await c.raw('POST', '/api/me/google/connect', { password }))
  /** the console sends the browser back to the team: the cookies the browser holds */
  const back = (returnUrl: string, cookie: string) => {
    const u = new URL(returnUrl)
    return h.fetch(u.pathname + u.search, { base: TEAM, headers: cookie ? { cookie } : {} })
  }
  const where = (r: Response) => r.headers.get('location')
  const sessionOf = (res: Response) => res.headers.getSetCookie().find((c) => c.startsWith('__Host-sid=') && !c.startsWith('__Host-sid=;'))?.split(';')[0]
  const reset = () => { cp.account = { sub: '900', email: 'olga@acme.test' }; cp.tamper = null; cp.signer = {}; cp.bendUrl = null; cp.configured = true }

  test('the button shows at the team’s own address when the console serves the team', async () => {
    expect((await browser().call('GET', '/api/setup')).googleSignIn).toBe(true)
    expect((await h.client({ base: 'https://other.trina.test' }).call('GET', '/api/setup')).googleSignIn).toBeUndefined()
    expect((await h.client().call('GET', '/api/setup')).googleSignIn).toBeUndefined()
    expect(await owner.call('GET', '/api/me/google')).toEqual({ available: true, account: null })
    // the status call: signed with the team key over the sign-in contract's own string
    const status = cp.calls.find((c) => c.path === GOOGLE_SIGNIN_PATHS.status)!
    expect(status.authorization.startsWith('TrinaGoogleSignin key=')).toBe(true)
    expect(JSON.parse(status.body)).toEqual({ v: 1 })
  })

  test('Admin › Team settings shows the switch on a team the console serves (no own Google client); not while it does not', async () => {
    expect(await owner.call('GET', '/api/admin/google-login')).toEqual({ client: true })
    const broker = googleSigninBrokerOf(h.ctx)!
    cp.configured = false
    try {
      await broker.check()
      expect(await owner.call('GET', '/api/admin/google-login')).toEqual({ client: false })
    } finally {
      cp.configured = true
      await broker.check()
    }
    expect(await owner.call('GET', '/api/admin/google-login')).toEqual({ client: true })
    // the switch works there: off, no button for new people; on again, back
    await owner.call('PATCH', '/api/admin/settings', { googleSignIn: false })
    expect((await browser().call('GET', '/api/setup')).googleSignIn).toBeUndefined()
    expect(await owner.call('GET', '/api/admin/google-login')).toEqual({ client: true })
    await owner.call('PATCH', '/api/admin/settings', { googleSignIn: true })
    expect((await browser().call('GET', '/api/setup')).googleSignIn).toBe(true)
  })

  test('the start: our state, challenge and nonce to the console; its Google address checked and passed on', async () => {
    const before = cp.calls.length
    const s = await signInStart(browser())
    const call = cp.calls.slice(before).find((c) => c.path === GOOGLE_SIGNIN_PATHS.start)!
    const body = JSON.parse(call.body) as { v: number; returnState: string; codeChallenge: string; nonce: string }
    expect(Object.keys(body).sort()).toEqual(['codeChallenge', 'nonce', 'returnState', 'v'])
    const u = new URL(s.url)
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(u.searchParams.get('nonce')).toBe(body.nonce)
    expect(u.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(u.searchParams.get('scope')).toBe('openid email profile')
    expect(u.searchParams.get('access_type')).toBeNull()
    expect(u.searchParams.get('redirect_uri')).toBe(ORIGIN + GOOGLE_SIGNIN_CALLBACK_PATH)
    // the console's own PKCE pair toward Google, never ours
    expect(u.searchParams.get('code_challenge')).not.toBe(body.codeChallenge)
    // the flow keeps the console's client id; only hashes of the state and the binding
    const row = h.ctx.db.query('SELECT config_key, state_hash FROM google_signin_flows ORDER BY created_at DESC LIMIT 1').get() as { config_key: string; state_hash: string }
    expect(row.config_key).toBe(`gsi-broker:${CLIENT_ID}`)
    expect(row.state_hash).not.toBe(body.returnState)
  })

  test('connect with the password, then sign in with it in a fresh browser; next is kept', async () => {
    reset()
    const c = await connectStart(owner)
    const res = await back(cp.browserReturn(c.url), `${owner.cookie}; ${c.gsi}`)
    expect(res.status).toBe(302)
    expect(where(res)).toBe('/settings/security?google=connected')
    expect(res.headers.getSetCookie().some((x) => x.startsWith(`${GSI}=;`))).toBe(true)
    expect(h.ctx.db.query("SELECT user_id, subject FROM login_identities WHERE provider = 'google'").get()).toEqual({ user_id: 'olga', subject: '900' })

    const b = browser()
    const s = await signInStart(b, '/rooms')
    const done = await back(cp.browserReturn(s.url), s.gsi)
    expect(where(done)).toBe('/rooms')
    const sid = sessionOf(done)!
    expect(sid).toBeTruthy()
    const me = await h.fetch('/api/me', { base: TEAM, headers: { cookie: sid } })
    expect(((await me.json()) as any).user.id).toBe('olga')
    // the redeem: our handoff and our verifier, nothing else
    const redeem = cp.calls.filter((x) => x.path === GOOGLE_SIGNIN_PATHS.redeem).at(-1)!
    expect(Object.keys(JSON.parse(redeem.body)).sort()).toEqual(['codeVerifier', 'handoff', 'v'])
  })

  test('an id_token Google did not sign, for another client, another flow, expired or unverified signs nobody in', async () => {
    const cases: [string, () => void][] = [
      ['another key, same kid', () => { cp.signer = { key: OTHER.privateKey } }],
      ['a kid Google never listed', () => { cp.signer = { key: OTHER.privateKey, kid: 'made-up' } }],
      ['alg none', () => { cp.signer = { alg: 'none' } }],
      ['alg HS256', () => { cp.signer = { alg: 'HS256' } }],
      ['another client', () => { cp.tamper = (x) => ({ ...x, aud: 'other.apps.googleusercontent.com', azp: 'other.apps.googleusercontent.com' }) }],
      ['another azp', () => { cp.tamper = (x) => ({ ...x, azp: 'other.apps.googleusercontent.com' }) }],
      ['another issuer', () => { cp.tamper = (x) => ({ ...x, iss: 'https://evil.test' }) }],
      ['another nonce', () => { cp.tamper = (x) => ({ ...x, nonce: 'n'.repeat(43) }) }],
      ['expired', () => { cp.tamper = (x) => ({ ...x, exp: Math.floor(h.auth.now() / 1000) - 5 }) }],
      ['unverified address', () => { cp.account = { sub: '900', email: 'olga@acme.test', verified: false } }],
    ]
    for (const [name, bend] of cases) {
      reset(); bend()
      const b = browser()
      const s = await signInStart(b)
      const res = await back(cp.browserReturn(s.url), s.gsi)
      expect(`${name}: ${where(res)}`).toBe(`${name}: /login?google=failed`)
      expect(sessionOf(res)).toBeUndefined()
    }
    reset()
  })

  test('only the browser that started it finishes it, once, within ten minutes', async () => {
    reset()
    let s = await signInStart(browser())
    let ret = cp.browserReturn(s.url)
    expect(where(await back(ret, ''))).toBe('/login?google=expired')
    expect(where(await back(ret, `${GSI}=${'A'.repeat(43)}`))).toBe('/login?google=expired')
    expect(where(await back(ret, s.gsi))).toBe('/')
    expect(where(await back(ret, s.gsi))).toBe('/login?google=expired')
    s = await signInStart(browser())
    ret = cp.browserReturn(s.url)
    h.advance(11 * 60_000)
    try { expect(where(await back(ret, s.gsi))).toBe('/login?google=expired') } finally { h.advance(-11 * 60_000) }
  })

  test('a flow comes back only the way it went: a broker state on the Drive callback fails', async () => {
    reset()
    const s = await signInStart(browser())
    const state = new URL(cp.browserReturn(s.url)).searchParams.get('state')!
    const res = await h.fetch(`/api/integrations/google-drive/callback?state=${state}&code=x`, { base: TEAM, headers: { cookie: s.gsi } })
    expect(where(res)).toBe('/login?google=failed')
  })

  test('the console’s errors: a cancel at Google, Google failing, a handoff that is not this flow’s', async () => {
    reset()
    let s = await signInStart(browser())
    expect(where(await back(cp.browserReturn(s.url, 'consent_denied'), s.gsi))).toBe('/login?google=cancelled')
    s = await signInStart(browser())
    expect(where(await back(cp.browserReturn(s.url, 'provider_error'), s.gsi))).toBe('/login?google=failed')
    s = await signInStart(browser())
    const ret = new URL(cp.browserReturn(s.url))
    ret.searchParams.set('handoff', 'B'.repeat(43))
    expect(where(await back(ret.href, s.gsi))).toBe('/login?google=failed')
  })

  test('a Google address that is not this flow’s is never handed to the browser', async () => {
    const bends: ((u: URL) => void)[] = [
      (u) => { u.host = 'evil.test' },
      (u) => { u.searchParams.set('nonce', 'x'.repeat(43)) },
      (u) => { u.searchParams.set('client_id', 'other.apps.googleusercontent.com') },
      (u) => { u.searchParams.set('redirect_uri', 'https://evil.test/cb') },
      (u) => { u.searchParams.set('access_type', 'offline') },
      (u) => { u.searchParams.set('scope', 'openid email profile https://www.googleapis.com/auth/drive') },
    ]
    for (const bend of bends) {
      reset(); cp.bendUrl = bend
      const r = await browser().try('POST', '/api/auth/google/start', {})
      expect(r.status).toBe(503)
      expect(r.body.error.code).toBe('unavailable')
    }
    reset()
  })

  test('a console that stops serving the team: the start fails and the button goes', async () => {
    reset(); cp.configured = false
    const r = await browser().try('POST', '/api/auth/google/start', {})
    expect(r.status).toBe(503)
    expect((await browser().call('GET', '/api/setup')).googleSignIn).toBeUndefined()
    reset()
    await googleSigninBrokerOf(h.ctx)!.check()
    expect((await browser().call('GET', '/api/setup')).googleSignIn).toBe(true)
  })

  test('Google’s keys are fetched once and kept by kid; an unknown kid fetches again at most once a minute', async () => {
    reset()
    const before = cp.certsCalls
    for (let i = 0; i < 3; i++) {
      const s = await signInStart(browser())
      expect(where(await back(cp.browserReturn(s.url), s.gsi))).toBe('/')
    }
    expect(cp.certsCalls - before).toBeLessThanOrEqual(1)
    const keys = new GoogleKeys(new GoogleTransport(cp.fetch), () => h.auth.now())
    const n = cp.certsCalls
    expect(await keys.get('nope')).toBeNull()
    expect(await keys.get('nope')).toBeNull()
    expect(await keys.get(KID)).not.toBeNull()
    expect(cp.certsCalls - n).toBe(1)
  })

  test('verifyGoogleIdToken: Google’s signature and the claims', async () => {
    const keys = new GoogleKeys(new GoogleTransport(cp.fetch), Date.now)
    const now = Date.now(), nonce = 'q'.repeat(43)
    const base = { iss: 'accounts.google.com', aud: CLIENT_ID, exp: Math.floor(now / 1000) + 60, nonce, sub: '7', email: 'a@b.test', email_verified: true }
    expect(await verifyGoogleIdToken(keys, signJwt(base), { clientId: CLIENT_ID, nonce, now })).toEqual({ sub: '7', email: 'a@b.test', hd: null })
    // one changed byte of the claims breaks the signature
    const t = signJwt(base).split('.')
    expect(await verifyGoogleIdToken(keys, [t[0], b64({ ...base, sub: '8' }), t[2]].join('.'), { clientId: CLIENT_ID, nonce, now })).toBeNull()
    expect(await verifyGoogleIdToken(keys, signJwt(base), { clientId: 'other.apps.googleusercontent.com', nonce, now })).toBeNull()
    expect(await verifyGoogleIdToken(keys, 'a.b', { clientId: CLIENT_ID, nonce, now })).toBeNull()
    expect(await verifyGoogleIdToken(keys, undefined, { clientId: CLIENT_ID, nonce, now })).toBeNull()
  })

  test('a connect finishes only in the session that started it; one Google account signs one person in', async () => {
    reset()
    const m = await addMember(h, owner, { username: 'pia' })
    const one = browser(), two = browser()
    await one.login('pia', m.password)
    await two.login('pia', m.password)
    cp.account = { sub: '901', email: 'pia@acme.test' }
    let c = await connectStart(one, m.password)
    expect(where(await back(cp.browserReturn(c.url), `${two.cookie}; ${c.gsi}`))).toBe('/settings/security?google=expired')
    expect(h.ctx.db.query('SELECT 1 FROM login_identities WHERE user_id = ?').get(m.id)).toBeNull()
    // olga's Google account (sub 900) stays hers
    cp.account = { sub: '900', email: 'olga@acme.test' }
    c = await connectStart(one, m.password)
    expect(where(await back(cp.browserReturn(c.url), `${one.cookie}; ${c.gsi}`))).toBe('/settings/security?google=in_use')
    reset()
  })
})

describe('a self-installed server never signs in through the hosting service', () => {
  let h: Harness
  beforeAll(async () => { h = await harness('google-login-broker-self', { publicOrigins: [TEAM] } as Partial<AppConfig>); await withOwner(h) })
  afterAll(() => h.close())
  test('no broker, no button', async () => {
    googleDriveOf(h.ctx, { config: null, broker: null })
    expect(googleSigninBrokerOf(h.ctx, { origin: ORIGIN })).toBeNull()
    expect((await h.client({ base: TEAM }).call('GET', '/api/setup')).googleSignIn).toBeUndefined()
    expect((await h.client({ base: TEAM }).try('POST', '/api/auth/google/start', {})).status).toBe(503)
  })
})

describe('google-signin contract', () => {
  const st = 'S'.repeat(43), ch = 'C'.repeat(43), no = 'N'.repeat(43)
  test('strict bodies: exactly the fields, the right shapes', () => {
    expect(parseGoogleSigninStart({ v: 1, returnState: st, codeChallenge: ch, nonce: no })).toEqual({ v: 1, returnState: st, codeChallenge: ch, nonce: no })
    expect(parseGoogleSigninStart({ v: 1, returnState: st, codeChallenge: ch, nonce: no, purpose: 'x' })).toBeNull()
    expect(parseGoogleSigninStart({ v: 1, returnState: st, codeChallenge: ch })).toBeNull()
    expect(parseGoogleSigninStart({ v: 2, returnState: st, codeChallenge: ch, nonce: no })).toBeNull()
    expect(parseGoogleSigninStart({ v: 1, returnState: st, codeChallenge: ch, nonce: 'short' })).toBeNull()
    expect(parseGoogleSigninRedeem({ v: 1, handoff: st, codeVerifier: 'v'.repeat(64) })).toEqual({ v: 1, handoff: st, codeVerifier: 'v'.repeat(64) })
    expect(parseGoogleSigninRedeem({ v: 1, handoff: st, codeVerifier: 'v'.repeat(64), extra: 1 })).toBeNull()
    expect(parseGoogleSigninRedeem({ v: 1, handoff: st, codeVerifier: 'short' })).toBeNull()
    expect(parseGoogleSigninStatus({ v: 1 })).toEqual({ v: 1 })
    expect(parseGoogleSigninStatus({ v: 1, x: 1 })).toBeNull()
  })
  test('its own signing string: a Drive broker signature never verifies here', () => {
    const a = googleSigninSigningString(GOOGLE_SIGNIN_PATHS.start, 1, 'n'.repeat(22), 'h')
    expect(a.startsWith('trina-google-signin-v1\n')).toBe(true)
    expect(a).not.toBe(driveBrokerSigningString(GOOGLE_SIGNIN_PATHS.start, 1, 'n'.repeat(22), 'h'))
    expect(a).not.toBe(googleSigninSigningString(DRIVE_BROKER_PATHS.start, 1, 'n'.repeat(22), 'h'))
  })
  test('the return address is built from the team address only', () => {
    expect(googleSigninReturnUrl('https://acme.trina.test/', st, { handoff: ch })).toBe(`https://acme.trina.test${GOOGLE_SIGNIN_TEAM_RETURN_PATH}?state=${st}&handoff=${ch}`)
    expect(googleSigninReturnUrl('https://acme.trina.test', st, { error: 'consent_denied' })).toBe(`https://acme.trina.test${GOOGLE_SIGNIN_TEAM_RETURN_PATH}?state=${st}&error=consent_denied`)
  })
  test('googleSigninAuthorizeUrl takes only Google’s page for exactly this flow', () => {
    const u = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    for (const [k, v] of Object.entries({ client_id: CLIENT_ID, redirect_uri: ORIGIN + GOOGLE_SIGNIN_CALLBACK_PATH, response_type: 'code', scope: 'openid email profile', state: st, nonce: no, code_challenge: ch, code_challenge_method: 'S256', prompt: 'select_account' })) u.searchParams.set(k, v)
    const o = { origin: ORIGIN, clientId: CLIENT_ID, nonce: no }
    expect(googleSigninAuthorizeUrl(u.href, o)).toBe(u.href)
    expect(googleSigninAuthorizeUrl(u.href.replace('accounts.google.com', 'accounts.google.com.evil.test'), o)).toBeNull()
    expect(googleSigninAuthorizeUrl(u.href + '#x', o)).toBeNull()
    expect(googleSigninAuthorizeUrl(u.href, { ...o, nonce: 'M'.repeat(43) })).toBeNull()
    expect(googleSigninAuthorizeUrl(u.href, { ...o, origin: 'https://other.cp.test' })).toBeNull()
    expect(googleSigninAuthorizeUrl(42, o)).toBeNull()
  })
})
