// The "paused" notice of an app in a room (notifications 'room_app.paused', table room_app_notices, migration 299): what
// it says is read when the notice is read. The room is named and linked only while the person is still in it.
import { plainLabel, ROOM_APP_DAILY_CAP, type InboxNotification } from '@mycel/shared/api'
import type { AppContext } from '../../context'
import { groupName, mayManageApps, memberRow, roomRow } from '../store'
import { roomAppsOf, type AppRow } from './service'

export function roomAppNoticeOut(ctx: AppContext, userId: string, sourceId: string): NonNullable<InboxNotification['roomApp']> | null {
  const m = /^(.+)\.(\d{4}-\d{2}-\d{2})$/.exec(sourceId)
  if (!m) return null
  const [, appId, day] = m as unknown as [string, string, string]
  const apps = roomAppsOf(ctx)
  const row = ctx.db.query('SELECT * FROM room_apps WHERE id = ?').get(appId) as AppRow | null
  if (!row) return null
  const room = roomRow(ctx.db, row.room_id)
  const inRoom = !!room && !room.archived_at && !!memberRow(ctx.db, room.id, userId)
  const name = inRoom && room.kind !== 'dm' ? room.name || groupName(ctx.db, room) : null
  const out = apps.out(row)
  const skipped = (ctx.db.query('SELECT skipped FROM room_app_days WHERE app_id = ? AND day = ?').get(appId, day) as { skipped: number } | null)?.skipped ?? 0
  return {
    appId, name: plainLabel(row.name, 40), roomId: inRoom ? room.id : null, roomKind: inRoom ? room.kind : null, roomName: name ? plainLabel(name, 80) : null,
    day, cap: ROOM_APP_DAILY_CAP, skipped, pausedUntil: out.pausedUntil, canResume: inRoom && mayManageApps(ctx.db, room, userId) && out.canResume,
  }
}

/** The notice's app and its room while the person is still in that room and it is not archived (ids only: it runs inside
 * the push service). Null: no such notice, the app removed, the person out of the room or the room archived. */
function noticeApp(ctx: AppContext, notificationId: string): { room_id: string; paused_until: string | null } | null {
  const n = ctx.db.query('SELECT user_id, source_id FROM room_app_notices WHERE id = ?').get(notificationId) as { user_id: string; source_id: string } | null
  const appId = n && /^(.+)\.\d{4}-\d{2}-\d{2}$/.exec(n.source_id)?.[1]
  if (!n || !appId) return null
  return ctx.db.query(`SELECT a.room_id, a.paused_until FROM room_apps a JOIN rooms r ON r.id = a.room_id AND r.archived_at IS NULL
    JOIN room_members m ON m.room_id = a.room_id AND m.user_id = ? WHERE a.id = ?`).get(n.user_id, appId) as { room_id: string; paused_until: string | null } | null
}
/** The paused push (migration 351, room_app_push_deliveries), asked before and after each send
 * (notifications/push-service.ts SOURCES wanted): the app is still there and still paused ("Resume now" clears
 * paused_until, the team's midnight passes it) and the person is still in its room. */
export function roomAppPushWanted(ctx: AppContext, notificationId: string, now = Date.now()): boolean {
  const a = noticeApp(ctx, notificationId)
  return !!a?.paused_until && Date.parse(a.paused_until) > now
}
/** A tap opens the app's room (/rooms/<roomId>) while the person is still in it; else the app's start page
 * (notifications/push-events.ts). */
export function roomAppPushPath(ctx: AppContext, notificationId: string): string | null {
  const a = noticeApp(ctx, notificationId)
  return a ? `/rooms/${a.room_id}` : null
}
