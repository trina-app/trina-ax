-- min_compatible_reader: 1
-- Component B: onboarding v5 (docs/DECISIONS.md "W5"; server/src/skills/share.ts, share-merge.ts). Additive only.
--   skill_shares.source_detail: 'codex' for a share Codex sent through the team connector (share_skills). The source
--     column's CHECK knows only browser, desktop and claude_code, and tables are never rebuilt, so such a row keeps
--     'claude_code' there (the closest: sent by an app through the connector) and its real source here. NULL: the
--     source column says it all. An older build reads such a row as a Claude Code share.
--   skill_share_merges: a skill of a share that is merged into an existing team skill. While the owner's welcome steps
--     are unfinished the merge waits (chat_id NULL) and starts at their end; then, or at once outside the steps, it is
--     a row of the merge chat, whose turns are restricted (no team instructions, no tool but read, write and edit of the
--     team skills named here; the candidate's text goes into the instructions as data, never as the person's message).
--     `text` is the candidate's SKILL.md as the server checked it (no secret: a skill with one is never kept), so the
--     share's staged files can go when it is applied; a merged skill becomes a team file anyway. The rows go with the
--     chat (purged from the trash) and with the share.
--   skill_merge_notices: the owner's one Inbox notice at the end of the welcome steps, "합칠 스킬 N개 확인하기" (n), its
--     source the merge chat's id. notification_inbox has a fixed event_type CHECK list and tables are never rebuilt, so
--     it gets its own table, as team_join_notices and onboarding_notices do.
-- Dismissed and expired shares keep nothing of what they proposed (the review of PR #100): their result is emptied
-- here once, and from now on when they close (skills/share.ts close). The audit rows keep the counts.
ALTER TABLE skill_shares ADD COLUMN source_detail TEXT;

CREATE TABLE skill_share_merges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  share_id TEXT NOT NULL REFERENCES skill_shares(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  target_path TEXT NOT NULL,
  target_title TEXT NOT NULL,
  text TEXT NOT NULL,
  chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  started_at TEXT,
  UNIQUE(share_id, name)
);
CREATE INDEX skill_share_merges_chat ON skill_share_merges(chat_id);
CREATE INDEX skill_share_merges_waiting ON skill_share_merges(user_id, started_at);

CREATE TABLE skill_merge_notices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('skills.merge_waiting')),
  source_id TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 1 CHECK(n >= 1),
  created_at TEXT NOT NULL,
  read_at TEXT,
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK(suppressed IN (0,1)),
  UNIQUE(user_id,event_type,source_id)
);
CREATE INDEX skill_merge_notices_user_page ON skill_merge_notices(user_id,suppressed,created_at DESC,id DESC);
CREATE INDEX skill_merge_notices_retention ON skill_merge_notices(created_at);

UPDATE skill_shares SET result = '{"candidates":[],"rule":null,"ruleIn":null,"tools":[],"landing":null}'
  WHERE status IN ('dismissed', 'expired');
