-- Component G: indexes for the hourly retention sweep (server/src/system/retention.ts). Additive only.
-- tool_events(at) and file_events(at) already have indexes (101_a_auth_admin.sql, 002_foundation.sql): the IF NOT
-- EXISTS lines are no-ops there and keep this file correct on its own.
CREATE INDEX IF NOT EXISTS tool_events_at ON tool_events(at);
CREATE INDEX IF NOT EXISTS file_events_at ON file_events(at);
CREATE INDEX IF NOT EXISTS turns_ended ON turns(ended_at);
CREATE INDEX IF NOT EXISTS proxy_tokens_expires ON proxy_tokens(expires_at);
CREATE INDEX IF NOT EXISTS proxy_tokens_revoked ON proxy_tokens(revoked_at);
CREATE INDEX IF NOT EXISTS jobs_finished ON jobs(finished_at);
