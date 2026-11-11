-- min_compatible_reader: 1
-- Component C: a token refresh is not a change of the safe-operations policy (11-11 code audit, row 18).
-- The policy trigger of integrations (319, last redefined in 341) also fired on secret_enc, key_version and status. A
-- token refresh rewrites the sealed tokens (secret_enc, key_version) and a call that fails or works again rewrites
-- status; neither changes who may use a connection or where its key goes, but each advanced the generation, so another
-- person's protected publish waiting for its approval failed with "changed" (safe-ops/publication.ts). They are
-- bookkeeping now, like a shared Drive's sealed tokens (337). A new key, a sign-in, a sign-out or a new address also
-- moves version (connections/service.ts, google-apps/service.ts), which stays audited.
-- Only the trigger's definition changes (reader 1): an older build reads the same columns.
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
BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
