-- min_compatible_reader: 1
-- Files the AI saved before fix/files-hide-keys (docs/DECISIONS.md "Stored keys are hidden in the files the AI saves")
-- that still hold one of their person's stored connection keys, found once at a server start
-- (server/src/integrations/connections/file-scan.ts, settings key 'files.storedKeyScan'; QA TC-3082). Nothing is
-- rewritten: the person is told.
--   stored_key_files: the person whose key it is (whose AI turn saved the file) and the file's team path. Paths only,
--     never the key or the text around it. Which of them the person may open is read when the notice is shown.
--   stored_key_file_notices: 'files.stored_key' to that person, one per person (source 'scan'). The same columns as
--     service_request_closed_notices (353), a table of its own because notification_inbox has a fixed event_type
--     CHECK list and tables are never rebuilt. Activity only, never pushed.
-- Additive only (reader 1): an older build does not know the tables.
CREATE TABLE stored_key_files (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  found_at TEXT NOT NULL,
  PRIMARY KEY (user_id, path)
);
CREATE TABLE stored_key_file_notices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('files.stored_key')),
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT,
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK(suppressed IN (0,1)),
  UNIQUE(user_id,event_type,source_id)
);
CREATE INDEX stored_key_file_notices_user_page ON stored_key_file_notices(user_id,suppressed,created_at DESC,id DESC);
CREATE INDEX stored_key_file_notices_retention ON stored_key_file_notices(created_at);
