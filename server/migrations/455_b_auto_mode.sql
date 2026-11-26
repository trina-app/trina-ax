-- min_compatible_reader: 1
-- Component B: auto mode (docs/decisions/20261125-auto-mode.md). The person's own choice: 1 on, 0 off, NULL = the team's
-- default (Admin › Team AI settings autoMode: 'default' starts it on, any other value off). The team value is a settings
-- key (no column). Every card auto mode approves is an audit row (ai.auto_allow), so no table holds them.
-- 455: 454 is the highest b on dev (453 was this PR's first number, never on dev).
-- Additive only (reader 1): an older build ignores the column and shows every card, as before auto mode.
ALTER TABLE users ADD COLUMN auto_mode INTEGER;
