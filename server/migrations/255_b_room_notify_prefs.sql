-- Room notification settings (docs/DECISIONS.md "대화방 알림 설정", shared/src/api/room-alerts.ts). Additive only (reader 1):
-- an older build ignores the new columns and keeps reading room_members.muted and notification_preferences.room_messages,
-- which this build keeps in step, so it still mutes what is off and stays quiet for a person who chose nothing.
--   room_members.notify_level: my level for the room ('all', 'mentions', 'off'); NULL = my default. muted stays the
--     source of truth for 'off' (1 exactly when the level is 'off'; an older build that unmutes clears it).
--   notification_preferences.room_level: my default for rooms without a level ('direct', 'all', 'none'). room_messages
--     stays the source of truth for 'none' (0 exactly when it is 'none'); a person who had turned it off is 'none'.
--   notification_preferences.room_thread_replies: replies in threads I follow alert me (default on).
--   notification_preferences.quiet_*: quiet hours in the team's time zone, minutes after midnight (default off,
--     22:00–08:00), quiet_weekends: all of Saturday and Sunday too.
--   room_notices.quiet: made inside the person's quiet hours: it stays in the inbox and the badges but is never pushed,
--     and it does not hold back the next notice of the room once the quiet hours are over.
ALTER TABLE room_members ADD COLUMN notify_level TEXT CHECK(notify_level IN ('all','mentions','off'));
UPDATE room_members SET notify_level = 'off' WHERE muted = 1;
ALTER TABLE notification_preferences ADD COLUMN room_level TEXT NOT NULL DEFAULT 'direct' CHECK(room_level IN ('direct','all','none'));
UPDATE notification_preferences SET room_level = 'none' WHERE room_messages = 0;
ALTER TABLE notification_preferences ADD COLUMN room_thread_replies INTEGER NOT NULL DEFAULT 1 CHECK(room_thread_replies IN (0,1));
ALTER TABLE notification_preferences ADD COLUMN quiet_on INTEGER NOT NULL DEFAULT 0 CHECK(quiet_on IN (0,1));
ALTER TABLE notification_preferences ADD COLUMN quiet_start INTEGER NOT NULL DEFAULT 1320 CHECK(quiet_start BETWEEN 0 AND 1439);
ALTER TABLE notification_preferences ADD COLUMN quiet_end INTEGER NOT NULL DEFAULT 480 CHECK(quiet_end BETWEEN 0 AND 1439);
ALTER TABLE notification_preferences ADD COLUMN quiet_weekends INTEGER NOT NULL DEFAULT 0 CHECK(quiet_weekends IN (0,1));
ALTER TABLE room_notices ADD COLUMN quiet INTEGER NOT NULL DEFAULT 0 CHECK(quiet IN (0,1));
