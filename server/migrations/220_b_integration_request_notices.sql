-- min_compatible_reader: 1
-- Component B: the inbox rows of an admin's request to connect a service as one's own connection
-- (server/src/notifications/service.ts, server/src/integrations/connections/requests.ts).
--   integration_request_notices: one row per request for its member. notification_inbox has a fixed event_type CHECK
--     list and tables are never rebuilt, so these notices get their own table, as skill_notices and dev_env_notices
--     do. Metadata only: the request id, never the service's name or address. No OS push: push_deliveries refers to
--     notification_inbox only.
-- Additive only (reader 1): an older build does not know the table.
CREATE TABLE integration_request_notices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('integration.request')),
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT,
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK(suppressed IN (0,1)),
  UNIQUE(user_id,event_type,source_id)
);
CREATE INDEX integration_request_notices_user_page ON integration_request_notices(user_id,suppressed,created_at DESC,id DESC);
CREATE INDEX integration_request_notices_retention ON integration_request_notices(created_at);
