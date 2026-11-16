-- min_compatible_reader: 1
-- Component B: threads on AI answers in shared chats (docs/decisions/20261116-chat-answer-threads.md). Teammates who
-- see a shared chat talk under one AI answer; the AI never reads these tables (server/src/chat/threads.ts). 408 is in
-- B's second range; 407 was taken by an open branch (file shares) when this was written.
--   chat_thread_replies: one row per reply under an answer (root_id, one answer version). author_id has no foreign key:
--     a removed account's replies stay under its tombstone name, as messages.author_id. client_id: the sender's id for
--     this send, so a send again after a lost connection posts once. A deleted reply's row goes (no tombstone).
--   chat_thread_follows: who follows a thread (the answer's asker and everyone who replied) and the newest reply each
--     has read.
--   chat_thread_notices: one unread notice per thread and person (the partial unique index); a new reply updates the
--     open row in place (by_user: the newest replier, reply_id: the newest reply). source_id is the thread's answer, so
--     the Inbox reads it like every notice table. push_at: the earliest time it is pushed (someone with the thread on
--     screen reads it meanwhile). Metadata only: never the chat's title or a reply's text.
--   chat_thread_push_deliveries: the same columns as push_deliveries (server/src/notifications/push-service.ts SOURCES).
-- No new setting: "Replies in threads I'm part of" (notification_preferences.room_thread_replies) decides the push.
-- Additive only (reader 1): an older build does not know the tables; after a rollback the threads are not shown and
-- nothing else reads them.
CREATE TABLE chat_thread_replies (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  root_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  author_id TEXT,
  content TEXT NOT NULL,
  client_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX chat_thread_replies_root ON chat_thread_replies(root_id, id);
CREATE UNIQUE INDEX chat_thread_replies_client ON chat_thread_replies(author_id, client_id) WHERE client_id IS NOT NULL;
CREATE INDEX chat_thread_replies_author ON chat_thread_replies(author_id);
CREATE INDEX chat_thread_replies_chat ON chat_thread_replies(chat_id, root_id);

CREATE TABLE chat_thread_follows (
  root_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  last_read_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (root_id, user_id)
);
CREATE INDEX chat_thread_follows_user ON chat_thread_follows(user_id, chat_id);

CREATE TABLE chat_thread_notices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('chat.thread_reply')),
  source_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  by_user TEXT,
  reply_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  push_at TEXT NOT NULL,
  read_at TEXT,
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK(suppressed IN (0,1))
);
CREATE UNIQUE INDEX chat_thread_notices_open ON chat_thread_notices(user_id, source_id) WHERE read_at IS NULL;
CREATE INDEX chat_thread_notices_user ON chat_thread_notices(user_id, created_at);
CREATE INDEX chat_thread_notices_retention ON chat_thread_notices(created_at);

CREATE TABLE chat_thread_push_deliveries (
  notification_id TEXT NOT NULL REFERENCES chat_thread_notices(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at TEXT NOT NULL,
  lease_until TEXT,
  expires_at TEXT NOT NULL,
  PRIMARY KEY(notification_id,subscription_id)
);
CREATE INDEX chat_thread_push_deliveries_due ON chat_thread_push_deliveries(state,next_at);
