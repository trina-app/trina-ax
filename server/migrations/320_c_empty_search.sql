-- min_compatible_reader: 4
-- Live-tree search is safe only while quarantine is durably empty. These leases
-- survive process death; offline child shutdown is required before manual reap.
CREATE TABLE safe_ops_empty_searches (
 lease TEXT PRIMARY KEY, owner_pid INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TRIGGER safe_ops_empty_search_admission BEFORE INSERT ON safe_ops_empty_searches
WHEN EXISTS(SELECT 1 FROM safe_ops_artifacts)
 OR EXISTS(SELECT 1 FROM safe_ops_publications)
 OR EXISTS(SELECT 1 FROM safe_ops_inodes)
BEGIN SELECT RAISE(ABORT,'safe_ops_quarantined'); END;
CREATE TRIGGER safe_ops_empty_artifact_insert BEFORE INSERT ON safe_ops_artifacts
WHEN EXISTS(SELECT 1 FROM safe_ops_empty_searches)
BEGIN SELECT RAISE(ABORT,'safe_ops_search_busy'); END;
CREATE TRIGGER safe_ops_empty_artifact_update BEFORE UPDATE ON safe_ops_artifacts
WHEN EXISTS(SELECT 1 FROM safe_ops_empty_searches)
BEGIN SELECT RAISE(ABORT,'safe_ops_search_busy'); END;
CREATE TRIGGER safe_ops_empty_publication_insert BEFORE INSERT ON safe_ops_publications
WHEN EXISTS(SELECT 1 FROM safe_ops_empty_searches)
BEGIN SELECT RAISE(ABORT,'safe_ops_search_busy'); END;
CREATE TRIGGER safe_ops_empty_inode_insert BEFORE INSERT ON safe_ops_inodes
WHEN EXISTS(SELECT 1 FROM safe_ops_empty_searches)
BEGIN SELECT RAISE(ABORT,'safe_ops_search_busy'); END;
