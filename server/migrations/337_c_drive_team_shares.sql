-- min_compatible_reader: 1
-- Component C: a Google Drive an admin shares with the team (server/src/integrations/google-drive/shares.ts,
-- docs/GOOGLE-DRIVE.md "Sharing a Drive with the team").
--   drive_team_shares: one admin's Google sign-in (drive.readonly, the server's own client), sealed like a person's own
--     connection but in its own key context ("drive-share:<id>"), with the folders (or shared drives) members may use,
--     everything below them included, or the whole Drive. owner_user_id is the admin whose Google account it is: when
--     they leave, are disabled or stop being an admin, the share stops (its tokens are deleted, secret_enc NULL) and the
--     admins get an Inbox notice to sign in again. No foreign key: the code handles a gone owner.
--   drive_team_share_access: who may use it (everyone / groups / people, like a team connection's rule).
--   drive_oauth_flows.purpose / share_id: a Google sign-in for a team share ('share'; share_id when it signs in again
--     for one) next to the personal ones ('personal').
--   drive_share_notices: the admins' inbox rows ('drive.share_reconnect'); notification_inbox has a fixed CHECK list.
--   settings 'integrations.driveMembers': members may connect their own Drive. A new team starts with it off; a team
--     whose members had already connected their own Drive keeps it on (set here), so nothing they use stops working.
-- Changes to a share's rule, folders or owner advance the safe-operations policy generation (316/319), like a team
-- connection's rule does. Additive only (reader 1): an older build does not know the tables or the columns (their
-- defaults keep its own flows personal) and keeps letting members connect.
CREATE TABLE drive_team_shares (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_user_id TEXT,
  config_key TEXT NOT NULL,
  account TEXT NOT NULL,
  scopes TEXT NOT NULL,
  secret_enc TEXT,
  key_version INTEGER NOT NULL,
  folders TEXT NOT NULL DEFAULT '[]',
  whole_drive INTEGER NOT NULL DEFAULT 0 CHECK(whole_drive IN (0,1)),
  status TEXT NOT NULL CHECK(status IN ('connected','needs_reconnect')),
  reason TEXT CHECK(reason IS NULL OR reason IN ('owner_gone','signed_out','client_changed')),
  version INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX drive_team_shares_name ON drive_team_shares(lower(name));
CREATE TABLE drive_team_share_access (
  share_id TEXT NOT NULL REFERENCES drive_team_shares(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK(subject_type IN ('everyone','group','user')),
  subject_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (share_id, subject_type, subject_id)
);
ALTER TABLE drive_oauth_flows ADD COLUMN purpose TEXT NOT NULL DEFAULT 'personal' CHECK(purpose IN ('personal','share'));
ALTER TABLE drive_oauth_flows ADD COLUMN share_id TEXT;
CREATE TABLE drive_share_notices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('drive.share_reconnect')),
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT,
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK(suppressed IN (0,1)),
  UNIQUE(user_id,event_type,source_id)
);
CREATE INDEX drive_share_notices_user_page ON drive_share_notices(user_id,suppressed,created_at DESC,id DESC);
CREATE INDEX drive_share_notices_retention ON drive_share_notices(created_at);
INSERT OR IGNORE INTO settings(key, value) SELECT 'integrations.driveMembers', 'true' WHERE EXISTS (SELECT 1 FROM drive_connections);
CREATE TRIGGER safe_ops_drive_team_shares_insert AFTER INSERT ON drive_team_shares BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
CREATE TRIGGER safe_ops_drive_team_shares_delete AFTER DELETE ON drive_team_shares BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
CREATE TRIGGER safe_ops_drive_team_shares_update AFTER UPDATE ON drive_team_shares
WHEN OLD.id IS NOT NEW.id
 OR OLD.folders IS NOT NEW.folders
 OR OLD.whole_drive IS NOT NEW.whole_drive
 OR OLD.status IS NOT NEW.status
 OR OLD.owner_user_id IS NOT NEW.owner_user_id
 OR OLD.config_key IS NOT NEW.config_key
BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
CREATE TRIGGER safe_ops_drive_team_share_access_insert AFTER INSERT ON drive_team_share_access BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
CREATE TRIGGER safe_ops_drive_team_share_access_delete AFTER DELETE ON drive_team_share_access BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
CREATE TRIGGER safe_ops_drive_team_share_access_update AFTER UPDATE ON drive_team_share_access
WHEN OLD.share_id IS NOT NEW.share_id
 OR OLD.subject_type IS NOT NEW.subject_type
 OR OLD.subject_id IS NOT NEW.subject_id
BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
