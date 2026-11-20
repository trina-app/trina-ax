-- min_compatible_reader: 1
-- Component B: a team project is its own chat room (docs/decisions/20261120-project-is-room.md,
-- server/src/rooms/project-room.ts).
--   room_project_links.mode: 'room' = the project's chat room, its members follow the project's readers (Rooms.sync);
--     'linked' = a row from 0.5.21's linked private channel, or one an older build made after a rollback: settled at
--     start (converted to 'room' when the people are the same, else the row is deleted).
--   room_project_links.history_floor_seq: a later member of the room sees its history from this seq on (a converted
--     channel's seq at the conversion, so nobody sees the old channel's private past; 0 for a room made as a project room).
--   room_file_refs: a room file kept in the team folder instead of room storage (the project's Chat attachments; filled
--     from the next step on): where it is and how it is followed (moves, renames, the trash). The follow columns are
--     team_file_refs' own (path, path_at_attach, ino, dev, sha256, event_id, trash_id, trash_suffix, lost).
-- Additive only (reader 1): an older build never reads the columns or the table, and shows a project room as a private
-- channel linked to the project.
ALTER TABLE room_project_links ADD COLUMN mode TEXT NOT NULL DEFAULT 'linked' CHECK (mode IN ('linked', 'room'));
ALTER TABLE room_project_links ADD COLUMN history_floor_seq INTEGER NOT NULL DEFAULT 0;
CREATE TABLE room_file_refs (
  room_file_id TEXT PRIMARY KEY REFERENCES room_files(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  path_at_attach TEXT NOT NULL,
  ino INTEGER,
  dev INTEGER,
  sha256 TEXT,
  event_id INTEGER NOT NULL DEFAULT 0,
  trash_id TEXT,
  trash_suffix TEXT,
  lost INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX room_file_refs_path ON room_file_refs(path);
