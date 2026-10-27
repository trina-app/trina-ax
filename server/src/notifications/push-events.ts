// Small lifecycle bridge: auth/notification policy can cancel work without importing network/secret modules.
import type { AppContext } from '../context'
import type { NotificationPreferences } from '@mycel/shared/api'
import { eventEnabled } from './preferences'
type Stop = (scope: { userId?: string; sessionId?: string }) => void
const listeners = new WeakMap<AppContext, Stop>()
export function onPushCancellation(ctx: AppContext, stop: Stop) { listeners.set(ctx, stop); return () => { if (listeners.get(ctx) === stop) listeners.delete(ctx) } }
export function cancelPushUser(ctx: AppContext, userId: string) { try { listeners.get(ctx)?.({ userId }) } catch { ctx.log.warn('push cancellation deferred') } }
export function cancelPushSession(ctx: AppContext, sessionId: string) { try { listeners.get(ctx)?.({ sessionId }) } catch { ctx.log.warn('push cancellation deferred') } }

/** Called inside the preference transaction: an acknowledged opt-out cannot leave a retry revivable later. */
export function cancelDisabledPushDeliveries(ctx: AppContext, userId: string, preferences: NotificationPreferences) {
  const disabled = (['schedule.success', 'schedule.failure', 'connection.reconnect'] as const).filter(event => !eventEnabled(preferences, event))
  if (disabled.length) ctx.db.query(`UPDATE push_deliveries SET state='cancelled',lease_until=NULL WHERE state IN ('pending','sending') AND notification_id IN
    (SELECT id FROM notification_inbox WHERE user_id=? AND event_type IN (${disabled.map(() => '?').join(',')}))`).run(userId, ...disabled)
}
