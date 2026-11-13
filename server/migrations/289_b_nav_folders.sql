-- min_compatible_reader: 1
-- Component B: list folders (docs/DECISIONS.md "List folders"; server/src/chat/nav-folders.ts). A person's own folders
-- in their Trina list (kind 'chats': their AI chats) and in their 대화 list (kind 'rooms': rooms, DMs, group chats).
-- Only the maker sees them; they hold no files, instructions or permissions and never change who sees a chat or a room.
-- Not "personal folders" (that is a person's files folder, users/<name>/) and not "folders" (the team drive's table).
--   nav_folders: one row per folder, its place in its list (position, 0..n-1 per person and kind) and its name (as
--     typed, NFC, trimmed; name_key = NFC + lower case, unique per person and kind).
--   nav_folder_items: one row per chat or room a person put in one of their folders (at most one folder each). The
--     composite key ties an item to a folder of the same person and the same kind, so no code path can put an item in
--     someone else's folder or a chat in a room folder. What a folder shows is decided on every read by one SQL check
--     (chat/nav-folders.ts): a row of something its person cannot open now is never listed or counted.
-- Rows go with the folder, the chat or the room (cascade, a purge), when the chat goes to the trash or gets a project,
-- and when the person leaves the room or is taken out. A hidden or archived room keeps its row (filtered on read).
-- A deleted account keeps its users row (tombstone), so the cascade on user_id never runs: server/src/admin/users.ts
-- deletes both tables' rows of the person by hand.
-- Additive only (reader 1): an older build ignores both tables (no folders, its lists as before).
-- Numbered 289: 288 (skill_draft_from_form) is the highest B on dev and no open branch uses 289.
CREATE TABLE nav_folders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('chats', 'rooms')),
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, user_id, kind)
);
CREATE INDEX nav_folders_user ON nav_folders(user_id, kind, position);
CREATE UNIQUE INDEX nav_folders_name ON nav_folders(user_id, kind, name_key);

CREATE TABLE nav_folder_items (
  folder_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('chats', 'rooms')),
  chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
  room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL,
  FOREIGN KEY (folder_id, user_id, kind) REFERENCES nav_folders(id, user_id, kind) ON DELETE CASCADE,
  CHECK ((kind = 'chats' AND chat_id IS NOT NULL AND room_id IS NULL)
      OR (kind = 'rooms' AND room_id IS NOT NULL AND chat_id IS NULL))
);
CREATE UNIQUE INDEX nav_folder_items_chat ON nav_folder_items(user_id, chat_id) WHERE chat_id IS NOT NULL;
CREATE UNIQUE INDEX nav_folder_items_room ON nav_folder_items(user_id, room_id) WHERE room_id IS NOT NULL;
CREATE INDEX nav_folder_items_folder ON nav_folder_items(folder_id);
CREATE INDEX nav_folder_items_chat_id ON nav_folder_items(chat_id) WHERE chat_id IS NOT NULL;
CREATE INDEX nav_folder_items_room_id ON nav_folder_items(room_id) WHERE room_id IS NOT NULL;
