-- min_compatible_reader: 1
-- Component B: what an AI turn's chat had seen while it ran (docs/DECISIONS.md "대화방을 읽은 뒤 카드 줄이기").
--   turns.outside_content: 0 nothing someone else wrote; 1 content someone else wrote (chats.session_tainted: other
--     people's files, attachments, project instructions); 2 a team chat room's messages or something from outside the
--     team (chats.rooms_seen, a room's own session, chats.room_outside: the web, a search, a connection, the browser).
--   A file in the person's own folder whose content an AI turn wrote carries that turn's mark: a chat that reads it later
--   counts it as that much outside content (chat/turn.ts noteReads: 1 taints the chat, so remember asks; 2 also lets no
--   room card be skipped). The bytes are traced by their hash too (file_events_sha256: copies, restores).
--   chats.room_outside, a room question's mark until now, is kept for the person's own chats too (until a new session).
-- Additive only (reader 1): an older build ignores the column and the index.
-- Backfill: a turn of a chat that read rooms or of a room's session 2, of any other tainted chat 1, of a chat that is gone
-- 2 (unknown counts as outside). An own chat whose answers used a tool outside the team's own words (their stored steps:
-- the web search, the browser, a connection's tools, `rooms`, anything not on chat/turn.ts OWN_CHAT_TEAM_TOOLS as this
-- build has it, nor an attached file's line) gets room_outside first, and its turns 2.
-- Numbered 281: 280 (project_folder_made) is the highest on dev.
ALTER TABLE turns ADD COLUMN outside_content INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS file_events_sha256 ON file_events(sha256) WHERE sha256 IS NOT NULL;
UPDATE chats SET room_outside = 1 WHERE room_id IS NULL AND room_outside = 0 AND EXISTS (
  SELECT 1 FROM messages m WHERE m.chat_id = chats.id AND m.role = 'assistant' AND json_valid(m.steps) AND EXISTS (
    SELECT 1 FROM json_each(m.steps) s WHERE json_type(s.value) = 'object' AND json_extract(s.value, '$.tool') IS NOT NULL
      AND json_extract(s.value, '$.tool') NOT IN ('agent', 'artifact', 'ask_user', 'copy_files', 'edit', 'edit_files',
        'edit_hwp', 'find_skills', 'glob', 'grep', 'hwp_render', 'knowledge_explore', 'list', 'make_file', 'move_files',
        'project_chat', 'project_chats', 'read', 'remember', 'rename_file', 'room_file', 'room_read', 'room_thread',
        'save_room_file', 'search', 'set_title', 'share_file', 'skill', 'write', 'attachment')));
UPDATE turns SET outside_content = COALESCE((SELECT CASE WHEN c.rooms_seen = 1 OR c.room_id IS NOT NULL OR c.room_outside = 1 THEN 2
  WHEN c.session_tainted = 1 THEN 1 ELSE 0 END FROM chats c WHERE c.id = turns.chat_id), 2);
