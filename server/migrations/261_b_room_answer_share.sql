-- min_compatible_reader: 1
-- "대화방에 보내기" (shared/src/api/chats.ts shareAnswerToRoom, server/src/chat/answer-share.ts): a finished answer of a
-- person's own AI chat posted to a room they are in, as their own message (author_kind 'user'). Additive only (reader 1):
--   room_messages.answer_at: where the AI's answer starts in body (before it: the person's one-line note, maybe empty);
--     NULL = not a shared answer (every other message). Read by rooms/store.ts messagesOut (RoomMessage.sharedAnswer,
--     and its team-file links checked per viewer in `openable` like an AI answer's).
--   room_messages.answer_cut: 1 when the answer was too long for one message and ends with a line that says so.
-- An older build ignores both: it shows the message as plain text by its author (the note, then the answer), lets its
-- author edit it, and never treats it as an AI answer (nothing is exposed).
-- Numbered 261: 259 is skipped and 260 is the skill share targets'.
ALTER TABLE room_messages ADD COLUMN answer_at INTEGER;
ALTER TABLE room_messages ADD COLUMN answer_cut INTEGER NOT NULL DEFAULT 0;
