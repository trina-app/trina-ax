-- min_compatible_reader: 1
-- 내 AI 채팅에서 대화방 읽기 (docs/DECISIONS.md): a person's own AI chat reads their team chat rooms with the tools rooms,
-- room_read and room_file (server/src/chat/room-tools.ts). chats.rooms_seen = 1 once such a tool was called in the chat:
-- room messages are other people's words, so from then on, for the rest of that chat, every tool call that may change
-- something waits for the person's yes on a server card (server/src/chat/turn.ts confirmRoomChange), as in a room's own
-- AI session. Never cleared (not by a new session, an edited first message or a restart). Additive only (reader 1): an
-- older build has no room tools and never reads it; in a chat that already holds room content it asks only where it
-- asked before (docs/DECISIONS.md, "Rollback").
-- Numbered 254 as reserved for this branch: 249 and 253 are the skill-share branch's, 252 feat/phone-nav's.
ALTER TABLE chats ADD COLUMN rooms_seen INTEGER NOT NULL DEFAULT 0;
