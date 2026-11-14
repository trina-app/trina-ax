-- min_compatible_reader: 1
-- Push for the "app paused" notice of apps posting in rooms, and the "someone who left knows the address" notice (docs/DECISIONS.md "Apps posting in rooms", "Paused push";
-- plan docs/AGENTS/plan/20261114-0900-room-apps.md "6. Paused notice"). Numbered as component C: component B's range
-- (200-299) is full (299_b_room_apps.sql took the last number), and 350 is the highest C number here; the push pipeline
-- (server/src/notifications/push-service.ts SOURCES) is C's.
--   room_app_push_deliveries: the same columns as push_deliveries / chat_answer_push_deliveries, for room_app_notices
--     (migration 299). A notice is pushed through the normal pipeline while it is unread, the app is still there and
--     still paused, and the person is still in its room (rooms/apps/notice.ts roomAppPushWanted). No setting of its own.
--   room_app_leaver_notices: the "someone who left knows the address of <app>" notice in Activity (Activity only, never
--     pushed) to the people who may manage the app, once someone who was shown its address (or a secret Trina made) can
--     no longer manage it (rooms/apps/service.ts leaverSweep). The same columns as room_app_notices (299), a table of its
--     own because room_app_notices has a fixed event_type CHECK list and tables are never rebuilt. source_id
--     "<app id>.<first 12 of the address's token hash>": one notice per person and address; "Get a new address" marks
--     them read, and a later leaver of the new address makes a new one.
-- Additive only (reader 1): an older build does not know the tables.
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

CREATE TABLE room_app_leaver_notices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('room_app.leaver')),
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT,
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK(suppressed IN (0,1)),
  UNIQUE(user_id,event_type,source_id)
);
CREATE INDEX room_app_leaver_notices_user_page ON room_app_leaver_notices(user_id,suppressed,created_at DESC,id DESC);
CREATE INDEX room_app_leaver_notices_retention ON room_app_leaver_notices(created_at);
