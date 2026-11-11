-- min_compatible_reader: 1
-- Component C: a member asks the owner and the admins to add an app the team has not set up (Google Drive, Gmail,
-- Google Calendar, Google Docs, Google Sheets; server/src/integrations/service-requests.ts, docs/INTEGRATIONS.md
-- "A member asks for an app").
--   service_requests: one member's ask for one app. At most one open row per member and app (closed_at NULL);
--     closed_reason: added (the member can connect it now), expired (after the inbox's 30 days), left (the member left
--     the team or became an owner or admin). No free text: the app is one of a fixed list of ids.
--   service_request_notices: inbox rows. 'service.request': to each owner and admin, the source is the app's id (one row
--     per person and app, armed again by a new ask, so many asks are one notice); 'service.ready': to the member who
--     asked, the source is the request's id. notification_inbox has a fixed event_type CHECK list and tables are never
--     rebuilt, so these notices get their own table, as the other notices do. Metadata only: never a name.
-- Additive only (reader 1): an older build does not know the tables.
CREATE TABLE service_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service TEXT NOT NULL,
  created_at TEXT NOT NULL,
  closed_at TEXT,
  closed_reason TEXT CHECK(closed_reason IN ('added','expired','left'))
);
CREATE UNIQUE INDEX service_requests_open ON service_requests(user_id, service) WHERE closed_at IS NULL;
CREATE INDEX service_requests_service ON service_requests(service, closed_at);
CREATE INDEX service_requests_user_created ON service_requests(user_id, created_at);
CREATE TABLE service_request_notices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('service.request','service.ready')),
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT,
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK(suppressed IN (0,1)),
  UNIQUE(user_id,event_type,source_id)
);
CREATE INDEX service_request_notices_user_page ON service_request_notices(user_id,suppressed,created_at DESC,id DESC);
CREATE INDEX service_request_notices_retention ON service_request_notices(created_at);
