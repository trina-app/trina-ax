-- min_compatible_reader: 1
-- Component B: a scheduled task whose project its owner no longer sees (chat/schedules.ts; docs/DECISIONS.md "Project
-- skills"). The occurrence does not start, instead of running as a chat without the project (its instructions and its
-- skills gone, the answer saved where the project's people do not look), and the run's result and the owner's inbox say
-- so. schedule_outcomes has a fixed code CHECK list and tables are never rebuilt, so these get their own table, as
-- schedule_template_skips do. Metadata only: the project's id, never its name or folder.
-- Additive only (reader 1): an older build does not know the table.
-- Numbered 276: 275 (notification_preview) is the highest on dev.
CREATE TABLE schedule_project_skips (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  schedule_id TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  project_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(schedule_id, scheduled_for)
);
CREATE INDEX schedule_project_skips_retention ON schedule_project_skips(created_at);
