-- min_compatible_reader: 1
-- Component C: apps on the person's own computer as connectors (docs/decisions/20261118-local-app-connectors.md,
-- server/src/integrations/connections/local.ts).
--   integrations.local_app: what the desktop app runs on its owner's computer (shared/src/api/local-apps.ts
--     LocalAppSpec as JSON: the program, its arguments, the names of its settings without their values, and for a CLI
--     the tools it is wrapped as). It is an ordinary personal MCP connection (the write card, the per-tool switches,
--     audit) whose calls go only through the local relay to the desktop window of the turn; its `url` is a
--     placeholder under the reserved .invalid name and is never used to connect. The API calls it kind 'local'. NULL:
--     any other connection, as before. (The `kind` column's CHECK lists only 'mcp' and 'http', and a table is never
--     rebuilt, so the app is a column of its own, like google_app in 341.)
-- The new column joins the audited columns of the safe-operations policy trigger of integrations (redefined here as in
-- 344 with it): which program runs on the person's computer is policy, like a connection's address.
-- Additive only (reader 1): an older build ignores the column. It would list such a connection as the member's own
-- MCP connection whose address never resolves (.invalid), so nothing is sent anywhere and nothing runs.
ALTER TABLE integrations ADD COLUMN local_app TEXT;
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
 OR OLD.account IS NOT NEW.account
 OR OLD.write_policy IS NOT NEW.write_policy
 OR OLD.tools_json IS NOT NEW.tools_json
 OR OLD.disabled_tools IS NOT NEW.disabled_tools
 OR OLD.version IS NOT NEW.version
 OR OLD.template_id IS NOT NEW.template_id
 OR OLD.oauth_client IS NOT NEW.oauth_client
 OR OLD.oauth_client_enc IS NOT NEW.oauth_client_enc
 OR OLD.oauth_client_key_version IS NOT NEW.oauth_client_key_version
 OR OLD.google_app IS NOT NEW.google_app
 OR OLD.local_app IS NOT NEW.local_app
BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
