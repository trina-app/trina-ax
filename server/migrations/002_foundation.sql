-- min_compatible_reader: 1
-- Columns the REST/WebSocket contract (shared/src/api) needs on stage-1 tables. Additive only.

-- conversation tree: edit / regenerate add siblings with the same parent; the chat shows one path
ALTER TABLE messages ADD COLUMN parent_id TEXT;
ALTER TABLE messages ADD COLUMN turn_id TEXT;
ALTER TABLE messages ADD COLUMN author_id TEXT;
ALTER TABLE messages ADD COLUMN engine TEXT;
ALTER TABLE messages ADD COLUMN model TEXT;
-- FileChangeSummary json of the turn (answer footer)
ALTER TABLE messages ADD COLUMN files TEXT;
-- client-generated id of a sent message (idempotent resend after reconnect)
ALTER TABLE messages ADD COLUMN client_message_id TEXT;
ALTER TABLE messages ADD COLUMN updated_at TEXT;
CREATE INDEX messages_chat_parent ON messages(chat_id, parent_id);
CREATE UNIQUE INDEX messages_client_id ON messages(chat_id, client_message_id) WHERE client_message_id IS NOT NULL;

ALTER TABLE chats ADD COLUMN active_leaf_id TEXT;
CREATE INDEX chats_user_updated ON chats(user_id, updated_at);

ALTER TABLE turns ADD COLUMN message_id TEXT;
CREATE INDEX turns_chat ON turns(chat_id);
CREATE INDEX turns_user_started ON turns(user_id, started_at);

ALTER TABLE invites ADD COLUMN created_at TEXT;
ALTER TABLE invites ADD COLUMN used_by TEXT;
ALTER TABLE invites ADD COLUMN revoked_at TEXT;

-- per-person UI preferences (theme, answer language, last engine/model): json
ALTER TABLE users ADD COLUMN prefs TEXT NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN last_seen_at TEXT;

ALTER TABLE jobs ADD COLUMN message TEXT;

CREATE UNIQUE INDEX artifacts_chat_key_version ON artifacts(chat_id, key, version);
CREATE INDEX memories_user ON memories(user_id, created_at);
CREATE INDEX audit_log_at ON audit_log(at);
CREATE INDEX file_events_at ON file_events(at);
