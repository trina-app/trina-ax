// Sign in with Google from the desktop and phone apps (docs/AGENTS/plan/20261122-0620-google-login-apps.md,
// docs/decisions/20261122-google-login-apps.md). Google refuses to sign in inside the apps' own windows, so the Google
// step runs in the system browser, which has none of the app's cookies. The flow is therefore bound to a secret the
// app's sign-in page keeps (RFC 8252's idea, shaped like PKCE): the start gets only its SHA-256, and Google's return
// (auth/google-login.ts settle, the same checks minus the browser binding) never signs the browser in. It makes a
// one-time code for the app:
//
// - 32 random bytes, only its SHA-256 kept (google_signin_codes, migration 133_a), GOOGLE_APP_CODE_MS (5 minutes), one
//   use, the Google account's `sub`, the client kind and the secret's hash. A newer code for the same Google account
//   voids the older one.
// - desktop: a page that names the Trina account and opens `<scheme>://open?url=<team>/login/google#code=<code>` by
//   itself and by a button; phone: a redirect to `<scheme>://google-signin#code=<code>`, the address its auth session
//   waits for. The code is only ever in a fragment (no server, proxy or log sees it).
// - POST /api/auth/google/redeem: the code with the secret, from the app's own window, so the session cookie lands in
//   the app. A wrong secret or another client kind spends the code; an app signed in as someone else is refused (409)
//   and the code stays (app-signin.ts's rule: a code never replaces another person's sign-in); the account is looked up
//   again by its Google `sub` (disconnected, turned off, deleted, a guest or a forced password change since: nobody).
//   Bad codes count per client IP like other tokens (tokenGuard). Never a code, a secret or an address in logs or audit.
import type { Context } from 'hono'
import type { z } from 'zod'
import { GOOGLE_APP_RETURN_PATH, googlePhoneReturn, type LoginResponse, type RedeemGoogleSignInBody } from '@mycel/shared/api'
import { PRODUCT } from '@mycel/shared'
import type { AppContext } from '../context'
import { newId } from '../db'
import { audit } from '../admin/audit'
import type { AppEnv } from '../http/env'
import { fail } from '../http/errors'
import { backToApp, returnHeaders, returnPage } from '../integrations/connections/return-page'
import { say } from '../integrations/connections/text'
import { tokenGuard, viaOf } from './accounts'
import { msg, type MessageKey } from './messages'
import { hashToken, newToken, safeEqual } from './passwords'
import { authOf } from './service'
import { getUser, type UserRow } from './users'

/** how long an app's one-time code works */
export const GOOGLE_APP_CODE_MS = 5 * 60_000
const TOKEN = /^[A-Za-z0-9_-]{43}$/
export type GoogleAppClient = 'desktop' | 'mobile'
/** the refusals a Google sign-in can end with before or at the redeem (google-login.ts GoogleResult) */
export type GoogleRefusal = 'not_connected' | 'account_off' | 'password_first'

/** Why this account may not sign in with Google now, or null: nobody (not connected, deleted, a guest), turned off, or a
 * temporary password set by an admin (its forced change needs a session made with that password). */
export function googleSignInRefusal(u: UserRow | null): { result: GoogleRefusal; reason: string } | null {
  if (!u || u.deleted_at || u.role === 'guest') return { result: 'not_connected', reason: 'google_not_connected' }
  if (u.status !== 'active') return { result: 'account_off', reason: 'disabled' }
  if (u.must_change_password) return { result: 'password_first', reason: 'temporary_password' }
  return null
}

const iso = (ms: number) => new Date(ms).toISOString()

/** A one-time code for the app that started the flow: Google proved the account `sub` (google-login.ts settle). */
export function holdGoogleCode(ctx: AppContext, o: { client: GoogleAppClient; secretHash: string; subject: string }): string {
  const code = newToken()
  const now = authOf(ctx).now()
  ctx.db.transaction(() => {
    // one live code per Google account: the button pressed again voids the earlier return's code
    ctx.db.query('DELETE FROM google_signin_codes WHERE subject = ? AND used_at IS NULL').run(o.subject)
    ctx.db.query('INSERT INTO google_signin_codes (id, code_hash, subject, client, secret_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(newId(), hashToken(code), o.subject, o.client, o.secretHash, iso(now), iso(now + GOOGLE_APP_CODE_MS))
  }).immediate()
  return code
}

/** Rows the sweeper removes: spent codes and codes past their time (auth/sweeper.ts). */
export function sweepGoogleCodes(ctx: AppContext, now: number): number {
  return ctx.db.query('DELETE FROM google_signin_codes WHERE used_at IS NOT NULL OR expires_at <= ?').run(iso(now)).changes
}

/** The desktop app's link for the code: the team page that redeems it, the code only in the fragment. */
export function googleAppLink(origin: string, code: string): string {
  return `${PRODUCT.linkScheme}://open?${new URLSearchParams({ url: origin + GOOGLE_APP_RETURN_PATH })}#code=${code}`
}

const RESULT_TEXT: Record<string, MessageKey> = {
  not_connected: 'googleAppNotConnected', account_off: 'googleAppAccountOff', password_first: 'googleAppPasswordFirst',
  cancelled: 'googleAppCancelled', expired: 'googleAppExpired', failed: 'googleAppFailed', wrong_domain: 'googleAppWrongDomain',
}
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)

