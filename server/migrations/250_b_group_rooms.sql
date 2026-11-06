-- min_compatible_reader: 5
-- Group chats and room names (docs/DECISIONS.md "그룹 대화와 방 이름"). Additive only: two nullable columns.
--   rooms.name: a room's own name (trimmed, 1-80 characters, no control characters), set by a member who may rename
--     it (a group chat: any member; a team room or the everyone room: an owner or admin in it; never a DM). NULL: the
--     server's name (the group's name, the app's word for everyone, a group chat's members). Rooms.sync never touches
--     it. Group chats themselves are rooms of kind 'group', which 240's CHECK already allows (tables are never rebuilt).
--   room_messages.event: an event line, a JSON object {"type": "created" | "renamed" | "added" | "left" | "removed",
--     ...}; author_kind 'user' and author_id = who did it (240's CHECK allows only 'user' and 'ai'). Such a row takes a
--     seq so it sits in order, but it is no message: body '', no unread count, badge, notice or push, not editable,
--     deletable, quotable or postable, and never given to the AI (server/src/rooms/store.ts, service.ts, ai.ts).
-- Reader 5 (server/src/db.ts SCHEMA_READER_LEVEL): an older build would list a group chat as a room of a kind its
-- contract does not know (RoomKind has no 'group': the response check fails, and without the check it is shown under
-- the everyone room's name) and an event line as an empty message from the person who did it, which they could edit
-- into words and which counts as unread. So a build before this one refuses this database; going back means restoring
-- the backup taken before the update (the update screen says so: needsBackupRestoreToRollBack).
ALTER TABLE rooms ADD COLUMN name TEXT;
ALTER TABLE room_messages ADD COLUMN event TEXT;
