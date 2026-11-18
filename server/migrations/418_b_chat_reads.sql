-- min_compatible_reader: 1
-- Component B: the AI's file reads last for the chat, not one answer (docs/decisions/20261118-read-state-for-the-chat.md,
-- server/src/chat/carried-reads.ts). One row per file an answer's AI read or saved, with the sha256 of the version it
-- last saw: the next answer of the same person on that branch may change the file without reading it again while it is
-- still that version and they may still read it. user_id: whose turn it was (a shared chat never hands one person's
-- reads to another). Gone with the chat or the answer. Metadata only (paths and hashes, never content).
-- Additive only (reader 1): an older build ignores the table and asks for a read in every answer, as before.
CREATE TABLE chat_reads (
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (message_id, path)
);
CREATE INDEX chat_reads_chat_user ON chat_reads(chat_id, user_id);
