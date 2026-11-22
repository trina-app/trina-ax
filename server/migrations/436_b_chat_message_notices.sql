-- min_compatible_reader: 1
-- Component B: a new message in a chat shared with people tells the others (docs/decisions/
-- 20261122-shared-chat-new-message-notices.md; server/src/chat/message-notices.ts). 436: 435 is taken by an open branch
-- (shared-chat leave notices).
--   chat_message_notices: one row per message and person who sees the chat (never its sender). kind 'message': a
--     person's message (pushed while it holds); kind 'answer': Trina's answer to someone else (the unread number only,
--     never pushed). quiet: made inside the person's quiet hours, never pushed. mention: the message mentions them ("@" in the box: it reaches them in a chat they muted too).
--     source_id is the message, so the Inbox
--     reads it like every notice table (it never lists these: the chat row's number shows them). Metadata only.
--   chat_message_push_deliveries: the same columns as push_deliveries (server/src/notifications/push-service.ts SOURCES).
--   chat_mutes: "Mute this chat": no notices for that person in that chat but the ones that mention them.
-- Additive only (reader 1): an older build does not know the tables; after a rollback nothing reads them.
CREATE TABLE chat_message_notices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('chat.message')),
  source_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  by_user TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('message','answer')),
  created_at TEXT NOT NULL,
  read_at TEXT,
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK(suppressed IN (0,1)),
  quiet INTEGER NOT NULL DEFAULT 0 CHECK(quiet IN (0,1)),
  mention INTEGER NOT NULL DEFAULT 0 CHECK(mention IN (0,1)),
  UNIQUE(user_id, event_type, source_id)
);
CREATE INDEX chat_message_notices_unread ON chat_message_notices(user_id, chat_id, read_at);
CREATE INDEX chat_message_notices_chat ON chat_message_notices(chat_id);
CREATE INDEX chat_message_notices_source ON chat_message_notices(source_id);
CREATE INDEX chat_message_notices_retention ON chat_message_notices(created_at);

CREATE TABLE chat_message_push_deliveries (
  notification_id TEXT NOT NULL REFERENCES chat_message_notices(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at TEXT NOT NULL,
  lease_until TEXT,
  expires_at TEXT NOT NULL,
  PRIMARY KEY(notification_id,subscription_id)
);
CREATE INDEX chat_message_push_deliveries_due ON chat_message_push_deliveries(state,next_at);

CREATE TABLE chat_mutes (
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(chat_id, user_id)
);
