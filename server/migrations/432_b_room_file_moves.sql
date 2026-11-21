-- min_compatible_reader: 1
-- Component B: a conversation made a project (POST /api/rooms/:id/make-project, docs/AGENTS/plan/
-- 20261121-0619-structure-polish.md A) moves its old files into the project's Chat attachments, one file at a time,
-- after the conversion (server/src/rooms/file-moves.ts).
--   room_files.origin: how a room file was made ('upload' from the computer, 'team_copy' a phone's team pick,
--     'answer_copy' a copy of a team file an AI answer attached), written for every new row. NULL on rows from before
--     this migration: the mover then reads team_path and the message's scope.attached, and in doubt keeps the file.
--   room_file_moves: one row per file that moves, with its state ('pending', 'placing' staged under .system/room-moves/,
--     'cleanup' going back to room storage, 'done', 'kept', 'cancelled' its message deleted). No cascade on the file: a
--     message deleted mid-move must not erase the record of a file already placed. actor: who made the project;
--     sender: who sent the file (the uploader in its history).
-- Additive only (reader 1): an older build never reads the column or the table.
ALTER TABLE room_files ADD COLUMN origin TEXT CHECK (origin IN ('upload', 'team_copy', 'answer_copy'));
CREATE TABLE room_file_moves (
  id TEXT PRIMARY KEY,
  room_file_id TEXT REFERENCES room_files(id) ON DELETE SET NULL,
  room_id TEXT NOT NULL, project_id TEXT NOT NULL, actor TEXT NOT NULL, sender TEXT,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'placing', 'cleanup', 'done', 'kept', 'cancelled')),
  staged TEXT, placed_path TEXT, ino INTEGER, dev INTEGER, sha256 TEXT NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0, reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX room_file_moves_file ON room_file_moves (room_file_id) WHERE room_file_id IS NOT NULL;
CREATE INDEX room_file_moves_open ON room_file_moves (state) WHERE state IN ('pending', 'placing', 'cleanup', 'cancelled');
