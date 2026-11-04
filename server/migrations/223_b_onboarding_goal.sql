-- min_compatible_reader: 1
-- Stream G (onboarding): the 7-day team goal (docs/DECISIONS.md "G — The 7-day team goal").
--   turn_skill_runs: team skills a person RAN in a turn: "/name" (and so a skill form) or the skill tool. The goal
--     counts these only, never a plain read of a SKILL.md. turn_skill_usage cannot say it: the skill tool is recorded
--     there as 'read' together with plain reads, its first row of a turn wins (ON CONFLICT DO NOTHING), and its CHECK
--     list ('command','read') cannot change without rebuilding the table. So the runs get a small table of their own;
--     turn_skill_usage and Admin › Usage stay as they are. Team skills only (skills/...), like turn_skill_usage.
--     Earlier "/name" runs come over from turn_skill_usage; earlier skill-tool runs cannot be told from reads and are
--     not guessed.
--   onboarding_goal_notices: the owners' inbox rows "○○님이 '광고 문구'를 처음 써 봤어요 (2/3)". notification_inbox
--     and the other notice tables have fixed event_type CHECK lists and tables are never rebuilt (as for
--     onboarding_notices, team_join_notices). source_id = the turn of the member's first successful run; member_id,
--     skill_path and runners (people who had run that skill then) are kept for the text. UNIQUE(user_id, member_id,
--     skill_path) is the "once per member per skill" for each owner.
-- Additive only (reader 1): an older build does not know the tables.
CREATE TABLE turn_skill_runs (
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  skill_path TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('command', 'tool')),
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (turn_id, skill_path)
);
CREATE INDEX turn_skill_runs_path ON turn_skill_runs(skill_path);
INSERT INTO turn_skill_runs (turn_id, skill_path, skill_name, source, recorded_at)
  SELECT turn_id, skill_path, skill_name, 'command', recorded_at FROM turn_skill_usage WHERE source = 'command';

CREATE TABLE onboarding_goal_notices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('onboarding.first_run')),
  source_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  skill_path TEXT NOT NULL,
  runners INTEGER NOT NULL CHECK (runners >= 1),
  created_at TEXT NOT NULL,
  read_at TEXT,
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK(suppressed IN (0,1)),
  UNIQUE(user_id,event_type,source_id),
  UNIQUE(user_id,member_id,skill_path)
);
CREATE INDEX onboarding_goal_notices_user_page ON onboarding_goal_notices(user_id,suppressed,created_at DESC,id DESC);
CREATE INDEX onboarding_goal_notices_retention ON onboarding_goal_notices(created_at);
