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
}
