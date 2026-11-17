// One-time codes that sign the desktop app in as the person who pressed "Continue in the Mac app" (or Windows) in their
// browser right after making the team (web /open-app; docs/decisions/20261116-desktop-first-onboarding.md). The browser
// opens `<scheme>://open?url=https://<team>/app-signin#c=<code>`; the app asks first (screen ④), then its /app-signin
// page spends the code here and gets a normal session through AuthService.signIn. No second password, no other way in.
//
// A code is a sign-in, so:
// - 32 random bytes (newToken, 43 characters); only its SHA-256 is stored (app_signin_codes, migration 128_a);
// - it lives APP_SIGNIN_TTL_MS (3 minutes) and is spent once, by one atomic UPDATE that also checks the time;
// - it belongs to the browser sign-in that made it (session_id, ON DELETE CASCADE): signed out there, signed out from
//   another device or expired, the code goes with it;
// - it never replaces another person's sign-in: an app (or a browser) that sends a live session of someone else is
//   refused and the code is left unspent (login CSRF: a member's code sent to the owner's signed-in app must not turn
//   that app into the member's);
// - the session it makes is a desktop one (RedeemAppSignInBody.client);
// - one live code per person: a new one, a password change or reset, a disabled or deleted account, and signing out of
//   the browser void the ones before (voidAppSignInCodes, called from AuthService.endUserSessions and the logout route);
// - it is made only by a cookie session (the browser), never by an app's bearer token, and counted per person
//   (RateLimiter 'app-code'); spending is POST only and counts failures per client IP (tokenGuard), like invite links;
// - it travels only in the URL fragment (never sent to a server or written to a proxy log) and is never logged here:
//   the audit rows carry the person and the IP, not the code.
import type { Context } from 'hono'
import type { Database } from 'bun:sqlite'
import type { z } from 'zod'
import type { AppSignInCode, LoginResponse, RedeemAppSignInBody } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { newId } from '../db'
import type { AppEnv } from '../http/env'
import { fail } from '../http/errors'
import { audit } from '../admin/audit'
import { msg } from './messages'
import { hashToken, newToken } from './passwords'
import { appCodeKey } from './rate-limit'
import { authOf } from './service'
import { tokenGuard, viaOf } from './accounts'
import { getUser } from './users'

export const APP_SIGNIN_TTL_MS = 3 * 60_000
/** newToken's shape: 32 bytes in base64url */
export const APP_SIGNIN_CODE = /^[A-Za-z0-9_-]{43}$/

/** Every code of this person that was not spent yet stops working (deleted: nothing about it is kept). */
export function voidAppSignInCodes(db: Database, userId: string): number {
  return db.query('DELETE FROM app_signin_codes WHERE user_id = ? AND used_at IS NULL').run(userId).changes
}

/** Rows the sweeper removes: spent codes, and codes past their time (auth/sweeper.ts). */
export function sweepAppSignInCodes(db: Database, now: number): number {
  return db.query('DELETE FROM app_signin_codes WHERE used_at IS NOT NULL OR expires_at <= ?').run(new Date(now).toISOString()).changes
}

/** POST /api/auth/app-signin: a new code for the signed-in person; the ones before stop working. */
export function mintAppSignIn(c: Context<AppEnv>, ctx: AppContext): AppSignInCode {
  const a = authOf(ctx)
  const auth = c.get('auth')!
  // the browser's own session only: an app's or a script's bearer token is not the person at this browser
  if (auth.via !== 'cookie') fail('forbidden')
  const hold = a.limiter.hold([appCodeKey(auth.user.id)])
  if (hold.wait > 0) fail('rate_limited', undefined, { retryAfter: hold.wait })
  const code = newToken()
  const now = a.now()
  const expiresAt = new Date(now + APP_SIGNIN_TTL_MS).toISOString()
  ctx.db.transaction(() => {
    // one live code per person: the button pressed again makes the earlier code useless
    voidAppSignInCodes(ctx.db, auth.user.id)
    ctx.db.query('INSERT INTO app_signin_codes (id, user_id, session_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(newId(), auth.user.id, auth.session.id, hashToken(code), new Date(now).toISOString(), expiresAt)
    audit(ctx.db, { actor: auth.user.id, action: 'auth.app_signin_code', target: auth.user.id, detail: { ip: c.get('info').ip, expiresAt } })
  }).immediate()
  return { code, expiresAt }
}

/** POST /api/auth/app-signin/redeem: spend a code and sign in (cookie). Expired, used or unknown: 410 gone. */
export function redeemAppSignIn(c: Context<AppEnv>, ctx: AppContext, b: z.output<typeof RedeemAppSignInBody>): LoginResponse {
  const a = authOf(ctx)
  const locale = c.get('locale')
  const info = c.get('info')
  const guard = tokenGuard(ctx, info.ip)
  const gone = (): never => {
    guard.fail()
    return fail('gone', msg('appSignInGone', locale))
  }
  if (!APP_SIGNIN_CODE.test(b.code)) gone()
  // cookie only: who is signed in is then read from the same cookie that AuthService.signIn replaces (a bearer header
  // would be read first, and an unknown one would hide another person's live cookie from the check below)
  if (c.req.header('authorization')) fail('bad_request')
  // whoever this app (or browser) is signed in as now, if anyone: a code never replaces another person's sign-in
  const current = c.get('auth')
  const userId = ctx.db.transaction(() => {
    const now = new Date(a.now()).toISOString()
    // unspent, in its time, and the browser sign-in that made it still there
    const found = ctx.db.query(`SELECT c.id, c.user_id FROM app_signin_codes c JOIN sessions s ON s.id = c.session_id
      WHERE c.token_hash = ? AND c.used_at IS NULL AND c.expires_at > ? AND s.expires_at > ?`).get(hashToken(b.code), now, now) as { id: string; user_id: string } | null
    if (!found) return null
    if (current && current.user.id !== found.user_id) fail('conflict', msg('appSignInOtherPerson', locale), { params: { reason: 'signed_in_as_other' } })
    // spent here or not at all: two redeems at once cannot both pass (used_at IS NULL), nor one after its time
    const row = ctx.db.query('UPDATE app_signin_codes SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ? RETURNING user_id')
      .get(now, found.id, now) as { user_id: string } | null
    if (!row) return null
    // the account as it is now: switched off or deleted since the code was made signs nobody in
    const u = getUser(ctx.db, row.user_id)
    if (!u || u.status !== 'active' || u.deleted_at) return null
    audit(ctx.db, { actor: u.id, action: 'auth.app_signin', target: u.id, detail: { ip: info.ip, via: viaOf(info), client: b.client } })
    return u.id
  }).immediate()
  if (!userId) return gone()
  return a.signIn(c, userId, b.client, 'cookie')
}
