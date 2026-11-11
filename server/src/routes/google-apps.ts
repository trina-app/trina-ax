// Gmail, Google Calendar, Google Docs and Google Sheets (contract: shared/src/api/google-apps.ts; logic:
// server/src/integrations/google-apps/service.ts). Registered by the files route module next to Google Drive's.
import { API } from '@mycel/shared/api'
import type { GoogleAppId } from '@mycel/shared/api'
import type { AppContext } from '../context'
import type { RouteKit } from '../http/route'
import { HttpError } from '../http/errors'
import type { AppContextC } from '../http/env'
import { isAppId } from '../integrations/google-apps/catalog'
import { CALLBACK_PATH } from '../integrations/google-apps/config'
import { googleAppsOf, GoogleAppError } from '../integrations/google-apps/service'

/** the app in the path, or not found */
function appOf(raw: string | undefined): GoogleAppId {
  if (!isAppId(raw)) throw new HttpError('not_found')
  return raw
}

/** A refusal as the API's error: the reason code in the message and params (the web shows it in the person's words). */
async function safe<T>(fn: () => T | Promise<T>): Promise<T> {
  try { return await fn() } catch (e) {
    if (e instanceof HttpError) throw e
    if (e instanceof GoogleAppError) {
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
  kit.handle(API.setGoogleAppClient, ({ auth, params, body }) => safe(() => svc().setClient(auth.user.id, appOf(params.app), body)))
  kit.handle(API.setGoogleAppMembers, ({ auth, params, body }) => safe(() => svc().setMembers(auth.user.id, appOf(params.app), body.on)))
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
