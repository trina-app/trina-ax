-- min_compatible_reader: 1
-- Component B: leaving a chat shared with people, and saying who lost access and why (scenario QA 11-22, plan
-- docs/AGENTS/plan/20261122-0027-shared-chat-ux-gaps.md; docs/decisions/20261122-shared-chat-leave-and-lost-notices.md).
--   chat_audience_events: who changed a chat's people and how ("{actor} added {names}", "{actor} removed {names}",
--     "{actor} left"), shown between its messages. `subjects`: JSON [{"t":"user"|"group","id":"…"}], ids only (names are
--     read when shown). Deleted with the chat.
--   chat_lost_notices: the Inbox's 'chat.lost' rows: someone stopped sharing a chat with the person ('stopped'), moved
--     it to the trash ('deleted') or its creator's account was deleted ('account'). Ids only, never the title (the
--     chat's title is shown only while the reader still sees it). At most one per person, chat, reason and day.
--     notification_inbox has a fixed event_type CHECK list and tables are never rebuilt, so these get their own table,
--     as chat_share_notices (298) did.
--   messages.stopped_for: why an answer was stopped for its requester ('requester_removed': their account was deleted;
--     'requester_disabled': switched off). messages.stop_reason holds only the two per-answer limits (212, a CHECK).
-- Additive only (reader 1): an older build never reads them.
CREATE TABLE chat_audience_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('added', 'removed', 'left')),
  subjects TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX chat_audience_events_chat ON chat_audience_events(chat_id, at);

CREATE TABLE chat_lost_notices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('chat.lost')),
  source_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  by_user TEXT,
  reason TEXT NOT NULL CHECK (reason IN ('stopped', 'deleted', 'account')),
  day TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT,
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK(suppressed IN (0,1)),
  UNIQUE(user_id,event_type,source_id)
);
CREATE INDEX chat_lost_notices_user_page ON chat_lost_notices(user_id,suppressed,created_at DESC,id DESC);
CREATE INDEX chat_lost_notices_retention ON chat_lost_notices(created_at);
CREATE INDEX chat_lost_notices_chat ON chat_lost_notices(chat_id);

ALTER TABLE messages ADD COLUMN stopped_for TEXT CHECK(stopped_for IS NULL OR stopped_for IN ('requester_removed','requester_disabled'));
