// The "paused" notice of an app in a room (notifications 'room_app.paused', table room_app_notices, migration 299): what
// it says is read when the notice is read. The room is named and linked only while the person is still in it.
import { plainLabel, ROOM_APP_DAILY_CAP, type InboxNotification } from '@mycel/shared/api'
import type { AppContext } from '../../context'
import { groupName, memberRow, roomRow } from '../store'
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
    day, cap: ROOM_APP_DAILY_CAP, skipped, pausedUntil: out.pausedUntil, canResume: inRoom && out.canResume,
  }
}
