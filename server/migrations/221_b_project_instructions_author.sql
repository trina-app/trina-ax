-- min_compatible_reader: 1
-- Component B: who wrote a project's instructions (docs/DECISIONS.md "Projects: a folder with instructions").
--   projects.instructions_author: the one person who wrote every saved version of the instructions. NULL when more
--     than one person did, or when it is not known.
--   projects.instructions_authored: the instructions as that person last saved them. A build that does not know
--     these columns (after a rollback) can still change the instructions; the text then differs and the author no
--     longer counts.
-- A turn counts the instructions as outside content (remember protection, server/src/chat/runtime.ts projectTaints)
-- unless its person is instructions_author and the instructions are still instructions_authored. Before, only
-- created_by was compared, so a creator whose instructions an admin had rewritten was never protected.
-- Existing rows: the audit log is the only history. It is complete for a project made by a build that audited every
-- instruction change (project.update came before project.create, e482a367 then 4ed7bf8d) whose project.create entry
-- is still kept (the retention purge removes the oldest rows first, so every later entry is kept too). For such a
-- project the author is created_by when every project.update that changed the instructions, or whose detail cannot
-- be read, was made by created_by. Every other row stays NULL: everyone's turns, the creator's included, count the
-- instructions as outside content.
-- audit_log has an index on `at` only: without one on (target, action) the backfill reads the whole log once per
-- project (1000 projects and 1M audit rows: 29.5 s under the write lock at start). A temporary index made for the
-- backfill and dropped after it: 0.4 s.
-- Additive only (reader 1): an older build does not know the columns and keeps comparing created_by.
ALTER TABLE projects ADD COLUMN instructions_author TEXT;
ALTER TABLE projects ADD COLUMN instructions_authored TEXT;
CREATE INDEX audit_log_target_action_221 ON audit_log(target, action);
UPDATE projects SET instructions_author = created_by, instructions_authored = instructions
WHERE created_by IS NOT NULL
  AND EXISTS (SELECT 1 FROM audit_log a WHERE a.action = 'project.create' AND a.target = projects.id AND a.actor_id = projects.created_by)
  AND NOT EXISTS (
    SELECT 1 FROM audit_log a
    WHERE a.action = 'project.update' AND a.target = projects.id
      AND (a.actor_id IS NULL OR a.actor_id <> projects.created_by)
      AND (a.detail IS NULL OR NOT json_valid(a.detail) OR json_extract(a.detail, '$.changed.instructions') IS NOT 0)
  );
DROP INDEX audit_log_target_action_221;
