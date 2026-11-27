// Route module "auth" — owner: component A (docs/WORKPLAN.md).
// Implements: AUTH (setup, login, logout, password, me, sessions, invite info/accept, password reset links, the desktop
// app's one-time sign-in codes) and
// ACCOUNT_DELETION (a person's request to have their account deleted: routes/account-deletion.ts)
// Contract: shared/src/api/auth.ts, shared/src/api/account-deletion.ts
import { API } from '@mycel/shared/api'
import { LOCALE_CHANGED, WEB_ACCESS_CHANGED } from '../admin/settings'
import { WEB_ALLOW_ALL_WARNING_VERSION } from '@mycel/shared'
import { setWebAllowAll, teamAllowsWebAll, webAllowAll } from '../tools/web-allow-all'
import { audit } from '../admin/audit'
import { profileChangedFor } from '../auth/profiles'
import { forgetUserName } from '../chat/runtime'
import { fail } from '../http/errors'
import { acceptInvite, changePassword, completeReset, inviteInfo, login, resetInfo, setPassword, setup, setupStatusFor } from '../auth/accounts'
import { authOf, installAuth } from '../auth/service'
import { mintAppSignIn, redeemAppSignIn, voidAppSignInCodes } from '../auth/app-signin'
import { consoleSetup, previewConsoleSetup } from '../auth/setup-console'
import { disconnectGoogle, finishGoogleBroker, googleAppLoginAvailable, googleReauthStatus, googleSignInPageAvailable, myGoogle, startGoogleConnect, startGoogleReauth, startGoogleSignIn } from '../auth/google-login'
import { redeemGoogleApp } from '../auth/google-login-apps'
import { startGoogleInvite, startGoogleSetup, withInviteGoogle, withSetupGoogle } from '../auth/google-signup'
import { googleSigninBrokerOf } from '../auth/google-login-broker'
import { GOOGLE_SIGNIN_TEAM_RETURN_PATH } from '@mycel/shared/cloud-protocol'
import type { Context } from 'hono'
import type { AppEnv } from '../http/env'
import { startSweeper } from '../auth/sweeper'
import { registerAccountsCleanup } from '../auth/account-removal'
import { getUser, setUserLocale } from '../auth/users'
import { emailUsedByOther, isGuest } from '../auth/guests'
import { msg } from '../auth/messages'
import type { RouteModule } from './module'
import { reachedAt } from '../system/connection'
import { canChooseEngine, filterEnginePrefs } from '../admin/engine-choice'
import { myUsage } from '../admin/my-usage'
import { registerAccountDeletionRoutes } from './account-deletion'

/** a guest's e-mail changes (an address, not clearing it) per hour, in this process: enough for typos, too few to probe */
export const GUEST_EMAIL_TRIES = 10
const guestEmailTries = new Map<string, number[]>()
function guestEmailTry(userId: string, now: number): boolean {
  const recent = (guestEmailTries.get(userId) ?? []).filter((t) => t > now - 3600_000)
  if (recent.length >= GUEST_EMAIL_TRIES) { guestEmailTries.set(userId, recent); return false }
  recent.push(now)
  guestEmailTries.set(userId, recent)
  return true
}

