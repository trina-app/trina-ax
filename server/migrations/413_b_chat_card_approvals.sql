-- min_compatible_reader: 1
-- Component B: what the person allowed on a card in a chat, so the same card does not come back for the same kind of
-- action to the same target in that chat (docs/decisions/20261117-card-approved-once-per-chat.md, chat/card-approvals.ts).
--   chat_card_approvals: one row per [이번만 허용] / [보내기] the person answered on a server card (never "Always allow",
--     which has its own tables). kind: file_change (a change to one team file after a room read), connector (a write to
--     one connection with one tool; detail.pins: every value of the call that may say where it goes), connector_made
--     (the id of a draft that a connector write the person allowed on its card made, unchanged since), room_post (a post
--     to one room or thread), save_wider (a save where more people can see: the folder and who may see it; detail.sources:
--     the narrower sources the card named). target: the kind's key, built by the server from the call, never by the AI. user_id: the
--     person who answered; only their own later turns are covered. created_at: covers for 12 hours at most.
--   Cleared with the chat's session (chat/turn.ts newSession), like chats.others_words.
-- Additive only (reader 1): an older build ignores the table and asks as before.
CREATE TABLE chat_card_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX chat_card_approvals_key ON chat_card_approvals(chat_id, user_id, kind, target);
