-- min_compatible_reader: 1
-- Component B: a project room that was made on purpose stays in the people's lists before its first message
-- (docs/AGENTS/plan/20261121-1503-p3-structure-polish.md, TC-6733).
--   room_project_links.listed: 1 for a conversation made a project ("Make it a project") and for a room opened with
--     "New project with {name}"; 0 for a room made the first time the project page opens its chat (that one is listed
--     only after its first message). Rooms already made a project are marked from their 'project_made' line.
-- Additive only (reader 1): an older build never reads the column.
ALTER TABLE room_project_links ADD COLUMN listed INTEGER NOT NULL DEFAULT 0 CHECK (listed IN (0, 1));
UPDATE room_project_links SET listed = 1 WHERE mode = 'room' AND EXISTS (
  SELECT 1 FROM room_messages m WHERE m.room_id = room_project_links.room_id AND m.event IS NOT NULL
    AND json_extract(m.event, '$.type') = 'project_made' AND json_extract(m.event, '$.projectId') = room_project_links.project_id);
