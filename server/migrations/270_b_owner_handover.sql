-- min_compatible_reader: 1
-- Onboarding v6: easy owner handover (server/src/admin/handover.ts, docs/DECISIONS.md "W6 — Onboarding v6: easy owner
-- handover").
--   invites.lead_hint, lead_for, lead_hint_by, lead_dismissed_at: "이 사람이 팀장이에요" on a single-use invite. Only the
--     owner sets it (checked on the server). A lead invite always makes a member in the team's group and is open 3 days;
--     the flag is a hint only (no join, link or forward changes a role). lead_for is the owner's own words for whom it
--     is ("누구에게 보내나요?", at most 60 characters, plain text). lead_hint_by is the owner who flagged it: the card
--     holds only while that person is still the owner. lead_dismissed_at: ✕ on Home's card (the Inbox notice stays).
--     At most one lead invite is open (invites_one_open_lead; a new one revokes the open one in the same write). A
--     transfer clears every flag (lead_hint 0), used or not.
--   owner_transfers: one row per transfer: who, to whom, from where (lead_card: the target joined with the owner's lead
--     link; members_menu: anyone else), what the old owner asked to end of their own connections (to_end, JSON list of
--     { kind, id, label }, written in the transfer's own write, so a stop right after the commit cannot lose it: the
--     server retries what is not ended at its start) and what became of each (ended, JSON list of { kind, id, label,
--     result, revoke }). The notices read it. No foreign keys: the rows outlive deleted accounts.
--   handover_notices: the Inbox rows of the handover. notification_inbox has a fixed event_type CHECK list and tables are
--     never rebuilt, so these have their own table, as team_join_notices and credential_change_notices do.
--     owner.lead_joined (source: the invite) to the owner who flagged it; owner.transferred (source: the transfer) to
--     the new owner, the old owner and every other admin; owner.reauth_locked (source: the lock's 15-minute window) to
--     the owner whose 팀장 넘기기 password check locked. Metadata only.
--   handover_push_deliveries: owner.lead_joined and owner.reauth_locked also go to the owner's phones and browsers
--     (push-service.ts SOURCES), the same columns as push_deliveries.
--   team_sign_ins: who signed a team connection (integrations, OAuth), a Drive shared with the team or a team AI
--     connection (engine_credentials, a subscription token) in, and when: set by the sign-in itself (integrations/
--     connections/service.ts callback, google-drive/oauth.ts completeShare, credentials/service.ts createCredential and
--     replaceSecret), cleared when that sign-in ends (the end, a removal, a stop, an owner gone, a moved address), so a
--     row always means a live sign-in. 팀장 넘기기 decides whose sign-in it is from this alone (never from the audit log, whose details hold
--     names an admin or a service chooses). A connection signed in before this table has no row: unknown, so it is
--     neither listed nor ended (fail closed). A column on integrations cannot be added here: migration 313 makes that
--     table after this one runs on a new database; no foreign key for the same reason (the code joins on the id).
-- Additive only (reader 1): an older build ignores the columns (a lead invite then reads as a plain member invite) and
-- does not know the tables.
ALTER TABLE invites ADD COLUMN lead_hint INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invites ADD COLUMN lead_for TEXT;
ALTER TABLE invites ADD COLUMN lead_hint_by TEXT;
ALTER TABLE invites ADD COLUMN lead_dismissed_at TEXT;
CREATE UNIQUE INDEX invites_one_open_lead ON invites(lead_hint) WHERE lead_hint = 1 AND used_at IS NULL AND revoked_at IS NULL;
CREATE INDEX invites_lead ON invites(lead_hint, used_by);

CREATE TABLE owner_transfers (
  id TEXT PRIMARY KEY,
  from_user TEXT NOT NULL,
  to_user TEXT NOT NULL,
  via TEXT NOT NULL CHECK(via IN ('lead_card','members_menu')),
  invite_id TEXT,
  at TEXT NOT NULL,
  to_end TEXT NOT NULL DEFAULT '[]',
  ended TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX owner_transfers_at ON owner_transfers(at);

CREATE TABLE handover_notices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('owner.lead_joined','owner.transferred','owner.reauth_locked')),
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT,
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK(suppressed IN (0,1)),
  UNIQUE(user_id,event_type,source_id)
);
CREATE INDEX handover_notices_user_page ON handover_notices(user_id,suppressed,created_at DESC,id DESC);
CREATE INDEX handover_notices_retention ON handover_notices(created_at);

CREATE TABLE handover_push_deliveries (
  notification_id TEXT NOT NULL REFERENCES handover_notices(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at TEXT NOT NULL,
  lease_until TEXT,
  expires_at TEXT NOT NULL,
  PRIMARY KEY(notification_id,subscription_id)
);
CREATE INDEX handover_push_deliveries_due ON handover_push_deliveries(state,next_at);

CREATE TABLE team_sign_ins (
  kind TEXT NOT NULL CHECK(kind IN ('team_connection','drive_share','team_ai')),
  target_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY(kind, target_id)
);
