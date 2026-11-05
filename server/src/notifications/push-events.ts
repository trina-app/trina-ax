// Small lifecycle bridge: auth/notification policy can cancel work without importing network/secret modules.
import type { AppContext } from '../context'
import { ROOM_PUSH_EVENTS, type NotificationPreferences } from '@mycel/shared/api'
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
  // room notices have their own deliveries (migration 241)
  if (preferences.roomMessages === false) ctx.db.query(`UPDATE room_push_deliveries SET state='cancelled',lease_until=NULL WHERE state IN ('pending','sending') AND notification_id IN
    (SELECT id FROM room_notices WHERE user_id=?)`).run(userId)
}

/** Where a tapped phone notification opens on the team (the app refuses anything but an id path, and so does the
 * gateway). An event code may register its own resolver, e.g. a room message: `/rooms/<roomId>`. None: the app's
 * start page. Resolvers read ids only; they never put names or text into the path. */
type PushPath = (ctx: AppContext, notificationId: string) => string | null | undefined
const PATH = /^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)?$/
// the existing events open the inbox, as a Web Push click does (web/pwa/sw.js)
const pushPaths = new Map<string, PushPath>(['schedule.success', 'schedule.failure', 'connection.reconnect'].map(code => [code, () => '/settings/notifications']))
// a room notice opens its room (the same page a Web Push click opens, web/pwa/sw.js), only while the person is still in
// that room and it is not archived; the room page checks membership again
const roomPath: PushPath = (ctx, id) => {
  const r = ctx.db.query(`SELECT n.room_id FROM room_notices n JOIN room_members m ON m.room_id=n.room_id AND m.user_id=n.user_id
    JOIN rooms r ON r.id=n.room_id AND r.archived_at IS NULL WHERE n.id=?`).get(id) as { room_id: string } | null
  return r ? `/rooms/${r.room_id}` : null
}
for (const code of ROOM_PUSH_EVENTS) pushPaths.set(code, roomPath)
export function registerPushPath(code: string, path: PushPath) { pushPaths.set(code, path) }
export function pushPathOf(ctx: AppContext, code: string, notificationId: string): string | undefined {
  try {
    const p = pushPaths.get(code)?.(ctx, notificationId)
    return typeof p === 'string' && p.length <= 200 && PATH.test(p) ? p : undefined
  } catch { return undefined }
}
