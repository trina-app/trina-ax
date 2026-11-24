// Sign in with Google (docs/AGENTS/plan/20261122-0454-google-login.md, part A1). A person connects their Google account
// in Settings › Security with their current password, then signs in with it. An account is found by Google's `sub`
// only, never by e-mail (docs/decisions/20261122-google-login-identity.md).
//
// Direct mode: the Google client is this server's own (googleDriveOf(ctx).config: a company's own Google app, the
// in-app setup or MYCEL_GOOGLE_DRIVE_CLIENT_FILE), and Google returns to the address that client already registered,
// the Drive callback (routes/drive.ts asks ownsGoogleState first), so nothing new is registered at Google
// (docs/decisions/20261122-google-login-client.md). The id_token comes from Google's token answer over TLS, asked with
// the client secret, so its signature is not checked (Google's OpenID Connect guide allows it on that channel); iss,
// aud, azp, exp, nonce and email_verified are.
//
// Broker mode (part B): a hosted server without a client of its own borrows the hosting service's
// (google-login-broker.ts). The flow keeps the broker's client id (config_key `gsi-broker:<client id>`), the console
// sends the browser back to GOOGLE_SIGNIN_TEAM_RETURN_PATH with a one-time handoff, and the raw id_token it redeems is
// checked here in full, Google's RS256 signature included (google-id-token.ts): the console relays a sign-in, it cannot
// make one up.
//
// Either way only `openid email profile`, no offline access, and nothing from Google is kept but the identity row.
//
// A re-check (intent 'reauth', auth/reauth.ts, docs/decisions/20261122-google-reauth.md): an account without a password
// (made with Google) confirms with its connected Google account where others type their password again. Google opens in
// a new window; its return, in this session and for that very Google account, marks the flow 'confirmed', the window
// says so and closes, and the tab that asked sends its request with the flow's id. The team switch never stops a
// re-check or such a person's sign-in: it stops new people connecting and joining with Google.
//
// A flow is bound to the browser that started it: a short HttpOnly cookie whose hash the flow keeps. Nobody finishes a
// sign-in someone else started, or sends a person back signed in as the starter's Google account (login CSRF). A
// connect is also bound to the session that started it. A state works once. The desktop and phone apps start flows
// bound to a secret their sign-in page keeps instead (no cookie), and Google's return gives them a one-time code, never
// a session in the system browser (auth/google-login-apps.ts, docs/decisions/20261122-google-login-apps.md).
import crypto, { createHmac } from 'node:crypto'
import type { Context } from 'hono'
import type { MyGoogle } from '@mycel/shared/api'
import { isFreeRoam } from '../app-config'
import type { AppContext } from '../context'
import { newId } from '../db'
import { audit } from '../admin/audit'
import type { AppEnv } from '../http/env'
import { fail } from '../http/errors'
import { GOOGLE_AUTH, GOOGLE_TOKEN } from '../integrations/google-drive/client'
import { configKey, hash as driveHash, type DriveConfig } from '../integrations/google-drive/config'
import { googleDriveOf } from '../integrations/google-drive/oauth'
import { publicHostOf } from '../system/deployment'
import { brokerClientOf, brokerFlowKey, googleSigninBrokerOf } from './google-login-broker'
import { verifyGoogleIdToken } from './google-id-token'
import { viaOf } from './accounts'
import { isGuest } from './guests'
import { forgetLoginIdentities, passwordlessCount } from './login-identities'
import { googleSignInOn } from './google-login-admin'
import { notifyGoogleConnected, notifySignInChange } from '../notifications/service'
import { CLOSE_SCRIPT, returnHeaders, returnPage } from '../integrations/connections/return-page'
import { msg } from './messages'
import { hashToken, safeEqual } from './passwords'
import { googleStartKeys, limitIp, reauthKey, tokenIpKeys } from './rate-limit'
import { confirmSecret } from '../chat/confirm-key'
import { hasNoPassword, reauthState, requireReauth, REAUTH_CONFIRMED_MS } from './reauth'
import { authOf } from './service'
import { getUser } from './users'
import { googleAppReturn, googleSignInRefusal, holdGoogleCode, type GoogleAppClient } from './google-login-apps'
import { signUpPage, signUpReturn, type SignUpExtra } from './google-signup'

export const GOOGLE_FLOW_TTL_MS = 10 * 60_000
/** open flows at once, for the whole server: a flood of starts from many addresses stops here, not at the disk */
export const GOOGLE_OPEN_FLOWS_MAX = 500
/** open sign-in flows at once from one address: a few addresses cannot fill GOOGLE_OPEN_FLOWS_MAX and lock out the
 * people who sign in only with Google (docs/decisions/20261124-google-signin-security.md) */
export const GOOGLE_OPEN_FLOWS_PER_IP = 10
/** the last open slots under GOOGLE_OPEN_FLOWS_MAX, kept for sign-ins counted per address: starts that are not (no
 * address known, a sign-up's start) cannot take them */
export const GOOGLE_OPEN_FLOWS_RESERVE = 50
/** a re-check's id_token must be this new (its `iat`), and Google's own sign-in (`auth_time`, when Google sends it) at
 * most REAUTH_SIGN_IN_MAX_MS old: the re-check proves a sign-in at Google now, not only one left open in the browser */
