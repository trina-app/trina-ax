// Route module "room-apps" — owner: component B. Apps posting in rooms (docs/DECISIONS.md "Apps posting in rooms"):
// the management API (ROOM_APPS, shared/src/api/room-apps.ts) and the public address POST /in/<token> (outside /api;
// the token is the auth). Logic: server/src/rooms/apps/*.
import { API } from '@mycel/shared/api'
import type { Context } from 'hono'
import type { RouteModule } from './module'
import type { AppContextC } from '../http/env'
import { publicAddressRefusal, visitorScheme } from '../http/middleware'
import { NOT_FOUND, roomAppInbound } from '../rooms/apps/inbound'
import { roomAppsOf } from '../rooms/apps/service'

export const roomAppsRoutes: RouteModule = {
  name: 'room-apps',
  owner: 'B',
  init(ctx) {
    // old deliveries, day counters and threads go once an hour; every 5 minutes (and with the hourly prune) the managers
    // are told when someone who left still knows an app's address (RoomApps.leaverSweep: no single code path to hook)
    if (process.env.NODE_ENV === 'test') return
    const sweep = () => { try { roomAppsOf(ctx).leaverSweep() } catch (e) { ctx.log.warn('room app leaver sweep failed', { err: e }) } }
    const tick = setInterval(() => { try { roomAppsOf(ctx).prune() } catch (e) { ctx.log.warn('room app prune failed', { err: e }) } sweep() }, 3_600_000)
    const short = setInterval(sweep, 300_000)
    for (const t of [tick, short]) (t as { unref?: () => void }).unref?.()
    ctx.onClose(() => { clearInterval(tick); clearInterval(short) })
  },
  register(kit, ctx) {
    const apps = roomAppsOf(ctx)
    kit.handle(API.listRoomApps, ({ c, auth, params }) => { c.header('Cache-Control', 'no-store'); return apps.list(auth.user.id, params.id) })
    kit.handle(API.createRoomApp, ({ c, auth, params, body }) => { c.header('Cache-Control', 'no-store'); return apps.create(auth.user.id, params.id, body, c.get('locale')) })
    kit.handle(API.getRoomAppAddress, ({ c, auth, params }) => { c.header('Cache-Control', 'no-store'); return apps.address(auth.user.id, params.id, params.appId) })
    kit.handle(API.updateRoomApp, ({ c, auth, params, body }) => apps.update(auth.user.id, params.id, params.appId, body, c.get('locale')))
    kit.handle(API.setRoomAppSecret, ({ c, auth, params, body }) => { c.header('Cache-Control', 'no-store'); return apps.setSecret(auth.user.id, params.id, params.appId, body, c.get('locale')) })
    kit.handle(API.rotateRoomApp, ({ c, auth, params }) => { c.header('Cache-Control', 'no-store'); return apps.rotate(auth.user.id, params.id, params.appId) })
    kit.handle(API.resumeRoomApp, ({ c, auth, params }) => apps.resume(auth.user.id, params.id, params.appId, c.get('locale')))
    kit.handle(API.exampleRoomApp, ({ auth, params }) => { apps.example(auth.user.id, params.id, params.appId) })
    kit.handle(API.deleteRoomApp, ({ auth, params }) => { apps.remove(auth.user.id, params.id, params.appId) })

    // the public address. A request through the server's own public address with a country or network list got here
    // only through the /in/ exemption (http/middleware.ts hostCheck): it gets the stricter limit for unknown tokens
    kit.raw('POST', '/in/:token', (c: Context) => {
      const info = (c as unknown as AppContextC).get('info')
      const t = ctx.config.tunnel
      const strict = !!(info.via === 'direct' && info.tunnel && t && (t.allowFrom.length || t.countries.length)
        && publicAddressRefusal(t, info.ip, visitorScheme(c.req.header('cf-visitor'), c.req.header('x-forwarded-proto')), c.req.header('cf-ipcountry')))
      return roomAppInbound(ctx, c.req.raw, c.req.param('token') ?? '', { ip: info.ip, strict })
    })
    // any other method, and anything under /in/, answers as an unknown address does (never the web app's page)
    kit.raw('ALL', '/in/*', () => NOT_FOUND())
    kit.raw('ALL', '/in', () => NOT_FOUND())
  },
}
