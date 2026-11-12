-- min_compatible_reader: 1
-- Component C: Gmail, Google Calendar, Google Docs and Google Sheets as built-in connectors (docs/GOOGLE-APPS.md,
-- server/src/integrations/google-apps/).
--   integrations.google_app: a person's own connection to one Google app ('gmail', 'calendar', 'docs', 'sheets'), one
--     per person and app. It is an ordinary personal MCP connection (sealed OAuth tokens, refresh, the write card, the
--     per-tool switches, scheduled-run rules, audit) whose tools come from the Google Workspace MCP server this server
--     runs on 127.0.0.1; its `url` is a placeholder under the reserved .invalid name and is never used to connect (the
--     server sends its calls only to the library's loopback address). It is hidden from the generic connection list and
--     APIs. NULL: any other connection, as before. (The `kind` column's CHECK lists only 'mcp' and 'http', and a table is
--     never rebuilt, so the app is a column of its own rather than a new kind.)
--   google_app_flows: a person's Google sign-in for one app, bound to the person and session that started it, the state
--     stored hashed, the PKCE verifier (and once Google answered, the tokens and account) sealed; 10 minutes. 'ready'
--     waits for the person to confirm the account shown, like Google Drive's sign-in.
--   settings 'integrations.driveMembers': members may connect their own Google Drive. It is on for a new team from now
--     on (no value = on); a team that exists already (it has people) keeps what it had: off unless an admin turned it on
--     or its members had connected (337), written here as an explicit value so nothing changes for it.
-- The new column joins the audited columns of the safe-operations policy trigger of integrations (redefined here as in
-- 338 with it): which Google app a connection reaches is policy, like its address.
-- Additive only (reader 1): an older build ignores the column and the table. It would list such a connection as a
-- member's own MCP connection whose address never resolves (.invalid), so no token is sent anywhere; it reads the Drive
-- switch's explicit value as before and an absent one as off.
ALTER TABLE integrations ADD COLUMN google_app TEXT CHECK(google_app IS NULL OR google_app IN ('gmail','calendar','docs','sheets'));
CREATE UNIQUE INDEX integrations_google_app ON integrations(owner_user_id, google_app) WHERE google_app IS NOT NULL;
CREATE TABLE google_app_flows (
  id TEXT PRIMARY KEY,
  app TEXT NOT NULL CHECK(app IN ('gmail','calendar','docs','sheets')),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  state_hash TEXT NOT NULL UNIQUE,
  config_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','exchanging','ready','completed','failed','expired')),
  secret_enc TEXT,
  key_version INTEGER NOT NULL,
  account TEXT,
  reason TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX google_app_flows_user ON google_app_flows(user_id, created_at);
INSERT OR IGNORE INTO settings(key, value) SELECT 'integrations.driveMembers', 'false' WHERE EXISTS (SELECT 1 FROM users);
DROP TRIGGER safe_ops_integrations_update;
CREATE TRIGGER safe_ops_integrations_update AFTER UPDATE ON integrations
WHEN OLD.id IS NOT NEW.id
 OR OLD.scope IS NOT NEW.scope
 OR OLD.owner_user_id IS NOT NEW.owner_user_id
 OR OLD.kind IS NOT NEW.kind
 OR OLD.slug IS NOT NEW.slug
 OR OLD.url IS NOT NEW.url
 OR OLD.auth IS NOT NEW.auth
 OR OLD.auth_header IS NOT NEW.auth_header
 OR OLD.secret_enc IS NOT NEW.secret_enc
 OR OLD.key_version IS NOT NEW.key_version
 OR OLD.account IS NOT NEW.account
 OR OLD.write_policy IS NOT NEW.write_policy
 OR OLD.status IS NOT NEW.status
 OR OLD.tools_json IS NOT NEW.tools_json
 OR OLD.disabled_tools IS NOT NEW.disabled_tools
 OR OLD.version IS NOT NEW.version
 OR OLD.template_id IS NOT NEW.template_id
 OR OLD.oauth_client IS NOT NEW.oauth_client
 OR OLD.oauth_client_enc IS NOT NEW.oauth_client_enc
 OR OLD.oauth_client_key_version IS NOT NEW.oauth_client_key_version
 OR OLD.google_app IS NOT NEW.google_app
BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
