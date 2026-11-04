-- min_compatible_reader: 1
-- Component C: a project whose folder is in the trash (docs/DECISIONS.md "Projects: a folder with instructions"). The
-- projects table is the foundation's (001); this is in C's range because the backfill reads trash_items.kind
-- (301_c_files), and B's 221 runs before that.
--   projects.trashed_with: the trash item that took the project's folder (or a folder above it) to the trash; NULL
--   while the folder is in place. Set by TeamFiles.remove(), cleared by a restore (which moves folder_path to where the
--   folder came back), kept by a purge. While it is set, only admins and the owner see the project
--   (chat/projects.ts canSeeProject): the folder's rules went to the trash with it, so its path falls back to the rules
--   above, and the path may be another folder's by now.
-- Existing rows: the unrestored folder items in the trash at or above a team project's folder, deleted after the project
-- was made (an older folder of that name, trashed before the project, was another folder); the earliest such item. When
-- the trashed folder took folders rows with it (parked under its storage path), one of them must be the project's own
-- (its marker or rules row, parked at the project's place): a project moved later onto a path where an unrelated folder
-- had been trashed has its row in place, not there. When the trashed folder took no rows (a project an admin pointed at
-- a folder has no row), the item still counts: failing closed, such a project is the admins' until an admin restores
-- the folder or points the project at one. Left as they were: an unrelated trashed folder that had a row at exactly
-- the project's place (that row is taken for the project's), and a project without a row of its own inside a trashed
-- folder whose rows were parked elsewhere (it shows by its path's rules, as before this build).
-- Personal projects (users/) are their person's in the trash too and are left out. A folder that was trashed and
-- purged before this migration left no row and is not found.
-- The backfill looks up each project's own folder and the folders above it (a handful of paths) in a temporary index
-- on trash_items(original_path), instead of comparing every project with every trashed folder.
-- Additive only (reader 1): an older build does not know the column and judges by the folder's rules alone.
ALTER TABLE projects ADD COLUMN trashed_with TEXT;
CREATE INDEX trash_items_path_332 ON trash_items(original_path);
-- each team project's folder and every folder above it (rtrim with the path's own non-'/' characters drops the last name)
CREATE TEMP TABLE project_trash_332 AS
  WITH RECURSIVE above(pid, made, fp, p) AS (
    SELECT id, created_at, folder_path, folder_path FROM projects
    WHERE folder_path <> '' AND folder_path <> 'users' AND substr(folder_path, 1, 6) <> 'users/'
    UNION ALL
    SELECT pid, made, fp, substr(p, 1, length(rtrim(p, replace(p, '/', ''))) - 1) FROM above WHERE instr(p, '/') > 0
  )
  SELECT above.pid AS pid, t.id AS tid, t.deleted_at AS at FROM above JOIN trash_items t ON t.original_path = above.p
  WHERE t.kind = 'folder' AND t.restored_at IS NULL AND t.deleted_at >= above.made
    AND (EXISTS (SELECT 1 FROM folders f WHERE f.path = t.storage_path || substr(above.fp, length(above.p) + 1))
      OR NOT EXISTS (SELECT 1 FROM folders f WHERE f.path = t.storage_path OR substr(f.path, 1, length(t.storage_path) + 1) = t.storage_path || '/'));
UPDATE projects SET trashed_with = (SELECT tid FROM project_trash_332 h WHERE h.pid = projects.id ORDER BY h.at, h.tid LIMIT 1)
WHERE id IN (SELECT pid FROM project_trash_332);
DROP TABLE project_trash_332;
DROP INDEX trash_items_path_332;
