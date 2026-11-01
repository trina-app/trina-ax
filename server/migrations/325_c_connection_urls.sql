-- Component C: save_url (server/src/tools/save-url.ts, docs/DECISIONS.md "Outbound web channels").
--   chat_connection_urls: web addresses that came back in this chat from an external-service connection (in an MCP
--     tool's text or resource link, or an api_request answer). save_url opens them without a card as learned links,
--     within the link budget (8 per answer, 30 per chat, counted together with chat_seen_urls.free_turn_id), while the
--     person can still use that connection, and never when the AI had put the address, its query or a long
--     random-looking part of it into a tool input of this chat before it came back (echo = 1: a service may repeat
--     what it was sent, and then the address carries what the AI chose; always a card).
--     integration_id: the connection; user_id: the person of the turn; turn_id: the answer it came back in;
--     free_turn_id: the answer that opened it without a card.
--   chat_sent_marks: what the AI sent in tool inputs of this chat, for that check: the first 16 bytes of the SHA-256
--     of each address (also folded), its host and path, its query, and each 20-character window of a long
--     random-looking part (tools/connection-urls.ts). Hashes only: no input text is kept.
-- New tables only: chat_seen_urls (and its CHECK on source) is not rebuilt. An older build ignores both tables (it
-- opens the database; save_url and these rows are just not there), so this migration needs no newer reader.
-- Additive only.
CREATE TABLE chat_connection_urls (
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  turn_id TEXT,
  echo INTEGER NOT NULL DEFAULT 0 CHECK (echo IN (0, 1)),
  free_turn_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (chat_id, url)
) WITHOUT ROWID;
CREATE INDEX chat_connection_urls_free ON chat_connection_urls(chat_id, free_turn_id) WHERE free_turn_id IS NOT NULL;
CREATE TABLE chat_sent_marks (
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  mark BLOB NOT NULL,
  PRIMARY KEY (chat_id, mark)
) WITHOUT ROWID;
