-- min_compatible_reader: 1
-- The AI in team chat rooms ("대화방의 트리나", docs/DECISIONS.md): "@트리나 …" in a room runs a normal chat turn as the
-- person who asked, in an AI session of their own for that room. Additive only (reader 1): an older build lists such a
-- session as one of the person's chats without a title, and never reads the new tables.
--   chats.room_id: this chat is the AI session of (room_id, user_id); it never shows in the chat list or the chat
--     routes (server/src/chat/store.ts ownChat). chats.room_outside: the session used something that is not a team
--     file (a web page or search, a connected service, the in-app browser, another tool outside the file tools): its
--     answers stay private to the person until they post one. Cleared with the read scope when the session starts anew.
--   room_ai_turns: one row per question (the chat turn's id): the room message that asked, where the answer went
--     (status posted / private, answer_id = its room message) or why it did not (stopped, error), and for a private
--     preview what kept it from the room (decision JSON: folders, personal, outside; shown to the person only).
--   room_message_sources: an AI answer's "참고한 파일" in the room (copied from message_sources when it is written; a
--     source some member cannot read is removed when the person posts a private preview). Checked for each viewer when
--     the list is opened, like an answer's sources in a chat.
ALTER TABLE chats ADD COLUMN room_id TEXT;
ALTER TABLE chats ADD COLUMN room_outside INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX chats_room_session ON chats(room_id, user_id) WHERE room_id IS NOT NULL;
CREATE TABLE room_ai_turns (
  turn_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','posted','private','stopped','error')),
  answer_id TEXT REFERENCES room_messages(id) ON DELETE SET NULL,
  decision TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX room_ai_turns_active ON room_ai_turns(room_id, status);
CREATE INDEX room_ai_turns_answer ON room_ai_turns(answer_id) WHERE answer_id IS NOT NULL;
CREATE TABLE room_message_sources (
  message_id TEXT NOT NULL REFERENCES room_messages(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT,
  locs TEXT NOT NULL DEFAULT '[]',
  via TEXT NOT NULL,
  by_main INTEGER NOT NULL DEFAULT 1 CHECK(by_main IN (0,1)),
  by_subagent INTEGER NOT NULL DEFAULT 0 CHECK(by_subagent IN (0,1)),
  PRIMARY KEY (message_id, ord)
);
