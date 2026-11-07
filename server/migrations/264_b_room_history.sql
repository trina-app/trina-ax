-- min_compatible_reader: 1
-- 지난 대화 (docs/DECISIONS.md "지난 대화"): a member who joins a team room or the everyone room later sees its earlier
-- history, as in a Slack channel, except the old answers they could not open (server/src/rooms/history.ts). Additive:
--   room_members.history_from_seq: where the member sees the room from once their hidden answers are worked out (0: the
--     whole history, team rooms and the everyone room); NULL until then and in group chats and 1:1s: they see from
--     visible_from_seq (the room's last seq when they joined), which stays the floor of their read position.
--   room_members.history_recheck: 1 when their access changed since their hidden answers were worked out: the next pass
--     walks them again and keeps only what is still hidden (a member's hidden answers only become fewer).
--   room_hidden_answers: per member, the old answers they may not see (the room's AI's, one a person shared from their
--     own AI chat, a message an AI app sent after reading): it used something they cannot open, or what it used was not
--     kept. Worked out when they join; gone when they leave. see_seq: the seq that decides who sees it (a thread
--     reply's is its thread's first message's): an answer that used the room from there on stays private for them.
--   room_messages.source_scope: what a person's message brought in from elsewhere, as checked when it was sent
--     ({sources, unknown} JSON): an answer shared from their own AI chat, or a message an AI app sent after reading.
--     NULL: their own words. An AI answer's is room_ai_turns.scope (246).
-- An older build ignores all of it: it shows every member the room from their join on, as before (visible_from_seq is
-- unchanged, so nothing hidden is exposed), and the reader level stays.
-- Numbered 264: 262 is feat/inbox-room-notices', 263 feat/ios-notification-labels' (not on dev yet).
ALTER TABLE room_members ADD COLUMN history_from_seq INTEGER;
ALTER TABLE room_members ADD COLUMN history_recheck INTEGER NOT NULL DEFAULT 0;
ALTER TABLE room_messages ADD COLUMN source_scope TEXT;
CREATE TABLE room_hidden_answers (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES room_messages(id) ON DELETE CASCADE,
  see_seq INTEGER NOT NULL,
  PRIMARY KEY (room_id, user_id, message_id)
) WITHOUT ROWID;
CREATE INDEX room_hidden_answers_see ON room_hidden_answers(room_id, user_id, see_seq);
CREATE INDEX room_messages_answers ON room_messages(room_id, seq) WHERE author_kind = 'ai' OR answer_at IS NOT NULL OR source_scope IS NOT NULL;
