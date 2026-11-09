-- min_compatible_reader: 1
-- Component C: sign-in through your own app at the service (docs/INTEGRATIONS.md "Your own app"), for services that do
-- not let apps register themselves (Google's MCP servers, NAVER WORKS ...).
--   oauth_client: what is not secret about the app, as JSON {clientId, authorizationUrl, tokenUrl, scope}; NULL: the
--     service registers the app itself (dynamic client registration), as before.
--   oauth_client_enc / oauth_client_key_version: the app's client secret, sealed like keys in the connections key
--     directory with its own AAD ("<connection AAD>:client", "template:<id>:client"); NULL: none (a public app).
-- On integrations: a personal or team connection's own app (a member's connection made from a template has none: it
-- signs in through the template's). On integration_templates: the team's app each member signs in through.
-- Where a sign-in's client secret goes is policy, like a key: the three columns join the audited columns of the
-- safe-operations policy triggers of both tables (336_c_integration_template_policy.sql, redefined here with them).
-- Additive only (reader 1): an older build does not read the columns; it would try to register an app at sign-in.
ALTER TABLE integrations ADD COLUMN oauth_client TEXT;
ALTER TABLE integrations ADD COLUMN oauth_client_enc TEXT;
ALTER TABLE integrations ADD COLUMN oauth_client_key_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE integration_templates ADD COLUMN oauth_client TEXT;
ALTER TABLE integration_templates ADD COLUMN oauth_client_enc TEXT;
ALTER TABLE integration_templates ADD COLUMN oauth_client_key_version INTEGER NOT NULL DEFAULT 1;
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
BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
DROP TRIGGER safe_ops_integration_templates_update;
CREATE TRIGGER safe_ops_integration_templates_update AFTER UPDATE ON integration_templates
WHEN OLD.id IS NOT NEW.id
 OR OLD.kind IS NOT NEW.kind
 OR OLD.url IS NOT NEW.url
 OR OLD.auth IS NOT NEW.auth
 OR OLD.auth_header IS NOT NEW.auth_header
 OR OLD.version IS NOT NEW.version
 OR OLD.oauth_client IS NOT NEW.oauth_client
 OR OLD.oauth_client_enc IS NOT NEW.oauth_client_enc
 OR OLD.oauth_client_key_version IS NOT NEW.oauth_client_key_version
BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
