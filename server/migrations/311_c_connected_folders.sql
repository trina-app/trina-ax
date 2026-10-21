-- Connected folders (server/src/team-files/connected.ts): a folder of the server Mac (a NAS share mounted in Finder,
-- Google Drive for desktop, any local folder) mirrored read-only into the team folder at connected/<name>, so the
-- AI and people read it through the usual folder rules. Additive only.
CREATE TABLE connected_folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,            -- absolute path on the server Mac
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_sync_at TEXT,
  last_status TEXT,                -- ok | partial | error
  last_error TEXT,
  files INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0
);
-- what the mirror itself wrote: only these files are updated or removed by a sync (a file someone saved into the
-- mirror, or changed there, is never overwritten or deleted)
CREATE TABLE connected_files (
  folder_id TEXT NOT NULL REFERENCES connected_folders(id) ON DELETE CASCADE,
  path TEXT NOT NULL,              -- relative to the mirror folder
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,       -- of the copy in the team folder
  src_size INTEGER NOT NULL,
  src_mtime_ms INTEGER NOT NULL,
  PRIMARY KEY (folder_id, path)
) WITHOUT ROWID;