/**
 * What the system browser gets back for an app's flow. Phone: a redirect to the address its auth session waits for
 * (the session closes and the app reads the fragment). Desktop: a page; with a code, it names the Trina account,
 * opens the app's link by itself (meta refresh) and by its button, and says to open it only in one's own app; without,
 * it says why in words and offers "Back to the app" (no code).
 */
export function googleAppReturn(c: Context<AppEnv>, o: { client: GoogleAppClient; code?: string; who?: { name: string; username: string }; result?: string }): Response {
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'no-referrer')
  if (o.client === 'mobile') {
    const back = googlePhoneReturn(PRODUCT.linkScheme)
    return c.redirect(o.code ? `${back}#code=${o.code}` : `${back}#error=${RESULT_TEXT[o.result ?? ''] ? o.result : 'failed'}`, 302)
  }
  const L = c.get('locale')
  const origin = new URL(c.req.url).origin
  const P = { product: PRODUCT.displayName }
  returnHeaders(c)
  if (!o.code) {
    return c.html(returnPage(L, { title: msg('googleAppNotTitle', L), text: msg(RESULT_TEXT[o.result ?? ''] ?? 'googleAppFailed', L), cta: backToApp(L, origin) }), 400)
  }
  const link = googleAppLink(origin, o.code)
  const who = o.who ? msg('googleAppWho', L).replace('{name}', o.who.name).replace('{username}', o.who.username) : ''
  return c.html(returnPage(L, {
    head: `<meta http-equiv="refresh" content="0;url=${esc(link)}">`,
    title: msg('googleAppTitle', L).replace('{product}', PRODUCT.displayName),
    text: msg('googleAppHeld', L),
    extra: who ? `<ul class="facts" data-testid="google-app-who"><li>${esc(who)}</li></ul>` : '',
    cta: { href: link, label: say('callbackBackToApp', L), testid: 'google-app-back' },
    tail: `<p class="note" data-testid="google-app-own">${esc(say('callbackHeldOwnApp', L, P))}</p>`,
  }), 200)
}

/** POST /api/auth/google/redeem: the app spends its code with its secret and is signed in (cookie). */
export function redeemGoogleApp(c: Context<AppEnv>, ctx: AppContext, b: z.output<typeof RedeemGoogleSignInBody>): LoginResponse {
  const a = authOf(ctx)
  const locale = c.get('locale')
  const info = c.get('info')
  const guard = tokenGuard(ctx, info.ip)
  const gone = (): never => {
    guard.fail()
    return fail('gone', msg('googleAppCodeGone', locale))
  }
  if (!TOKEN.test(b.code) || !TOKEN.test(b.appSecret)) gone()
  // cookie only: who is signed in is then read from the same cookie AuthService.signIn replaces (app-signin.ts)
  if (c.req.header('authorization')) fail('bad_request')
  const current = c.get('auth')
  const userId = ctx.db.transaction(() => {
    const now = iso(a.now())
    const row = ctx.db.query('SELECT id, subject, client, secret_hash FROM google_signin_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?')
      .get(hashToken(b.code), now) as { id: string; subject: string; client: GoogleAppClient; secret_hash: string } | null
    if (!row) return null
    // only the app that started it, as the kind of app it started as: anything else that holds the code spends it
    if (!safeEqual(hashToken(b.appSecret), row.secret_hash) || row.client !== b.client) {
      ctx.db.query('UPDATE google_signin_codes SET used_at = ? WHERE id = ?').run(now, row.id)
      return null
    }
    // the account as it is now, by its Google account (disconnected meanwhile: nobody)
    const linked = ctx.db.query("SELECT user_id FROM login_identities WHERE provider = 'google' AND subject = ?").get(row.subject) as { user_id: string } | null
    const u = linked ? getUser(ctx.db, linked.user_id) : null
    // an app signed in here as someone else: a code never replaces that sign-in, and stays for after a sign-out
    if (current && u && current.user.id !== u.id) fail('conflict', msg('googleAppOtherPerson', locale), { params: { reason: 'signed_in_as_other' } })
    // spent here or not at all: two redeems at once cannot both pass, nor one after its time
    if (!ctx.db.query('UPDATE google_signin_codes SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?').run(now, row.id, now).changes) return null
    const detail = { ip: info.ip, via: viaOf(info), method: 'google', client: b.client }
    const no = googleSignInRefusal(u)
    if (no || !u) {
      audit(ctx.db, { actor: null, action: 'auth.login_failed', target: u?.id ?? null, detail: { ...detail, reason: no?.reason ?? 'google_not_connected' } })
      return null
    }
    ctx.db.query("UPDATE login_identities SET last_used_at = ? WHERE user_id = ? AND provider = 'google'").run(now, u.id)
    audit(ctx.db, { actor: u.id, action: 'auth.login', target: u.id, detail })
    return u.id
  }).immediate()
  if (!userId) return gone()
  return a.signIn(c, userId, b.client, 'cookie')
}
