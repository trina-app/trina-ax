// Gmail, Google Calendar, Google Docs and Google Sheets (contract: shared/src/api/google-apps.ts; logic:
// server/src/integrations/google-apps/service.ts). Registered by the files route module next to Google Drive's. Also a
// member's ask to add one of these apps or Google Drive (shared/src/api/service-requests.ts;
// server/src/integrations/service-requests.ts): an admin's setup closes the asks it answers.
import { API } from '@mycel/shared/api'
import type { GoogleAppId } from '@mycel/shared/api'
import type { AppContext } from '../context'
import type { RouteKit } from '../http/route'
import { HttpError } from '../http/errors'
import type { AppContextC } from '../http/env'
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
  kit.handle(API.authorizeGoogleApp, ({ auth, params }) => safe(() => svc().authorize(auth.user.id, auth.session.id, appOf(params.app))))
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
  kit.handle(API.setGoogleOwnApp, ({ auth, body }) => safe(() => {
    const st = setOwnApp(ctx, auth.user.id, body)
    for (const s of ['google-drive', 'gmail', 'calendar', 'docs', 'sheets'] as const) afterServiceSetup(ctx, s)
    return st
  }))
  kit.handle(API.removeGoogleOwnApp, ({ auth }) => safe(() => removeOwnApp(ctx, auth.user.id)))
  // the account shared with the team: owners and admins only (the route checks the role; the service checks it again)
  kit.handle(API.authorizeGoogleAppTeam, ({ auth, params }) => safe(() => svc().authorize(auth.user.id, auth.session.id, appOf(params.app), 'team')))
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
    let ok = false
    const auth = (c as unknown as AppContextC).get('auth')
    try { ok = await svc().callback({ state: c.req.query('state'), code: c.req.query('code'), error: c.req.query('error'), handoff: c.req.query('handoff') }, auth ? { userId: auth.user.id, sessionId: auth.session.id } : undefined) } catch {}
    c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer')
    c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
    // only static same-origin words: never carry code or state into a link
    return c.html(ok
      ? '<!doctype html><meta charset="utf-8"><title>Google</title><p>Google sign-in received. Return to your team app to confirm the account.</p>'
      : '<!doctype html><meta charset="utf-8"><title>Google</title><p>Google sign-in could not be completed. <a href="/login" rel="noreferrer">Sign into the same team account in this browser</a>, then start again from your team app.</p>', ok ? 200 : 400)
  })
}
