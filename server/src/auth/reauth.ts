// Re-checks (docs/decisions/20261122-google-reauth.md): every place that asks a signed-in person to prove it is them
// again, the owner-reauth and admin-reauth endpoints (http/route.ts) and the direct checks (an admin removing a member,
// one's own deletion request, the voice key, the office update, setting a first password), takes
// the password as before or, for an account WITHOUT a password (made with Google), `reauthFlow`: the id of a Google
// check this session finished in the last 5 minutes (auth/google-login.ts intent 'reauth'). Exactly one of them.
// People with a password keep typing it: the Google check is only the way of those who have none.
//
// What a Google check proves: the person signed in to their connected Google account at Google just now. The flow asks
// Google for a new sign-in (`max_age=0`, the `auth_time` claim) and the return needs an id_token issued in the last
// minute and, when Google sends `auth_time`, a sign-in of the last 5 minutes (google-login.ts freshEnough;
// docs/decisions/20261124-google-signin-security.md), so a Google session left open in an unlocked browser is not
// enough where Google honours it.
//
// The check: Google's return marks the flow row 'confirmed' with `confirmed_at` and the Google account's `sub`
// (migration 131). The request spends it once, atomically, for the person and the session that started it, within
// REAUTH_CONFIRMED_MS of the return; then the same Google account must still be the one connected, the account active,
// without a password and without a forced password change. A spent, late, unknown or other session's flow counts as a
// wrong try on the person's re-check limit, as a wrong password does, and a locked limit refuses both kinds
// (AuthService.verifyReauth, onReauthLocked: the locked re-check has no way around it). Nothing here logs or audits a
// password, a code or a Google answer.
//
// Loads nothing heavy: http/route.ts imports it.
import type { Database } from 'bun:sqlite'
import type { Context } from 'hono'
import type { AppContext } from '../context'
import type { AppEnv } from '../http/env'
import { fail } from '../http/errors'
import { msg } from './messages'

/** a confirmed Google check is good for this long after Google's return */
export const REAUTH_CONFIRMED_MS = 5 * 60_000
const FLOW_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** What a re-check got: the password, or the id of a Google check. */
export type ReauthProof = { password: string; reauthFlow?: undefined } | { reauthFlow: string; password?: undefined }

/** The proof a body carries: a password or a Google check's flow id, exactly one. 'none' for neither, 'both' for both. */
export function proofOf(body: unknown, field = 'password'): ReauthProof | 'none' | 'both' {
  const b = (body ?? {}) as Record<string, unknown>
  const pw = typeof b[field] === 'string' ? b[field] as string : undefined
  const flow = typeof b.reauthFlow === 'string' ? b.reauthFlow : undefined
  if (pw !== undefined && flow !== undefined) return 'both'
  if (pw !== undefined) return { password: pw }
  if (flow !== undefined) return { reauthFlow: flow }
  return 'none'
}

/**
 * The re-check of a signed-in request: the body's password or reauthFlow for the caller's own account and session.
 * Refused with 403 and the field that was wrong (the web dialogs show it and stay open); both at once is a 400. Neither
 * answers as the endpoint did when the password was missing, without counting: a 400 where the field was required, a
 * 403 like a wrong password where it was optional (`missing: 'forbidden'`: an admin removing a member, the office update).
 */
export async function requireReauth(c: Context<AppEnv>, ctx: AppContext, body: unknown, o: { missing?: 'validation' | 'forbidden' } = {}): Promise<void> {
  const auth = c.get('auth')
  if (!auth) return fail('unauthorized')
  const locale = c.get('locale')
  const p = proofOf(body)
  if (p === 'both') return fail('validation', undefined, { fields: { 'body.reauthFlow': 'send the password or the Google check, not both' } })
  if (p === 'none') {
    if (o.missing === 'forbidden') return fail('forbidden', msg('wrongPassword', locale), { fields: { 'body.password': 'wrong password' } })
    return fail('validation', undefined, { fields: { 'body.password': 'required' } })
  }
  if (await ctx.services.sessions.verifyReauth(auth.user.id, auth.session.id, p, c.get('info'))) return
  if (p.reauthFlow !== undefined) fail('forbidden', msg('reauthGoogleAgain', locale), { fields: { 'body.reauthFlow': 'not confirmed' } })
  // in words: the bare 'forbidden' text ("you do not have permission") sent owners looking for a missing right
  fail('forbidden', msg('wrongPassword', locale), { fields: { 'body.password': 'wrong password' } })
}

/**
 * Spend a confirmed Google check: true once, for this person and this session, within REAUTH_CONFIRMED_MS of Google's
 * return, while the Google account it confirmed is still the one connected and the account is active, without a
 * password and without a forced change. Anything else is false (the caller counts it as a wrong try).
 */
export function spendReauthFlow(db: Database, flowId: string, userId: string, sessionId: string, now: number): boolean {
  if (!FLOW_ID_RE.test(flowId)) return false
  const since = new Date(now - REAUTH_CONFIRMED_MS).toISOString()
  return db.transaction(() => {
    const row = db.query("SELECT subject FROM google_signin_flows WHERE id = ? AND intent = 'reauth' AND user_id = ? AND session_id = ? AND status = 'confirmed' AND confirmed_at > ?")
      .get(flowId, userId, sessionId, since) as { subject: string | null } | null
    if (!row?.subject) return false
    // once: spent here whatever the checks below say
    if (!db.query("UPDATE google_signin_flows SET status = 'used' WHERE id = ? AND status = 'confirmed'").run(flowId).changes) return false
    const still = db.query("SELECT 1 FROM login_identities WHERE user_id = ? AND provider = 'google' AND subject = ?").get(userId, row.subject)
    const u = db.query('SELECT 1 FROM users WHERE id = ? AND status = \'active\' AND deleted_at IS NULL AND guest = 0 AND password_hash IS NULL AND must_change_password = 0').get(userId)
    return !!still && !!u
  }).immediate()
}

/** What the tab that started a Google check learns when it asks: still at Google, confirmed (send the flow id with the
 * request now), or over without a confirmation (the window at Google said why). Only that session asks: anyone else
 * gets null (a 404). */
export function reauthState(db: Database, flowId: string, userId: string, sessionId: string, now: number): 'waiting' | 'confirmed' | 'failed' | null {
  if (!FLOW_ID_RE.test(flowId)) return null
  const f = db.query("SELECT status, expires_at, confirmed_at FROM google_signin_flows WHERE id = ? AND intent = 'reauth' AND user_id = ? AND session_id = ?")
    .get(flowId, userId, sessionId) as { status: string; expires_at: string; confirmed_at: string | null } | null
  if (!f) return null
  const at = new Date(now).toISOString()
  if (f.status === 'pending') return f.expires_at > at ? 'waiting' : 'failed'
  if (f.status === 'confirmed') return f.confirmed_at && f.confirmed_at > new Date(now - REAUTH_CONFIRMED_MS).toISOString() ? 'confirmed' : 'failed'
  return 'failed'
}

/** The account has no password (it was made with Google): the Google check is its re-check. */
export function hasNoPassword(db: Database, userId: string): boolean {
  return !!db.query('SELECT 1 FROM users WHERE id = ? AND password_hash IS NULL').get(userId)
}
