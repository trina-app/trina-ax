-- min_compatible_reader: 1
-- Component B: team files sent in a room from a phone's attach sheet (POST /api/rooms/:id/team-file).
--   room_files.team_path: the team path an unsent copy was made from (rooms/files.ts teamCopy); NULL for uploads and for
--     the copies "대화방에 보내기" makes and sends at once (audited and counted with the shared answer).
--   room_files.team_stamp: the team file as it was at the copy (its size, modification time and inode): the same file,
--     unchanged, picked again in the same room by the same person before sending gets that copy back, not a new one.
-- A person's unsent copies are capped in bytes (rooms/files.ts TEAM_COPIES_UNSENT_MAX); sending one is audited with its
-- path (rooms/service.ts send: room.team_file).
-- Additive only (reader 1): an older build ignores the columns (an unsent copy is then an upload like any other).
-- Numbered 287: 286 (member_welcome) is the highest on dev.
ALTER TABLE room_files ADD COLUMN team_path TEXT;
ALTER TABLE room_files ADD COLUMN team_stamp TEXT;
CREATE INDEX IF NOT EXISTS room_files_team_unsent ON room_files(user_id) WHERE message_id IS NULL AND team_path IS NOT NULL;