export const REAUTH_TOKEN_MAX_AGE_MS = 60_000
export const REAUTH_SIGN_IN_MAX_MS = 5 * 60_000
/** the sealed verifier and nonce: the Drive store's vault, in a context of their own (no person yet at sign-in) */
const SEAL_CONTEXT = 'google-login'
const SCOPES = 'openid email profile'
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com'])

/** How a Google return ended, for the page it goes back to (?google=<result>): the sign-in page or Settings › Security
 * says it in words. A sign-in that worked opens `next` instead. */
export type GoogleResult = 'connected' | 'not_connected' | 'account_off' | 'password_first' | 'in_use' | 'cancelled' | 'expired' | 'failed'
  // sign-up (auth/google-signup.ts): the username was taken meanwhile, the invite, link or setup no longer works, every
  // seat is taken
  | 'username_taken' | 'gone' | 'full'
  // a re-check (intent 'reauth'): confirmed for the person's connected Google account, or another Google account
  | 'confirmed' | 'wrong_account'

/** binding_hash: the browser's binding cookie's hash ('web'), or the hash of the secret the app keeps ('desktop',
 * 'mobile': auth/google-login-apps.ts, migration 133) */
interface FlowRow {
  id: string; binding_hash: string; intent: 'signin' | 'connect' | 'setup' | 'join' | 'reauth'; user_id: string | null; session_id: string | null
  config_key: string; next: string | null; secret_enc: string | null; key_version: number; status: 'pending' | 'used' | 'confirmed'; expires_at: string
  client: 'web' | GoogleAppClient
}
/** `name`: Google's `name` claim (the first owner made with Google is named so, auth/google-signup.ts); absent when Google
 * sends none */
export interface GoogleClaims { sub: string; email: string | null; hd: string | null; name?: string; iat?: number; authTime?: number }
/** How a return ended: a result for the page, a web sign-in's address to open, or an app's one-time code */
type Settled = { row: FlowRow | null; result: GoogleResult } | { row: FlowRow; next: string } | { row: FlowRow; code: string; who: { name: string; username: string } }
/** what binds a new flow: the browser's cookie, or the secret an app keeps (only its hash comes here) */
type Binding = { client: 'web' } | { client: GoogleAppClient; secretHash: string }

const random = () => crypto.randomBytes(32).toString('base64url')
const clean = (v: unknown, max: number): string | null => typeof v === 'string' && v ? v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : null

/** The binding cookie: __Host- on https (no other *.trina.app site can set it), a plain name on a plain-http dev server
 * (browsers refuse __Host- there), like the session cookie (service.ts cookieFor). */
