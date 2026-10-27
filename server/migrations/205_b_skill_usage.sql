-- Structured skill use only; no prompt/arguments/body. Turns are foundation rows (001).
-- One skill per turn prevents repeated reads and engine retries inflating the report.
CREATE TABLE turn_skill_usage (
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  skill_path TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('command', 'read')),
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (turn_id, skill_path)
);
CREATE INDEX turn_skill_usage_path ON turn_skill_usage(skill_path);
