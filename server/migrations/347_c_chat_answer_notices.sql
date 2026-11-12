-- min_compatible_reader: 1
-- Component C: a push when an answer in my own AI chat needs me (QA TC-442, docs/DECISIONS.md "AI 답변 알림").
--   chat_answer_notices: one row per answer for the person who asked it (the turn's user): 'chat.answer_done' with
--     kind done (it finished), failed (it ended with an error) or waiting (the AI asks the person something or waits for
--     a yes/no card). The source is the turn's id (a card: '<turn>.ask', at most one per turn); chat_id is the chat a
--     tap opens. push_at: the earliest time it is pushed (a window that has the chat on screen marks the answer seen
--     meanwhile, and then nothing is pushed). Not listed in the Inbox. notification_inbox has a fixed event_type CHECK
--     list and tables are never rebuilt, so these have their own table, as the other notices do. Metadata only: never
--     the chat's title or the answer's text.
--   chat_answer_push_deliveries: the same columns as push_deliveries (server/src/notifications/push-service.ts SOURCES).
--   notification_preferences.chat_answers: Settings › Notifications "AI answers" (default on).
-- Additive only (reader 1): an older build ignores the column and does not know the tables.
CREATE TABLE chat_answer_notices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('chat.answer_done')),
  source_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('done','failed','waiting')),
  created_at TEXT NOT NULL,
  push_at TEXT NOT NULL,
  read_at TEXT,
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK(suppressed IN (0,1)),
  UNIQUE(user_id,event_type,source_id)
);
CREATE INDEX chat_answer_notices_chat ON chat_answer_notices(user_id,chat_id,created_at);
CREATE INDEX chat_answer_notices_retention ON chat_answer_notices(created_at);

CREATE TABLE chat_answer_push_deliveries (
  notification_id TEXT NOT NULL REFERENCES chat_answer_notices(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at TEXT NOT NULL,
  lease_until TEXT,
  expires_at TEXT NOT NULL,
  PRIMARY KEY(notification_id,subscription_id)
);
CREATE INDEX chat_answer_push_deliveries_due ON chat_answer_push_deliveries(state,next_at);

ALTER TABLE notification_preferences ADD COLUMN chat_answers INTEGER NOT NULL DEFAULT 1;
