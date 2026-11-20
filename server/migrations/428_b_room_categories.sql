-- min_compatible_reader: 1
-- Component B: team-wide conversation categories (shared/src/api/room-categories.ts, server/src/rooms/categories.ts).
-- An admin or the owner makes them, names them, orders them and puts channels in them; everyone sees the same
-- categories in the Chats list, each holding the channels of it they are in. They replace the personal conversation
-- folders on screen (nav_folders kind 'rooms' is no longer shown). Additive only (reader 1): an older build never reads
-- this table or the new column.
CREATE TABLE room_categories (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  -- NFC, trimmed, lower case: one name per team, any letter case
  name_key   TEXT NOT NULL UNIQUE,
  position   INTEGER NOT NULL,
  -- who made it: never shown; set null when their account goes
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- the category a channel is in, the same for every member; a deleted category lets its channels go back to Channels
ALTER TABLE rooms ADD COLUMN category_id TEXT REFERENCES room_categories(id) ON DELETE SET NULL;
CREATE INDEX rooms_category ON rooms(category_id) WHERE category_id IS NOT NULL;
