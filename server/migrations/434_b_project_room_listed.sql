-- min_compatible_reader: 1
-- Component B: a project room that was made on purpose stays in the people's lists before its first message
-- (docs/AGENTS/plan/20261121-1503-p3-structure-polish.md, TC-6733).
--   room_project_links.listed: 1 for a conversation made a project ("Make it a project") and for a room opened with
--     "New project with {name}"; 0 for a room made the first time the project page opens its chat (that one is listed
--     only after its first message).
-- Rooms that already are a project are marked when a conversation became them: a room a person made (rooms.created_by;
-- the project page makes its room with none) or one with history before the conversion (history_floor_seq > 0). The
-- backfill reads only reader-1 columns (rooms 240, room_project_links 427/430), never room_messages.event (250, reader
-- 5), so it runs on every database this migration can meet. At worst it lists a room that people already talked in.
-- Additive only (reader 1): an older build never reads the column.
ALTER TABLE room_project_links ADD COLUMN listed INTEGER NOT NULL DEFAULT 0 CHECK (listed IN (0, 1));
UPDATE room_project_links SET listed = 1 WHERE mode = 'room' AND (history_floor_seq > 0
  OR EXISTS (SELECT 1 FROM rooms r WHERE r.id = room_project_links.room_id AND r.created_by IS NOT NULL));
