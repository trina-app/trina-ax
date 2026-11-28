import { API, type ClientKind, type Locale } from '@mycel/shared/api'
import { APP_RETURN_PROOF_HEADER } from '@mycel/shared/desktop-bridge'
import { msg } from '../auth/messages'
import { refuseClientInUse } from '../auth/google-login-admin'
import type { AppContext } from '../context'
import type { RouteKit } from '../http/route'
import { HttpError } from '../http/errors'
import type { AppContextC } from '../http/env'
import { GOOGLE_RETURN_CSP, drivePreGooglePage, googleReturnOf, googleReturnPage, type CallbackOutcome } from '../integrations/google-drive/callback-page'
import { GO_PATH } from '../integrations/google-drive/app-return'
import { CALLBACK_PATH } from '../integrations/google-drive/config'
import { GOOGLE_BROKER_KEY_PATH } from '@mycel/shared/cloud-protocol'
import { googleDriveOf } from '../integrations/google-drive/oauth'
import { driveAdminStatus, setDriveClient } from '../integrations/google-drive/admin-setup'
import { listShares, setMembersCanConnect, shareFolders, stopShare, updateShare } from '../integrations/google-drive/share-admin'
import { shareView } from '../integrations/google-drive/shares'
import { DriveError } from '../integrations/google-drive/store'
import { afterServiceSetup } from '../integrations/service-requests'
import { googleAppsOf, GoogleAppError } from '../integrations/google-apps/service'
import { slackOf } from '../integrations/slack/service'
import { integrationsOf } from '../integrations/connections/service'
import { finishGoogle, ownsGoogleState } from '../auth/google-login'
import { googleSigninBrokerOf } from '../auth/google-login-broker'
import type { Context } from 'hono'
import type { AppEnv } from '../http/env'

async function safe<T>(fn: () => T | Promise<T>, locale?: Locale): Promise<T> {
  try { return await fn() } catch (e) {
    if (e instanceof HttpError) throw e
    // the claim's refusals say it in words, not as the code (QA: "drive_invalid_code" on screen)
    if (e instanceof DriveError && locale && (e.reason === 'invalid_code' || e.reason === 'expired')) throw new HttpError('bad_request', msg('claimGone', locale), { status: e.status })
    if (e instanceof DriveError) throw new HttpError(e.status === 404 ? 'not_found' : e.status === 401 ? 'unauthorized' : e.status === 403 ? 'forbidden' : 'bad_request', e.message, { status: e.status })
    throw new HttpError('internal')
  }
}
/** Who starts a Google sign-in: the desktop app when its page says so (a session it signed in can be recorded as 'web'),
 * else the session's kind. Saying 'desktop' only decides how a return without a session ends (held for the app's
 * one-time code, which only this session redeems), never who may finish it. A phone app's session stays the phone's. */
export const startedFrom = (session: ClientKind, said?: 'desktop'): ClientKind => (said === 'desktop' && session !== 'mobile' ? 'desktop' : session)

