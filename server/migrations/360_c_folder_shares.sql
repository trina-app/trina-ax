-- min_compatible_reader: 1
-- Component C: a person shares a folder inside their own files (docs/decisions/20261116-folder-share-server.md,
-- server/src/files/folder-shares.ts). Additive only. An older build ignores the columns, reads a folder row as a file
-- row, and its link answers no access (it refuses a directory), paused or not.
--   kind: 'file' (every row before this) or 'folder'.
--   folder_id: a folder row's identity on disk when it was shared, '<dev>:<ino>:<birth time in ns>' (saveFolderId). A
--     folder row's sha256, size, mtime_ms and ctime_ms are NULL; ino and dev are filled but nothing new reads them.
--   paused_at: a folder row whose folder on disk is no longer the one shared: no access, the people on it kept, until
--     its owner resumes it. Paused is a column, not a state: `state` keeps its three values.
ALTER TABLE file_shares ADD COLUMN kind TEXT NOT NULL DEFAULT 'file' CHECK(kind IN ('file','folder'));
ALTER TABLE file_shares ADD COLUMN folder_id TEXT;
ALTER TABLE file_shares ADD COLUMN paused_at TEXT;
CREATE INDEX file_shares_live_folders ON file_shares(path) WHERE kind = 'folder' AND state = 'live';

-- What a removal took away, for its Undo (10 minutes, the person who removed them only, once). Rows go one day after
-- expires_at.
CREATE TABLE file_share_undos (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  share_id TEXT NOT NULL REFERENCES file_shares(id) ON DELETE CASCADE,
  step_id TEXT,
  grants TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX file_share_undos_user ON file_share_undos(user_id, created_at);
CREATE INDEX file_share_undos_expiry ON file_share_undos(expires_at);
