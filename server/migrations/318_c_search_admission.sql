-- min_compatible_reader: 3
-- Old readers reopen mutable team paths in search. Do not downgrade into that
-- behavior. Leases have NO timeout/PID-based reap: a child can outlive its server.
CREATE TABLE safe_ops_search_inputs (
 lease TEXT NOT NULL, hash TEXT NOT NULL, owner_pid INTEGER NOT NULL,
 PRIMARY KEY(lease,hash)
) WITHOUT ROWID;
CREATE INDEX safe_ops_search_hash ON safe_ops_search_inputs(hash);
CREATE TRIGGER safe_ops_artifact_search_insert BEFORE INSERT ON safe_ops_artifacts
WHEN EXISTS(SELECT 1 FROM safe_ops_search_inputs WHERE hash=NEW.hash)
BEGIN SELECT RAISE(ABORT,'safe_ops_search_busy'); END;
CREATE TRIGGER safe_ops_artifact_search_update BEFORE UPDATE OF hash ON safe_ops_artifacts
WHEN EXISTS(SELECT 1 FROM safe_ops_search_inputs WHERE hash=NEW.hash)
BEGIN SELECT RAISE(ABORT,'safe_ops_search_busy'); END;
-- Defend admission even if another connection inserts a lease directly.
CREATE TRIGGER safe_ops_search_quarantine BEFORE INSERT ON safe_ops_search_inputs
WHEN EXISTS(SELECT 1 FROM safe_ops_artifacts WHERE hash=NEW.hash)
BEGIN SELECT RAISE(ABORT,'safe_ops_quarantined'); END;
