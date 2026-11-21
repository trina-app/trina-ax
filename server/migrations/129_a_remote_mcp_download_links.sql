-- min_compatible_reader: 1
-- Component A (App connectors). Short-lived download links for team files (create_download_link + GET
-- /connector-downloads/<token>), the mirror of the upload links (108). Only the sha256 of the token is stored. A link
-- is bound to the person, the connection grant, the path as authorized and the file's version when it was made
-- (inode, size, mtime): a changed file is refused. `uses` counts the GETs, at most `max_uses`. Additive only: a new
-- table and two indexes.
CREATE TABLE remote_mcp_download_links (
  hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES remote_mcp_grants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  ino TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER NOT NULL
);
CREATE INDEX remote_mcp_download_links_grant ON remote_mcp_download_links(grant_id, expires_at);
CREATE INDEX remote_mcp_download_links_expiry ON remote_mcp_download_links(expires_at);
