import { PUSH } from '@mycel/shared/api'
import type { RouteKit } from '../http/route'
import type { AppContext } from '../context'
import { fail } from '../http/errors'
import { audit } from '../admin/audit'
import { isHosted } from '../system/deployment'
import { pushOf } from '../notifications/push-service'
import { checkGatewayHealth, pushGatewaySetting, writePushGateway } from '../notifications/push-gateway-setting'
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
  // where phone notifications go (owners and admins, Settings › Notifications; notifications/push-gateway-setting.ts)
  kit.handle(PUSH.getPushGateway, ({ c }) => { c.header('Cache-Control', 'no-store'); return pushGatewaySetting(ctx.config, ctx.db) })
  kit.handle(PUSH.setPushGateway, async ({ c, auth, body }) => {
    c.header('Cache-Control', 'no-store')
    const before = pushGatewaySetting(ctx.config, ctx.db)
    // the operator's MYCEL_PUSH_GATEWAY or server.json wins: nothing to change here
    if (before.lockedBy) fail('conflict', undefined, { params: { reason: 'locked' } })
    if (body.choice === 'default' && !before.defaultHost) fail('validation', undefined, { params: { reason: 'address' }, fields: { 'body.choice': 'no default gateway' } })
    let url: string | undefined
    if (body.choice === 'custom') {
      // saved only when it answers as a gateway; why not, otherwise (nothing is saved)
      const check = await checkGatewayHealth(body.url ?? '', { hosted: isHosted(ctx.config) })
      if (!check.ok) fail('validation', undefined, { params: { reason: check.problem }, fields: { 'body.url': check.problem } })
      else url = check.url
    }
    writePushGateway(ctx.db, body.choice, url)
    const next = pushGatewaySetting(ctx.config, ctx.db)
    if (before.choice !== next.choice || before.url !== next.url)
      audit(ctx.db, { actor: auth.user.id, action: 'push.gateway', target: null, detail: { choice: next.choice, ...(next.url ? { host: new URL(next.url).host } : {}), before: before.choice } })
    return next
  })
}
