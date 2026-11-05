-- min_compatible_reader: 1
-- Room notices ("대화방" v1): a DM message or an @mention puts a row in the person's inbox and, when they turned OS push
-- on, a push. notification_inbox has a fixed event_type CHECK list and tables are never rebuilt, so these notices get
-- their own table, and their own deliveries table because push_deliveries refers to notification_inbox only. The push
-- service sends from both (server/src/notifications/push-service.ts, push sources).
--   room_notices: source_id = the message id, room_id = its room; never the message's text. A DM sends one notice per
--     unread run (no new one while one of that room is unread); reading the room marks its notices read.
--   room_push_deliveries: the same columns as push_deliveries.
--   notification_preferences.room_messages: the person's switch for both (default on).
-- Additive only (reader 1).
CREATE TABLE room_notices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('room.dm','room.mention')),
  source_id TEXT NOT NULL,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  read_at TEXT,
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK(suppressed IN (0,1)),
  UNIQUE(user_id, event_type, source_id)
);
CREATE INDEX room_notices_user_page ON room_notices(user_id, suppressed, created_at DESC, id DESC);
CREATE INDEX room_notices_retention ON room_notices(created_at);
CREATE INDEX room_notices_room ON room_notices(user_id, room_id, read_at);
CREATE TABLE room_push_deliveries (
  notification_id TEXT NOT NULL REFERENCES room_notices(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at TEXT NOT NULL,
  lease_until TEXT,
  expires_at TEXT NOT NULL,
  PRIMARY KEY(notification_id, subscription_id)
);
CREATE INDEX room_push_deliveries_due ON room_push_deliveries(state, next_at);
ALTER TABLE notification_preferences ADD COLUMN room_messages INTEGER NOT NULL DEFAULT 1 CHECK(room_messages IN (0,1));
