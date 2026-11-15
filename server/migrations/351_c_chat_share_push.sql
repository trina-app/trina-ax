-- min_compatible_reader: 1
-- Component C: a phone push when someone shares a chat with me by name (QA TC-1414, docs/DECISIONS.md "Chats shared
-- with me: a push that names the sharer").
--   chat_share_push_deliveries: the same columns as push_deliveries (server/src/notifications/push-service.ts SOURCES),
--     for chat_share_notices (298) of a share by name (named=1). A group's people get the Inbox row alone.
--   notification_preferences.chat_shares: Settings › Notifications "Chats shared with me" (default on). Off: no push;
--     the Inbox row stays.
-- Additive only (reader 1): an older build ignores the column and does not know the table.
CREATE TABLE chat_share_push_deliveries (
  notification_id TEXT NOT NULL REFERENCES chat_share_notices(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at TEXT NOT NULL,
  lease_until TEXT,
  expires_at TEXT NOT NULL,
  PRIMARY KEY(notification_id,subscription_id)
);
CREATE INDEX chat_share_push_deliveries_due ON chat_share_push_deliveries(state,next_at);

ALTER TABLE notification_preferences ADD COLUMN chat_shares INTEGER NOT NULL DEFAULT 1;
