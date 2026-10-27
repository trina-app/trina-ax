-- Remote OAuth credentials are a separate audience; they are never ordinary app/Unix-turn bearer tokens.
CREATE TABLE remote_mcp_clients (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, redirects TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL
);
CREATE TABLE remote_mcp_requests (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES remote_mcp_clients(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL, state TEXT, scopes TEXT NOT NULL, resource TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE, session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE remote_mcp_grants (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES remote_mcp_clients(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  resource TEXT NOT NULL, scopes TEXT NOT NULL, sources TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE TABLE remote_mcp_codes (
  hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES remote_mcp_grants(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER
);
CREATE TABLE remote_mcp_tokens (
  hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('access','refresh')),
  grant_id TEXT NOT NULL REFERENCES remote_mcp_grants(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL, used_at INTEGER
);
CREATE TABLE remote_mcp_limits (key TEXT PRIMARY KEY, bucket INTEGER NOT NULL, count INTEGER NOT NULL);
CREATE INDEX remote_mcp_grants_user ON remote_mcp_grants(user_id,created_at);
CREATE INDEX remote_mcp_tokens_grant ON remote_mcp_tokens(grant_id);
CREATE INDEX remote_mcp_requests_expiry ON remote_mcp_requests(expires_at);
