-- min_compatible_reader: 1
-- Component A: the inbox rows for changes to the team's AI. An admin adds, replaces, removes, switches off, reassigns or
-- limits a team AI connection, turns on shared subscriptions or edits the API engine: each owner gets a row (who, what,
-- and the connection's name or the engine's address and model: never a token or key). An admin who switches off or
-- removes a member's own connection tells that member the same way. notification_inbox has a fixed event_type CHECK
-- list and tables are never rebuilt, so these rows have their own table (same shape as drive_share_notices, plus
-- the words: actor_name, action (no CHECK list: a later build may add actions; a reader shows a generic line for one it does not know), subject). Additive only (reader 1): an older build does not list them.
CREATE TABLE credential_change_notices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('credential.change')),
  source_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  read_at TEXT,
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK(suppressed IN (0,1)),
  UNIQUE(user_id,event_type,source_id)
);
CREATE INDEX credential_change_notices_user_page ON credential_change_notices(user_id,suppressed,created_at DESC,id DESC);
CREATE INDEX credential_change_notices_retention ON credential_change_notices(created_at);
