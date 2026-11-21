-- min_compatible_reader: 1
-- Component B: a room's Files list (GET /api/rooms/:id/files, rooms/search.ts listRoomFiles) reads one room's sent
-- files newest first; the table had only the message index, the sender's and partial ones for unsent uploads, so a
-- room with a few files read every room's files (docs/decisions/20261120-project-is-room.md D8). Sent files only, in
-- the order of the rowid within a room. Additive (reader 1).
CREATE INDEX IF NOT EXISTS room_files_by_room ON room_files(room_id) WHERE message_id IS NOT NULL;
