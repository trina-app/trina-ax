-- min_compatible_reader: 1
-- A person asks the team owner to delete their own account ("계정 삭제 요청", Settings › Profile; App Store review
-- 5.1.1(v): an app with accounts lets people start the deletion inside the app). Team admins make the accounts and only
-- the owner deletes them (server/src/admin/users.ts deleteUser), so the request goes to the owner, who deletes the
-- account in Admin › Members (server/src/auth/deletion-requests.ts, server/src/notifications/service.ts).
--   account_deletion_requests: one row per person, so there is never more than one open request: open while
--     cancelled_at and handled_at are both NULL. Asking again after a cancel opens the same row again (new
--     requested_at). handled_at / handled_by: the owner deleted the account (the users row stays as a tombstone, so
--     the row stays with it; the history is in the audit log). If the users row itself goes, the request goes too.
--   account_deletion_notices: the owners' inbox rows. notification_inbox has a fixed event_type CHECK list and tables
--     are never rebuilt, so these notices get their own table, as team_join_notices and onboarding_notices do.
--     Metadata only: source_id is the requesting person's id, never any text. UNIQUE(user_id,event_type,source_id) is
--     the dedupe: asking, cancelling and asking again re-arms the one row per owner and person instead of adding rows.
--     No OS push.
-- Additive only (reader 1): an older build does not know the tables.
CREATE TABLE account_deletion_requests (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  requested_at TEXT NOT NULL,
  cancelled_at TEXT,
  handled_at TEXT,
  handled_by TEXT
);
CREATE INDEX account_deletion_requests_open ON account_deletion_requests(requested_at) WHERE cancelled_at IS NULL AND handled_at IS NULL;

CREATE TABLE account_deletion_notices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('account.deletion_request')),
  source_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  read_at TEXT,
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK(suppressed IN (0,1)),
  UNIQUE(user_id,event_type,source_id)
);
CREATE INDEX account_deletion_notices_user_page ON account_deletion_notices(user_id,suppressed,created_at DESC,id DESC);
CREATE INDEX account_deletion_notices_retention ON account_deletion_notices(created_at);
CREATE INDEX account_deletion_notices_source ON account_deletion_notices(source_id);
