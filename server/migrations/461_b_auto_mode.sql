-- min_compatible_reader: 1
-- Component B: auto mode (docs/decisions/20261125-auto-mode.md). The person's own choice: 1 on, 0 off, NULL = the team's
-- default (Admin › Team AI settings autoMode: 'default' starts it on, any other value off). The team value is a settings
-- key (no column). Every card auto mode approves is an audit row (ai.auto_allow), so no table holds them.
-- 461: 458 is the highest b on dev; open PRs #641 and #645 take 459 and 460 (453, 455 and 459 were this PR's earlier numbers, never on dev).
-- Additive only (reader 1): an older build ignores the column and shows every card, as before auto mode.
ALTER TABLE users ADD COLUMN auto_mode INTEGER;
