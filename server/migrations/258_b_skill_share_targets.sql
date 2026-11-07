-- min_compatible_reader: 1
-- Component B: a share proposal to one group (docs/DECISIONS.md "Group skills"; server/src/skills/share.ts). Additive.
--   skill_shares.target_group_id: NULL = the team (skills/, as before); else the id of one of the proposer's groups,
--     whose skills folder (groups/<folder>/skills/) the proposal goes to. Its checks run against that group's skills
--     and the team's, and the group's members who may write that folder review and apply it. No foreign key (a column
--     added to a table is never rebuilt): a group deleted since leaves an id no group has, which reads as "the target
--     is gone" (nothing can be applied, the proposer still sees it). An older build reads every row as a team share.
--   An index for the review list of a group's members (open proposals of their groups).
ALTER TABLE skill_shares ADD COLUMN target_group_id TEXT;
CREATE INDEX skill_shares_by_target ON skill_shares(target_group_id, status) WHERE target_group_id IS NOT NULL;
