-- min_compatible_reader: 1
-- Component A: an Inbox row to the owners and admins when the AI could not start on this server (QA TC-3521): the
-- engine's sandbox could not set up its program (bwrap "Can't find source path …: Permission denied" after an update
-- left the app folder unreadable to the engine account), so every answer fails at once until the server is fixed. One
-- per breakage: the next one only after an answer worked again (notifications/service.ts notifyEngineStartFailed).
-- notification_inbox has a fixed event_type CHECK list and tables are never rebuilt, so it has its own table, as
-- hosting_notices does. Metadata only: the source is the first failed turn's id. Additive only (reader 1): an older
-- build does not list them.
CREATE TABLE engine_start_notices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('engine.start_failed')),
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT,
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK(suppressed IN (0,1)),
  UNIQUE(user_id,event_type,source_id)
);
CREATE INDEX engine_start_notices_user_page ON engine_start_notices(user_id,suppressed,created_at DESC,id DESC);
CREATE INDEX engine_start_notices_retention ON engine_start_notices(created_at);
