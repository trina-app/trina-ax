-- min_compatible_reader: 1
-- A member's ask to add an app (migration 343, server/src/integrations/service-requests.ts) that closed without the
-- app: an owner or admin pressed Dismiss, or it waited the inbox's 30 days. The page told the member "We'll tell you
-- when it is ready", so they are told it was closed and that they may ask again (QA TC-2946).
--   service_request_closed_notices: 'service.closed' to the member who asked, the source is the request's id (one per
--     request). The same columns as service_request_notices (343), a table of its own because that one has a fixed
--     event_type CHECK list and tables are never rebuilt. Activity only, never pushed. Metadata only: never a name.
--     How it closed is the request's closed_reason ('expired', or NULL for a dismissed one), read when it is shown.
-- Additive only (reader 1): an older build does not know the table.
CREATE TABLE service_request_closed_notices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('service.closed')),
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT,
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK(suppressed IN (0,1)),
  UNIQUE(user_id,event_type,source_id)
);
CREATE INDEX service_request_closed_notices_user_page ON service_request_closed_notices(user_id,suppressed,created_at DESC,id DESC);
CREATE INDEX service_request_closed_notices_retention ON service_request_closed_notices(created_at);
