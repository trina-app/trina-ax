-- Scheduled tasks (server/src/chat/schedules.ts): a person's prompt that the server sends for them on a schedule, each
-- run in a new chat of theirs with their own access. Additive only.
CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  -- once | daily | weekdays | weekly | monthly; time is HH:MM in the team's time zone
  repeat TEXT NOT NULL CHECK (repeat IN ('once', 'daily', 'weekdays', 'weekly', 'monthly')),
  time TEXT NOT NULL,
  weekday INTEGER,            -- weekly: 0 = Sunday … 6 = Saturday
  day INTEGER,                -- monthly: 1–28
  date TEXT,                  -- once: YYYY-MM-DD
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at TEXT,           -- UTC ISO; NULL when finished (a once-schedule that ran) or disabled
  last_run_at TEXT,
  last_chat_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX schedules_due ON schedules(enabled, next_run_at);
CREATE INDEX schedules_user ON schedules(user_id);
