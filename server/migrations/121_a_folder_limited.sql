-- min_compatible_reader: 7
-- Component A: folder access adds up like Google Drive (docs/DECISIONS.md "Folder access adds up like Google Drive
-- (P2)"). folders.limited cuts what comes from the folders above. folder_rules.origin marks a person rule the one-time
-- conversion wrote (C1-A). The conversion of existing rules is not here: it runs after every pending migration, in the
-- same transaction (server/src/db-steps.ts, server/src/policy/convert-additive.ts). Reader level 7: an older build
-- reads deepest-wins and must not open a converted database (owner decision M6-A).
-- These triggers name only folders and folder_rules (001_init), so a fresh database, where 121 runs before the B and C
-- tables exist, works.
ALTER TABLE folders ADD COLUMN limited INTEGER NOT NULL DEFAULT 0 CHECK (limited IN (0, 1));
ALTER TABLE folder_rules ADD COLUMN origin TEXT;
-- "No access" rows exist only as: the legacy marker everyone: none on a limited folder (what an older reader reads as
-- the cut); a person's own none on projects/<name> (the project exception, depth 2, any letter case of "projects");
-- copies parked in .system/ (trash, restore); rows under users/ (ignored by both resolvers).
CREATE TRIGGER folder_rules_no_deny_ins BEFORE INSERT ON folder_rules
  WHEN NEW.access = 'none' AND NOT (
       (NEW.subject_type = 'everyone' AND (SELECT limited FROM folders WHERE id = NEW.folder_id) = 1)
    OR (NEW.subject_type = 'user' AND (SELECT
          (lower(path) GLOB 'projects/?*' AND instr(substr(path, 10), '/') = 0)
          OR path GLOB '.system/*'
          OR path GLOB 'users/*'
        FROM folders WHERE id = NEW.folder_id))
  )
  BEGIN SELECT RAISE(ABORT, 'folder_rules: no access rules are not allowed'); END;
CREATE TRIGGER folder_rules_no_deny_upd BEFORE UPDATE OF access, subject_type, subject_id, folder_id ON folder_rules
  WHEN NEW.access = 'none' AND NOT (
       (NEW.subject_type = 'everyone' AND (SELECT limited FROM folders WHERE id = NEW.folder_id) = 1)
    OR (NEW.subject_type = 'user' AND (SELECT
          (lower(path) GLOB 'projects/?*' AND instr(substr(path, 10), '/') = 0)
          OR path GLOB '.system/*'
          OR path GLOB 'users/*'
        FROM folders WHERE id = NEW.folder_id))
  )
  BEGIN SELECT RAISE(ABORT, 'folder_rules: no access rules are not allowed'); END;
-- The one role row left is the managed marker role: admin: write (inert for access; it keeps a folder admin-only to
-- move, rename or trash).
CREATE TRIGGER folder_rules_role_marker_only BEFORE INSERT ON folder_rules
  WHEN NEW.subject_type = 'role' AND NOT (NEW.subject_id = 'admin' AND NEW.access = 'write')
  BEGIN SELECT RAISE(ABORT, 'folder_rules: only the managed marker role:admin:write is a role rule'); END;
CREATE TRIGGER folder_rules_role_marker_only_upd BEFORE UPDATE OF access, subject_type, subject_id ON folder_rules
  WHEN NEW.subject_type = 'role' AND NOT (NEW.subject_id = 'admin' AND NEW.access = 'write')
  BEGIN SELECT RAISE(ABORT, 'folder_rules: only the managed marker role:admin:write is a role rule'); END;
