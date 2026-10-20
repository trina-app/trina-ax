-- min_compatible_reader: 1
-- Component B: turn queue, engine-session bookkeeping, memory provenance, chat search, browser site grants.
-- Additive only (docs/WORKPLAN.md section 4).

-- turns are the queue (tab 3 "대기열"): the window that sent the turn (browser tools go there), the user message
-- the turn answers, the client kind (desktop -> browser tools), and the per-turn options (engine/model overrides).
ALTER TABLE turns ADD COLUMN window_id TEXT;
ALTER TABLE turns ADD COLUMN user_message_id TEXT;
ALTER TABLE turns ADD COLUMN client_kind TEXT;
ALTER TABLE turns ADD COLUMN queued_at TEXT;
ALTER TABLE turns ADD COLUMN usage_source TEXT;
CREATE INDEX turns_status ON turns(status);

-- the engine session of a chat follows one path of the message tree: the message the session's conversation
-- ends at. A turn whose parent is a different message (edit, regenerate, other branch) starts a new session
-- with the DB history of its path. session_tainted: the session saw outside content (web, other people's files,
-- project instructions) -> remember needs the person's confirmation (tab 3 "remember 보호").
ALTER TABLE chats ADD COLUMN engine_session_leaf_id TEXT;
ALTER TABLE chats ADD COLUMN session_tainted INTEGER NOT NULL DEFAULT 0;

-- memories: who asked for it (ai | user) and the turn that created it (tab 1)
ALTER TABLE memories ADD COLUMN source TEXT NOT NULL DEFAULT 'user';
ALTER TABLE memories ADD COLUMN created_turn_id TEXT;

-- chat search (tab 1 messages_fts): finished messages only, filled by triggers
CREATE VIRTUAL TABLE messages_fts USING fts5(content, message_id UNINDEXED, chat_id UNINDEXED, tokenize = 'trigram');
CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages WHEN new.status <> 'streaming' BEGIN
  INSERT INTO messages_fts (content, message_id, chat_id) VALUES (new.content, new.id, new.chat_id);
END;
CREATE TRIGGER messages_fts_update AFTER UPDATE OF status, content ON messages WHEN new.status <> 'streaming' BEGIN
  DELETE FROM messages_fts WHERE message_id = new.id;
  INSERT INTO messages_fts (content, message_id, chat_id) VALUES (new.content, new.id, new.chat_id);
END;
CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
END;
INSERT INTO messages_fts (content, message_id, chat_id) SELECT content, id, chat_id FROM messages WHERE status <> 'streaming';

-- in-app browser: sites on the office network the person allowed "always" (tab 3 "사내망 주소는 사람 확인")
CREATE TABLE browser_site_grants (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, host)
);
