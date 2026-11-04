-- min_compatible_reader: 1
-- Stream A (onboarding): a member with no AI connection asks the owner(s) to connect one ("관리자에게 알리기").
--   onboarding_notices: one inbox row per owner and requesting member (source_id = the member's id, never any text).
--     notification_inbox has a fixed event_type CHECK list and tables are never rebuilt, so these notices get their
--     own table, as integration_request_notices does. UNIQUE(user_id,event_type,source_id) is the dedupe: a second
--     click adds nothing; the row goes with the 30 day retention, after which the member can ask again.
--     Also the member's "알렸어요": a row with their id as source_id exists. No OS push.
-- Additive only (reader 1): an older build does not know the table.
CREATE TABLE onboarding_notices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('onboarding.ai_request')),
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT,
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK(suppressed IN (0,1)),
  UNIQUE(user_id,event_type,source_id)
);
CREATE INDEX onboarding_notices_user_page ON onboarding_notices(user_id,suppressed,created_at DESC,id DESC);
CREATE INDEX onboarding_notices_retention ON onboarding_notices(created_at);
CREATE INDEX onboarding_notices_source ON onboarding_notices(source_id);
