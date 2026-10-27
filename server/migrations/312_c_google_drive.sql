-- min_compatible_reader: 1
-- Personal Drive connections have their own key namespace; AI rekey must never delete these keys.
CREATE TABLE drive_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  config_key TEXT NOT NULL,
  account TEXT NOT NULL,
  scopes TEXT NOT NULL,
  secret_enc TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('connected','needs_reconnect')),
  version INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE drive_oauth_flows (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  state_hash TEXT NOT NULL UNIQUE,
  config_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','exchanging','ready','failed','expired','completed')),
  secret_enc TEXT,
  key_version INTEGER NOT NULL,
  account TEXT,
  reason TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX drive_flows_owner ON drive_oauth_flows(user_id,created_at);
