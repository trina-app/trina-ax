-- min_compatible_reader: 1
-- Component B: room notices in the Inbox say who, where and why (docs/DECISIONS.md "알림함의 대화 알림"). Additive only.
--   room_notices.last_seq / last_at: the newest message this notice held back while it was unread (one notice per kind
--     and unread run: Notifications.roomNotice). The Inbox's row of a place (a thread, a room's timeline) counts and
--     shows the run's messages up to there and sits where the newest is; NULL = the notice's own message only. Kept
--     once read: a run ends when it is read, and its row stays as it was then.
-- An older build ignores the columns: a notice is its own message there (nothing is exposed, nothing else changes).
-- Numbered 262: 261 is feat/answer-to-room's.
ALTER TABLE room_notices ADD COLUMN last_seq INTEGER;
ALTER TABLE room_notices ADD COLUMN last_at TEXT;
