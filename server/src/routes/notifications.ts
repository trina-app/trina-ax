import { NOTIFICATIONS } from '@mycel/shared/api'
import type { RouteKit } from '../http/route'
import type { AppContext } from '../context'
import { notificationsOf } from '../notifications/service'
export function registerNotifications(kit: RouteKit, ctx: AppContext) {
  const service = notificationsOf(ctx)
  kit.handle(NOTIFICATIONS.getNotification, ({ c, auth, params }) => { c.header('Cache-Control','no-store'); return service.get(auth.user.id, params.id) })
  kit.handle(NOTIFICATIONS.listNotifications, ({ c, auth, query }) => {
    c.header('Cache-Control','no-store')
    try { service.reconcile(auth.user.id) } catch { ctx.log.warn('notification reconciliation deferred') }
    return service.list(auth.user.id, query)
  })
  kit.handle(NOTIFICATIONS.markNotificationRead, ({ auth, params }) => service.read(auth.user.id, params.id))
  kit.handle(NOTIFICATIONS.getNotificationPreferences, ({ c, auth }) => { c.header('Cache-Control','no-store'); return service.preferences(auth.user.id) })
  kit.handle(NOTIFICATIONS.updateNotificationPreferences, ({ auth, body }) => service.setPreferences(auth.user.id, body))
}
