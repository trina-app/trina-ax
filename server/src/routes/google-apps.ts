// Gmail, Google Calendar, Google Docs and Google Sheets (contract: shared/src/api/google-apps.ts; logic:
// server/src/integrations/google-apps/service.ts). Registered by the files route module next to Google Drive's. Also a
// member's ask to add one of these apps or Google Drive (shared/src/api/service-requests.ts;
// server/src/integrations/service-requests.ts): an admin's setup closes the asks it answers.
import { API } from '@mycel/shared/api'
import type { GoogleAppId } from '@mycel/shared/api'
import { refuseClientInUse } from '../auth/google-login-admin'
import type { AppContext } from '../context'
import type { RouteKit } from '../http/route'
import { HttpError } from '../http/errors'
import type { AppContextC } from '../http/env'
import { GOOGLE_RETURN_CSP, googleReturnOf, googleReturnPage, type CallbackOutcome } from '../integrations/google-drive/callback-page'
import { isAppId } from '../integrations/google-apps/catalog'
import { CALLBACK_PATH } from '../integrations/google-apps/config'
import { googleAppsOf, GoogleAppError } from '../integrations/google-apps/service'
import { GoogleOwnAppError, ownAppStatusFresh, removeOwnApp, setOwnApp } from '../integrations/google-drive/own-app'
import { afterServiceSetup, askService, dismissServiceRequests, myServiceRequests, teamServiceRequests, withdrawService } from '../integrations/service-requests'

/** the app in the path, or not found */
function appOf(raw: string | undefined): GoogleAppId {
  if (!isAppId(raw)) throw new HttpError('not_found')
  return raw
}

/** A refusal as the API's error: the reason code in the message and params (the web shows it in the person's words). */
async function safe<T>(fn: () => T | Promise<T>): Promise<T> {
  try { return await fn() } catch (e) {
    if (e instanceof HttpError) throw e
    if (e instanceof GoogleAppError || e instanceof GoogleOwnAppError) {
      const code = e.status === 404 ? 'not_found' : e.status === 401 ? 'unauthorized' : e.status === 403 ? 'forbidden' : e.status === 429 ? 'rate_limited' : e.status === 409 ? 'conflict' : e.status >= 500 ? 'unavailable' : 'bad_request'
      throw new HttpError(code, e.message, { status: e.status, params: { reason: e.reason } })
    }
    throw new HttpError('internal')
  }
}

