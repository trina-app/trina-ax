-- min_compatible_reader: 1
-- Component B: one queue for the dev environment on srt (server/src/devenv/srt/queue.ts, docs/DECISIONS.md "Dev
-- environment: one queue").
--   dev_env_runs.foreground: 1 = a queue ticket of a foreground command (box_shell with no job and no background). The
--     ticket waits in the same queue as the jobs (kind 'job', state 'waiting'; the kind CHECK stays as it is, tables are
--     never rebuilt). It has no command file and never runs as a job: the waiting call runs the command itself. A ticket
--     is deleted when its command starts, times out or is cancelled. A ticket with no waiting call (the server
--     restarted) ends with end_reason 'lost'. An older build reads a ticket as a waiting job with no command file and
--     ends it ("the command of this job is gone").
--   settings devEnv.team: the dev environment is on by default for a new team (setting.ts teamSetting: no row = on). A
--     team that has people before this migration keeps what it had: with no row it was off, so it gets an explicit
--     off row. A team with a row keeps its row.
-- Additive only (reader 1).
ALTER TABLE dev_env_runs ADD COLUMN foreground INTEGER NOT NULL DEFAULT 0 CHECK(foreground IN (0,1));
INSERT INTO settings (key, value)
  SELECT 'devEnv.team', '{"enabled":false}'
  WHERE EXISTS (SELECT 1 FROM users) AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'devEnv.team');
