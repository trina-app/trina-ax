-- min_compatible_reader: 1
-- Component B: pinned chats (docs/DECISIONS.md "Pinned chats"; server/src/chat/pins.ts).
--   chat_pins: one row per person and chat they pinned to the top of their chat list ("상단에 고정"). A person's own
--     choice: a shared project chat someone else made can be pinned too, for the one who pinned it only. Goes with the
--     chat (purge) and the person; the server drops it when the chat goes to the trash and when its person can no
--     longer see the chat.
-- Additive only (reader 1): an older build ignores the table (no pins, its list in the usual order).
-- Numbered 277: 275 (notification_preview) is the highest on dev, 276 is taken by an open branch (side chat).
CREATE TABLE chat_pins (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  pinned_at TEXT NOT NULL,
  PRIMARY KEY (user_id, chat_id)
);
CREATE INDEX chat_pins_chat ON chat_pins(chat_id);
