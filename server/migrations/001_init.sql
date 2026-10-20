-- Stage 1 schema (design tab 1). Folder paths are relative to the team root, actual on-disk names,
-- no leading/trailing slash; '' is the team root.
CREATE TABLE users (
  id TEXT PRIMARY KEY,                 -- stable slug, also the personal folder name users/<id>/
  username TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  email TEXT,
  password_hash TEXT,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  must_change_password INTEGER NOT NULL DEFAULT 0,
  locale TEXT NOT NULL DEFAULT 'ko',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT
);
CREATE TABLE group_members (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
);
CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE folder_rules (
  id TEXT PRIMARY KEY,
  folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('everyone','role','group','user')),
  subject_id TEXT,
  access TEXT NOT NULL CHECK (access IN ('none','read','write')),
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (folder_id, subject_type, subject_id)
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE,
  client TEXT NOT NULL CHECK (client IN ('web','desktop','mobile')), user_agent TEXT,
  created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE invites (
  id TEXT PRIMARY KEY, role TEXT NOT NULL, group_ids TEXT NOT NULL DEFAULT '[]', token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT REFERENCES users(id), expires_at TEXT NOT NULL, used_at TEXT
);
CREATE TABLE projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, folder_path TEXT NOT NULL, instructions TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE chats (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), project_id TEXT REFERENCES projects(id),
  title TEXT NOT NULL DEFAULT '', engine TEXT NOT NULL DEFAULT 'claude-code', model TEXT, engine_session_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), deleted_at TEXT
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')), content TEXT NOT NULL DEFAULT '',
  attachments TEXT NOT NULL DEFAULT '[]', steps TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('streaming','done','error','stopped')), error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, message_id TEXT, key TEXT NOT NULL,
  version INTEGER NOT NULL, type TEXT NOT NULL, title TEXT, language TEXT, content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE memories (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, text TEXT NOT NULL,
  source_chat_id TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE turns (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
  engine TEXT NOT NULL, model TEXT, status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('queued','running','done','error','stopped','interrupted')),
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), ended_at TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
  engine_session_blob TEXT,             -- path of the stashed engine session file (server data dir), not the content
  error TEXT
);
CREATE TABLE file_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, turn_id TEXT, user_id TEXT NOT NULL, path TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create','update','delete','conflict','rejected','upload','restore')),
  size INTEGER, sha256 TEXT, detail TEXT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX file_events_path ON file_events(path);
CREATE INDEX file_events_turn ON file_events(turn_id);
CREATE TABLE tool_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, turn_id TEXT, user_id TEXT, tool TEXT NOT NULL, summary TEXT NOT NULL,
  ok INTEGER NOT NULL, at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX tool_events_turn ON tool_events(turn_id);
CREATE TABLE file_versions (
  id TEXT PRIMARY KEY, path TEXT NOT NULL, version INTEGER NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL,
  author_id TEXT, turn_id TEXT, kind TEXT NOT NULL CHECK (kind IN ('edit','conflict_copy','restore')),
  conflict_path TEXT, storage_path TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (path, version)
);
CREATE TABLE trash_items (
  id TEXT PRIMARY KEY, original_path TEXT NOT NULL, storage_path TEXT NOT NULL, size INTEGER NOT NULL,
  deleted_by TEXT NOT NULL, turn_id TEXT, deleted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  purge_at TEXT NOT NULL, restored_at TEXT
);
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, user_id TEXT, kind TEXT NOT NULL CHECK (kind IN ('transcribe','backup','restore','update','export')),
  status TEXT NOT NULL CHECK (status IN ('queued','running','done','failed','canceled')), progress REAL, result TEXT, error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), finished_at TEXT
);
CREATE TABLE upload_sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, target TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
  chunk_size INTEGER NOT NULL, received TEXT NOT NULL DEFAULT '[]', expires_at TEXT NOT NULL
);
CREATE TABLE engine_accounts (
  id TEXT PRIMARY KEY, engine TEXT NOT NULL, secret_ref TEXT NOT NULL, label TEXT,
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','invalid')), checked_at TEXT
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, action TEXT NOT NULL, target TEXT, detail TEXT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE budgets (
  id TEXT PRIMARY KEY, subject_type TEXT NOT NULL CHECK (subject_type IN ('team','group','user')), subject_id TEXT,
  period TEXT NOT NULL CHECK (period IN ('day','month')), limit_usd REAL NOT NULL, limit_tokens INTEGER,
  action TEXT NOT NULL CHECK (action IN ('warn','block'))
);
CREATE TABLE proxy_tokens (
  token_hash TEXT PRIMARY KEY, turn_id TEXT NOT NULL, user_id TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT,
  budget_usd REAL
);
