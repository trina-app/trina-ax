-- Quarantine checks also run with the feature disabled. Avoid scanning the entire
-- retained journal on every ordinary file access or workflow admission.
CREATE INDEX safe_ops_artifacts_size ON safe_ops_artifacts(size);
CREATE INDEX safe_ops_publications_destination ON safe_ops_publications(destination) WHERE state != 'conflict';
CREATE INDEX safe_ops_publications_cleanup ON safe_ops_publications(cleanup) WHERE cleanup != 'clean';
CREATE INDEX safe_ops_publications_approved ON safe_ops_publications(state) WHERE state = 'approved';
CREATE INDEX safe_ops_workflows_active ON safe_ops_workflows(state) WHERE state IN ('running', 'debt');
CREATE INDEX safe_ops_workflows_user_created ON safe_ops_workflows(user_id, created);
CREATE INDEX safe_ops_workflows_turn_created ON safe_ops_workflows(user_id, turn_id, created);
CREATE INDEX safe_ops_jobs_workflow ON safe_ops_jobs(workflow) WHERE state != 'clean';
