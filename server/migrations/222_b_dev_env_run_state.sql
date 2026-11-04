-- min_compatible_reader: 1
-- Component B: the srt runner of the dev environment (server/src/devenv/srt/, docs/research/srt-dev-env.md 4.3).
--   state: waiting (a job in the queue), running, ended. A row of the box runner stays 'running' until ended_at is set;
--     the srt runner sets 'ended' with ended_at.
--   kind: job, or server (a dev server: the server finds it again after a restart).
--   run_at: when the run left the queue (started_at is when it was asked for).
--   cwd: the folder in the project for a job that starts later. unit: the systemd scope of the run.
--   end_reason: exit, timeout, oom, stopped, idle, disk, setting, expired, lost.
-- Additive only (reader 1): an older build sees a waiting row as running (ended_at IS NULL), which is harmless, because
-- an older build has no srt runner.
ALTER TABLE dev_env_jobs ADD COLUMN state TEXT NOT NULL DEFAULT 'running' CHECK(state IN ('waiting','running','ended'));
ALTER TABLE dev_env_jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'job' CHECK(kind IN ('job','server'));
ALTER TABLE dev_env_jobs ADD COLUMN run_at TEXT;
ALTER TABLE dev_env_jobs ADD COLUMN cwd TEXT NOT NULL DEFAULT '';
ALTER TABLE dev_env_jobs ADD COLUMN unit TEXT NOT NULL DEFAULT '';
ALTER TABLE dev_env_jobs ADD COLUMN end_reason TEXT NOT NULL DEFAULT '';
CREATE INDEX dev_env_jobs_waiting ON dev_env_jobs(started_at) WHERE state = 'waiting';
