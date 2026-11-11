import type { Database } from 'bun:sqlite'
import { QUIET_HOURS_DEFAULT, type NotificationEventType, type NotificationPreferences, type QuietHours, type RoomNotifyDefault } from '@mycel/shared/api'

/** Every field filled (what this server reads and answers; the contract keeps the room fields optional for older servers). */
export type Preferences = Required<NotificationPreferences>
type Row = {
  schedule_success: number; schedule_failure: number; connection_reconnect: number; skill_suggestions: number; room_messages: number
  room_level: string; room_thread_replies: number; message_preview: number; quiet_on: number; quiet_start: number; quiet_end: number; quiet_weekends: number
}
const COLS = 'schedule_success, schedule_failure, connection_reconnect, skill_suggestions, room_messages, room_level, room_thread_replies, message_preview, quiet_on, quiet_start, quiet_end, quiet_weekends'
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
const mins = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5))

/** The room default (migration 255): room_messages decides 'none' (an older build that turns it on or off is followed),
 * room_level the rest. */
function roomDefault(row: Pick<Row, 'room_messages' | 'room_level'> | null): RoomNotifyDefault {
  if (!row) return 'direct'
  if (!row.room_messages) return 'none'
  return row.room_level === 'all' ? 'all' : 'direct'
}
export function preferencesOf(row: Row | null): Preferences {
  const level = roomDefault(row)
  const quietHours: QuietHours = row ? { on: !!row.quiet_on, start: hhmm(row.quiet_start), end: hhmm(row.quiet_end), weekends: !!row.quiet_weekends } : { ...QUIET_HOURS_DEFAULT }
  return {
    scheduleSuccess: row ? !!row.schedule_success : true, scheduleFailure: row ? !!row.schedule_failure : true, connectionReconnect: row ? !!row.connection_reconnect : true, skillSuggestions: row ? !!row.skill_suggestions : true,
    roomMessages: level !== 'none', roomLevel: level, roomThreadReplies: row ? !!row.room_thread_replies : true, messagePreview: row ? !!row.message_preview : true, quietHours,
  }
}
export function getPreferences(db: Database, userId: string): Preferences {
  return preferencesOf(db.query(`SELECT ${COLS} FROM notification_preferences WHERE user_id=?`).get(userId) as Row | null)
}
/** Several people's preferences at once (a room's members: rooms/alerts.ts). Nobody without a row gets the defaults. */
export function getPreferencesOf(db: Database, userIds: readonly string[]): Map<string, Preferences> {
  const out = new Map<string, Preferences>()
  for (let i = 0; i < userIds.length; i += 500) {
    const part = userIds.slice(i, i + 500)
    const rows = db.query(`SELECT user_id, ${COLS} FROM notification_preferences WHERE user_id IN (${part.map(() => '?').join(',')})`).all(...part) as (Row & { user_id: string })[]
    for (const r of rows) out.set(r.user_id, preferencesOf(r))
  }
  for (const u of userIds) if (!out.has(u)) out.set(u, preferencesOf(null))
  return out
}
/** roomMessages (older apps): false is 'none'; true brings 'none' back to 'direct' and leaves 'all' alone. roomLevel wins. */
export function savePreferences(db: Database, userId: string, patch: Partial<NotificationPreferences>): Preferences {
  const before = getPreferences(db, userId)
  const level: RoomNotifyDefault = patch.roomLevel ?? (patch.roomMessages === false ? 'none' : patch.roomMessages === true && before.roomLevel === 'none' ? 'direct' : before.roomLevel)
  const p: Preferences = { ...before, ...patch, roomLevel: level, roomMessages: level !== 'none', quietHours: patch.quietHours ?? before.quietHours, roomThreadReplies: patch.roomThreadReplies ?? before.roomThreadReplies, messagePreview: patch.messagePreview ?? before.messagePreview }
  db.query(`INSERT INTO notification_preferences(user_id,${COLS}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET schedule_success=excluded.schedule_success,schedule_failure=excluded.schedule_failure,connection_reconnect=excluded.connection_reconnect,skill_suggestions=excluded.skill_suggestions,room_messages=excluded.room_messages,
    room_level=excluded.room_level,room_thread_replies=excluded.room_thread_replies,message_preview=excluded.message_preview,quiet_on=excluded.quiet_on,quiet_start=excluded.quiet_start,quiet_end=excluded.quiet_end,quiet_weekends=excluded.quiet_weekends`)
    .run(userId, Number(p.scheduleSuccess), Number(p.scheduleFailure), Number(p.connectionReconnect), Number(p.skillSuggestions), Number(level !== 'none'),
      level, Number(p.roomThreadReplies), Number(p.messagePreview), Number(p.quietHours.on), mins(p.quietHours.start), mins(p.quietHours.end), Number(p.quietHours.weekends))
  return p
}
/** Did a change touch what decides room alerts (the app reloads its rooms then: each one's level, the quiet hours, the
 * message preview)? */
export function roomAlertsChanged(a: Preferences, b: Preferences): boolean {
  return a.roomLevel !== b.roomLevel || a.roomThreadReplies !== b.roomThreadReplies || a.messagePreview !== b.messagePreview || JSON.stringify(a.quietHours) !== JSON.stringify(b.quietHours)
}
export function eventEnabled(p: NotificationPreferences, event: NotificationEventType) {
  switch (event) {
    case 'schedule.success': return p.scheduleSuccess
    case 'schedule.failure': return p.scheduleFailure
    case 'connection.reconnect': return p.connectionReconnect
    case 'skill.suggested': case 'skill.reviewed': return p.skillSuggestions
    // no setting of their own: a job the person started, a box that stopped
    case 'dev_env.job': case 'dev_env.box': return true
    // an admin waits for the answer (shown always, Notifications.integrationRequest)
    case 'integration.request': return true
    // a member without AI asks the owner (shown always: the member cannot work until it is answered)
    case 'onboarding.ai_request': return true
    // someone joined the team, whichever way (shown always, Notifications.teamJoined)
    case 'team.joined': return true
    // someone started to see a project the person is in (shown always, Notifications.projectJoined)
    case 'project.joined': return true
    // a message, an @mention or a followed thread's reply in a room: each room's level decides, per message and person,
    // whether there is a notice at all (rooms/service.ts notify, shared room-alerts.ts), and the push checks it again
    // (rooms/alerts.ts noticeWanted); a person's default 'none' is 'off' for every room without a level of its own
    case 'room.dm': case 'room.mention': return true
    // a person asks the owner to delete their account (shown always, Notifications.deletionRequest)
    case 'account.deletion_request': return true
    // a Drive shared with the team stopped and needs an admin's new sign-in (shown always, Notifications.driveShareReconnect)
    case 'drive.share_reconnect': return true
    // an admin changed the team's AI (told to the owners), or switched off / removed a member's own connection (told to them)
    case 'credential.change': return true
    // 팀장 넘기기 (admin/handover.ts): a join with the owner's lead link (also pushed), a transfer, a locked password check
    case 'owner.lead_joined': case 'owner.transferred': case 'owner.reauth_locked': return true
  }
}
