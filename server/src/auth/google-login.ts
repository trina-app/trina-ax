// Sign in with Google (docs/AGENTS/plan/20261122-0454-google-login.md, part A1). A person connects their Google account
// in Settings › Security with their current password, then signs in with it. An account is found by Google's `sub`
// only, never by e-mail (docs/decisions/20261122-google-login-identity.md).
//
// The Google client is this server's own (googleDriveOf(ctx).config: a company's own Google app, the in-app setup or
// MYCEL_GOOGLE_DRIVE_CLIENT_FILE), and Google returns to the address that client already registered, the Drive
// callback (routes/drive.ts asks ownsGoogleState first), so nothing new is registered at Google
// (docs/decisions/20261122-google-login-client.md). Only `openid email profile`, no offline access, and nothing from
// Google is kept but the identity row. The id_token comes from Google's token answer over TLS, asked with the client
// secret, so its signature is not checked (Google's OpenID Connect guide allows it on that channel); iss, aud, azp,
// exp, nonce and email_verified are.
//
// A flow is bound to the browser that started it: a short HttpOnly cookie whose hash the flow keeps. Nobody finishes a
// sign-in someone else started, or sends a person back signed in as the starter's Google account (login CSRF). A
// connect is also bound to the session that started it. A state works once.
import crypto from 'node:crypto'
import type { Context } from 'hono'
import type { MyGoogle } from '@mycel/shared/api'
import { isFreeRoam } from '../app-config'
import type { AppContext } from '../context'
import { newId } from '../db'
import { audit } from '../admin/audit'
import type { AppEnv } from '../http/env'
import { fail } from '../http/errors'
import { GOOGLE_AUTH, GOOGLE_TOKEN } from '../integrations/google-drive/client'
import { configKey, type DriveConfig } from '../integrations/google-drive/config'
import { googleDriveOf } from '../integrations/google-drive/oauth'
import { tokenGuard, viaOf } from './accounts'
import { isGuest } from './guests'
import { forgetLoginIdentities } from './login-identities'
import { msg } from './messages'
import { hashToken, safeEqual } from './passwords'
import { googleStartKeys } from './rate-limit'
import { authOf } from './service'
import { getUser } from './users'

export const GOOGLE_FLOW_TTL_MS = 10 * 60_000
/** open flows at once, for the whole server: a flood of starts from many addresses stops here, not at the disk */
export const GOOGLE_OPEN_FLOWS_MAX = 500
/** the sealed verifier and nonce: the Drive store's vault, in a context of their own (no person yet at sign-in) */
const SEAL_CONTEXT = 'google-login'
const SCOPES = 'openid email profile'
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com'])

/** How a Google return ended, for the page it goes back to (?google=<result>): the sign-in page or Settings › Security
 * says it in words. A sign-in that worked opens `next` instead. */
export type GoogleResult = 'connected' | 'not_connected' | 'account_off' | 'password_first' | 'in_use' | 'cancelled' | 'expired' | 'failed'

interface FlowRow {
  id: string; binding_hash: string; intent: 'signin' | 'connect'; user_id: string | null; session_id: string | null
  config_key: string; next: string | null; secret_enc: string | null; key_version: number; status: 'pending' | 'used'; expires_at: string
}
interface GoogleClaims { sub: string; email: string | null; hd: string | null }

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

/** This page can use Sign in with Google: this server has a Google client of its own, Google returns to the address
 * this page was opened at (people on an office, Tailscale or LAN address sign in with the password there: the binding
 * cookie lives on one address), and it is not a demo. */
export function googleLoginAvailable(ctx: AppContext, reqUrl: string): boolean {
  if (ctx.config.demo || isFreeRoam(ctx.config)) return false
  const cfg = googleDriveOf(ctx).config
  if (!cfg) return false
  try { return new URL(cfg.redirectUri).origin === new URL(reqUrl).origin } catch { return false }
}

