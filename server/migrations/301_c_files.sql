-- Component C: file screen, uploads, attachments, jobs, artifacts. Additive only.

-- Version history and trash remember the nearest folders row and the path at save time (design tab 2 "동시 수정"):
-- viewing an old version needs read access to that folder (its current path) and to the file's current path, so
-- moving a file out of a private folder does not expose its history. file_versions.path is the CURRENT path of the
-- file (the move API keeps it up to date); path_at_save never changes.
ALTER TABLE file_versions ADD COLUMN folder_id TEXT;
ALTER TABLE file_versions ADD COLUMN path_at_save TEXT;
ALTER TABLE trash_items ADD COLUMN folder_id TEXT;
-- 'file' or 'folder' (a folder is trashed and restored as one)
ALTER TABLE trash_items ADD COLUMN kind TEXT NOT NULL DEFAULT 'file';

-- Filled by triggers so every writer (AI tools of stage 1, the file screen, uploads) records them the same way.
CREATE TRIGGER file_versions_stamp AFTER INSERT ON file_versions WHEN NEW.path_at_save IS NULL
BEGIN
  UPDATE file_versions SET path_at_save = NEW.path,
    folder_id = (SELECT f.id FROM folders f
                 WHERE f.path = '' OR substr(NEW.path, 1, length(f.path) + 1) = f.path || '/'
                 ORDER BY length(f.path) DESC LIMIT 1)
  WHERE id = NEW.id;
END;
CREATE TRIGGER trash_items_stamp AFTER INSERT ON trash_items WHEN NEW.folder_id IS NULL
BEGIN
  UPDATE trash_items SET
    folder_id = (SELECT f.id FROM folders f
                 WHERE f.path = '' OR f.path = NEW.original_path OR substr(NEW.original_path, 1, length(f.path) + 1) = f.path || '/'
                 ORDER BY length(f.path) DESC LIMIT 1)
  WHERE id = NEW.id;
END;
CREATE INDEX file_versions_path ON file_versions(path, version);
CREATE INDEX file_versions_created ON file_versions(created_at);
CREATE INDEX trash_items_purge ON trash_items(purge_at);
CREATE INDEX trash_items_deleted ON trash_items(deleted_at);

-- Chat attachments (POST /api/uploads, upload sessions with target attachment). The file itself lives in the team
-- folder at users/<user>/.attachments/<chatId>/<name>; messages.attachments keeps a copy of the API shape.
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime TEXT NOT NULL,
  kind TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  sha256 TEXT NOT NULL,
  -- server data dir relative path of the generated thumbnail (null: none)
  thumb_path TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX attachments_chat ON attachments(chat_id);
CREATE INDEX attachments_user ON attachments(user_id, created_at);

-- Upload sessions: when they were made, and the result of complete (a retried complete returns the same answer).
ALTER TABLE upload_sessions ADD COLUMN created_at TEXT;
ALTER TABLE upload_sessions ADD COLUMN result TEXT;
CREATE INDEX upload_sessions_user ON upload_sessions(user_id);
CREATE INDEX upload_sessions_expires ON upload_sessions(expires_at);

CREATE INDEX jobs_status ON jobs(status);
CREATE INDEX jobs_user ON jobs(user_id, created_at);
CREATE INDEX artifacts_chat ON artifacts(chat_id, key, version);
