-- min_compatible_reader: 1
-- Component A (auth + admin). Additive only: new tables, nullable columns, indexes.

-- Failed sign-in attempts for rate limiting (per account and per real client IP). key = 'user:<lower username>',
-- 'ip:<address>', 'reauth:<user id>', 'token-ip:<address>'. Old rows are swept.
CREATE TABLE login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  at INTEGER NOT NULL            -- unix ms
);
CREATE INDEX login_attempts_key_at ON login_attempts(key, at);

-- One-time password reset links (tab 1 password_resets): admin-issued or owner local recovery (CLI). 24 h.
CREATE TABLE password_resets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT,               -- null = owner recovery from the server Mac (CLI)
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX password_resets_user ON password_resets(user_id);

-- Deleted accounts stay as tombstones (usage history, audit names); chats and memories are purged later.
ALTER TABLE users ADD COLUMN deleted_at TEXT;
-- "last password reset: who, when" shown in the person's settings (tab 5)
ALTER TABLE users ADD COLUMN password_reset_by TEXT;
ALTER TABLE users ADD COLUMN password_reset_at TEXT;
-- usernames are unique without regard to case (sign-in matches case-insensitively)
CREATE UNIQUE INDEX users_username_lower ON users(lower(username));

-- the folder a group was created with (groups/<name>/), so the admin screen can link them
ALTER TABLE groups ADD COLUMN folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL;

-- last 4 characters of a company key, for recognition (the key itself lives in <data>/secrets/)
ALTER TABLE engine_accounts ADD COLUMN hint TEXT;

CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX invites_created ON invites(created_at);
CREATE INDEX folder_rules_folder ON folder_rules(folder_id);
CREATE INDEX file_events_user_at ON file_events(user_id, at);
CREATE INDEX tool_events_at ON tool_events(at);
