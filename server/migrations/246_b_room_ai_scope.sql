-- min_compatible_reader: 1
-- 대화방의 트리나 (docs/DECISIONS.md "대화방의 트리나", what makes an answer private): every room question starts with
-- an empty read scope and outside mark (server/src/chat/turn.ts), so the session's scope is that of its latest question
-- only. room_ai_turns.scope keeps what one question used ({ sources, outside } JSON, written when it ends), so posting
-- its private preview later decides again on that question's own sources (server/src/rooms/ai.ts share). Additive only
-- (reader 1): an older build never reads it, and a row without it is decided on the session's scope as before.
ALTER TABLE room_ai_turns ADD COLUMN scope TEXT;
