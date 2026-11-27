// Sign in with Google, the team's side (docs/AGENTS/plan/20261122-0616-google-login-admin.md, part A2): the team switch
// (TeamSettings.googleSignIn, Admin › Team settings) and whether this server has a Google client for it. Admin › Members'
// label and the connectors' login_hint read login-identities.ts, which loads nothing.
import type { Database } from 'bun:sqlite'
import { GoogleDomain, type GoogleSignInAdminStatus, type Locale } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { getSetting } from '../admin/settings'
import { fail } from '../http/errors'
import { googleDriveOf } from '../integrations/google-drive/oauth'
import { publicHostOf } from '../system/deployment'
import { googleSigninBrokerOf } from './google-login-broker'
import { passwordlessCount } from './login-identities'
import { msg } from './messages'

/** the team setting (TeamSettings.googleSignIn): on unless an owner or admin turned it off */
export const GOOGLE_SIGN_IN_SETTING = 'googleSignIn'

/** The team lets people sign in with Google (Admin › Team settings). Off: no connect and no joining with Google, and a
 * return on its way does not connect; the connected accounts stay. It never locks anyone out: people without a password
 * (accounts made with Google) still sign in and re-check with Google (google-login.ts signInAnyway, reauth). Read for
 * every sign-in page, so one setting row, not all of them. */
export const googleSignInOn = (db: Database): boolean => getSetting<unknown>(db, GOOGLE_SIGN_IN_SETTING) !== false

/** Which Google client Sign in with Google uses here, whatever the team switch says: 'direct', this server's own (the
 * one Google Drive uses); 'broker', the hosting service's, on a hosted server without an own client while the service
 * serves it; null when neither. An operator's own client file that does not load: null, no fallback to the hosting
 * service (as for Drive). google-login.ts googleClientMode reads this too. */
export function googleClientKind(ctx: AppContext): 'direct' | 'broker' | null {
  const drive = googleDriveOf(ctx)
  if (drive.config) return 'direct'
  if (drive.clientFromEnv) return null
  const broker = googleSigninBrokerOf(ctx)
  return broker && publicHostOf(ctx.config) && broker.serves() ? 'broker' : null
}

/** This server has a Google client Sign in with Google can use: its own, or the hosting service's (googleClientKind). */
export const googleSignInClient = (ctx: AppContext): boolean => googleClientKind(ctx) !== null

/** The server's own Google client would go while people without a password sign in only with it. */
export class GoogleClientInUse extends Error {
  constructor(readonly count: number) { super('google_client_in_use') }
}

/** Before the server's own Google client is removed (`next` null) or replaced by another client id: throws
 * GoogleClientInUse while active people without a password sign in with it (docs/decisions/20261122-google-reauth.md),
 * unless the hosting service serves this server's Google sign-in (it takes over). The same client id with a new secret
 * is fine: Google answers for the same accounts. */
export function guardOwnGoogleClient(ctx: AppContext, next: string | null): void {
  const cur = googleDriveOf(ctx).config
  if (!cur || (next !== null && next === cur.clientId)) return
  const n = passwordlessCount(ctx.db)
  if (!n) return
  const broker = googleSigninBrokerOf(ctx)
  if (broker && publicHostOf(ctx.config) && broker.serves()) return
  throw new GoogleClientInUse(n)
}

/** Run a change of the Google client; a GoogleClientInUse becomes 409 with the count, in the person's words. */
export async function refuseClientInUse<T>(locale: Locale, fn: () => T | Promise<T>): Promise<T> {
  try { return await fn() } catch (e) {
    if (e instanceof GoogleClientInUse) fail('conflict', msg('googleClientNeeded', locale).replace('{n}', String(e.count)), { params: { reason: 'passwordless_accounts', count: e.count } })
    throw e
  }
}

/** The team's domain list (TeamSettings.googleSignInDomains): empty, every Google account. */
export function googleSignInDomains(db: Database): string[] {
  const v = getSetting<unknown>(db, GOOGLE_SIGN_IN_DOMAINS_SETTING)
  // only the entries that are domains: one bad stored entry (validation keeps them out) never opens the list to all
  return Array.isArray(v) ? v.filter((d): d is string => GoogleDomain.safeParse(d).success) : []
}

/** People who sign in only with Google (no password) whose Google account's `hd`, as of their last sign-in, is not on
 * `domains`: they could not sign in any more once it is saved (Admin › Sign-in methods warns first). Empty: 0. */
export function googleDomainLockouts(db: Database, domains: readonly string[]): number {
  if (!domains.length) return 0
  const rows = db.query("SELECT l.hd FROM users u JOIN login_identities l ON l.user_id = u.id AND l.provider = 'google' WHERE u.password_hash IS NULL AND u.status = 'active' AND u.deleted_at IS NULL AND u.guest = 0").all() as { hd: string | null }[]
  return rows.filter((r) => !r.hd || !domains.includes(r.hd.toLowerCase())).length
}
export const GOOGLE_SIGN_IN_DOMAINS_SETTING = 'googleSignInDomains'

/** The Google account may sign in here under the domain list: no list, or Google's `hd` claim (the Workspace domain
 * Google vouches for) is on it. Never the e-mail address: a personal Google account can carry bob@acme.com, verified,
 * with no `hd` (docs/decisions/20261127-google-signin-selfhost.md). */
export function googleDomainAllowed(db: Database, hd: string | null): boolean {
  const list = googleSignInDomains(db)
  return !list.length || (!!hd && list.includes(hd.toLowerCase()))
}

/** No Google client here only because the hosting service's sign-in service cannot be asked now (it served or may serve
 * this server): the sign-in page keeps the button for people without a password, and a click says so
 * (google-login.ts). */
export function googleBrokerUnreachable(ctx: AppContext): boolean {
  const drive = googleDriveOf(ctx)
  if (drive.config || drive.clientFromEnv || !publicHostOf(ctx.config)) return false
  const broker = googleSigninBrokerOf(ctx)
  return !!broker && !broker.serves() && broker.unreachable()
}

/** GET /api/admin/google-login: what Admin › Sign-in methods says about Google. Never the client. `tryable`: this
 * page's address can run "Try it" (google-login.ts googleTryAvailable, filled in by the route). */
export function googleSignInAdminStatus(ctx: AppContext, tryable = false): GoogleSignInAdminStatus {
  const kind = googleClientKind(ctx)
  if (kind) return { client: true, via: kind === 'direct' ? 'own' : 'service', tryable }
  const broker = googleDriveOf(ctx).clientFromEnv ? null : googleSigninBrokerOf(ctx)
  const reason = !publicHostOf(ctx.config) ? 'no_address' : !broker ? 'none' : broker.unreachable() ? 'unreachable' : 'not_served'
  return { client: false, reason, tryable: false }
}
