-- min_compatible_reader: 1
-- The team link's starter (docs/DECISIONS.md "M — One meeting note, everyone's own tasks", server/src/auth/team-links.ts):
-- the team files the lead put in and what a new member asks about them, as JSON {"kind":"tasks"|"brief","files":[...]}.
-- After joining, the member lands on a new chat with the files attached (each checked with their account at the join;
-- one they cannot read is left out), the link's skill chosen and the question in the box. NULL: no starter.
-- Additive only (reader 1): an older build does not read the column and links work as before.
ALTER TABLE team_links ADD COLUMN starter TEXT;
