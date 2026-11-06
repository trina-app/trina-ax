// Room notification settings on the server (docs/DECISIONS.md "대화방 알림 설정"): each member's level for a room, what
// the app is told (Room.notify, the rooms list's alerts) and whether a room notice may still be pushed. The rule itself
// is shared with the web app (shared/src/api/room-alerts.ts: roomLevel, roomAlert, inQuietHours).
import type { Database } from 'bun:sqlite'
import { roomLevel, type Room, type RoomAlertSettings, type RoomNotifyLevel } from '@mycel/shared/api'
import { teamTimeZone } from '../admin/settings'
import { getPreferences, type Preferences } from '../notifications/preferences'

/** My own level for a room: muted decides 'off' (an older build may have changed it), notify_level the rest. */
export function ownLevel(m: { muted: number; notify_level?: string | null }): RoomNotifyLevel | null {
  if (m.muted) return 'off'
  return m.notify_level === 'all' || m.notify_level === 'mentions' ? m.notify_level : null
}
/** What the app is told about one room (Room.notify). */
export function roomNotifyOut(kind: string, m: { muted: number; notify_level?: string | null }, prefs: Preferences): NonNullable<Room['notify']> {
  const own = ownLevel(m), byDefault = roomLevel(kind, null, prefs.roomLevel)
  return { own, byDefault, level: own ?? byDefault }
}
/** What the app needs besides the levels to decide its sound (GET /api/rooms `alerts`). */
export function alertSettings(db: Database, prefs: Preferences): RoomAlertSettings {
  return { threadReplies: prefs.roomThreadReplies, quietHours: prefs.quietHours, timeZone: teamTimeZone(db) }
}
/** Set my level for a room (null: my default), muted in step. */
export function setOwnLevel(db: Database, roomId: string, userId: string, level: RoomNotifyLevel | null) {
  db.query('UPDATE room_members SET notify_level = ?, muted = ? WHERE room_id = ? AND user_id = ?').run(level, level === 'off' ? 1 : 0, roomId, userId)
}

/** May this room notice still be pushed? Only while its person is in the room and the room's level still asks for it:
 * a mention at any level but 'off', any other notice at 'all' or as a reply in a thread they follow (with replies on).
 * The push service asks before it sends and again after (a change in Settings or on the room's bell stops a push that
 * waits or retries). Quiet notices never get here (they are never queued). */
export function noticeWanted(db: Database, noticeId: string): boolean {
  const r = db.query(`SELECT n.user_id, n.event_type, r.kind, m.muted, m.notify_level, s.thread_root_id FROM room_notices n
    JOIN room_members m ON m.room_id = n.room_id AND m.user_id = n.user_id JOIN rooms r ON r.id = n.room_id AND r.archived_at IS NULL
    LEFT JOIN room_messages s ON s.id = n.source_id WHERE n.id = ?`).get(noticeId) as { user_id: string; event_type: string; kind: string; muted: number; notify_level: string | null; thread_root_id: string | null } | null
  if (!r) return false
  const prefs = getPreferences(db, r.user_id)
  const level = roomLevel(r.kind, ownLevel(r), prefs.roomLevel)
  if (level === 'off') return false
  if (r.event_type === 'room.mention' || level === 'all') return true
  return !!r.thread_root_id && prefs.roomThreadReplies
}
