-- min_compatible_reader: 3
-- Replace only trigger definitions, never applied SQL or data. INSERT/DELETE
-- triggers from 316 remain: revoke and restore each advance the generation.
DROP TRIGGER safe_ops_users_update;
CREATE TRIGGER safe_ops_users_update AFTER UPDATE ON users
WHEN OLD.id IS NOT NEW.id
 OR OLD.username IS NOT NEW.username
 OR OLD.password_hash IS NOT NEW.password_hash
 OR OLD.role IS NOT NEW.role
 OR OLD.status IS NOT NEW.status
 OR OLD.must_change_password IS NOT NEW.must_change_password
 OR OLD.deleted_at IS NOT NEW.deleted_at
 OR OLD.temp_password_expires_at IS NOT NEW.temp_password_expires_at
BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
DROP TRIGGER safe_ops_groups_update;
CREATE TRIGGER safe_ops_groups_update AFTER UPDATE ON groups
WHEN OLD.id IS NOT NEW.id
 OR OLD.folder_id IS NOT NEW.folder_id
BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
DROP TRIGGER safe_ops_group_members_update;
CREATE TRIGGER safe_ops_group_members_update AFTER UPDATE ON group_members
WHEN OLD.group_id IS NOT NEW.group_id
 OR OLD.user_id IS NOT NEW.user_id
BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
DROP TRIGGER safe_ops_folders_update;
CREATE TRIGGER safe_ops_folders_update AFTER UPDATE ON folders
WHEN OLD.id IS NOT NEW.id
 OR OLD.path IS NOT NEW.path
BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
DROP TRIGGER safe_ops_folder_rules_update;
CREATE TRIGGER safe_ops_folder_rules_update AFTER UPDATE ON folder_rules
WHEN OLD.id IS NOT NEW.id
 OR OLD.folder_id IS NOT NEW.folder_id
 OR OLD.subject_type IS NOT NEW.subject_type
 OR OLD.subject_id IS NOT NEW.subject_id
 OR OLD.access IS NOT NEW.access
BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
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
 OR OLD.version IS NOT NEW.version
BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
DROP TRIGGER safe_ops_integration_access_update;
CREATE TRIGGER safe_ops_integration_access_update AFTER UPDATE ON integration_access
WHEN OLD.integration_id IS NOT NEW.integration_id
 OR OLD.subject_type IS NOT NEW.subject_type
 OR OLD.subject_id IS NOT NEW.subject_id
BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
DROP TRIGGER safe_ops_connected_folders_update;
CREATE TRIGGER safe_ops_connected_folders_update AFTER UPDATE ON connected_folders
WHEN OLD.id IS NOT NEW.id
 OR OLD.name IS NOT NEW.name
 OR OLD.source IS NOT NEW.source
BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
