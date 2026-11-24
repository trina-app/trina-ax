-- min_compatible_reader: 1
-- Component A: the Inbox row "a Google account was connected to your account" (Sign in with Google, part A2;
-- docs/AGENTS/plan/20261122-0616-google-login-admin.md). A connected Google account signs its holder in as the person,
-- so the person gets this row whenever one is connected to their account (shown always): if someone else did it with
-- their password, they learn of it. notification_inbox has a fixed event_type CHECK list and tables are never rebuilt,
-- so it has its own table, as reset_link_notices does. Metadata only: the source is the connection's linked_at
-- (login_identities), never the Google account or its address; whether that same connection is still there is read
-- when the Inbox is read. Additive only (reader 1): an older build does not list it.
CREATE TABLE google_connect_notices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('account.google_connected')),
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT,
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK(suppressed IN (0,1)),
  UNIQUE(user_id,event_type,source_id)
);
CREATE INDEX google_connect_notices_user_page ON google_connect_notices(user_id,suppressed,created_at DESC,id DESC);
CREATE INDEX google_connect_notices_retention ON google_connect_notices(created_at);
