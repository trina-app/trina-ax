-- min_compatible_reader: 1
-- Component B: who was in a chat shared with people and groups (docs/DECISIONS.md "A link to a chat you were taken out
-- of says so", QA TC-2009/TC-2032).
--   chat_audience_past: a person who saw the chat as one of its people (by name or through a group) at some point:
--     recorded when a save of its audience shows it to them or takes it away, when they leave a listed group and when a
--     listed group is deleted. chat/shared.ts chatFor reads it only for someone who does not see the chat now: they get
--     the 404 with reason `no_longer_shared` ("This chat is no longer shared with you"); everyone else keeps the one 404
--     of a missing chat. Never the chat's creator. The rows go with the chat (ON DELETE CASCADE) and with the person's
--     account (chat/account-cleanup.ts).
-- Additive only (reader 1). 402 and 403 are taken (room message link previews; room app states, #874).
CREATE TABLE chat_audience_past (
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX chat_audience_past_user ON chat_audience_past(user_id);
