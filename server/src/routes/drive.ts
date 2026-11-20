import { API } from '@mycel/shared/api'
import type { AppContext } from '../context'
import type { RouteKit } from '../http/route'
import { HttpError } from '../http/errors'
import type { AppContextC } from '../http/env'
import { GOOGLE_RETURN_CSP, googleReturnOf, googleReturnPage, type CallbackOutcome } from '../integrations/google-drive/callback-page'
import { BIND_COOKIE, OPEN_PATH, bindCookie, cookieValue } from '../integrations/google-drive/app-browser'
import { CALLBACK_PATH } from '../integrations/google-drive/config'
import { googleDriveOf } from '../integrations/google-drive/oauth'
import { driveAdminStatus, setDriveClient } from '../integrations/google-drive/admin-setup'
import { listShares, setMembersCanConnect, shareFolders, stopShare, updateShare } from '../integrations/google-drive/share-admin'
import { shareView } from '../integrations/google-drive/shares'
import { DriveError } from '../integrations/google-drive/store'
import { afterServiceSetup } from '../integrations/service-requests'

async function safe<T>(fn: () => T | Promise<T>): Promise<T> {
  try { return await fn() } catch (e) {
    if (e instanceof DriveError) throw new HttpError(e.status === 404 ? 'not_found' : e.status === 401 ? 'unauthorized' : e.status === 403 ? 'forbidden' : 'bad_request', e.message, { status: e.status })
    throw new HttpError('internal')
  }
}
export function registerDriveRoutes(kit: RouteKit, ctx: AppContext) {
  kit.handle(API.myDriveConnection, ({ auth }) => safe(() => googleDriveOf(ctx).status(auth.user.id)))
  // the session's kind: a sign-in from the desktop or phone app ends on a page that sends the person back to the app,
  // and the desktop app's system browser can finish it (google-drive/app-browser.ts)
  kit.handle(API.authorizeDrive, ({ auth }) => safe(() => googleDriveOf(ctx).begin(auth.user.id, auth.session.id, undefined, auth.session.client)))
  kit.handle(API.driveFlow, ({ auth, params }) => safe(() => googleDriveOf(ctx).flow(auth.user.id, auth.session.id, params.id)))
  kit.handle(API.completeDriveFlow, ({ auth, params, body }) => safe(() => googleDriveOf(ctx).complete(auth.user.id, auth.session.id, params.id)))
  kit.handle(API.cancelDriveFlow, ({ auth, params }) => safe(() => googleDriveOf(ctx).cancel(auth.user.id, auth.session.id, params.id)))
  kit.handle(API.disconnectDrive, ({ auth }) => safe(() => googleDriveOf(ctx).disconnect(auth.user.id)))
  // Admin › App connectors: set up Google Drive here instead of in the installer (integrations/google-drive/admin-setup.ts)
  kit.handle(API.driveAdminStatus, () => safe(() => driveAdminStatus(ctx)))
  // a member's ask for Google Drive closes once members can connect it (integrations/service-requests.ts)
  kit.handle(API.setDriveClient, ({ auth, body }) => safe(() => { const st = setDriveClient(ctx, auth.user.id, body); afterServiceSetup(ctx, 'google-drive'); return st }))
  // the members' switch and Drives shared with the team (integrations/google-drive/shares.ts); admins only, and the
  // service checks the caller is an active admin again
  kit.handle(API.setDriveMembers, ({ auth, body }) => safe(() => { setMembersCanConnect(ctx, auth.user.id, body.on); afterServiceSetup(ctx, 'google-drive'); return driveAdminStatus(ctx) }))
  kit.handle(API.listDriveShares, ({ auth }) => safe(() => ({ items: listShares(ctx, auth.user.id) })))
  kit.handle(API.authorizeDriveShare, ({ auth, body }) => safe(() => googleDriveOf(ctx).begin(auth.user.id, auth.session.id, { shareId: body.shareId }, auth.session.client)))
  kit.handle(API.completeDriveShareFlow, ({ auth, params, body }) => safe(() => { const svc = googleDriveOf(ctx); return shareView(ctx.db, svc.completeShare(auth.user.id, auth.session.id, params.id, body.name), svc.key) }))
  kit.handle(API.driveShareFolders, ({ auth, params, query }) => safe(async () => ({ items: await shareFolders(ctx, auth.user.id, params.id, query.q) })))
  kit.handle(API.updateDriveShare, ({ auth, params, body }) => safe(() => updateShare(ctx, auth.user.id, params.id, body)))
  kit.handle(API.stopDriveShare, ({ auth, params }) => safe(() => stopShare(ctx, auth.user.id, params.id)))
  // The desktop app's first stop in the system browser (google-drive/app-browser.ts): a one-time ticket of a flow its
  // session started gives this browser the cookie that finishes that flow, then on to the flow's sign-in page. No
  // session here (the system browser has none); the ticket is the proof. A used, late or unknown one: the expired page.
  kit.raw('GET', OPEN_PATH, async c => {
    const cc = c as unknown as AppContextC
    let to: { url: string; bind: string } | null = null
    try { to = googleDriveOf(ctx).openInBrowser(c.req.query('flow'), c.req.query('t')) } catch {}
    c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer')
    if (!to) {
      c.header('Content-Security-Policy', GOOGLE_RETURN_CSP)
      const page = googleReturnPage('expired', cc.get('locale'), { app: 'desktop', origin: new URL(c.req.url).origin })
      return c.html(page.html, 400)
    }
    c.header('Set-Cookie', bindCookie(c.req.url, CALLBACK_PATH, to.bind, 600), { append: true })
    return c.redirect(to.url, 302)
  })
  kit.raw('GET', CALLBACK_PATH, async c => {
    let r: CallbackOutcome = { ok: false, reason: 'provider_unavailable' }
    const cc = c as unknown as AppContextC
    const auth = cc.get('auth')
    const bind = cookieValue(c.req.header('cookie'), BIND_COOKIE)
    try { r = await googleDriveOf(ctx).callbackOutcome({ state: c.req.query('state'), code: c.req.query('code'), error: c.req.query('error'), handoff: c.req.query('handoff') }, auth ? { userId: auth.user.id, sessionId: auth.session.id } : undefined, bind) } catch {}
    c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer')
    c.header('Content-Security-Policy', GOOGLE_RETURN_CSP)
    if (bind && r.ok) c.header('Set-Cookie', bindCookie(c.req.url, CALLBACK_PATH, '', 0), { append: true })
    // in the person's language, with why it did not work (google-drive/callback-page.ts); static words and same-origin
    // links only (a sign-in started in an app: the app's own link to this team): never carry code or state into a link
    const page = googleReturnPage(googleReturnOf(r, !!auth), cc.get('locale'), { app: r.app, origin: new URL(c.req.url).origin, connector: '/settings/connectors/google-drive' })
    return c.html(page.html, page.status)
  })
}
