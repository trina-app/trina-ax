-- min_compatible_reader: 1
-- Component B: the message's first line in a room notification on a device (docs/DECISIONS.md "알림 미리보기").
--   notification_preferences.message_preview: a room push and the desktop app's notification show the message's first
--     line (default on, as Slack does). Off: who and where only, with the generic line (the behaviour before this).
-- Additive only (reader 1): an older build ignores the column and shows the generic line.
-- Numbered 275: 274 (chat_deleted_by) is the highest on dev.
ALTER TABLE notification_preferences ADD COLUMN message_preview INTEGER NOT NULL DEFAULT 1 CHECK(message_preview IN (0,1));
