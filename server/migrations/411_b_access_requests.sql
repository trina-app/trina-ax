-- min_compatible_reader: 1
-- Component B: "Ask for access" on a chat's or a project's link (QA TC-4185, TC-4186; docs/decisions/
-- 20261116-chat-project-ask-access.md, server/src/chat/access-requests.ts). The file requests (355, file_access_requests)
-- hang on a file's link row (share_id, a foreign key), so a chat or a project gets its own rows here, with a kind.
--   access_requests: one ask of a person to open a chat (kind 'chat', target_id a chats.id) or a team project (kind
--     'project', target_id a projects.id). owner_id: whose chat or project it is (its creator; '' when none is known),
--     the key of the per-owner daily limit, shared with the file requests. One pending per person and target. No
--     foreign key to the target (two kinds): a request whose chat or project went is closed when someone reads it.
--   access_request_notices: the Activity rows. access.requested to whoever answers it (source: the request's kind,
--     target and asker, '<kind>:<target>:<asker>', one row per person, target and asker, brought back up by a new ask);
--     access.answered to the asker (source: the request id) on a decline, or when a project's Share added them.
--     Metadata only: never a title or a name.
--   access_request_push_deliveries: the same columns as push_deliveries (server/src/notifications/push-service.ts
--     SOURCES), for access.requested only.
-- Additive only (reader 1): an older build does not know the tables.
CREATE TABLE access_requests (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('chat','project')),
  target_id TEXT NOT NULL,
  requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL DEFAULT '',
  message TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','approved','declined','closed')),
  created_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT
);
CREATE UNIQUE INDEX access_requests_one_pending ON access_requests(kind, target_id, requester_id) WHERE state = 'pending';
CREATE INDEX access_requests_requester ON access_requests(requester_id, created_at);
CREATE INDEX access_requests_pair ON access_requests(requester_id, owner_id, created_at);
CREATE INDEX access_requests_target ON access_requests(kind, target_id);
CREATE TABLE access_request_notices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('access.requested','access.answered')),
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT,
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK(suppressed IN (0,1)),
  UNIQUE(user_id,event_type,source_id)
);
CREATE INDEX access_request_notices_user_page ON access_request_notices(user_id,suppressed,created_at DESC,id DESC);
CREATE INDEX access_request_notices_retention ON access_request_notices(created_at);
CREATE TABLE access_request_push_deliveries (
  notification_id TEXT NOT NULL REFERENCES access_request_notices(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at TEXT NOT NULL,
  lease_until TEXT,
  expires_at TEXT NOT NULL,
  PRIMARY KEY(notification_id,subscription_id)
);
CREATE INDEX access_request_push_deliveries_due ON access_request_push_deliveries(state,next_at);
