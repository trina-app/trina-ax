-- min_compatible_reader: 1
-- Component B: who left a team project (docs/DECISIONS.md "Leaving a project"; server/src/chat/project-leave.ts; QA
-- TC-1020). One row per project and person who left it with Leave project. Only a person's "no access" rule on the
-- project folder that such a row backs is a leaver's exception (the members screen shows it on a group's row or as
-- "Left: Bob"); any other "no access" for a person stays an admin's setting that the members screen does not change.
-- The rule stays while the row does; adding the person back by name (the members dialog, the AI's members card, Add me)
-- deletes the row. Additive only (reader 1): an older build ignores the table and treats the rule as an admin's.
CREATE TABLE project_leavers (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  left_at TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
