import { API } from '@mycel/shared/api'
import type { AppContext } from '../context'
import type { RouteKit } from '../http/route'
import { HttpError } from '../http/errors'
import type { AppContextC } from '../http/env'
import { CALLBACK_PATH } from '../integrations/google-drive/config'
import { googleDriveOf } from '../integrations/google-drive/oauth'
import { driveAdminStatus, setDriveClient } from '../integrations/google-drive/admin-setup'
import { listShares, setMembersCanConnect, shareFolders, stopShare, updateShare } from '../integrations/google-drive/share-admin'
import { shareView } from '../integrations/google-drive/shares'
import { DriveError } from '../integrations/google-drive/store'

async function safe<T>(fn: () => T | Promise<T>): Promise<T> {
  try { return await fn() } catch (e) {
    if (e instanceof DriveError) throw new HttpError(e.status === 404 ? 'not_found' : e.status === 401 ? 'unauthorized' : e.status === 403 ? 'forbidden' : 'bad_request', e.message, { status: e.status })
    throw new HttpError('internal')
  }
}
export function registerDriveRoutes(kit: RouteKit, ctx: AppContext) {
  kit.handle(API.myDriveConnection, ({ auth }) => safe(() => googleDriveOf(ctx).status(auth.user.id)))
  kit.handle(API.authorizeDrive, ({ auth }) => safe(() => googleDriveOf(ctx).begin(auth.user.id, auth.session.id)))
  kit.handle(API.driveFlow, ({ auth, params }) => safe(() => googleDriveOf(ctx).flow(auth.user.id, auth.session.id, params.id)))
  kit.handle(API.completeDriveFlow, ({ auth, params, body }) => safe(() => googleDriveOf(ctx).complete(auth.user.id, auth.session.id, params.id, { membersOn: body.membersOn === true })))
  kit.handle(API.cancelDriveFlow, ({ auth, params }) => safe(() => googleDriveOf(ctx).cancel(auth.user.id, auth.session.id, params.id)))
  kit.handle(API.disconnectDrive, ({ auth }) => safe(() => googleDriveOf(ctx).disconnect(auth.user.id)))
  // Admin › App connectors: set up Google Drive here instead of in the installer (integrations/google-drive/admin-setup.ts)
  kit.handle(API.driveAdminStatus, () => safe(() => driveAdminStatus(ctx)))
  kit.handle(API.setDriveClient, ({ auth, body }) => safe(() => setDriveClient(ctx, auth.user.id, body)))
  // the members' switch and Drives shared with the team (integrations/google-drive/shares.ts); admins only, and the
  // service checks the caller is an active admin again
  kit.handle(API.setDriveMembers, ({ auth, body }) => safe(() => { setMembersCanConnect(ctx, auth.user.id, body.on); return driveAdminStatus(ctx) }))
  kit.handle(API.listDriveShares, ({ auth }) => safe(() => ({ items: listShares(ctx, auth.user.id) })))
  kit.handle(API.authorizeDriveShare, ({ auth, body }) => safe(() => googleDriveOf(ctx).begin(auth.user.id, auth.session.id, { shareId: body.shareId })))
  kit.handle(API.completeDriveShareFlow, ({ auth, params, body }) => safe(() => { const svc = googleDriveOf(ctx); return shareView(ctx.db, svc.completeShare(auth.user.id, auth.session.id, params.id, body.name), svc.key) }))
  kit.handle(API.driveShareFolders, ({ auth, params, query }) => safe(async () => ({ items: await shareFolders(ctx, auth.user.id, params.id, query.q) })))
  kit.handle(API.updateDriveShare, ({ auth, params, body }) => safe(() => updateShare(ctx, auth.user.id, params.id, body)))
  kit.handle(API.stopDriveShare, ({ auth, params }) => safe(() => stopShare(ctx, auth.user.id, params.id)))
  kit.raw('GET', CALLBACK_PATH, async c => {
    let ok = false
    const auth = (c as unknown as AppContextC).get('auth')
    try { ok = await googleDriveOf(ctx).callback({ state: c.req.query('state'), code: c.req.query('code'), error: c.req.query('error'), handoff: c.req.query('handoff') }, auth ? { userId: auth.user.id, sessionId: auth.session.id } : undefined) } catch {}
    c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer')
    c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
    // Only static same-origin navigation. Never carry code/state into a login return URL or a native deep link.
    return c.html(ok
      ? '<!doctype html><meta charset="utf-8"><title>Google Drive</title><p>Google authorization received. Return to your team app to confirm the account.</p>'
      : '<!doctype html><meta charset="utf-8"><title>Google Drive</title><p>Google authorization could not be completed. <a href="/login" rel="noreferrer">Sign into the same team account in this browser</a>, then start again from your team app.</p>', ok ? 200 : 400)
  })
}
