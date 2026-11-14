// The "paused" notice of an app in a room (notifications 'room_app.paused', table room_app_notices, migration 299): what
// it says is read when the notice is read. The room is named and linked only while the person is still in it.
import { plainLabel, ROOM_APP_DAILY_CAP, type InboxNotification } from '@mycel/shared/api'
import type { AppContext } from '../../context'
import { groupName, mayManageApps, memberRow, roomRow, type RoomRow } from '../store'
import { leaverSource, roomAppsOf, type AppRow } from './service'

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

/** The "someone who left knows the address" notice (notifications 'room_app.leaver', table room_app_leaver_notices,
 * migration 352): the app and its room, read when the notice is read. Null once the app is removed or got a new address
 * (the source's token hash prefix is no longer the app's). The room is named and linked only while the person is in it. */
export function roomAppLeaverOut(ctx: AppContext, userId: string, sourceId: string): NonNullable<InboxNotification['roomAppLeaver']> | null {
  const m = /^(.+)\.([0-9a-f]{12})$/.exec(sourceId)
  if (!m) return null
  const [, appId, hash] = m as unknown as [string, string, string]
  const row = ctx.db.query('SELECT id, room_id, name, token_hash FROM room_apps WHERE id = ?').get(appId) as Pick<AppRow, 'id' | 'room_id' | 'name' | 'token_hash'> | null
  if (!row || leaverSource(row) !== `${appId}.${hash}`) return null
  const room = roomRow(ctx.db, row.room_id)
  const inRoom = !!room && !room.archived_at && !!memberRow(ctx.db, room.id, userId)
  const name = inRoom && room.kind !== 'dm' ? room.name || groupName(ctx.db, room) : null
  return { appId, name: plainLabel(row.name, 40), roomId: inRoom ? room.id : null, roomKind: inRoom ? room.kind : null, roomName: name ? plainLabel(name, 80) : null }
}

/** The notice's app and its room while the person is still in that room and it is not archived (ids only: it runs inside
 * the push service). Null: no such notice, the app removed, the person out of the room or the room archived. */
function noticeApp(ctx: AppContext, notificationId: string): { room_id: string; paused_until: string | null } | null {
  const n = ctx.db.query('SELECT user_id, source_id FROM room_app_notices WHERE id = ?').get(notificationId) as { user_id: string; source_id: string } | null
  const appId = n && /^(.+)\.\d{4}-\d{2}-\d{2}$/.exec(n.source_id)?.[1]
  if (!n || !appId) return null
  const a = ctx.db.query(`SELECT a.room_id, a.paused_until, r.kind FROM room_apps a JOIN rooms r ON r.id = a.room_id AND r.archived_at IS NULL
    JOIN room_members m ON m.room_id = a.room_id AND m.user_id = ? WHERE a.id = ?`).get(n.user_id, appId) as { room_id: string; paused_until: string | null; kind: RoomRow['kind'] } | null
  // only while they may still manage the room's apps: an admin made a member (still in the room) gets no push
  return a && mayManageApps(ctx.db, { kind: a.kind }, n.user_id) ? { room_id: a.room_id, paused_until: a.paused_until } : null
}
/** The paused push (migration 352, room_app_push_deliveries), asked before and after each send
 * (notifications/push-service.ts SOURCES wanted): the app is still there and still paused ("Resume now" clears
 * paused_until, the team's midnight passes it) and the person is still in its room and may still manage its apps. */
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