/** The flow row, the binding cookie and Google's address. Each start counts against the caller's address, connect too. */
function begin(c: Context<AppEnv>, ctx: AppContext, intent: FlowRow['intent'], who: { userId: string; sessionId: string } | null, next: string | null): { url: string } {
  const a = authOf(ctx)
  const locale = c.get('locale')
  const hold = a.limiter.hold(googleStartKeys(c.get('info').ip))
  if (hold.wait > 0) fail('rate_limited', msg('tooManyAttempts', locale), { retryAfter: hold.wait })
  if (!googleLoginAvailable(ctx, c.req.url)) fail('unavailable', msg('googleSignInOff', locale))
  const drive = googleDriveOf(ctx)
  const cfg = drive.config as DriveConfig
  const now = a.now()
  ctx.db.query('DELETE FROM google_signin_flows WHERE expires_at <= ?').run(new Date(now).toISOString())
  if ((ctx.db.query('SELECT COUNT(*) AS n FROM google_signin_flows').get() as { n: number }).n >= GOOGLE_OPEN_FLOWS_MAX) fail('rate_limited', msg('tooManyAttempts', locale), { retryAfter: 60 })
  const id = newId(), state = random(), binding = random(), nonce = random(), verifier = crypto.randomBytes(48).toString('base64url')
  let sealed: { enc: string; keyVersion: number }
  try { sealed = drive.store.seal(SEAL_CONTEXT, id, { verifier, nonce }) } catch { return fail('unavailable', msg('googleSignInOff', locale)) }
  ctx.db.transaction(() => {
    // a person's earlier connect still open goes: the binding cookie below replaces its cookie anyway
    if (who) ctx.db.query("DELETE FROM google_signin_flows WHERE user_id = ? AND status = 'pending'").run(who.userId)
    ctx.db.query('INSERT INTO google_signin_flows (id, state_hash, binding_hash, intent, user_id, session_id, config_key, next, secret_enc, key_version, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, hashToken(state), hashToken(binding), intent, who?.userId ?? null, who?.sessionId ?? null, configKey(cfg), next, sealed.enc, sealed.keyVersion, new Date(now).toISOString(), new Date(now + GOOGLE_FLOW_TTL_MS).toISOString())
  })()
  c.header('Set-Cookie', bindingCookie(c.req.url, binding, GOOGLE_FLOW_TTL_MS / 1000), { append: true })
  const url = new URL(GOOGLE_AUTH)
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  for (const [k, v] of Object.entries({ client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: 'code', scope: SCOPES, state, nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account' })) url.searchParams.set(k, v)
  return { url: url.href }
}

/** POST /api/auth/google/start: sign in with a connected Google account. */
export function startGoogleSignIn(c: Context<AppEnv>, ctx: AppContext, next: string | undefined): { url: string } {
  return begin(c, ctx, 'signin', null, safeNextPath(next))
}

/** POST /api/me/google/connect: connect my Google account, after my current password. Not for guests, not from a
 * temporary-password session (the route is not allowWhilePasswordChange), and only from a browser's cookie session:
 * the flow is bound to this browser and this session. */
export async function startGoogleConnect(c: Context<AppEnv>, ctx: AppContext, password: string): Promise<{ url: string }> {
  const auth = c.get('auth')!
  const locale = c.get('locale')
  if (auth.via !== 'cookie') fail('forbidden')
  if (isGuest(ctx.db, auth.user.id)) fail('forbidden', msg('googleGuest', locale))
  if (!googleLoginAvailable(ctx, c.req.url)) fail('unavailable', msg('googleSignInOff', locale))
  // the current password, like a password change (accounts.ts changePassword): someone who only holds an open session
  // (a borrowed laptop, a stolen cookie) must not add a way in that outlives it. Wrong tries count per person
  if (!(await authOf(ctx).verifyPassword(auth.user.id, password, c.get('info')))) fail('forbidden', msg('wrongPassword', locale), { fields: { 'body.password': 'wrong password' } })
  return begin(c, ctx, 'connect', { userId: auth.user.id, sessionId: auth.session.id }, null)
}

/** The Drive callback's state is one of ours (routes/drive.ts): a used one too, so a second return still lands here. */
export function ownsGoogleState(ctx: AppContext, state: string | undefined): boolean {
  return !!state && TOKEN_RE.test(state) && !!ctx.db.query('SELECT 1 FROM google_signin_flows WHERE state_hash = ?').get(hashToken(state))
}

/** Google's return (the Drive callback address): sign in or connect, then a redirect to the page that says how it went.
 * The binding cookie is spent either way. */
export async function finishGoogle(c: Context<AppEnv>, ctx: AppContext): Promise<Response> {
  const to = await settle(c, ctx, c.req.query('state'), c.req.query('code'), c.req.query('error'))
  c.header('Set-Cookie', bindingCookie(c.req.url, '', 0), { append: true })
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'no-referrer')
  return c.redirect(to, 302)
}

function backTo(row: FlowRow | null, result: GoogleResult): string {
  if (row?.intent === 'connect') return `/settings/security?google=${result}`
  return `/login?google=${result}${row?.next ? `&next=${encodeURIComponent(row.next)}` : ''}`
}

async function settle(c: Context<AppEnv>, ctx: AppContext, state: string | undefined, code: string | undefined, error: string | undefined): Promise<string> {
  const a = authOf(ctx)
  const guard = tokenGuard(ctx, c.get('info').ip)
  const row = state && TOKEN_RE.test(state) ? ctx.db.query('SELECT * FROM google_signin_flows WHERE state_hash = ?').get(hashToken(state)) as FlowRow | null : null
  if (!row) { guard.fail(); return backTo(null, 'expired') }
  // only the browser that started it: checked before the state is spent, so someone who only saw the address cannot
  // use up another person's sign-in
  const binding = readBinding(c)
  if (!binding || !safeEqual(hashToken(binding), row.binding_hash)) { guard.fail(); return backTo(row, 'expired') }
  // once: the first return takes it, a reload or a second request finds it used
  if (!ctx.db.query("UPDATE google_signin_flows SET status = 'used' WHERE id = ? AND status = 'pending' AND expires_at > ?").run(row.id, new Date(a.now()).toISOString()).changes) return backTo(row, 'expired')
  if (error) return backTo(row, error === 'access_denied' ? 'cancelled' : 'failed')
  const drive = googleDriveOf(ctx)
  const cfg = drive.config
  // the client changed since the start (an admin replaced it): its code is for the other one
  if (!cfg || configKey(cfg) !== row.config_key || !code || code.length > 4096) return backTo(row, 'failed')
  let secret: { verifier: string; nonce: string }
  try { secret = drive.store.open({ id: row.id, user_id: SEAL_CONTEXT, secret_enc: row.secret_enc, key_version: row.key_version }) } catch { return backTo(row, 'failed') }
  ctx.db.query('UPDATE google_signin_flows SET secret_enc = NULL WHERE id = ?').run(row.id)
  let claims: GoogleClaims | null = null
  try {
    const json = await drive.transport.json(GOOGLE_TOKEN, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: cfg.redirectUri, code_verifier: secret.verifier, client_id: cfg.clientId, client_secret: cfg.clientSecret }),
    }, 32_768)
    claims = googleClaims(json.id_token, cfg.clientId, secret.nonce, a.now())
  } catch { claims = null }
  if (!claims) return backTo(row, 'failed')
  return row.intent === 'connect' ? backTo(row, connect(c, ctx, row, claims)) : signInWith(c, ctx, row, claims)
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
  return { sub: p.sub, email: clean(p.email, 320), hd: clean(p.hd, 255) }
}

