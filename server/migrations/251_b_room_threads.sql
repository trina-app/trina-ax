-- min_compatible_reader: 6
-- Threads and reactions in rooms (docs/DECISIONS.md "스레드와 반응"). Additive only: three columns, two tables, indexes.
--   room_messages.thread_root_id: a reply in a thread, the id of the message it answers there (the root, a message of
--     the room's timeline: not an event line, not deleted, for the whole room). NULL: a message of the timeline.
--   room_messages.thread_root_seq: the root's seq, kept on each reply. A thread follows its root: a member sees a reply
--     only when they see the root (visible_from_seq < the root's seq), whenever the reply was written. A root's seq never
--     changes (only a private preview moves when it is posted, and a root is never private).
--   room_messages.also_in_room: 1 for a reply also sent to the room ("대화방에도 보내기"): it shows in the timeline too,
--     marked as a thread reply, and counts there like any message. 0 for every other row.
--   room_thread_follows: who follows a thread (the root's author, everyone who replied, people mentioned in a reply) and
--     their read position in it (a seq). New replies notify them (unless they muted the room) and mark the root for them.
--   room_reactions: one of the fixed emoji (shared/src/api/rooms.ts ROOM_REACTIONS) by one person on one message. Never
--     notified, never unread, never given to the AI. A person's reactions in a room go when they leave it.
-- Reader 6 (server/src/db.ts SCHEMA_READER_LEVEL): an older build knows no thread_root_id, so it would show every reply
-- in the room's timeline, count it as unread and notify it, and show the replies of a root written before someone
-- joined to that person (it checks a reply's own seq). So a build before this one refuses this database; going back
-- means restoring the backup taken before the update (needsBackupRestoreToRollBack).
ALTER TABLE room_messages ADD COLUMN thread_root_id TEXT;
ALTER TABLE room_messages ADD COLUMN thread_root_seq INTEGER;
ALTER TABLE room_messages ADD COLUMN also_in_room INTEGER NOT NULL DEFAULT 0 CHECK(also_in_room IN (0,1));
CREATE INDEX room_messages_thread ON room_messages(thread_root_id, seq) WHERE thread_root_id IS NOT NULL;
CREATE TABLE room_thread_follows (
  root_id TEXT NOT NULL REFERENCES room_messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (root_id, user_id)
);
CREATE INDEX room_thread_follows_user ON room_thread_follows(user_id, room_id);
CREATE TABLE room_reactions (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES room_messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX room_reactions_user ON room_reactions(room_id, user_id);
