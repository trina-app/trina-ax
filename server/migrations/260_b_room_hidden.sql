-- Hiding a conversation (docs/DECISIONS.md "대화 숨기기", shared/src/api/rooms.ts setRoomHidden). Additive only (reader 1):
--   room_members.hidden_at: when this member hid the room from their own lists (a DM, a team room, the everyone room);
--     NULL = shown. The server clears it when something for them arrives (rooms/service.ts unhideFor) and when they open
--     the room again. Nobody else reads it.
-- An older build ignores the column: it lists every room as before (nothing is hidden there, nothing is exposed).
-- Numbered 258: 256 is skipped and 257 is the member skill contributions'.
ALTER TABLE room_members ADD COLUMN hidden_at TEXT;
-- min_compatible_reader: 1
