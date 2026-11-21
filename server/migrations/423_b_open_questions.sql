-- min_compatible_reader: 1
-- Component B: the AI's questions (ask_user) wait as long as it takes (docs/decisions/20261118-questions-wait-and-todo-card.md,
-- server/src/chat/open-questions.ts). The tool returns at once and the answer ends; the card stays open here, with no
-- time limit, through reloads and restarts. The person's answer starts the next turn of the chat (session resume).
-- request: the card as the apps show it (TurnRequest JSON, ask_user). message_id: the answer that asked (the card shows
-- under it, and the answer's turn continues from it). answer: the person's answer while other questions of the same
-- answer are still open (JSON; NULL until answered). Rows go when the next turn starts (answered, or another message
-- sent in the chat), or with the chat, the answer or the person.
-- Additive only (reader 1): an older build ignores the table; its cards are gone, as an expired card was before.
CREATE TABLE open_questions (
  request_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request TEXT NOT NULL,
  answer TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX open_questions_chat ON open_questions(chat_id);
-- what a user message answered (the engine message names the question; chat/open-questions.ts answeredNote): kept with
-- the message. questions: JSON list of { question, answer }.
CREATE TABLE answered_questions (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  questions TEXT NOT NULL
);
