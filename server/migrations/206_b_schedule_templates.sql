-- Explicit opt-in templates. No schedules or engine calls are created by this migration.
ALTER TABLE schedules ADD COLUMN template_id TEXT;
ALTER TABLE schedules ADD COLUMN template_version INTEGER;
ALTER TABLE schedules ADD COLUMN template_source_path TEXT;
ALTER TABLE schedules ADD COLUMN template_output_path TEXT;
-- Snapshot the approved scope in the same admission transaction as the occurrence, independent of later deletion.
ALTER TABLE turns ADD COLUMN template_source_path TEXT;
ALTER TABLE turns ADD COLUMN template_output_path TEXT;
CREATE TABLE schedule_template_requests (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  schedule_id TEXT REFERENCES schedules(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(user_id, request_id)
);
-- Admission skips have no turn row; retain a metadata-only occurrence result so failures can be reconciled.
CREATE TABLE schedule_outcomes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  schedule_id TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  code TEXT NOT NULL CHECK(code IN ('budget_exceeded','user_unavailable')),
  created_at TEXT NOT NULL,
  UNIQUE(schedule_id,scheduled_for)
);
CREATE INDEX schedule_outcomes_recent ON schedule_outcomes(created_at);
