-- min_compatible_reader: 1
-- Component B: a phone follows reads made on another device (plan docs/AGENTS/plan/20261123-0705-phone-badge-sync.md).
--   push_subscriptions.sync_ok: the phone app said it takes silent syncs (push-sync-v1); an Android app from before
--   would list an empty notification for one while it is open, so only these get one.
--   push_phone_ledger: the notices pushed to each phone (any push source), kept 2 days: what the phone may still show,
--   also after the notice itself was deleted (its delivery row goes with it).
--   push_phone_sync: per phone the icon number it was last sent (an iPhone's; NULL: none known), the digest of the
--   read ids last looked at, a mark of what the person had read then (read_mark: the count is worked out again only
--   after a read), when the last sync went and how many it got that UTC day.
-- Additive only (reader 1): an older build ignores the column and the tables.
ALTER TABLE push_subscriptions ADD COLUMN sync_ok INTEGER NOT NULL DEFAULT 0;
CREATE TABLE push_phone_ledger (
  subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  notification_id TEXT NOT NULL,
  src TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY(subscription_id, notification_id)
);
CREATE INDEX push_phone_ledger_sent ON push_phone_ledger(sent_at);
CREATE TABLE push_phone_sync (
  subscription_id TEXT PRIMARY KEY REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  badge INTEGER,
  digest TEXT,
  read_mark TEXT,
  synced_at TEXT,
  day TEXT,
  day_count INTEGER NOT NULL DEFAULT 0
);
