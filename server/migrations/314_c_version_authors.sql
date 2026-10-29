-- Component C: the real author of each file version (QA TEAM-03 / B-W7-6, R2-ETC-06 / B-W24-2). Additive only.
-- file_versions.author_id / turn_id are the person (and AI turn) whose save REPLACED the stored content, not the person
-- who wrote it. saved_by / saved_turn_id are the person and AI turn whose save PRODUCED the stored content
-- (server/src/files/timeline.ts contentOrigin). NULL saved_by: not known; the history then says "replaced by".
ALTER TABLE file_versions ADD COLUMN saved_by TEXT;
ALTER TABLE file_versions ADD COLUMN saved_turn_id TEXT;

-- Backfill: the newest content event at the path of that time with the same hash, before the version was stored.
-- Rows with no such event keep NULL (unknown author).
UPDATE file_versions SET
  saved_by = (SELECT e.user_id FROM file_events e
              WHERE e.path = COALESCE(file_versions.path_at_save, file_versions.path) AND e.sha256 = file_versions.sha256
                AND e.action IN ('create','update','upload','restore') AND e.at <= file_versions.created_at
              ORDER BY e.id DESC LIMIT 1),
  saved_turn_id = (SELECT e.turn_id FROM file_events e
              WHERE e.path = COALESCE(file_versions.path_at_save, file_versions.path) AND e.sha256 = file_versions.sha256
                AND e.action IN ('create','update','upload','restore') AND e.at <= file_versions.created_at
              ORDER BY e.id DESC LIMIT 1)
WHERE kind <> 'conflict_copy';
-- a conflict copy row describes the copy, which the saver wrote
UPDATE file_versions SET saved_by = author_id, saved_turn_id = turn_id WHERE kind = 'conflict_copy';
