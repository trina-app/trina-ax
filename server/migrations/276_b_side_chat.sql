-- min_compatible_reader: 1
-- Component B: the room side chat (docs/DECISIONS.md "Trina side chat").
--   chats.side_room_id: a person's own AI chat opened from a room's side panel (✦ Trina). The AI is told the room and
--     reads it with its room tools, as the person sees it; an answer goes to the room only with "Share to room"
--     (chat/answer-share.ts). NULL: an ordinary chat. The chat stays the person's when they leave the room.
-- Additive only (reader 1): an older build ignores the column and lists the chat as an ordinary chat.
-- Numbered 276: 275 (notification_preview) is the highest on dev.
ALTER TABLE chats ADD COLUMN side_room_id TEXT;
CREATE INDEX IF NOT EXISTS chats_side_room ON chats(user_id, side_room_id) WHERE side_room_id IS NOT NULL;
