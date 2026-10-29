-- R2-SKILL-12: skill suggestion notices stay in the inbox, so a manager who was offline sees them later.
-- notification_inbox has a fixed event_type CHECK list and tables are never rebuilt, so these notices get their own
-- table with the same columns. The service lists both tables as one inbox. Metadata only: the suggestion id, never
-- its name, folder or content. No OS push: push_deliveries refers to notification_inbox only.
CREATE TABLE skill_notices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('skill.suggested','skill.reviewed')),
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT,
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK(suppressed IN (0,1)),
  UNIQUE(user_id,event_type,source_id)
);
CREATE INDEX skill_notices_user_page ON skill_notices(user_id,suppressed,created_at DESC,id DESC);
CREATE INDEX skill_notices_retention ON skill_notices(created_at);
ALTER TABLE notification_preferences ADD COLUMN skill_suggestions INTEGER NOT NULL DEFAULT 1 CHECK(skill_suggestions IN (0,1));