function bindingName(reqUrl: string): { name: string; secure: boolean } {
  return new URL(reqUrl).protocol === 'https:' ? { name: '__Host-gsi', secure: true } : { name: 'mycel-dev-gsi', secure: false }
}
function bindingCookie(reqUrl: string, value: string, maxAgeSec: number): string {
  const { name, secure } = bindingName(reqUrl)
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`
}
function readBinding(c: Context<AppEnv>): string | null {
  const name = bindingName(c.req.url).name
  for (const part of (c.req.header('cookie') ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) {
      const v = part.slice(i + 1).trim()
      return TOKEN_RE.test(v) ? v : null
    }
  }
  return null
}

/** A path of this site to open after signing in (the sign-in page's ?next=), else null: never another site, a
 * scheme-relative address or a backslash (browsers read `/\x` as `//x`). */
export function safeNextPath(v: string | null | undefined): string | null {
  if (!v || v.length > 500 || !v.startsWith('/') || v.startsWith('//') || /[\\\s\u0000-\u001f\u007f]/.test(v)) return null
  return v
}

/** Which Google client signs in here, whatever the page's address: 'direct' when this server has a Google client of its
 * own, 'broker' on a hosted server without one when the hosting service serves it; null when neither, when the team
 * turned it off (Admin › Team settings, google-login-admin.ts), or in a demo. `anyway`: the team switch does not count
 * (people without a password sign in and re-check with Google whatever it says). */
function googleClientMode(ctx: AppContext, anyway = false): 'direct' | 'broker' | null {
  if (ctx.config.demo || isFreeRoam(ctx.config) || (!anyway && !googleSignInOn(ctx.db))) return null
  const drive = googleDriveOf(ctx)
  if (drive.config) return 'direct'
  // an operator's own client file that does not load: no fallback to the hosting service (as for Drive)
  if (drive.clientFromEnv) return null
  const broker = googleSigninBrokerOf(ctx)
  return broker && publicHostOf(ctx.config) && broker.serves() ? 'broker' : null
}

/** How this page signs in with Google, or null when it cannot: googleClientMode, and the page is at the address Google
 * (direct) or the console (broker: the team's own address) sends the browser back to. People on an office, Tailscale
 * or LAN address sign in with the password there: the binding cookie lives on one address. */
export function googleLoginMode(ctx: AppContext, reqUrl: string, anyway = false): 'direct' | 'broker' | null {
  const mode = googleClientMode(ctx, anyway)
  if (!mode) return null
  try {
    const origin = new URL(reqUrl).origin
    const back = mode === 'direct' ? new URL(googleDriveOf(ctx).config!.redirectUri).origin : new URL(`https://${publicHostOf(ctx.config)}`).origin
    return back === origin ? mode : null
  } catch { return null }
}

/** This page can use Sign in with Google (googleLoginMode): connect it, and the setup, invite and join pages' Google. */
export function googleLoginAvailable(ctx: AppContext, reqUrl: string): boolean {
  return googleLoginMode(ctx, reqUrl) !== null
}

/** The team switch is off, but people without a password sign in with Google: their sign-in stays (the switch only
 * stops new people joining, connecting or starting with Google). */
const signInAnyway = (ctx: AppContext): boolean => !googleSignInOn(ctx.db) && passwordlessCount(ctx.db) > 0

/** The sign-in page offers "Sign in with Google": googleLoginAvailable, or, with the team switch off, while someone
 * here has no password. */
export function googleSignInPageAvailable(ctx: AppContext, reqUrl: string): boolean {
  return googleLoginMode(ctx, reqUrl, signInAnyway(ctx)) !== null
}

/** The desktop and phone apps can use it (auth/google-login-apps.ts): googleClientMode, from any address the app shows
 * (an office LAN address too): their flow is bound to a secret the app keeps, not to a cookie of one address. */
export function googleAppLoginAvailable(ctx: AppContext): boolean {
  return googleClientMode(ctx, signInAnyway(ctx)) !== null
}

/** The flow row, the binding (a cookie for a browser; for an app, the hash of its secret) and Google's address (direct:
 * built here; broker: the console's start answer, its client id kept in the flow). Each start counts against the
 * caller's address, connect too; a sign-up's start (setup, join: auth/google-signup.ts) instead counts where its
 * password form would (the setup token, the invite or link and its limit), so an office joining from one address is
 * not stopped by the per-address start limit. `extra`: what a sign-up carries to Google's return (the team name, the
 * username the person picked, the invite's id, …), sealed with the verifier and the nonce, never in plain columns. */
export async function begin(c: Context<AppEnv>, ctx: AppContext, intent: FlowRow['intent'], who: { userId: string; sessionId: string } | null, next: string | null, bind: Binding = { client: 'web' }, extra: SignUpExtra | null = null): Promise<{ url: string }> {
  const a = authOf(ctx)
  const locale = c.get('locale')
  const hold = intent === 'setup' || intent === 'join' ? { wait: 0 } : a.limiter.hold(googleStartKeys(c.get('info').ip))
  if (hold.wait > 0) fail('rate_limited', msg('tooManyAttempts', locale), { retryAfter: hold.wait })
  // the team switch stops new people only: a re-check, and a sign-in while someone has no password, go on
  const anyway = intent === 'reauth' || (intent === 'signin' && signInAnyway(ctx))
  const mode = bind.client === 'web' ? googleLoginMode(ctx, c.req.url, anyway) : googleClientMode(ctx, anyway)
  if (!mode) fail('unavailable', msg('googleSignInOff', locale))
  const drive = googleDriveOf(ctx)
  ctx.db.query('DELETE FROM google_signin_flows WHERE expires_at <= ?').run(new Date(a.now()).toISOString())
  // only flows still waiting for Google: a used one cannot be finished again, and goes when it expires. A signed-in
  // person's flow (a connect or a re-check: one open per person, below) is not counted, so a flood of sign-in starts
  // never stops a re-check; a sign-in counts per address too
  // the address as the rate limiter counts it (an IPv6 /64), keyed with this process's secret: the row never holds
  // anything that names the address; a restart starts the count again, like the limiter
  const ip = c.get('info').ip
  const perIp = !who && intent === 'signin' && !!ip
  const ipHash = perIp ? flowIpHash(ctx, ip!) : null
  if (!who && (ctx.db.query("SELECT COUNT(*) AS n FROM google_signin_flows WHERE status = 'pending' AND user_id IS NULL").get() as { n: number }).n >= GOOGLE_OPEN_FLOWS_MAX - (perIp ? 0 : GOOGLE_OPEN_FLOWS_RESERVE)) fail('rate_limited', msg('tooManyAttempts', locale), { retryAfter: 60 })
  if (perIp && (ctx.db.query("SELECT COUNT(*) AS n FROM google_signin_flows WHERE ip_hash = ? AND status = 'pending'").get(ipHash) as { n: number }).n >= GOOGLE_OPEN_FLOWS_PER_IP) fail('rate_limited', msg('tooManyAttempts', locale), { retryAfter: 60 })
  const id = newId(), state = random(), binding = random(), nonce = random(), verifier = crypto.randomBytes(48).toString('base64url')
  const bindingHash = bind.client === 'web' ? hashToken(binding) : bind.secretHash
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  let googleUrl: string, key: string
  if (mode === 'direct') {
    const cfg = drive.config as DriveConfig
    key = configKey(cfg)
    const url = new URL(GOOGLE_AUTH)
    for (const [k, v] of Object.entries({ client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: 'code', scope: SCOPES, state, nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account' })) url.searchParams.set(k, v)
    if (intent === 'reauth') freshSignIn(url)
    googleUrl = url.href
  } else {
    // the hosting service's client: our state comes back on GOOGLE_SIGNIN_TEAM_RETURN_PATH, our nonce is in Google's
    // address, our challenge binds the handoff to this flow's verifier
    let r: { url: string; clientId: string }
    try { r = await googleSigninBrokerOf(ctx)!.start(state, challenge, nonce) } catch { return fail('unavailable', msg('googleSignInOff', locale)) }
    key = brokerFlowKey(r.clientId)
    // a re-check asks Google for a new sign-in here too: Google's page, checked above, with two more questions
    const url = new URL(r.url)
    if (intent === 'reauth') freshSignIn(url)
    googleUrl = url.href
  }
  const now = a.now()
  let sealed: { enc: string; keyVersion: number }
  try { sealed = drive.store.seal(SEAL_CONTEXT, id, { verifier, nonce, ...(extra ? { extra } : {}) }) } catch { return fail('unavailable', msg('googleSignInOff', locale)) }
  ctx.db.transaction(() => {
    // a person's earlier connect still open goes: the binding cookie below replaces its cookie anyway
    if (who) ctx.db.query("DELETE FROM google_signin_flows WHERE user_id = ? AND status = 'pending'").run(who.userId)
    ctx.db.query('INSERT INTO google_signin_flows (id, state_hash, binding_hash, intent, user_id, session_id, config_key, next, secret_enc, key_version, created_at, expires_at, client, ip_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, hashToken(state), bindingHash, intent, who?.userId ?? null, who?.sessionId ?? null, key, next, sealed.enc, sealed.keyVersion, new Date(now).toISOString(), new Date(now + GOOGLE_FLOW_TTL_MS).toISOString(), bind.client, ipHash)
  })()
  // an app's flow sets no cookie: the system browser that comes back is not the app's window
  if (bind.client === 'web') c.header('Set-Cookie', bindingCookie(c.req.url, binding, GOOGLE_FLOW_TTL_MS / 1000), { append: true })
  return { url: googleUrl }
}

/** The key a sign-in flow's address counts under (google_signin_flows.ip_hash): HMAC-SHA-256 of the limiter's id for
 * the address (limitIp: an IPv6 /64 as one) with this server process's secret. Exported for the tests. */
export function flowIpHash(ctx: AppContext, ip: string): string {
  return createHmac('sha256', confirmSecret(ctx)).update(`google-flow-ip:${limitIp(ip)}`).digest('base64url')
}

/** A re-check asks Google to sign the person in again rather than take the browser's open Google session: `max_age=0`
 * (Google honours it though its guide does not list it; `prompt=login` it refuses) and the `auth_time` claim, which
 * Google sends where the client has it turned on. settle checks both answers (freshEnough). */
function freshSignIn(url: URL): void {
  url.searchParams.set('max_age', '0')
  url.searchParams.set('claims', JSON.stringify({ id_token: { auth_time: { essential: true } } }))
}

/** A re-check's id_token is new (`iat` within REAUTH_TOKEN_MAX_AGE_MS either way of now) and, when Google says when the
 * person last signed in (`auth_time`), that was within REAUTH_SIGN_IN_MAX_MS. Exported for the tests. */
export function freshEnough(g: GoogleClaims, now: number): boolean {
  if (typeof g.iat !== 'number' || Math.abs(now - g.iat * 1000) > REAUTH_TOKEN_MAX_AGE_MS) return false
  if (g.authTime !== undefined && (now - g.authTime * 1000 > REAUTH_SIGN_IN_MAX_MS || g.authTime * 1000 - now > REAUTH_TOKEN_MAX_AGE_MS)) return false
  return true
}

/** POST /api/auth/google/start: sign in with a connected Google account. A browser by default; the desktop or phone app
 * with the hash of the secret its sign-in page keeps (auth/google-login-apps.ts). */
export function startGoogleSignIn(c: Context<AppEnv>, ctx: AppContext, b: { next?: string; client?: 'web' | GoogleAppClient; appSecretHash?: string }): Promise<{ url: string }> {
  const client = b.client ?? 'web'
  if (client === 'web') {
    if (b.appSecretHash) fail('bad_request')
    return begin(c, ctx, 'signin', null, safeNextPath(b.next))
  }
  if (!b.appSecretHash) return fail('bad_request')
  return begin(c, ctx, 'signin', null, safeNextPath(b.next), { client, secretHash: b.appSecretHash })
}

/** POST /api/me/google/connect: connect my Google account, after my current password. Not for an account without a
 * password (409 no_password), not for guests, not from a
 * temporary-password session (the route is not allowWhilePasswordChange), and only from a browser's cookie session:
 * the flow is bound to this browser and this session. */
export async function startGoogleConnect(c: Context<AppEnv>, ctx: AppContext, body: { password?: string; reauthFlow?: string }): Promise<{ url: string }> {
  const auth = c.get('auth')!
  const locale = c.get('locale')
  if (auth.via !== 'cookie') fail('forbidden')
  if (isGuest(ctx.db, auth.user.id)) fail('forbidden', msg('googleGuest', locale))
  if (!googleLoginAvailable(ctx, c.req.url)) fail('unavailable', msg('googleSignInOff', locale))
  // an account without a password signs in only with its Google account: whoever holds that Google session (an
  // unlocked browser) must not swap it for one of theirs. An admin's temporary password is the way to another one
  // (docs/decisions/20261124-google-signin-security.md); connect() checks it again at Google's return
  if (hasNoPassword(ctx.db, auth.user.id)) fail('conflict', msg('googleReplaceAdmin', locale), { params: { reason: 'no_password' } })
  // the current password, like a password change (accounts.ts changePassword): someone who only holds an open session
  // (a borrowed laptop, a stolen cookie) must not add a way in that outlives it. Wrong tries count per person
  // (auth/reauth.ts)
  await requireReauth(c, ctx, body)
  return begin(c, ctx, 'connect', { userId: auth.user.id, sessionId: auth.session.id }, null)
}

/**
 * POST /api/me/google/reauth: a Google check instead of the password, for an account without one (auth/reauth.ts).
 * Only from a browser's cookie session (the window at Google comes back with this session's cookie), not for guests,
 * with a Google account connected, while the re-check limit is not locked. People with a password type it. Google's
 * address opens in a new window; the tab asks googleReauthStatus with the returned id.
 */
export async function startGoogleReauth(c: Context<AppEnv>, ctx: AppContext): Promise<{ url: string; flow: string }> {
  const auth = c.get('auth')!
  const locale = c.get('locale')
  if (auth.via !== 'cookie') fail('forbidden', msg('reauthInBrowser', locale))
  if (isGuest(ctx.db, auth.user.id)) fail('forbidden', msg('googleGuest', locale))
  if (!hasNoPassword(ctx.db, auth.user.id)) fail('conflict', msg('reauthUsePassword', locale), { params: { reason: 'has_password' } })
  if (!ctx.db.query("SELECT 1 FROM login_identities WHERE user_id = ? AND provider = 'google'").get(auth.user.id)) fail('conflict', msg('reauthNoGoogle', locale), { params: { reason: 'no_google' } })
  // the locked re-check has no way around it: the Google check waits like the password
  const wait = authOf(ctx).limiter.retryAfter([reauthKey(auth.user.id)])
  if (wait > 0) fail('rate_limited', undefined, { retryAfter: wait })
  const { url } = await begin(c, ctx, 'reauth', { userId: auth.user.id, sessionId: auth.session.id }, null)
  const row = ctx.db.query("SELECT id FROM google_signin_flows WHERE user_id = ? AND session_id = ? AND intent = 'reauth' AND status = 'pending' ORDER BY created_at DESC LIMIT 1").get(auth.user.id, auth.session.id) as { id: string }
  return { url, flow: row.id }
}

/** GET /api/me/google/reauth/:id: how the session's Google check stands (only that session; never cached). */
export function googleReauthStatus(c: Context<AppEnv>, ctx: AppContext, id: string): { state: 'waiting' | 'confirmed' | 'failed' } {
  const auth = c.get('auth')!
  c.header('Cache-Control', 'no-store')
  const state = reauthState(ctx.db, id, auth.user.id, auth.session.id, authOf(ctx).now())
  if (!state) return fail('not_found')
  return { state }
}

/** The Drive callback's state is one of ours (routes/drive.ts): a used one too, so a second return still lands here.
 * `c`: also a state that is no Drive flow either (made up, or swept away) from a browser that holds a sign-in binding
 * cookie or is not signed in here (a Drive connect always has its flow row, and a signed-in person's): a sign-in return
 * that went wrong, so it gets the sign-in page's words, not Drive's. */
export function ownsGoogleState(ctx: AppContext, state: string | undefined, c?: Context<AppEnv>): boolean {
  if (state && TOKEN_RE.test(state) && ctx.db.query('SELECT 1 FROM google_signin_flows WHERE state_hash = ?').get(hashToken(state))) return true
  return !!c && (!!readBinding(c) || !c.get('auth')) && !(state && ctx.db.query('SELECT 1 FROM drive_oauth_flows WHERE state_hash = ?').get(driveHash(state)))
}

/** Google's return (the Drive callback address): see finish. */
export function finishGoogle(c: Context<AppEnv>, ctx: AppContext): Promise<Response> {
  return finish(c, ctx, 'direct', c.req.query('code'))
}

/** GET GOOGLE_SIGNIN_TEAM_RETURN_PATH: the hosting service sends the browser back with a one-time handoff (or an error
 * of its own: consent_denied, provider_error). The same checks as a direct return, then the redeem and the full
 * id_token check. Google never sees this address. */
export function finishGoogleBroker(c: Context<AppEnv>, ctx: AppContext): Promise<Response> {
  return finish(c, ctx, 'broker', c.req.query('handoff'))
}

/** A browser's flow: sign in or connect, then a redirect to the page that says how it went; its binding cookie is spent
 * either way. An app's flow (auth/google-login-apps.ts): never signs this browser in; a one-time code for the app, or
 * why not, in a page (desktop) or a redirect to the app (phone). */
async function finish(c: Context<AppEnv>, ctx: AppContext, mode: 'direct' | 'broker', proof: string | undefined): Promise<Response> {
  const s = await settle(c, ctx, mode, c.req.query('state'), proof, c.req.query('error'))
  const client = s.row?.client ?? 'web'
  if (client !== 'web') return googleAppReturn(c, { client, ...('code' in s ? { code: s.code, who: s.who } : { result: 'result' in s ? s.result : 'failed' }) })
  c.header('Set-Cookie', bindingCookie(c.req.url, '', 0), { append: true })
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'no-referrer')
  // a re-check came back in the window the tab opened for it: a page there, the tab learns it by asking
  if (s.row?.intent === 'reauth') return reauthPage(c, 'result' in s ? s.result : 'failed')
  return c.redirect('next' in s ? s.next : backTo(s.row, 'result' in s ? s.result : 'failed'), 302)
}

function backTo(row: FlowRow | null, result: GoogleResult): string {
  if (row?.intent === 'connect') return `/settings/security?google=${result}`
  // a sign-up comes back to its own page, which keeps its token in this tab (never in an address or the flow):
  // /setup, /invite (the page finds the invite it started from) or /join
  if (row?.intent === 'setup' || row?.intent === 'join') return `${signUpPage(row.intent, row.next)}?google=${result}`
  return `/login?google=${result}${row?.next ? `&next=${encodeURIComponent(row.next)}` : ''}`
}

/** `proof`: Google's code (direct) or the console's handoff (broker). */
async function settle(c: Context<AppEnv>, ctx: AppContext, mode: 'direct' | 'broker', state: string | undefined, proof: string | undefined, error: string | undefined): Promise<Settled> {
  const a = authOf(ctx)
  // bad states and bindings count against the address like other made-up tokens (accounts.ts tokenGuard); over the
  // limit the browser, which comes from Google, still gets the sign-in page with words, never a bare 429
  const keys = tokenIpKeys(c.get('info').ip)
  if (a.limiter.retryAfter(keys) > 0) return { row: null, result: 'expired' }
  const guard = { fail: () => a.limiter.fail(keys) }
  const row = state && TOKEN_RE.test(state) ? ctx.db.query('SELECT * FROM google_signin_flows WHERE state_hash = ?').get(hashToken(state)) as FlowRow | null : null
  if (!row) { guard.fail(); return { row: null, result: 'expired' } }
  const end = (result: GoogleResult): Settled => ({ row, result })
  // only the browser that started it: checked before the state is spent, so someone who only saw the address cannot
  // use up another person's sign-in. An app's flow has no browser to bind: its code is for the app's secret alone
  if (row.client === 'web') {
    const binding = readBinding(c)
    if (!binding || !safeEqual(hashToken(binding), row.binding_hash)) { guard.fail(); return end('expired') }
  }
  // once: the first return takes it, a reload or a second request finds it used
  if (!ctx.db.query("UPDATE google_signin_flows SET status = 'used' WHERE id = ? AND status = 'pending' AND expires_at > ?").run(row.id, new Date(a.now()).toISOString()).changes) return end('expired')
  // Google's cancel (direct), or the console's word for it (broker)
  if (error) return end(error === 'access_denied' || error === 'consent_denied' ? 'cancelled' : 'failed')
  // turned off for the team meanwhile (Admin › Team settings): nobody new connects or joins any more; a sign-in goes on
  // only for an account without a password (signInWith), a re-check always (only such accounts make one)
  if (!googleSignInOn(ctx.db) && row.intent !== 'signin' && row.intent !== 'reauth') return end('failed')
  const drive = googleDriveOf(ctx)
  const cfg = drive.config
  // a flow comes back the way it went: a direct one through the Drive callback, a broker one through its return route
  const brokerClient = brokerClientOf(row.config_key)
  const broker = brokerClient ? googleSigninBrokerOf(ctx) : null
  if (!proof || (mode === 'broker' ? !broker || !TOKEN_RE.test(proof)
    // the client changed since the start (an admin replaced it): its code is for the other one
    : !cfg || brokerClient || configKey(cfg) !== row.config_key || proof.length > 4096)) return end('failed')
  let secret: { verifier: string; nonce: string; extra?: SignUpExtra }
  try { secret = drive.store.open({ id: row.id, user_id: SEAL_CONTEXT, secret_enc: row.secret_enc, key_version: row.key_version }) } catch { return end('failed') }
  ctx.db.query('UPDATE google_signin_flows SET secret_enc = NULL WHERE id = ?').run(row.id)
  let claims: GoogleClaims | null = null
  try {
    if (broker && brokerClient) {
      // the console exchanges Google's code only now and hands back Google's raw id_token: checked here in full,
      // Google's signature included, for the client id the start answered and this flow's nonce
      const idToken = await broker.redeem(proof, secret.verifier)
      claims = await verifyGoogleIdToken(broker.keys, idToken, { clientId: brokerClient, nonce: secret.nonce, now: a.now() })
    } else if (cfg) {
      const json = await drive.transport.json(GOOGLE_TOKEN, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: proof, redirect_uri: cfg.redirectUri, code_verifier: secret.verifier, client_id: cfg.clientId, client_secret: cfg.clientSecret }),
      }, 32_768)
      claims = googleClaims(json.id_token, cfg.clientId, secret.nonce, a.now())
    }
  } catch { claims = null }
  if (!claims) return end('failed')
  if (row.intent === 'reauth') return end(reauthWith(c, ctx, row, claims))
  if (row.intent === 'connect') return end(connect(c, ctx, row, claims))
  if (row.intent === 'setup' || row.intent === 'join') {
    // a sign-up (auth/google-signup.ts): the account made and signed in, refused, or this Google account already signs
    // someone in here, who signs in instead
    const s = await signUpReturn(c, ctx, row, claims, secret.extra)
    return 'existing' in s ? signInWith(c, ctx, row, claims) : { row, ...s }
  }
  return signInWith(c, ctx, row, claims)
}

/** The id_token's claims when it is Google's, for this client, live, for this flow (nonce) and its address verified;
 * else null. Exported for the tests. */
export function googleClaims(idToken: unknown, clientId: string, nonce: string, now: number): GoogleClaims | null {
  if (typeof idToken !== 'string' || idToken.length > 8192) return null
  const parts = idToken.split('.')
  if (parts.length !== 3) return null
  let p: Record<string, unknown>
  try { p = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) } catch { return null }
  if (!p || typeof p !== 'object') return null
  if (typeof p.iss !== 'string' || !GOOGLE_ISSUERS.has(p.iss)) return null
  const aud = Array.isArray(p.aud) ? p.aud : [p.aud]
  if (!aud.includes(clientId) || ((aud.length > 1 || p.azp !== undefined) && p.azp !== clientId)) return null
  if (typeof p.exp !== 'number' || p.exp * 1000 <= now) return null
  if (typeof p.nonce !== 'string' || !safeEqual(p.nonce, nonce)) return null
  if (p.email_verified !== true && p.email_verified !== 'true') return null
  if (typeof p.sub !== 'string' || !/^[\x21-\x7e]{1,255}$/.test(p.sub)) return null
  const name = clean(p.name, 200)
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : undefined
  const iat = num(p.iat), authTime = num(p.auth_time)
  return { sub: p.sub, email: clean(p.email, 320), hd: clean(p.hd, 255), ...(name ? { name } : {}), ...(iat !== undefined ? { iat } : {}), ...(authTime !== undefined ? { authTime } : {}) }
}

