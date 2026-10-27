import type { Database } from 'bun:sqlite'
import type { NotificationEventType, NotificationPreferences } from '@mycel/shared/api'
export function getPreferences(db: Database, userId: string): NotificationPreferences {
  const row = db.query('SELECT schedule_success, schedule_failure, connection_reconnect FROM notification_preferences WHERE user_id=?').get(userId) as { schedule_success: number; schedule_failure: number; connection_reconnect: number } | null
  return { scheduleSuccess: row ? !!row.schedule_success : true, scheduleFailure: row ? !!row.schedule_failure : true, connectionReconnect: row ? !!row.connection_reconnect : true }
}
export function savePreferences(db: Database, userId: string, patch: Partial<NotificationPreferences>): NotificationPreferences {
  const p = { ...getPreferences(db, userId), ...patch }
  db.query(`INSERT INTO notification_preferences(user_id,schedule_success,schedule_failure,connection_reconnect) VALUES(?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET schedule_success=excluded.schedule_success,schedule_failure=excluded.schedule_failure,connection_reconnect=excluded.connection_reconnect`)
    .run(userId, Number(p.scheduleSuccess), Number(p.scheduleFailure), Number(p.connectionReconnect))
  return p
}
export function eventEnabled(p: NotificationPreferences, event: NotificationEventType) {
  return event === 'schedule.success' ? p.scheduleSuccess : event === 'schedule.failure' ? p.scheduleFailure : p.connectionReconnect
}
