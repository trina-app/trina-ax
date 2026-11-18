-- min_compatible_reader: 1
-- Component B: the AI's file reads last for the chat, not one answer (docs/decisions/20261118-read-state-for-the-chat.md,
-- server/src/chat/carried-reads.ts). One row per file an answer's AI read or saved, with the sha256 of the version it
-- last saw: the next answer of the same person on that branch may change the file without reading it again while it is
-- still that version and they may still read it. user_id: whose turn it was (a shared chat never hands one person's
-- reads to another; removed with a deleted account by the chat cleanup hook, chat/account-cleanup.ts). session_id: the
-- engine session the answer ran in (a whole-file replace from a read counts only in that same session). id: the order
-- rows were written in (the per-chat cap keeps the newest). Gone with the chat, the answer or the person. Metadata only
-- (paths and hashes, never content).
-- Additive only (reader 1): an older build ignores the table and asks for a read in every answer, as before.
CREATE TABLE chat_reads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  UNIQUE (message_id, path)
);
CREATE INDEX chat_reads_chat_user ON chat_reads(chat_id, user_id);
