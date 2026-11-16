-- min_compatible_reader: 1
-- Component G: Inbox rows about the team's disk (docs/decisions/20261116-storage-full-notices.md,
-- server/src/system/storage.ts checkAlert). 'storage.filling' to the owners and admins when the disk is 80 % full and
-- again at 95 %, at most once a day each (the live toast only reached people who were online); 'storage.cleanup' for the
-- next step, an admin's "Ask people to clean up" (the people whose files in conversations take the most space; who
-- asked is by_user), listed here now because a table's CHECK is never changed later.
-- notification_inbox has a fixed event_type CHECK list and tables are never rebuilt, so this has its own table, as
-- engine_start_notices does. percent: how full the disk was (the plan's view); rooms_bytes: the files in conversations
-- as last measured (null before the first measurement after a start): one number for the team, never a name. Metadata
-- only. Additive only (reader 1): an older build does not list them.
CREATE TABLE storage_notices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('storage.filling','storage.cleanup')),
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT,
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK(suppressed IN (0,1)),
  percent INTEGER,
  rooms_bytes INTEGER,
  by_user TEXT,
  UNIQUE(user_id,event_type,source_id)
);
CREATE INDEX storage_notices_user_page ON storage_notices(user_id,suppressed,created_at DESC,id DESC);
CREATE INDEX storage_notices_retention ON storage_notices(created_at);
