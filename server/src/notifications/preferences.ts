import type { Database } from 'bun:sqlite'
import type { NotificationEventType, NotificationPreferences } from '@mycel/shared/api'
export function getPreferences(db: Database, userId: string): NotificationPreferences {
  const row = db.query('SELECT schedule_success, schedule_failure, connection_reconnect, skill_suggestions, room_messages FROM notification_preferences WHERE user_id=?').get(userId) as { schedule_success: number; schedule_failure: number; connection_reconnect: number; skill_suggestions: number; room_messages: number } | null
  return { scheduleSuccess: row ? !!row.schedule_success : true, scheduleFailure: row ? !!row.schedule_failure : true, connectionReconnect: row ? !!row.connection_reconnect : true, skillSuggestions: row ? !!row.skill_suggestions : true, roomMessages: row ? !!row.room_messages : true }
}
export function savePreferences(db: Database, userId: string, patch: Partial<NotificationPreferences>): NotificationPreferences {
  const p = { ...getPreferences(db, userId), ...patch }
  db.query(`INSERT INTO notification_preferences(user_id,schedule_success,schedule_failure,connection_reconnect,skill_suggestions,room_messages) VALUES(?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET schedule_success=excluded.schedule_success,schedule_failure=excluded.schedule_failure,connection_reconnect=excluded.connection_reconnect,skill_suggestions=excluded.skill_suggestions,room_messages=excluded.room_messages`)
    .run(userId, Number(p.scheduleSuccess), Number(p.scheduleFailure), Number(p.connectionReconnect), Number(p.skillSuggestions), Number(p.roomMessages !== false))
  return p
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
    // someone joined through the team invite link (shown always, Notifications.teamJoined)
    case 'team.joined': return true
    // a DM message or an @mention in a room (Notifications.roomNotice)
    case 'room.dm': case 'room.mention': return p.roomMessages !== false
    // a person asks the owner to delete their account (shown always, Notifications.deletionRequest)
    case 'account.deletion_request': return true
    // a Drive shared with the team stopped and needs an admin's new sign-in (shown always, Notifications.driveShareReconnect)
    case 'drive.share_reconnect': return true
    // an admin changed the team's AI (told to the owners), or switched off / removed a member's own connection (told to them)
    case 'credential.change': return true
  }
}
