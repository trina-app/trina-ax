-- min_compatible_reader: 1
-- Stream B (projects): "Project contents only for members" (docs/DECISIONS.md). When someone starts to see a team
-- project in projects/ (an owner or admin adding themselves, someone added to one of its groups, a new account in one
-- of its groups, a members change), the project's members get one quiet inbox notice "{who} joined '{name}'".
--   project_notices: one row per member told (source_id = the id of the project.member_gained audit row, never any
--     text). notification_inbox has a fixed event_type CHECK list and tables are never rebuilt, so these notices get
--     their own table, as onboarding_notices does. No OS push.
-- Additive only (reader 1): an older build does not know the table.
CREATE TABLE project_notices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('project.joined')),
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT,
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK(suppressed IN (0,1)),
  UNIQUE(user_id,event_type,source_id)
);
CREATE INDEX project_notices_user_page ON project_notices(user_id,suppressed,created_at DESC,id DESC);
CREATE INDEX project_notices_retention ON project_notices(created_at);
CREATE INDEX project_notices_source ON project_notices(source_id);
