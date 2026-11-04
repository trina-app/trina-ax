-- min_compatible_reader: 1
-- Component B: the runs of the srt runner of the dev environment (server/src/devenv/srt/, docs/research/srt-dev-env.md
-- 4.3). srt is not locked to a project: any chat, with or without a project, can start a run, and the run gets the
-- folder access of the person who owns the chat. So a run has its own table (dev_env_jobs needs a project and stays for
-- the box runner).
--   dev_env_runs: one row per job or dev server (a foreground command has no row). project_id NULL: a chat with no
--     project. No foreign key on chat_id, turn_id or project_id: the record outlives a deleted chat or project.
--   state: waiting (a job in the queue), running, ended. kind: job, or server (a dev server).
--   started_at: when it was asked for; run_at: when it left the queue.
--   root: the folder the run starts in (the project folder, or the chat's work folder), absolute; cwd: a folder in it.
--   unit: the systemd scope of the run. access: a hash of the person's folder access when the run started; the tracker
--     stops the run when it changes.
--   end_reason: exit, timeout, oom, stopped, idle, disk, setting, expired, lost. ai_told_at: the AI of the chat got the
--     result.
-- Additive only (reader 1): an older build does not know the table.
CREATE TABLE dev_env_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id TEXT,
  project_id TEXT,
  turn_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('job','server')),
  name TEXT NOT NULL,
  command TEXT NOT NULL DEFAULT '',
  root TEXT NOT NULL,
  cwd TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'waiting' CHECK(state IN ('waiting','running','ended')),
  started_at TEXT NOT NULL,
  run_at TEXT,
  ended_at TEXT,
  unit TEXT NOT NULL DEFAULT '',
  access TEXT NOT NULL DEFAULT '',
  exit_code INTEGER,
  end_reason TEXT NOT NULL DEFAULT '',
  end_note TEXT NOT NULL DEFAULT '',
  last_line TEXT NOT NULL DEFAULT '',
  log_tail TEXT NOT NULL DEFAULT '',
  ai_told_at TEXT
);
CREATE INDEX dev_env_runs_open ON dev_env_runs(state, started_at) WHERE ended_at IS NULL;
CREATE INDEX dev_env_runs_user ON dev_env_runs(user_id) WHERE ended_at IS NULL;
CREATE INDEX dev_env_runs_report ON dev_env_runs(chat_id, ended_at) WHERE ai_told_at IS NULL;
CREATE INDEX dev_env_runs_retention ON dev_env_runs(ended_at);
