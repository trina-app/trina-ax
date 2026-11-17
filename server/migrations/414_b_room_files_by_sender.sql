-- min_compatible_reader: 1
-- Component B: "Files you sent" (GET /api/room-files/mine, rooms/search.ts listMyRoomFiles) lists a person's own files
-- sent in rooms, largest first; "Ask people to clean up" (system/storage-cleanup.ts) sums them per person. Both read
-- room_files by sender and size; the table had only the message index and partial ones for unsent uploads
-- (docs/decisions/20261116-room-files-cleanup.md). Sent files only. Additive (reader 1).
CREATE INDEX IF NOT EXISTS room_files_by_sender ON room_files(user_id, size DESC) WHERE message_id IS NOT NULL;
