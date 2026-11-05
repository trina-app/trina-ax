-- min_compatible_reader: 1
-- Team chat rooms ("대화방" v1, docs/DECISIONS.md "대화방 v1"): people talking to people, apart from the one-person AI
-- chats (chats / messages). Additive only: an older build does not know these tables.
--   rooms: kind 'team' (mirrors the members of group_id; kept by server/src/rooms/sync.ts), 'all' (everyone; one per
--     team), 'dm' (exactly two people; dm_key = the two user ids sorted, one room per pair). last_seq counts the room's
--     messages. A team room whose group was deleted keeps its row with archived_at set and no members.
--   room_members: who is in a room now. last_read_seq: read position. visible_from_seq: the member sees messages with a
--     higher seq only (the room's last_seq when they joined: a later member sees history from their join on). muted.
--   room_messages: seq within the room; author_id is the signed-in sender, never taken from the request. Reserved for
--     the AI step: author_kind 'ai', asked_by (who asked the AI), visibility 'private' with visible_to (seen by one
--     person only; no notice, badge or unread count for anyone else). mentions: JSON array of user ids. A deleted
--     message keeps its row with an empty body. client_id: the sender's idempotency key.
--   room_files: files sent in a room, stored under <data dir>/rooms/<room id>/ outside the team folder (owners and
--     admins can read the team folder outside users/<id>/); served only to the room's current members.
CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('team','all','dm')),
  group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
  dm_key TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0,
  activity_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE UNIQUE INDEX rooms_team_group ON rooms(group_id) WHERE kind = 'team' AND group_id IS NOT NULL;
CREATE UNIQUE INDEX rooms_all ON rooms(kind) WHERE kind = 'all';
CREATE UNIQUE INDEX rooms_dm ON rooms(dm_key) WHERE kind = 'dm';
CREATE TABLE room_members (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TEXT NOT NULL,
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  visible_from_seq INTEGER NOT NULL DEFAULT 0,
  muted INTEGER NOT NULL DEFAULT 0 CHECK(muted IN (0,1)),
  PRIMARY KEY(room_id, user_id)
);
CREATE INDEX room_members_user ON room_members(user_id);
CREATE TABLE room_messages (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  author_kind TEXT NOT NULL DEFAULT 'user' CHECK(author_kind IN ('user','ai')),
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  asked_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  visibility TEXT NOT NULL DEFAULT 'room' CHECK(visibility IN ('room','private')),
  visible_to TEXT REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  reply_to_id TEXT,
  mentions TEXT NOT NULL DEFAULT '[]',
  client_id TEXT,
  created_at TEXT NOT NULL,
  edited_at TEXT,
  deleted_at TEXT,
  CHECK(visibility = 'room' OR visible_to IS NOT NULL),
  UNIQUE(room_id, seq)
);
CREATE UNIQUE INDEX room_messages_client ON room_messages(room_id, author_id, client_id) WHERE client_id IS NOT NULL;
CREATE TABLE room_files (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  message_id TEXT REFERENCES room_messages(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime TEXT NOT NULL,
  kind TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  sha256 TEXT NOT NULL,
  thumb INTEGER NOT NULL DEFAULT 0 CHECK(thumb IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE INDEX room_files_message ON room_files(message_id);
CREATE INDEX room_files_unsent ON room_files(created_at) WHERE message_id IS NULL;
