-- min_compatible_reader: 1
-- Component C: files shared in one press, told once, pushed once (QA TC-3510, docs/decisions/20261116-file-share-everyone.md,
-- server/src/files/shares.ts shareMany). "Everyone on the team" (QA TC-3509) needs no table: it is a group grant with
-- the reserved id '*' in file_share_grants (355), which an older build reads as a group that does not exist (no access).
--   file_share_batches: one Share press of several files with the same people (who pressed, when). A notice of several
--     files names the press (file_share_notices.source_id 'b:<id>'); the files listed are the ones the viewer can open
--     when they look. Deleted with its last notice (retention) or with its sharer's account.
--   file_share_batch_items: the press's files (by their share row; a purged file's row goes with it).
--   file_share_notices.named: the person was added by name (not through a group or the whole team): only such a notice
--     is pushed.
--   file_share_push_deliveries: the same columns as push_deliveries (server/src/notifications/push-service.ts SOURCES),
--     for file_share_notices of a share by name.
-- Additive only (reader 1): an older build ignores the column and does not know the tables.
CREATE TABLE file_share_batches (
  id TEXT PRIMARY KEY,
  by_user TEXT REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE INDEX file_share_batches_created ON file_share_batches(created_at);
CREATE TABLE file_share_batch_items (
  batch_id TEXT NOT NULL REFERENCES file_share_batches(id) ON DELETE CASCADE,
  share_id TEXT NOT NULL REFERENCES file_shares(id) ON DELETE CASCADE,
  PRIMARY KEY(batch_id, share_id)
);
CREATE INDEX file_share_batch_items_share ON file_share_batch_items(share_id);

ALTER TABLE file_share_notices ADD COLUMN named INTEGER NOT NULL DEFAULT 0;

CREATE TABLE file_share_push_deliveries (
  notification_id TEXT NOT NULL REFERENCES file_share_notices(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at TEXT NOT NULL,
  lease_until TEXT,
  expires_at TEXT NOT NULL,
  PRIMARY KEY(notification_id,subscription_id)
);
CREATE INDEX file_share_push_deliveries_due ON file_share_push_deliveries(state,next_at);
