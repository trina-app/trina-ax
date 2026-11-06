-- min_compatible_reader: 1
-- Component B: long commands in a dev environment box (server/src/devenv/jobs.ts, docs/DECISIONS.md "Dev environment:
-- disk floor, jobs, CPU as activity").
--   dev_env_jobs: one row per box_shell job: who started it, from which chat and turn, when it ended, its exit code, and
--     the end of its log. exit_code NULL: the job runs, or no exit code is known (end_note says why). ai_told_at: the AI
--     got the result on a later box_shell call. No foreign key on chat_id or turn_id: the record outlives a deleted chat.
--   dev_env_stops: boxd stopped a box for a reason that people must hear of. UNIQUE keeps one notice per stop.
--   dev_env_notices: the inbox rows of these two. notification_inbox has a fixed event_type CHECK list and tables are
--     never rebuilt, so these notices get their own table, as skill_notices do. Metadata only: the job or stop id, never
--     the log. No OS push: push_deliveries refers to notification_inbox only.
-- Additive only (reader 1): an older build does not know these tables.
CREATE TABLE dev_env_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id TEXT,
  turn_id TEXT,
  command TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL,
  ended_at TEXT,
  exit_code INTEGER,
  end_note TEXT NOT NULL DEFAULT '',
  last_line TEXT NOT NULL DEFAULT '',
  log_tail TEXT NOT NULL DEFAULT '',
  ai_told_at TEXT
);
CREATE INDEX dev_env_jobs_open ON dev_env_jobs(project_id) WHERE ended_at IS NULL;
CREATE INDEX dev_env_jobs_report ON dev_env_jobs(project_id, ended_at) WHERE ai_told_at IS NULL;
CREATE INDEX dev_env_jobs_retention ON dev_env_jobs(ended_at);
CREATE TABLE dev_env_stops (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  stopped_at TEXT NOT NULL,
  UNIQUE(project_id, stopped_at)
);
CREATE INDEX dev_env_stops_retention ON dev_env_stops(stopped_at);
CREATE TABLE dev_env_notices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('dev_env.job','dev_env.box')),
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT,
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK(suppressed IN (0,1)),
  UNIQUE(user_id,event_type,source_id)
);
CREATE INDEX dev_env_notices_user_page ON dev_env_notices(user_id,suppressed,created_at DESC,id DESC);
CREATE INDEX dev_env_notices_retention ON dev_env_notices(created_at);