/** A sign-in Google answered: a browser's is signed in here; an app's gets a one-time code for the app's secret
 * (auth/google-login-apps.ts holdGoogleCode), redeemed in the app's own window. */
export function signInWith(c: Context<AppEnv>, ctx: AppContext, row: FlowRow, g: GoogleClaims): Settled {
  const a = authOf(ctx)
  const info = c.get('info')
  const linked = ctx.db.query("SELECT user_id FROM login_identities WHERE provider = 'google' AND subject = ?").get(g.sub) as { user_id: string } | null
  const u = linked ? getUser(ctx.db, linked.user_id) : null
  const detail = { ip: info.ip, via: viaOf(info), method: 'google', ...(row.client === 'web' ? {} : { client: row.client }) }
  // nobody here connected this Google account (the same answer whether or not it is anyone's elsewhere); turned off
  // (Google proved who it is, as the right password does: the truth, like a password sign-in of a switched-off
  // account); a temporary password set by an admin (the forced change needs a session made by that password)
  const no = googleSignInRefusal(u)
  if (no || !u) {
    audit(ctx.db, { actor: null, action: 'auth.login_failed', target: u?.id ?? null, detail: { ...detail, reason: no?.reason ?? 'google_not_connected' } })
    return { row, result: no?.result ?? 'not_connected' }
  }
  // the team switch is off: only an account without a password still signs in with Google (it has no other way)
  if (!googleSignInOn(ctx.db) && u.password_hash) {
    audit(ctx.db, { actor: null, action: 'auth.login_failed', target: u.id, detail: { ...detail, reason: 'google_off' } })
    return { row, result: 'failed' }
  }
  if (row.client !== 'web') {
    // the e-mail as Google says it now; last used is the app's redeem
    ctx.db.query("UPDATE login_identities SET email = ?, hd = ? WHERE user_id = ? AND provider = 'google'").run(g.email, g.hd, u.id)
    return { row, code: holdGoogleCode(ctx, { client: row.client, secretHash: row.binding_hash, subject: g.sub }), who: { name: u.name, username: u.username } }
  }
  ctx.db.query("UPDATE login_identities SET email = ?, hd = ?, last_used_at = ? WHERE user_id = ? AND provider = 'google'").run(g.email, g.hd, new Date(a.now()).toISOString(), u.id)
  audit(ctx.db, { actor: u.id, action: 'auth.login', target: u.id, detail: { ...detail, client: 'web' } })
  a.signIn(c, u.id, 'web', 'cookie')
  // `next` of a sign-up is the page it started from (google-signup.ts), never where a sign-in goes
  return { row, next: (row.intent === 'signin' ? row.next : null) ?? '/' }
}

