import type { Database } from 'bun:sqlite'
import type { NotificationEventType, NotificationPreferences } from '@mycel/shared/api'
export function getPreferences(db: Database, userId: string): NotificationPreferences {
  const row = db.query('SELECT schedule_success, schedule_failure, connection_reconnect, skill_suggestions FROM notification_preferences WHERE user_id=?').get(userId) as { schedule_success: number; schedule_failure: number; connection_reconnect: number; skill_suggestions: number } | null
  return { scheduleSuccess: row ? !!row.schedule_success : true, scheduleFailure: row ? !!row.schedule_failure : true, connectionReconnect: row ? !!row.connection_reconnect : true, skillSuggestions: row ? !!row.skill_suggestions : true }
}
export function savePreferences(db: Database, userId: string, patch: Partial<NotificationPreferences>): NotificationPreferences {
  const p = { ...getPreferences(db, userId), ...patch }
  db.query(`INSERT INTO notification_preferences(user_id,schedule_success,schedule_failure,connection_reconnect,skill_suggestions) VALUES(?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET schedule_success=excluded.schedule_success,schedule_failure=excluded.schedule_failure,connection_reconnect=excluded.connection_reconnect,skill_suggestions=excluded.skill_suggestions`)
    .run(userId, Number(p.scheduleSuccess), Number(p.scheduleFailure), Number(p.connectionReconnect), Number(p.skillSuggestions))
  return p
}
export function eventEnabled(p: NotificationPreferences, event: NotificationEventType) {
  switch (event) {
    case 'schedule.success': return p.scheduleSuccess
    case 'schedule.failure': return p.scheduleFailure
    case 'connection.reconnect': return p.connectionReconnect
    case 'skill.suggested': case 'skill.reviewed': return p.skillSuggestions
  }
}