export function registerGoogleAppsRoutes(kit: RouteKit, ctx: AppContext) {
  const svc = () => googleAppsOf(ctx)
  kit.handle(API.myGoogleApps, ({ auth }) => safe(() => svc().list(auth.user.id)))
  kit.handle(API.authorizeGoogleApp, ({ auth, params, body }) => safe(() => svc().authorize(auth.user.id, auth.session.id, appOf(params.app), 'personal', body.client)))
  kit.handle(API.googleAppFlow, ({ auth, params }) => safe(() => svc().flow(auth.user.id, auth.session.id, appOf(params.app), params.id)))
  kit.handle(API.completeGoogleAppFlow, ({ auth, params }) => safe(() => svc().complete(auth.user.id, auth.session.id, appOf(params.app), params.id)))
  kit.handle(API.cancelGoogleAppFlow, ({ auth, params }) => safe(() => svc().cancel(auth.user.id, auth.session.id, appOf(params.app), params.id)))
  kit.handle(API.updateGoogleApp, ({ auth, params, body }) => safe(() => svc().setWritePolicy(auth.user.id, appOf(params.app), body.writePolicy)))
  kit.handle(API.disconnectGoogleApp, ({ auth, params }) => safe(() => svc().disconnect(auth.user.id, appOf(params.app))))
  // Admin › Connectors: one card per app (the route checks the admin role)
  kit.handle(API.googleAppsAdminStatus, () => safe(() => svc().adminList()))
  kit.handle(API.setGoogleAppClient, ({ auth, params, body }) => safe(() => {
    const app = appOf(params.app), st = svc().setClient(auth.user.id, app, body)
    afterServiceSetup(ctx, app)
    return st
  }))
  // the company's own Google app for all five Google apps (integrations/google-drive/own-app.ts); owners and admins
  kit.handle(API.googleOwnApp, () => safe(() => ownAppStatusFresh(ctx)))
  kit.handle(API.setGoogleOwnApp, ({ c, auth, body }) => safe(() => refuseClientInUse(c.get('locale'), async () => {
    // awaited: Google is asked first, and members' asks close only once the app is saved (never on a refusal)
    const st = await setOwnApp(ctx, auth.user.id, body)
    for (const s of ['google-drive', 'gmail', 'calendar', 'docs', 'sheets'] as const) afterServiceSetup(ctx, s)
    return st
  })))
  // refused while people without a password sign in with it (auth/google-login-admin.ts guardOwnGoogleClient)
  kit.handle(API.removeGoogleOwnApp, ({ c, auth }) => safe(() => refuseClientInUse(c.get('locale'), () => removeOwnApp(ctx, auth.user.id))))
  // the account shared with the team: owners and admins only (the route checks the role; the service checks it again)
  kit.handle(API.authorizeGoogleAppTeam, ({ auth, params, body }) => safe(() => svc().authorize(auth.user.id, auth.session.id, appOf(params.app), 'team', body.client)))
  kit.handle(API.googleAppTeamFlow, ({ auth, params }) => safe(() => svc().flow(auth.user.id, auth.session.id, appOf(params.app), params.id, 'team')))
  kit.handle(API.cancelGoogleAppTeamFlow, ({ auth, params }) => safe(() => svc().cancel(auth.user.id, auth.session.id, appOf(params.app), params.id, 'team')))
  kit.handle(API.completeGoogleAppTeamFlow, ({ auth, params, body }) => safe(() => svc().completeTeam(auth.user.id, auth.session.id, appOf(params.app), params.id, { create: body.create })))
  kit.handle(API.setGoogleAppTeam, ({ auth, params, body }) => safe(() => svc().setTeamAccess(auth.user.id, appOf(params.app), body.access)))
  kit.handle(API.removeGoogleAppTeam, ({ auth, params, query }) => safe(() => svc().removeTeam(auth.user.id, appOf(params.app), query.id)))
  kit.handle(API.setGoogleAppMembers, ({ auth, params, body }) => safe(() => {
    const app = appOf(params.app), st = svc().setMembers(auth.user.id, app, body.on)
    afterServiceSetup(ctx, app)
    return st
  }))
  // a member asks the owner and the admins to add an app the team has not set up; the person comes from the session
  kit.handle(API.myServiceRequests, ({ auth }) => myServiceRequests(ctx, auth.user.id))
  kit.handle(API.askService, ({ auth, body }) => askService(ctx, auth.user, body.service))
  kit.handle(API.withdrawService, ({ auth, params }) => { withdrawService(ctx, auth.user.id, params.service) })
  kit.handle(API.teamServiceRequests, () => teamServiceRequests(ctx))
  kit.handle(API.dismissServiceRequests, ({ auth, params }) => { dismissServiceRequests(ctx, auth.user.id, params.service) })
  // Google (or the hosting service) sends the browser back here; which app is in the flow its state names
  kit.raw('GET', CALLBACK_PATH, async (c) => {
    let r: CallbackOutcome = { ok: false, reason: 'provider_unavailable' }
    const cc = c as unknown as AppContextC
    const auth = cc.get('auth')
    try { r = await svc().callbackOutcome({ state: c.req.query('state'), code: c.req.query('code'), error: c.req.query('error'), handoff: c.req.query('handoff') }, auth ? { userId: auth.user.id, sessionId: auth.session.id } : undefined) } catch {}
    c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer')
    c.header('Content-Security-Policy', GOOGLE_RETURN_CSP)
    // in the person's language, with why it did not work (google-drive/callback-page.ts); static words and same-origin
    // links only (a sign-in started in an app: the app's own link to this team, a desktop one with its one-time code in
    // the fragment): never carry Google's code or the state into a link
    const page = googleReturnPage(googleReturnOf(r, !!auth), cc.get('locale'), { app: r.app, origin: new URL(c.req.url).origin, code: r.ok ? r.code : undefined, who: r.ok ? r.who : undefined, google: r.ok ? r.google : undefined })
    return c.html(page.html, page.status)
  })
}
