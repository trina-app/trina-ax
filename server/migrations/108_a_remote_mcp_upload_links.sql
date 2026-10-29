-- min_compatible_reader: 1
-- Component A (App connectors). One-time upload links for big files (create_upload_link + PUT
-- /connector-uploads/<token>). Only the sha256 of the token is stored. A link is bound to the person, the connection
-- grant, the exact target path and the overwrite flag. Additive only: a new table and an index.
CREATE TABLE remote_mcp_upload_links (
  hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES remote_mcp_grants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  overwrite INTEGER NOT NULL DEFAULT 0,
  max_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX remote_mcp_upload_links_grant ON remote_mcp_upload_links(grant_id, expires_at);
CREATE INDEX remote_mcp_upload_links_expiry ON remote_mcp_upload_links(expires_at);
