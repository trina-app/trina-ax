-- min_compatible_reader: 1
-- Status messages (docs/DECISIONS.md "상태 메시지"; server/src/auth/status-messages.ts): an emoji, a short text and
--   when it clears.
--   user_status_messages: at most one row per person, set by them alone (PUT /api/me/status).
--     emoji       one emoji (or one emoji sequence), checked by shared/src/status-message.ts
--     text        up to 100 characters, trimmed, one line; may be empty (an emoji alone)
--     clear       what was chosen: never | 30m | 1h | 2h | today | week | dates
--     starts_at   ISO instant from when the team sees it (a vacation that starts later); NULL: at once
--     clears_at   ISO instant from when nobody sees it (the row is then removed); NULL: until its person clears it
--     until_day   the last day it shows ("YYYY-MM-DD", the team's time zone) when it clears at the end of a day
--                 (today, this week, chosen days); NULL when it clears at a time or never
--     updated_at  ISO instant of the last write
--   Read only through the people directory, the person's own account (GET /api/people, /api/me) and the AI's lines of
--   who is in a room (rooms/reader.ts, the connector's people_list), which show it between starts_at and clears_at, for
--   active accounts only. The row goes with the person (cascade, and
--   admin/users.ts deleteUser: the users row stays as a tombstone).
-- Additive only (reader 1): an older build ignores the table (no statuses shown).
-- Numbered 283: 280 (project_folder_made) is the highest on dev; 281 and 282 are taken by open branches.
CREATE TABLE user_status_messages (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  clear TEXT NOT NULL,
  starts_at TEXT,
  clears_at TEXT,
  until_day TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX user_status_messages_clears ON user_status_messages(clears_at) WHERE clears_at IS NOT NULL;
CREATE INDEX user_status_messages_starts ON user_status_messages(starts_at) WHERE starts_at IS NOT NULL;
