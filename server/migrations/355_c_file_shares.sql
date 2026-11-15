-- min_compatible_reader: 1
-- Component C: a member shares a file they own with chosen people or groups, Drive style (QA TC-3093, plan
-- docs/AGENTS/plan/20261115-1407-file-share-links.md, server/src/files/shares.ts).
--   file_shares: one row per file that has a link (/f/<id>). `id` is the link (16 random bytes, base64url); `path` the
--     file's current path, rewritten by moves like file_versions.path; ino / dev / sha256 pin the row to the file, so a
--     different file put at the same path never inherits it; owner_id from the event walk (creatorOf), NULL when no
--     owner is known (a team file: its requests go to the owner and admins). state 'trashed' while the file is in the
--     trash (trash_id), deleted with the trash item.
--   file_share_grants: who may open it besides the people the folder rules let in: a person or a group, view only.
--   file_access_requests: "Ask for access" by someone the link does not open for; one pending per person and file.
--   file_share_notices: the Activity rows (file.shared to the recipient, file.access_requested to the owner,
--     file.access_answered to the requester on a decline, file.unshared_by_move to the owner). Activity only: no push
--     table in this release. Metadata only: the source is a request's or a share's id, never a name.
-- Additive only (reader 1): an older build does not know the tables.
CREATE TABLE file_shares (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  ino INTEGER,
  dev INTEGER,
  sha256 TEXT,
  owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'live' CHECK(state IN ('live','trashed')),
  trash_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX file_shares_live_path ON file_shares(path) WHERE state = 'live';
CREATE INDEX file_shares_trash ON file_shares(trash_id) WHERE trash_id IS NOT NULL;
CREATE INDEX file_shares_owner ON file_shares(owner_id);
CREATE TABLE file_share_grants (
  share_id TEXT NOT NULL REFERENCES file_shares(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK(subject_type IN ('user','group')),
  subject_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'view' CHECK(role IN ('view')),
  granted_by TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  via TEXT NOT NULL CHECK(via IN ('dialog','ai','request')),
  PRIMARY KEY(share_id, subject_type, subject_id)
);
CREATE INDEX file_share_grants_subject ON file_share_grants(subject_type, subject_id);
CREATE TABLE file_access_requests (
  id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL REFERENCES file_shares(id) ON DELETE CASCADE,
  requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_id TEXT,
  message TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','approved','declined','closed')),
  created_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT
);
CREATE UNIQUE INDEX file_access_requests_one_pending ON file_access_requests(share_id, requester_id) WHERE state = 'pending';
CREATE INDEX file_access_requests_pair ON file_access_requests(requester_id, owner_id, created_at);
CREATE INDEX file_access_requests_requester ON file_access_requests(requester_id, created_at);
CREATE TABLE file_share_notices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('file.shared','file.access_requested','file.access_answered','file.unshared_by_move')),
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT,
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK(suppressed IN (0,1)),
  UNIQUE(user_id,event_type,source_id)
);
CREATE INDEX file_share_notices_user_page ON file_share_notices(user_id,suppressed,created_at DESC,id DESC);
CREATE INDEX file_share_notices_retention ON file_share_notices(created_at);
