-- min_compatible_reader: 1
-- Component B: files from the computer in a chat shared with people and groups (docs/DECISIONS.md "Files from the
-- computer in a chat shared with people", QA TC-1413; plan docs/AGENTS/plan/20261114-shared-chats-everywhere.md S6).
--   chat_files: a file owned by the chat, not by a folder: kept in <team>/.system/chat-files/<chat id>/<file id> (closed
--     to every person, the AI's file tools and the owner's export; in every backup, like room files), served only through
--     the chat (GET /api/chats/:id/files/:fileId: whoever sees the chat now). user_id is who sent it (no foreign key: a
--     purged account's files stay with the chat under the tombstone name). copied_from: the computer upload of the
--     chat's creator (attachments.id) it was copied from when the chat was shared; NULL for an upload made here.
--     A row whose id no message names is an upload not sent yet (only its sender may open it; swept after a day). The
--     rows go with the chat (ON DELETE CASCADE); the files go with ChatFiles.removeChat and the sweep.
-- Additive only (reader 1). Numbered 400: component B's 200–299 range is full (298 chat audience, 299 room apps), and
-- B's second range is 400–499 (docs/DECISIONS.md "B gets a second range, 400–499").
CREATE TABLE chat_files (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime TEXT NOT NULL,
  kind TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  sha256 TEXT NOT NULL,
  thumb TEXT,
  copied_from TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX chat_files_chat ON chat_files(chat_id);
CREATE INDEX chat_files_created ON chat_files(created_at);
