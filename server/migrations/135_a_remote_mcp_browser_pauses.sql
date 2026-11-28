-- min_compatible_reader: 1
-- Component A (App connectors). The person's own MCP apps can use their linked browser profiles (mcp:browser,
-- docs/decisions/20261128-mcp-browser-tools.md). When the person presses Stop in their browser on one of an app's
-- tasks, that whole connection's browser calls pause until `until` (epoch ms) or until the person presses Resume in
-- Settings › Trina AX MCP: a new session id must not get around it, and a restart or an update must not lift it.
-- Additive only: a new table, gone with its connection. 135: 134 is the highest a on dev.
CREATE TABLE remote_mcp_browser_pauses (
  grant_id TEXT PRIMARY KEY REFERENCES remote_mcp_grants(id) ON DELETE CASCADE,
  until INTEGER NOT NULL
);
