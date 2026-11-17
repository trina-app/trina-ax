-- min_compatible_reader: 1
-- Component B: where a file sent in a room was saved in the team folder (docs/decisions/20261117-room-file-save-btn.md).
--   room_file_saves: one row per room file and team path it was copied to, by a person's "Save to team folder"
--     (rooms/save-to-team.ts) or the AI's save_room_file. `sha256` is the copy's bytes as saved (the room file's own);
--     `size` the same bytes' length. A row only says where to look: every read checks again that the file is still
--     there with those bytes and that the viewer may open it, so a moved, changed or deleted copy simply stops counting.
--   No user column: who saved it is in file_events, and the row is about the file, not the person.
-- Additive only (reader 1): an older build ignores the table. Numbered 415: 414 is taken by an open PR.
CREATE TABLE room_file_saves (
  file_id TEXT NOT NULL REFERENCES room_files(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  saved_at TEXT NOT NULL,
  PRIMARY KEY (file_id, path)
);
