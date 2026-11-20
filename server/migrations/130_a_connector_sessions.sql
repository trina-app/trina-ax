-- min_compatible_reader: 1
-- Component A: an MCP connector grant (remote_mcp_grants) no longer hangs on the browser sign-in that allowed it
-- (docs/decisions/20261120-mcp-connector-session.md). Each grant gets its own sessions row (connector = 1): no
-- token is ever handed out for it (token_hash is 'connector:<grant id>', never a sha256 hex, so no sign-in can match
-- it), it is not listed among the person's devices, and its expires_at follows the grant's. Signing out of one browser
-- or that sign-in expiring no longer ends the connection; ending every session of the person (password change or
-- reset, sign out everywhere, disabled, removed) still does, through the grants' ON DELETE CASCADE.
-- Additive only (reader 1): an older build lists such a row as one more web sign-in, and its grants keep working.
ALTER TABLE sessions ADD COLUMN connector INTEGER NOT NULL DEFAULT 0;
-- live grants of live browser sign-ins move to their own row now, so they survive the next sign-out
INSERT INTO sessions (id, user_id, token_hash, client, user_agent, created_at, last_seen_at, expires_at, temp_login, connector)
  SELECT 'connector-' || g.id, g.user_id, 'connector:' || g.id, 'web', 'MCP connector',
    strftime('%Y-%m-%dT%H:%M:%fZ', g.created_at / 1000.0, 'unixepoch'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', g.expires_at / 1000.0, 'unixepoch'), 0, 1
  FROM remote_mcp_grants g JOIN sessions s ON s.id = g.session_id
  WHERE g.revoked_at IS NULL AND g.expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000 AND s.connector = 0
    AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
UPDATE remote_mcp_grants SET session_id = 'connector-' || id
  WHERE EXISTS (SELECT 1 FROM sessions s WHERE s.id = 'connector-' || remote_mcp_grants.id);
CREATE INDEX sessions_connector ON sessions(user_id, connector);
-- One live refresh chain per connection (review of #127): a token issued by a refresh records the refresh token it came
-- from (parent, a sha256 like remote_mcp_tokens.hash), when an access token was first used (seen_at) and whether a
-- retry replaced it before it was ever used (superseded). A side table, not new columns: an older build inserts into
-- remote_mcp_tokens without column names. It goes with its token (ON DELETE CASCADE).
CREATE TABLE remote_mcp_token_links (
  hash TEXT PRIMARY KEY REFERENCES remote_mcp_tokens(hash) ON DELETE CASCADE,
  parent TEXT NOT NULL, seen_at INTEGER, superseded INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX remote_mcp_token_links_parent ON remote_mcp_token_links(parent);
