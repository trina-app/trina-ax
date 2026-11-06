-- min_compatible_reader: 1
-- Onboarding stream E: one team invite link that a leader pastes into a chat app (server/src/auth/team-links.ts,
-- docs/DECISIONS.md "E — 팀 초대 링크").
--   team_links: one row per link made. At most one is open (revoked_at NULL) at a time: making a new one revokes the
--     open one in the same transaction. There is no role column: a team link only ever makes members. token_hash
--     (sha256) finds the link from the token; token_enc is the same token sealed with the server's key
--     (credentials/vault.ts, key file in <secrets>/team-links/, never in the database or a backup), so an admin can copy
--     the link again later. Revoking clears token_enc and keeps token_hash, so the old address says "revoked".
--   team_join_notices: the owners' inbox rows "someone joined through the team link". notification_inbox has a fixed
--     event_type CHECK list and tables are never rebuilt, so these notices get their own table, as skill_notices,
--     dev_env_notices and integration_request_notices do. Metadata only: the source is the new account's id.
-- Additive only (reader 1): an older build does not know the tables.
CREATE TABLE team_links (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  token_enc TEXT,
  key_version INTEGER NOT NULL DEFAULT 1,
  group_ids TEXT NOT NULL DEFAULT '[]',
  skill_path TEXT,
  max_uses INTEGER NOT NULL CHECK (max_uses >= 1),
  uses INTEGER NOT NULL DEFAULT 0 CHECK (uses >= 0),
  created_by TEXT REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by TEXT
);
CREATE INDEX team_links_open ON team_links(revoked_at, created_at);

CREATE TABLE team_join_notices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('team.joined')),
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT,
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK(suppressed IN (0,1)),
  UNIQUE(user_id,event_type,source_id)
);
CREATE INDEX team_join_notices_user_page ON team_join_notices(user_id,suppressed,created_at DESC,id DESC);
CREATE INDEX team_join_notices_retention ON team_join_notices(created_at);
