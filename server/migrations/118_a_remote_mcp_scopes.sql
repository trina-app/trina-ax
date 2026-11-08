-- Component A (App connectors). A read scope per MCP session (docs/DECISIONS.md "App connectors: a read scope per MCP
-- session"). What a connected AI read (files, room messages, as read-scope sources: chat/read-scope.ts) used to be one
-- list per connection (remote_mcp_grants.sources) that nothing cleared. Now one row per MCP session: `session` is the
-- sha256 of the Mcp-Session-Id that initialize gave the client, or '' for the calls that send none (that row is
-- forgotten after an hour without a tool call, connectors/remote-mcp/scope.ts). An upload link remembers the session
-- that made it (`session`, the same key; NULL: a link made before this, checked as ''). Additive only: a new table, an
-- index, a nullable column. remote_mcp_grants.sources stays as it is and is no longer written. Numbered 118: 117 is
-- another open branch's.
CREATE TABLE remote_mcp_scopes (
  grant_id TEXT NOT NULL REFERENCES remote_mcp_grants(id) ON DELETE CASCADE,
  session TEXT NOT NULL,
  sources TEXT NOT NULL,
  used_at INTEGER NOT NULL,
  PRIMARY KEY (grant_id, session)
);
-- the housekeeping (scope.ts pruneScopes, on every connector request) looks up the idle rows without a session
CREATE INDEX remote_mcp_scopes_idle ON remote_mcp_scopes(session, used_at);
ALTER TABLE remote_mcp_upload_links ADD COLUMN session TEXT;
-- A client connected before this update has no session id until it initializes again: what it read stays with the
-- calls without one, from now, so the update itself forgets nothing.
INSERT INTO remote_mcp_scopes (grant_id, session, sources, used_at)
  SELECT id, '', sources, CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM remote_mcp_grants WHERE sources <> '[]';
