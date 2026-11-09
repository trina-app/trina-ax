-- min_compatible_reader: 1
-- Component B: what an AI turn's chat had seen while it ran (docs/DECISIONS.md "대화방을 읽은 뒤 카드 줄이기").
--   turns.outside_content: 0 nothing someone else wrote; 1 content someone else wrote (chats.session_tainted: other
--     people's files, attachments, project instructions); 2 a team chat room's messages or something from outside the
--     team (chats.rooms_seen, a room's own session, chats.room_outside: the web, a search, a connection, the browser).
--   A file in the person's own folder whose newest content an AI turn wrote carries that turn's mark: a chat that reads
--   it later counts it as that much outside content (chat/turn.ts noteReads: 1 taints the chat, so remember asks; 2 also
--   lets no room card be skipped).
-- Additive only (reader 1): an older build ignores the column. Backfill: a turn of a chat that read rooms or of a room's
-- session 2, of any other tainted chat 1, of a chat that is gone 2 (unknown counts as outside); web use before this
-- build left no mark of its own, so such a turn's chat counts by its taint (1).
-- Numbered 281: 280 (project_folder_made) is the highest on dev.
ALTER TABLE turns ADD COLUMN outside_content INTEGER NOT NULL DEFAULT 0;
UPDATE turns SET outside_content = COALESCE((SELECT CASE WHEN c.rooms_seen = 1 OR c.room_id IS NOT NULL OR c.room_outside = 1 THEN 2
  WHEN c.session_tainted = 1 THEN 1 ELSE 0 END FROM chats c WHERE c.id = turns.chat_id), 2);