function connect(c: Context<AppEnv>, ctx: AppContext, row: FlowRow, g: GoogleClaims): GoogleResult {
  const auth = c.get('auth')
  // the browser that comes back must still be the session that started it: signed out, someone else signed in here
  // meanwhile, or another browser: refused
  if (!auth || auth.session.id !== row.session_id || auth.user.id !== row.user_id) return 'expired'
  const u = getUser(ctx.db, auth.user.id)
  if (!u || u.deleted_at || u.status !== 'active' || u.role === 'guest' || u.must_change_password) return 'expired'
  const now = new Date(authOf(ctx).now()).toISOString()
  const done = ctx.db.transaction(() => {
    const taken = ctx.db.query("SELECT user_id FROM login_identities WHERE provider = 'google' AND subject = ?").get(g.sub) as { user_id: string } | null
    // one Google account signs one person in: someone else here connected it first
    if (taken && taken.user_id !== u.id) return false
    if (taken) {
      ctx.db.query("UPDATE login_identities SET email = ?, hd = ? WHERE user_id = ? AND provider = 'google'").run(g.email, g.hd, u.id)
      return 'same'
    }
    // without a password (read in this write) the Google account is the only way in: never replaced here, whatever the
    // start allowed (startGoogleConnect)
    if (hasNoPassword(ctx.db, u.id)) {
      audit(ctx.db, { actor: u.id, action: 'auth.google_connect_refused', target: u.id, detail: { reason: 'no_password' } })
      return 'refused'
    }
    // another Google account of mine is replaced
    const replaced = forgetLoginIdentities(ctx.db, u.id) > 0
    ctx.db.query("INSERT INTO login_identities (user_id, provider, subject, email, hd, linked_at) VALUES (?, 'google', ?, ?, ?, ?)").run(u.id, g.sub, g.email, g.hd, now)
    // the Google address is not in the log: who and that it was Google
    audit(ctx.db, { actor: u.id, action: 'auth.google_connected', target: u.id, ...(replaced ? { detail: { replaced: true } } : {}) })
    return replaced ? 'replaced' : 'new'
  }).immediate()
  if (done === 'refused') return 'failed'
  // a new way in: the person's Inbox says so (if someone else did it with their password, they learn of it; part A2),
  // and the owners and admins learn of it too
  if (done === 'new' || done === 'replaced') {
    notifyGoogleConnected(ctx, u.id, now)
    notifySignInChange(ctx, u.id, u.id, done === 'new' ? 'signin_google_connected' : 'signin_google_replaced')
  }
  return done ? 'connected' : 'in_use'
}

