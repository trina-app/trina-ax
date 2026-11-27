// Sign in with Google, the team's side (docs/AGENTS/plan/20261122-0616-google-login-admin.md, part A2): the team switch
// (TeamSettings.googleSignIn, Admin › Team settings) and whether this server has a Google client for it. Admin › Members'
// label and the connectors' login_hint read login-identities.ts, which loads nothing.
import type { Database } from 'bun:sqlite'
import type { GoogleSignInAdminStatus, Locale } from '@mycel/shared/api'
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

/** GET /api/admin/google-login: whether Admin › Team settings shows the switch. Never the client. */
export function googleSignInAdminStatus(ctx: AppContext): GoogleSignInAdminStatus {
  return { client: googleSignInClient(ctx) }
}