export function registerDriveRoutes(kit: RouteKit, ctx: AppContext) {
  kit.handle(API.myDriveConnection, ({ auth }) => safe(() => googleDriveOf(ctx).status(auth.user.id)))
  // the session's kind: a sign-in from the desktop or phone app ends on a page that sends the person back to the app,
  // and the desktop app first opens a page that names whose Trina gets the Drive (google-drive/app-return.ts)
  // (`client`: the desktop app's page says it is one, for a session recorded as another kind; app-return.ts)
  kit.handle(API.authorizeDrive, ({ auth, body }) => safe(() => googleDriveOf(ctx).begin(auth.user.id, auth.session.id, undefined, startedFrom(auth.session.client, body.client))))
  kit.handle(API.driveFlow, ({ auth, params }) => safe(() => googleDriveOf(ctx).flow(auth.user.id, auth.session.id, params.id)))
  kit.handle(API.completeDriveFlow, ({ auth, params, body }) => safe(() => googleDriveOf(ctx).complete(auth.user.id, auth.session.id, params.id)))
  // the desktop app's one-time code for a sign-in Google answered in a browser without a session: this session's flow
  // only. The desktop app posts every such code here, so a Gmail, Calendar, Docs or Sheets sign-in's code is tried next
  // (google-apps/service.ts claim); a code neither knows is the same refusal.
  // An app connection's sign-in (MCP, GitHub, an own app: integrations/connections/service.ts claim) is tried last, so
  // every desktop app since the claim address existed finishes those too, with no update of its own. Its answer has the
  // claim's shape (no account: a connection is not confirmed).
  // The app's proof (APP_RETURN_PROOF_HEADER, its main process only): a result held with the app's key is redeemed only
  // with it (google-drive/app-return.ts heldProofOk); a wrong or missing one is the same refusal as an unknown code.
  kit.handle(API.claimDriveFlow, ({ c, auth, body }) => safe(async () => {
    const proof = c.req.header(APP_RETURN_PROOF_HEADER) ?? null
    try { return googleDriveOf(ctx).claim(auth.user.id, auth.session.id, body.code, proof) } catch (e) {
      if (!(e instanceof DriveError) || e.reason !== 'invalid_code') throw e
      try { return googleAppsOf(ctx).claim(auth.user.id, auth.session.id, body.code, proof) } catch (g) {
        // a Google app's refusal (no longer an owner or admin for a team sign-in, the person or session gone): the same
        // shape as the Google apps routes' (routes/google-apps.ts), never a 500
        if (g instanceof GoogleAppError) throw new HttpError(g.status === 401 ? 'unauthorized' : g.status === 403 ? 'forbidden' : g.status === 404 ? 'not_found' : g.status === 409 ? 'conflict' : g.status >= 500 ? 'unavailable' : 'bad_request', g.message, { status: g.status, params: { reason: g.reason } })
        if (!(g instanceof DriveError) || g.reason !== 'invalid_code') throw g
        const f = await integrationsOf(ctx).claim(auth.user.id, auth.session.id, body.code, proof)
        if (f) return { ...f, account: null }
        // then Slack's sign-ins and "Add to Slack" (integrations/slack/service.ts claim)
        const sl = await slackOf(ctx).claim(auth.user.id, auth.session.id, body.code, proof)
        if (!sl) throw g
        return { ...sl, account: null }
      }
    }
  }, c.get('locale')))
  kit.handle(API.cancelDriveFlow, ({ auth, params }) => safe(() => googleDriveOf(ctx).cancel(auth.user.id, auth.session.id, params.id)))
  kit.handle(API.disconnectDrive, ({ auth }) => safe(() => googleDriveOf(ctx).disconnect(auth.user.id)))
  // Admin › App connectors: set up Google Drive here instead of in the installer (integrations/google-drive/admin-setup.ts)
  // with the hosting service's answer fresh, as the company's app row and the Google apps' list read it (oauth.ts
  // brokerFresh): every Google status of the admin page says the same
  kit.handle(API.driveAdminStatus, () => safe(async () => { try { await googleDriveOf(ctx).brokerFresh() } catch {} return driveAdminStatus(ctx) }))
  // a member's ask for Google Drive closes once members can connect it (integrations/service-requests.ts)
  // another client in place of the one people without a password sign in with: refused (auth/google-login-admin.ts)
  kit.handle(API.setDriveClient, ({ c, auth, body }) => safe(() => refuseClientInUse(c.get('locale'), () => { const st = setDriveClient(ctx, auth.user.id, body); afterServiceSetup(ctx, 'google-drive'); return st })))
  // the members' switch and Drives shared with the team (integrations/google-drive/shares.ts); admins only, and the
  // service checks the caller is an active admin again
  kit.handle(API.setDriveMembers, ({ auth, body }) => safe(() => { setMembersCanConnect(ctx, auth.user.id, body.on); afterServiceSetup(ctx, 'google-drive'); return driveAdminStatus(ctx) }))
  kit.handle(API.listDriveShares, ({ auth }) => safe(() => ({ items: listShares(ctx, auth.user.id) })))
  kit.handle(API.authorizeDriveShare, ({ auth, body }) => safe(() => googleDriveOf(ctx).begin(auth.user.id, auth.session.id, { shareId: body.shareId }, startedFrom(auth.session.client, body.client))))
  kit.handle(API.completeDriveShareFlow, ({ auth, params, body }) => safe(() => { const svc = googleDriveOf(ctx); return shareView(ctx.db, svc.completeShare(auth.user.id, auth.session.id, params.id, body.name), svc.key) }))
  kit.handle(API.driveShareFolders, ({ auth, params, query }) => safe(async () => ({ items: await shareFolders(ctx, auth.user.id, params.id, query.q) })))
  kit.handle(API.updateDriveShare, ({ auth, params, body }) => safe(() => updateShare(ctx, auth.user.id, params.id, body)))
  kit.handle(API.stopDriveShare, ({ auth, params }) => safe(() => stopShare(ctx, auth.user.id, params.id)))
  // The desktop app's page before Google (google-drive/app-return.ts): the Trina person the Drive will belong to, then
  // on to the sign-in page. No session here (the system browser has none); the flow's key only shows this page.
  kit.raw('GET', GO_PATH, async c => {
    const cc = c as unknown as AppContextC
    let go: ReturnType<ReturnType<typeof googleDriveOf>['goPage']> = null
    try { go = googleDriveOf(ctx).goPage(c.req.query('flow'), c.req.query('k')) } catch {}
    const gone = go ? ('expired' as const) : googleDriveOf(ctx).goGone(c.req.query('flow'))
    c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer'); c.header('Content-Security-Policy', GOOGLE_RETURN_CSP)
    if (!go) {
      const page = googleReturnPage(gone, cc.get('locale'), { app: 'desktop', origin: new URL(c.req.url).origin })
      return c.html(page.html, 400)
    }
    return c.html(drivePreGooglePage(cc.get('locale'), go), 200)
  })
  // The hosting service's proof that this self-installed server's relay key belongs to this address (google-drive/
  // broker.ts `register`): the PUBLIC key only, no session; 404 unless this server registers itself there, for Drive
  // (google-drive/broker.ts) or for Sign in with Google (auth/google-login-broker.ts): one registration serves both,
  // so sign-in works on a server whose Drive has a client of its own or is turned off
  kit.raw('GET', GOOGLE_BROKER_KEY_PATH, async c => {
    c.header('Cache-Control', 'no-store')
    const drive = googleDriveOf(ctx).broker
    const signin = googleSigninBrokerOf(ctx)
    const identity = drive?.o.selfOrigin ? drive.o.identity : signin?.registersItself() ? signin.identity : null
    if (!identity) return c.json({ error: { code: 'not_found' } }, 404)
    let key: string
    try { key = identity().publicKey } catch { return c.json({ error: { code: 'unavailable' } }, 503) }
    return c.json({ v: 1, key }, 200)
  })
  kit.raw('GET', CALLBACK_PATH, async c => {
    // Sign in with Google comes back to the address this server's Google client registered for Drive, so a company that
    // set up its Google app registers nothing new (auth/google-login.ts): its states first, Drive's as before
    if (ownsGoogleState(ctx, c.req.query('state'), c as unknown as Context<AppEnv>)) return finishGoogle(c as unknown as Context<AppEnv>, ctx)
    let r: CallbackOutcome = { ok: false, reason: 'provider_unavailable' }
    const cc = c as unknown as AppContextC
    const auth = cc.get('auth')
    try { r = await googleDriveOf(ctx).callbackOutcome({ state: c.req.query('state'), code: c.req.query('code'), error: c.req.query('error'), handoff: c.req.query('handoff') }, auth ? { userId: auth.user.id, sessionId: auth.session.id } : undefined, { finish: true }) } catch {}
    c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer')
    c.header('Content-Security-Policy', GOOGLE_RETURN_CSP)
    // in the person's language, with why it did not work (google-drive/callback-page.ts); static words and same-origin
    // links only (a sign-in started in an app: the app's own link to this team, a desktop one with its one-time code in
    // the fragment): never carry Google's code or the state into a link
    const page = googleReturnPage(googleReturnOf(r, !!auth), cc.get('locale'), { app: r.app, origin: new URL(c.req.url).origin, connector: '/settings/connectors/google-drive', code: r.ok ? r.code : undefined, who: r.ok ? r.who : undefined, google: r.ok ? r.google : undefined, returnPort: r.ok ? r.returnPort : undefined })
    return c.html(page.html, page.status)
  })
}
