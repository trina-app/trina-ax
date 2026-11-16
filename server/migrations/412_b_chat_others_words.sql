-- min_compatible_reader: 1
-- Component B: a chat that holds content another person wrote (docs/decisions/20261116-always-allow-more-cards.md
-- "Content written by others").
--   chats.others_words: 1 once something the chat's person did not write themselves came in: a team file another
--     person wrote or changed, a file shared with them, a web page or search, a connected service's answer, a room's
--     file, another person's skill or project instructions (chat/turn.ts markOthersWords). From then on an action that
--     reaches other people (a share, a post to a room, a team file attached to a send, a project's members) goes
--     without its card under the person's "Always allow" only for what their own message names. Cleared with the
--     session (a chat's first message, as session_tainted and room_outside).
--   Narrower than session_tainted, which also counts the person's own uploads and attachments; other people's
--   messages in the chat itself are read apart (a shared chat, rooms_seen, a side chat, a quote).
-- Additive only (reader 1): an older build ignores the column.
-- Backfill: a chat already marked as holding outside content keeps asking (unknown counts as others' words).
-- Numbered 410: 409 (chat_thread_notice_cleanup) is the highest of B's range on dev.
ALTER TABLE chats ADD COLUMN others_words INTEGER NOT NULL DEFAULT 0;
UPDATE chats SET others_words = 1 WHERE session_tainted = 1 OR room_outside = 1;
