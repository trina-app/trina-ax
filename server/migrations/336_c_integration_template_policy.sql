-- min_compatible_reader: 1
-- Component C: connection templates in the safe-operations policy generation (319_c_policy_epoch.sql).
-- Who may use a member's connection made from a template depends on the template (its address, sign-in method and
-- header, store.ts templateCovers) and on who it is for (integration_template_access), so a change of either advances
-- the policy generation, like a team connection's rule (integration_access) does:
--   integrations.template_id joins the audited policy columns of the integrations update trigger (it is set when the
--     member connects and never changed after: a moved template drops and makes the row again);
--   integration_templates: made, deleted, or its address, sign-in method, header or version changed (its name and
--     note are bookkeeping: they change no one's access);
--   integration_template_access: a rule row added, removed or changed.
-- Replaces one trigger definition and adds new ones; no data changes. An older build never writes these columns or
-- tables, and the triggers read only columns that are there.
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
BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
CREATE TRIGGER safe_ops_integration_templates_insert AFTER INSERT ON integration_templates BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
CREATE TRIGGER safe_ops_integration_templates_delete AFTER DELETE ON integration_templates BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
CREATE TRIGGER safe_ops_integration_templates_update AFTER UPDATE ON integration_templates
WHEN OLD.id IS NOT NEW.id
 OR OLD.kind IS NOT NEW.kind
 OR OLD.url IS NOT NEW.url
 OR OLD.auth IS NOT NEW.auth
 OR OLD.auth_header IS NOT NEW.auth_header
 OR OLD.version IS NOT NEW.version
BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
CREATE TRIGGER safe_ops_integration_template_access_insert AFTER INSERT ON integration_template_access BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
CREATE TRIGGER safe_ops_integration_template_access_delete AFTER DELETE ON integration_template_access BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
CREATE TRIGGER safe_ops_integration_template_access_update AFTER UPDATE ON integration_template_access
WHEN OLD.template_id IS NOT NEW.template_id
 OR OLD.subject_type IS NOT NEW.subject_type
 OR OLD.subject_id IS NOT NEW.subject_id
BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