export const authRoutes: RouteModule = {
  name: 'auth',
  owner: 'A',
  init(ctx) {
    installAuth(ctx)
    registerAccountsCleanup(ctx)
    startSweeper(ctx)
  },
  register(kit, ctx) {
    const a = () => authOf(ctx)

    // the internet is not told whether the team is set up yet (attack review finding 2; round 4: no team name either):
    // the office internet address never offers the first-run setup (it is refused there anyway, accounts.ts setup),
    // the relay only to a visitor with the setup token (accounts.ts setupStatusFor). The default language still
    // changes when the owner picks another one at setup: accepted, it is the sign-in page's language
    // (docs/DECISIONS.md "보안 4차").
    kit.handle(API.setupStatus, ({ c }) => {
      const s = setupStatusFor(c, ctx)
      // Sign in with Google (auth/google-login.ts): only on a team that is set up, in a browser at the address Google
      // returns to; in the desktop and phone apps at any address (auth/google-login-apps.ts). Before setup, Start with
      // Google (auth/google-signup.ts) only to a visitor told that setup is needed, in a browser at that address
      if (s.needed) return withSetupGoogle(c, ctx, s)
      if (!googleAppLoginAvailable(ctx)) return s
      return { ...s, googleAppSignIn: true as const, ...(googleSignInPageAvailable(ctx, c.req.url) ? { googleSignIn: true as const } : {}) }
    })
    kit.handle(API.setup, ({ c, body }) => setup(c, ctx, body))
    // a hosted team made from the desktop app: the owner from the hosting console's one-time claim (auth/setup-console.ts)
    kit.handle(API.setupConsolePreview, ({ c, body }) => previewConsoleSetup(c, ctx, body))
    kit.handle(API.setupConsole, ({ c, body }) => consoleSetup(c, ctx, body))
    // Sign up with Google (auth/google-signup.ts): the setup token checked as POST /api/setup does, then Google
    kit.handle(API.startGoogleSetup, ({ c, body }) => startGoogleSetup(c, ctx, body))
    kit.handle(API.login, ({ c, body }) => login(c, ctx, body))

    kit.handle(API.logout, ({ c, auth }) => {
      a().revokeSession(auth.session.id, 'logout')
      // a desktop sign-in code made in this browser goes with the sign-out (auth/app-signin.ts)
      voidAppSignInCodes(ctx.db, auth.user.id)
      if (auth.via === 'cookie') a().clearCookie(c)
      // a shared computer: the browser forgets what it kept of this person (room pictures of this sign-in, the bodies
      // of private answers it stored to check again), so nothing of it is left for the next person (auth/media-key.ts)
      c.header('Clear-Site-Data', '"cache"')
    })

    // "Continue in the Mac app" (web /open-app): a one-time code for the desktop app, and its redeem there
    kit.handle(API.appSignIn, ({ c }) => mintAppSignIn(c, ctx))
    kit.handle(API.redeemAppSignIn, ({ c, body }) => redeemAppSignIn(c, ctx, body))

    // Sign in with Google (auth/google-login.ts): connect in Settings › Security with the current password, then sign in
    // with it. Google's return comes to the Drive callback address (routes/drive.ts)
    kit.handle(API.startGoogleSignIn, ({ c, body }) => startGoogleSignIn(c, ctx, body))
    // the desktop and phone apps: Google's return gave the app a one-time code, spent here with the app's secret
    kit.handle(API.redeemGoogleSignIn, ({ c, body }) => redeemGoogleApp(c, ctx, body))
    kit.handle(API.myGoogle, ({ c, auth }) => myGoogle(c, ctx, auth.user.id))
    kit.handle(API.connectGoogle, ({ c, body }) => startGoogleConnect(c, ctx, body))
    kit.handle(API.disconnectGoogle, ({ c, auth }) => disconnectGoogle(c, ctx, auth.user.id))
    // a re-check without a password (auth/reauth.ts): Google in a new window, the tab asks how it went, then sends its
    // request with the check's id; and a first password for an account made with Google, after such a check
    kit.handle(API.startGoogleReauth, ({ c }) => startGoogleReauth(c, ctx))
    kit.handle(API.googleReauthState, ({ c, params }) => googleReauthStatus(c, ctx, params.id))
    kit.handle(API.setPassword, async ({ c, body }) => {
      await setPassword(c, ctx, body)
      return { ok: true as const }
    })
    // Sign in with Google through the hosting service (hosted teams, and self-installed servers with a public address,
    // without a Google client of their own; auth/google-login-broker.ts): the console sends the browser back here with
    // a one-time handoff. Asked once at start whether the console serves this server, so the sign-in page knows soon (a
    // self-installed server with its own Google client asks nothing and registers nothing)
    kit.raw('GET', GOOGLE_SIGNIN_TEAM_RETURN_PATH, (c) => finishGoogleBroker(c as unknown as Context<AppEnv>, ctx))
    googleSigninBrokerOf(ctx)

    kit.handle(API.changePassword, async ({ c, body }) => {
      await changePassword(c, ctx, body)
      return { ok: true as const }
    })

    kit.handle(API.me, ({ c, auth }) => a().me(auth.user.id, auth.session.id, reachedAt(c)))

    // my "Allow all websites" for the AI's web reads (tools/web-allow-all.ts, docs/DECISIONS.md "Allow all websites
    // covers the AI's web reads"): on only with the risk sentence the person was shown and while the team allows it;
    // off always. Not while a password change is pending (the contract leaves allowWhilePasswordChange out).
    kit.handle(API.setMyWebAccess, ({ auth, body }) => {
      const before = webAllowAll(ctx.db, auth.user.id)
      if (body.on) {
        if (!teamAllowsWebAll(ctx.db)) fail('conflict', 'Your team does not let members allow all websites for the AI\'s web reads.', { params: { reason: 'web_allow_all_off' } })
        if (body.acceptWarning !== WEB_ALLOW_ALL_WARNING_VERSION) fail('conflict', 'Accept the current warning first.', { params: { reason: 'web_allow_all_warning', warningVersion: WEB_ALLOW_ALL_WARNING_VERSION } })
      }
      const allowAll = setWebAllowAll(ctx.db, auth.user.id, body.on, { via: 'settings' })
      if (body.on && !allowAll) fail('conflict', 'Your team does not let members allow all websites for the AI\'s web reads.', { params: { reason: 'web_allow_all_off' } })
      if (allowAll !== before) ctx.services.realtime.publish(auth.user.id, WEB_ACCESS_CHANGED)
      return { allowAll }
    })

    kit.handle(API.updateMe, ({ c, auth, body }) => {
      const u = getUser(ctx.db, auth.user.id)
      if (!u) fail('unauthorized')
      const sets: string[] = []
      const args: (string | null)[] = []
      if (body.name !== undefined) { sets.push('name = ?'); args.push(body.name) }
      if (body.email !== undefined) {
        // a guest may not take an address another account here gives (members may share one, as before). At most
        // GUEST_EMAIL_TRIES addresses an hour, whatever the answer, so it cannot be used to find who is in the team
        if (body.email !== null && isGuest(ctx.db, auth.user.id)) {
          if (!guestEmailTry(auth.user.id, Date.now())) fail('rate_limited', undefined, { params: { reason: 'email_tries' } })
          if (emailUsedByOther(ctx.db, auth.user.id, body.email)) fail('conflict', msg('emailInUse', c.get('locale')), { params: { reason: 'email_in_use' }, fields: { 'body.email': 'email_in_use' } })
        }
        sets.push('email = ?'); args.push(body.email)
      }
      if (body.prefs !== undefined) {
        // merge: a PATCH carrying only { theme } keeps the other preferences
        let cur: Record<string, unknown> = {}
        try { cur = JSON.parse(u!.prefs || '{}') } catch {}
        // own default engine / model: only for people who may pick (others' requests keep their theme etc.); null = back
        // to the team default
        const next: Record<string, unknown> = { ...cur, ...filterEnginePrefs(ctx, auth.user, body.prefs) }
        if (!canChooseEngine(ctx, auth.user)) { delete next.engine; delete next.model; delete next.effort }
        for (const [k, v] of Object.entries(next)) if (v === undefined || v === null) delete next[k]
        sets.push('prefs = ?'); args.push(JSON.stringify(next))
      }
      const renamed = body.name !== undefined && body.name !== u!.name
      ctx.db.transaction(() => {
        if (sets.length) ctx.db.query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args, auth.user.id)
        // null = follow the team default again
        if (body.locale !== undefined) setUserLocale(ctx.db, auth.user.id, body.locale)
      })()
      if (renamed) {
        forgetUserName(ctx, auth.user.id)
        audit(ctx.db, { actor: auth.user.id, action: 'profile.update', target: auth.user.id, detail: { fields: ['name'], name: { from: u!.name, to: body.name } } })
        ctx.services.realtime.publishEach(profileChangedFor(ctx.db, auth.user.id))
      }
      // the person's other windows and devices switch too
      if (body.locale !== undefined) ctx.services.realtime.publish(auth.user.id, LOCALE_CHANGED)
      return a().me(auth.user.id, auth.session.id, reachedAt(c))
    })

    // only the caller's own turns: the person comes from the session, never from the request
    kit.handle(API.myUsage, ({ auth, query }) => myUsage(ctx.db, auth.user.id, query.period))
    kit.handle(API.mySessions, ({ auth }) => ({
      items: a().listSessions(auth.user.id).map((s) => ({
        id: s.id, client: s.client, userAgent: s.user_agent, createdAt: s.created_at, lastSeenAt: s.last_seen_at, expiresAt: s.expires_at,
        current: s.id === auth.session.id,
      })),
    }))

    kit.handle(API.revokeMySession, ({ c, params, auth }) => {
      const row = ctx.db.query('SELECT id FROM sessions WHERE id = ? AND user_id = ? AND connector = 0').get(params.id, auth.user.id)
      if (!row) fail('not_found')
      a().revokeSession(params.id, 'revoked')
      if (params.id === auth.session.id && auth.via === 'cookie') a().clearCookie(c)
    })

    kit.handle(API.inviteInfo, ({ c, params }) => withInviteGoogle(c, ctx, inviteInfo(c, ctx, params.token)))
    kit.handle(API.acceptInvite, ({ c, params, body }) => acceptInvite(c, ctx, params.token, body))
    // Join with Google (auth/google-signup.ts): the token in the body, checked as an accept checks it, then Google
    kit.handle(API.startGoogleInvite, ({ c, body }) => startGoogleInvite(c, ctx, body))
    kit.handle(API.passwordResetInfo, ({ c, params }) => resetInfo(c, ctx, params.token))
    kit.handle(API.completePasswordReset, ({ c, params, body }) => completeReset(c, ctx, params.token, body))
    registerAccountDeletionRoutes(kit, ctx)
  },
}
