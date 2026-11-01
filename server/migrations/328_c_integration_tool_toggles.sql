-- min_compatible_reader: 1
-- Component C: single tools of an MCP connection turned off (docs/INTEGRATIONS.md, docs/DECISIONS.md "Turn single
-- tools of a connection off"), like the tool switches of Claude's connectors. Whoever manages the connection (the owner
-- of a personal one, an admin for a team one) turns a tool off; a tool that is off is not offered to the AI in any
-- turn (integrations/connections/tools.ts) and a call of it is refused.
--   integrations.disabled_tools: a JSON list of the service's own tool names (as its tools/list gives them) that are
--     off. Every other tool is on, so a tool the service adds later is on. A name stays when its tool disappears
--     from the service's list, so a tool that comes back is still off.
-- Like tools_json it is policy for safe operations (319_c_policy_epoch.sql): changing which tools the AI may call
-- advances the policy generation, so the integrations update trigger is made again with the column in it (the
-- service also moves version on, which the trigger already watched; this keeps any other writer covered).
-- Additive only (reader 1): an older build ignores the column and offers every tool again; the trigger reads a column
-- that is there, and an older build never changes it.
ALTER TABLE integrations ADD COLUMN disabled_tools TEXT NOT NULL DEFAULT '[]';
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
BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
