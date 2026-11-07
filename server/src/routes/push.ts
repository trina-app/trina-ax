import { PUSH } from '@mycel/shared/api'
import type { RouteKit } from '../http/route'
import type { AppContext } from '../context'
import { pushOf } from '../notifications/push-service'
export function registerPush(kit: RouteKit, ctx: AppContext) {
  const service = pushOf(ctx)
  kit.handle(PUSH.getPushSettings, ({ c, auth }) => { c.header('Cache-Control', 'no-store'); return service.settings(auth.user.id, auth.session.id) })
  kit.handle(PUSH.subscribePush, ({ c, auth, body }) => { c.header('Cache-Control', 'no-store'); return service.subscribe(auth.user.id, auth.session.id, body) })
  kit.handle(PUSH.updatePushSettings, ({ c, auth, body }) => { c.header('Cache-Control', 'no-store'); return service.setEnabled(auth.user.id, auth.session.id, body.enabled, body.consent) })
  kit.handle(PUSH.unsubscribePush, ({ auth, params }) => service.unsubscribe(auth.user.id, auth.session.id, params.id))
  kit.handle(PUSH.registerPushDevice, ({ c, auth, body }) => { c.header('Cache-Control', 'no-store'); return service.registerDevice(auth.user.id, auth.session.id, body) })
  kit.handle(PUSH.unregisterPushDevice, ({ auth, params }) => service.unsubscribe(auth.user.id, auth.session.id, params.id, 'native'))
  kit.handle(PUSH.removePushDevice, ({ params, body }) => { service.removeDevice(params.id, body) })
  // the iPhone app's notification extension: who and where of a room push, or {} (no session; never cached)
  kit.handle(PUSH.labelPushDevice, ({ c, params, body }) => { c.header('Cache-Control', 'no-store'); return service.label(params.id, body) })
}
