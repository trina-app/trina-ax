-- min_compatible_reader: 1
-- Component B: a team project whose folder the server made for it (docs/DECISIONS.md "Projects live only in projects/").
--   projects.folder_made: 1 when createProject (team) or sharing a personal project made its projects/<name> folder
--     with its rules; 0 for every project made before (on an existing folder, or a projects/<name> an admin had made
--     with rules of their own) and for one an admin pointed at an existing folder. Only a project whose folder the
--     server made is the creator's to change who sees it, or to put in the trash with it; admins change any.
-- Additive only (reader 1): an older build ignores the column. Existing rows stay 0: their folders' rules are the
-- admins' to change, as before.
-- Numbered 278: 277 (chat_pins) is the highest on dev.
ALTER TABLE projects ADD COLUMN folder_made INTEGER NOT NULL DEFAULT 0;