/**
 * A re-check Google answered (intent 'reauth'; auth/reauth.ts). The browser that comes back must still be the session
 * that started it, the account still without a password, and Google must have answered for the very Google account
 * connected to it. Then the flow is 'confirmed' for REAUTH_CONFIRMED_MS, for the request that needed it to spend once.
 * Another Google account counts on the person's re-check limit like a wrong password, and is audited (never which
 * account it was).
 */
function reauthWith(c: Context<AppEnv>, ctx: AppContext, row: FlowRow, g: GoogleClaims): GoogleResult {
  const a = authOf(ctx)
  const auth = c.get('auth')
  if (!auth || auth.session.id !== row.session_id || auth.user.id !== row.user_id) return 'expired'
  const u = getUser(ctx.db, auth.user.id)
  if (!u || u.deleted_at || u.status !== 'active' || u.role === 'guest' || u.must_change_password || u.password_hash) return 'failed'
  const key = reauthKey(u.id)
  const linked = ctx.db.query("SELECT subject FROM login_identities WHERE user_id = ? AND provider = 'google'").get(u.id) as { subject: string } | null
  if (!linked || !safeEqual(linked.subject, g.sub)) {
    a.limiter.fail([key])
    audit(ctx.db, { actor: u.id, action: 'auth.reauth_failed', target: u.id, detail: { method: 'google', reason: 'wrong_account' } })
    if (a.onReauthLocked && a.limiter.retryAfter([key]) > 0) try { a.onReauthLocked(u.id) } catch { /* the listener's own problem */ }
    return 'wrong_account'
  }
  // locked meanwhile (wrong tries elsewhere): nothing to spend until the window ends
  if (a.limiter.retryAfter([key]) > 0) return 'failed'
  // only a sign-in at Google now: an old id_token, or Google saying the person last typed their Google password long
  // ago (the browser's open Google session), proves nothing about who sits at this browser
  if (!freshEnough(g, a.now())) {
    audit(ctx.db, { actor: u.id, action: 'auth.reauth_failed', target: u.id, detail: { method: 'google', reason: 'not_fresh' } })
    return 'failed'
  }
  const now = a.now()
  const at = new Date(now).toISOString()
  ctx.db.query("UPDATE google_signin_flows SET status = 'confirmed', confirmed_at = ?, subject = ?, expires_at = ? WHERE id = ? AND status = 'used'")
    .run(at, g.sub, new Date(now + REAUTH_CONFIRMED_MS).toISOString(), row.id)
  ctx.db.query("UPDATE login_identities SET email = ?, hd = ?, last_used_at = ? WHERE user_id = ? AND provider = 'google'").run(g.email, g.hd, at, u.id)
  return 'confirmed'
}

