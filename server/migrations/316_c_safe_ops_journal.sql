-- Quarantine must survive rollback: an older reader would parse these files.
-- min_compatible_reader: 2
CREATE TABLE safe_ops_policy (id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL);
INSERT INTO safe_ops_policy VALUES (1, 0);
CREATE TABLE safe_ops_artifacts (hash TEXT PRIMARY KEY, size INTEGER NOT NULL, kind TEXT NOT NULL);
CREATE TABLE safe_ops_publications (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, turn_id TEXT, destination TEXT NOT NULL,
 hash TEXT NOT NULL, size INTEGER NOT NULL, policy INTEGER NOT NULL, audience TEXT NOT NULL,
 provenance TEXT NOT NULL, state TEXT NOT NULL, cleanup TEXT NOT NULL DEFAULT 'pending',
 created INTEGER NOT NULL, owner_pid INTEGER NOT NULL
);
CREATE TABLE safe_ops_workflows (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, turn_id TEXT, created INTEGER NOT NULL, owner_pid INTEGER NOT NULL,
 state TEXT NOT NULL, jobs INTEGER NOT NULL DEFAULT 0, io_bytes INTEGER NOT NULL DEFAULT 0,
 reserved_cpu INTEGER NOT NULL DEFAULT 0, debt_bytes INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE safe_ops_jobs (
 id TEXT PRIMARY KEY, workflow TEXT NOT NULL, cgroup TEXT NOT NULL, stage TEXT NOT NULL,
 state TEXT NOT NULL, reserved_bytes INTEGER NOT NULL
);
CREATE TRIGGER safe_ops_users_insert AFTER INSERT ON users BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
CREATE TRIGGER safe_ops_users_update AFTER UPDATE ON users BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
CREATE TRIGGER safe_ops_users_delete AFTER DELETE ON users BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
CREATE TRIGGER safe_ops_group_members_insert AFTER INSERT ON group_members BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
CREATE TRIGGER safe_ops_group_members_update AFTER UPDATE ON group_members BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
CREATE TRIGGER safe_ops_group_members_delete AFTER DELETE ON group_members BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
CREATE TRIGGER safe_ops_groups_insert AFTER INSERT ON groups BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
CREATE TRIGGER safe_ops_groups_update AFTER UPDATE ON groups BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
CREATE TRIGGER safe_ops_groups_delete AFTER DELETE ON groups BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
CREATE TRIGGER safe_ops_folders_insert AFTER INSERT ON folders BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
CREATE TRIGGER safe_ops_folders_update AFTER UPDATE ON folders BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
CREATE TRIGGER safe_ops_folders_delete AFTER DELETE ON folders BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
CREATE TRIGGER safe_ops_folder_rules_insert AFTER INSERT ON folder_rules BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
CREATE TRIGGER safe_ops_folder_rules_update AFTER UPDATE ON folder_rules BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
CREATE TRIGGER safe_ops_folder_rules_delete AFTER DELETE ON folder_rules BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
CREATE TRIGGER safe_ops_integrations_insert AFTER INSERT ON integrations BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
CREATE TRIGGER safe_ops_integrations_update AFTER UPDATE ON integrations BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
CREATE TRIGGER safe_ops_integrations_delete AFTER DELETE ON integrations BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
CREATE TRIGGER safe_ops_integration_access_insert AFTER INSERT ON integration_access BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
CREATE TRIGGER safe_ops_integration_access_update AFTER UPDATE ON integration_access BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
CREATE TRIGGER safe_ops_integration_access_delete AFTER DELETE ON integration_access BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
CREATE TRIGGER safe_ops_connected_folders_insert AFTER INSERT ON connected_folders BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
CREATE TRIGGER safe_ops_connected_folders_update AFTER UPDATE ON connected_folders BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
CREATE TRIGGER safe_ops_connected_folders_delete AFTER DELETE ON connected_folders BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;

CREATE TABLE safe_ops_inodes(identity TEXT PRIMARY KEY);
CREATE TABLE safe_ops_sources (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, turn_id TEXT, path TEXT NOT NULL,
 identity TEXT NOT NULL, hash TEXT NOT NULL, policy INTEGER NOT NULL, scope TEXT NOT NULL,
 created INTEGER NOT NULL
);
