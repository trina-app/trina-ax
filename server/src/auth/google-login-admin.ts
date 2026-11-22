// Sign in with Google, the team's side (docs/AGENTS/plan/20261122-0616-google-login-admin.md, part A2): the team switch
// (TeamSettings.googleSignIn, Admin › Team settings) and whether this server has a Google client for it. Admin › Members'
// label and the connectors' login_hint read login-identities.ts, which loads nothing.
import type { Database } from 'bun:sqlite'
import type { GoogleSignInAdminStatus } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { getSetting } from '../admin/settings'
import { googleDriveOf } from '../integrations/google-drive/oauth'

/** the team setting (TeamSettings.googleSignIn): on unless an owner or admin turned it off */
export const GOOGLE_SIGN_IN_SETTING = 'googleSignIn'

/** The team lets people sign in with Google (Admin › Team settings). Off: no button, no connect, no start, and a return
 * on its way neither signs in nor connects (google-login.ts); the connected accounts stay. Read for every sign-in page,
 * so one setting row, not all of them. */
export const googleSignInOn = (db: Database): boolean => getSetting<unknown>(db, GOOGLE_SIGN_IN_SETTING) !== false

/** This server has a Google client Sign in with Google can use: its own (googleLoginAvailable in google-login.ts reads
 * the same). Part B adds the hosting service's here. */
export const googleSignInClient = (ctx: AppContext): boolean => !!googleDriveOf(ctx).config

/** GET /api/admin/google-login: whether Admin › Team settings shows the switch. Never the client. */
export function googleSignInAdminStatus(ctx: AppContext): GoogleSignInAdminStatus {
  return { client: googleSignInClient(ctx) }
}
