-- min_compatible_reader: 1
-- Push for the "app paused" notice of apps posting in rooms (docs/DECISIONS.md "Apps posting in rooms", "Paused push";
-- plan docs/AGENTS/plan/20261114-0900-room-apps.md "6. Paused notice"). Numbered as component C: component B's range
-- (200-299) is full (299_b_room_apps.sql took the last number), and 350 is the highest C number here; the push pipeline
-- (server/src/notifications/push-service.ts SOURCES) is C's.
--   room_app_push_deliveries: the same columns as push_deliveries / chat_answer_push_deliveries, for room_app_notices
--     (migration 299). A notice is pushed through the normal pipeline while it is unread, the app is still there and
--     still paused, and the person is still in its room (rooms/apps/notice.ts roomAppPushWanted). No setting of its own.
-- Additive only (reader 1): an older build does not know the table.
CREATE TABLE room_app_push_deliveries (
  notification_id TEXT NOT NULL REFERENCES room_app_notices(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at TEXT NOT NULL,
  lease_until TEXT,
  expires_at TEXT NOT NULL,
  PRIMARY KEY(notification_id,subscription_id)
);
CREATE INDEX room_app_push_deliveries_due ON room_app_push_deliveries(state,next_at);
