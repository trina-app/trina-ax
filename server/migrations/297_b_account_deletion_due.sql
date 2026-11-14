-- min_compatible_reader: 1
-- A person's own account deletion request deletes the account by itself on a date (docs/DECISIONS.md "Self-service
-- account deletion"; App Store 5.1.1(v), Google Play): before, it only asked the team owner, and nothing happened if
-- nobody acted.
--   account_deletion_requests.due_at: when the server deletes the account (requested_at + 7 days; the hourly sweep in
--     server/src/auth/sweeper.ts). due_for: the requested_at that date was set for. A date counts only while due_for
--     equals requested_at: a request opened again by an older build after a rollback changes requested_at and keeps
--     the old date, which then counts as none. An open request with no date of its own is not deleted: the sweep
--     first gives it a date 7 days from then and tells the person (account.deletion_due below). So requests open when
--     this migration runs are deleted 7 days after the server started this build, never at the first sweep without a
--     warning.
--   account_deletion_due_notices: the person's inbox row "your account will be deleted on <date>" for such a request.
--     notification_inbox has a fixed event_type CHECK list and tables are never rebuilt, so it has its own table, like
--     account_deletion_notices. Metadata only: source_id is the person's own id; the date is read from the request.
-- Additive only (reader 1): an older build ignores the column and the table (and deletes nothing by itself).
ALTER TABLE account_deletion_requests ADD COLUMN due_at TEXT;
ALTER TABLE account_deletion_requests ADD COLUMN due_for TEXT;
CREATE INDEX account_deletion_requests_due ON account_deletion_requests(due_at) WHERE cancelled_at IS NULL AND handled_at IS NULL;

CREATE TABLE account_deletion_due_notices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('account.deletion_due')),
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT,
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK(suppressed IN (0,1)),
  UNIQUE(user_id,event_type,source_id)
);
CREATE INDEX account_deletion_due_notices_user_page ON account_deletion_due_notices(user_id,suppressed,created_at DESC,id DESC);
CREATE INDEX account_deletion_due_notices_retention ON account_deletion_due_notices(created_at);
