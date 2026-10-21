-- Team files attached to a chat by reference (the composer's "Add from team files"; POST /api/attachments/team-file).
-- Nothing is copied: a row remembers which file was meant (path, inode, content hash at attach time) and the server
-- finds it again on every send, turn and display (moves from file_events, same-folder renames by inode), always
-- re-checking the person's read access with today's rules. Additive only.
CREATE TABLE team_file_refs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  -- where the file was last found (actual on-disk names); path_at_attach never changes
  path TEXT NOT NULL,
  path_at_attach TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime TEXT NOT NULL,
  kind TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  mtime_ms INTEGER NOT NULL,
  ino INTEGER,
  dev INTEGER,
  -- file_events.id already applied to `path` (moves after it are followed)
  event_id INTEGER NOT NULL DEFAULT 0,
  -- trashed (by the trash entry trash_id, trash_suffix below the trashed folder): unavailable until restored
  trash_id TEXT,
  trash_suffix TEXT,
  -- 1: not found at `path`, nor by inode in its folder (deleted outside the app); looked for again only at `path`
  lost INTEGER NOT NULL DEFAULT 0,
  -- the last content hash computed since attaching (with the size / time / inode it was computed for), so a touched
  -- but equal file is not hashed again on every turn and does not show as changed
  cur_sha256 TEXT,
  cur_size INTEGER,
  cur_mtime_ms INTEGER,
  cur_ino INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX team_file_refs_chat ON team_file_refs(chat_id);
CREATE INDEX team_file_refs_user ON team_file_refs(user_id, created_at);
