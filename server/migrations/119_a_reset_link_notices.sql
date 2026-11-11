-- min_compatible_reader: 1
-- Component A: the Inbox row "a password reset link was made for your account" (QA TC-202). A reset link signs its
-- holder in as the person, and one made on the server (mycel-account / mycel-ctl reset-link) or by an admin used to
-- leave only an audit line. The person it is for gets this row (shown always). notification_inbox has a fixed
-- event_type CHECK list and tables are never rebuilt, so it has its own table, as team_join_notices does. Metadata
-- only: the source is the password_resets row id (never the token); who made it and whether it still works are read
-- from that row when the Inbox is read. Additive only (reader 1): an older build does not list it.
CREATE TABLE reset_link_notices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('account.reset_link')),
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT,
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK(suppressed IN (0,1)),
  UNIQUE(user_id,event_type,source_id)
);
CREATE INDEX reset_link_notices_user_page ON reset_link_notices(user_id,suppressed,created_at DESC,id DESC);
CREATE INDEX reset_link_notices_retention ON reset_link_notices(created_at);