/** The window at Google after a re-check: says how it went in words; a confirmed one closes itself (the tab that opened
 * it goes on by itself), a refused one stays open so the person reads why. */
function reauthPage(c: Context<AppEnv>, result: GoogleResult): Response {
  const L = c.get('locale')
  returnHeaders(c)
  const ok = result === 'confirmed'
  const text = ok ? 'reauthDone' : result === 'wrong_account' ? 'reauthWrongAccount' : result === 'cancelled' ? 'reauthCancelled' : 'reauthNotDone'
  return c.html(returnPage(L, { title: msg(ok ? 'reauthDoneTitle' : 'reauthNotTitle', L), text: msg(text, L), tail: ok ? CLOSE_SCRIPT : '' }), ok ? 200 : 400)
}

/** GET /api/me/google */
export function myGoogle(c: Context<AppEnv>, ctx: AppContext, userId: string): MyGoogle {
  const r = ctx.db.query("SELECT email, linked_at, last_used_at FROM login_identities WHERE user_id = ? AND provider = 'google'").get(userId) as { email: string | null; linked_at: string; last_used_at: string | null } | null
  return {
    available: googleLoginAvailable(ctx, c.req.url) && !isGuest(ctx.db, userId),
    account: r ? { email: r.email, connectedAt: r.linked_at, lastUsedAt: r.last_used_at } : null,
  }
}

/** DELETE /api/me/google. Refused (409) while the account has no password: Google is then its only way in (Set a
 * password first, Settings › Security & devices). Read inside the write, so a password removed meanwhile cannot slip by.
 * The person's other sessions end (one made with that Google account must not outlive it, like a password change), this
 * one stays; the owners and admins are told. */
export function disconnectGoogle(c: Context<AppEnv>, ctx: AppContext, userId: string): void {
  const gone = ctx.db.transaction(() => {
    if (hasNoPassword(ctx.db, userId)) fail('conflict', msg('googlePasswordFirst', c.get('locale')), { params: { reason: 'no_password' } })
    if (!forgetLoginIdentities(ctx.db, userId)) return false
    audit(ctx.db, { actor: userId, action: 'auth.google_disconnected', target: userId })
    return true
  }).immediate()
  if (!gone) return
  authOf(ctx).endUserSessions(userId, 'revoked', c.get('auth')?.session.id)
  notifySignInChange(ctx, userId, userId, 'signin_google_disconnected')
}
