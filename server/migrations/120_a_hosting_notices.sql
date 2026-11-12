-- min_compatible_reader: 1
-- Component A: Inbox rows for things done to the team from outside it (QA TC-348, TC-350). 'hosting.key_copied' and
-- 'hosting.exported' to the owners when the hosting service copied the AI connections' key (admin.js
-- credentials-escrow-out) or took a full export (admin.js archive --upload); 'relay.address_moved' to the owners and
-- admins when the relay stopped taking this server's key because the team address was moved to another key.
-- notification_inbox has a fixed event_type CHECK list and tables are never rebuilt, so they have their own table, as
-- reset_link_notices does. Metadata only: the source is the audit_log row id (the copies) or the relay_events row id
-- (the move). Additive only (reader 1): an older build does not list them.
CREATE TABLE hosting_notices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('hosting.key_copied','hosting.exported','relay.address_moved')),
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT,
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK(suppressed IN (0,1)),
  UNIQUE(user_id,event_type,source_id)
);
CREATE INDEX hosting_notices_user_page ON hosting_notices(user_id,suppressed,created_at DESC,id DESC);
CREATE INDEX hosting_notices_retention ON hosting_notices(created_at);