function signInWith(c: Context<AppEnv>, ctx: AppContext, row: FlowRow, g: GoogleClaims): string {
  const a = authOf(ctx)
  const info = c.get('info')
  const linked = ctx.db.query("SELECT user_id FROM login_identities WHERE provider = 'google' AND subject = ?").get(g.sub) as { user_id: string } | null
  const u = linked ? getUser(ctx.db, linked.user_id) : null
  const detail = { ip: info.ip, via: viaOf(info), method: 'google' }
  const no = (result: GoogleResult, reason: string) => {
    audit(ctx.db, { actor: null, action: 'auth.login_failed', target: u?.id ?? null, detail: { ...detail, reason } })
    return backTo(row, result)
  }
  // nobody here connected this Google account: the same answer whether or not it is anyone's elsewhere
  if (!u || u.deleted_at || u.role === 'guest') return no('not_connected', 'google_not_connected')
  // Google proved who it is, as the right password does: the truth, like a password sign-in of a switched-off account
  if (u.status !== 'active') return no('account_off', 'disabled')
  // a temporary password set by an admin: the forced change needs a session made by that password (accounts.ts)
  if (u.must_change_password) return no('password_first', 'temporary_password')
  ctx.db.query("UPDATE login_identities SET email = ?, hd = ?, last_used_at = ? WHERE user_id = ? AND provider = 'google'").run(g.email, g.hd, new Date(a.now()).toISOString(), u.id)
  audit(ctx.db, { actor: u.id, action: 'auth.login', target: u.id, detail: { ...detail, client: 'web' } })
  a.signIn(c, u.id, 'web', 'cookie')
  return row.next ?? '/'
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
      return true
    }
    // another Google account of mine is replaced
    forgetLoginIdentities(ctx.db, u.id)
    ctx.db.query("INSERT INTO login_identities (user_id, provider, subject, email, hd, linked_at) VALUES (?, 'google', ?, ?, ?, ?)").run(u.id, g.sub, g.email, g.hd, now)
    // the Google address is not in the log: who and that it was Google
    audit(ctx.db, { actor: u.id, action: 'auth.google_connected', target: u.id })
    return true
  }).immediate()
  return done ? 'connected' : 'in_use'
}

/** GET /api/me/google */
export function myGoogle(c: Context<AppEnv>, ctx: AppContext, userId: string): MyGoogle {
  const r = ctx.db.query("SELECT email, linked_at, last_used_at FROM login_identities WHERE user_id = ? AND provider = 'google'").get(userId) as { email: string | null; linked_at: string; last_used_at: string | null } | null
  return {
    available: googleLoginAvailable(ctx, c.req.url) && !isGuest(ctx.db, userId),
    account: r ? { email: r.email, connectedAt: r.linked_at, lastUsedAt: r.last_used_at } : null,
  }
}

/** DELETE /api/me/google */
export function disconnectGoogle(ctx: AppContext, userId: string): void {
  if (forgetLoginIdentities(ctx.db, userId)) audit(ctx.db, { actor: userId, action: 'auth.google_disconnected', target: userId })
}
