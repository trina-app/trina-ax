-- min_compatible_reader: 1
-- Component B: small UX follow-ups of the 11-22 scenario QA (plan docs/AGENTS/plan/20261122-0820-qa-ux-followups-1122.md;
-- docs/decisions/20261122-qa-ux-followups-1122.md).
--   chat_file_events: "{actor} restored {file} to version {n}" between a shared chat's messages (S-032). `file_id`: the
--     chain's root (chat_files), so the line shows only to people who may open that file. Ids and a number only (the
--     file's name is read when shown). Deleted with the chat.
--   chat_left_notices: the Activity row 'chat.left' for a chat's creator: "{name} left a chat you shared" (S-010).
--     notification_inbox has a fixed event_type CHECK list and tables are never rebuilt, so it gets its own table, as
--     chat_lost_notices (435) did. At most one per creator, chat, person who left and day. Ids only.
-- 439: 438 is the highest on dev and in batch 20261122-i; no open branch uses 439.
-- Additive only (reader 1): an older build never reads them.
CREATE TABLE chat_file_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('restored')),
  file_id TEXT NOT NULL,
  version INTEGER NOT NULL
);
CREATE INDEX chat_file_events_chat ON chat_file_events(chat_id, at);

CREATE TABLE chat_left_notices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('chat.left')),
  source_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  by_user TEXT,
  day TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT,
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK(suppressed IN (0,1)),
  UNIQUE(user_id,event_type,source_id)
);
CREATE INDEX chat_left_notices_user_page ON chat_left_notices(user_id,suppressed,created_at DESC,id DESC);
CREATE INDEX chat_left_notices_retention ON chat_left_notices(created_at);
CREATE INDEX chat_left_notices_chat ON chat_left_notices(chat_id);
