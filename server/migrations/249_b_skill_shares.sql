-- min_compatible_reader: 1
-- Component B: 내 스킬 가져오기 (docs/DECISIONS.md "SK — 내 스킬 가져오기"; server/src/skills/share.ts). An owner or admin
-- brings the skills they use with Claude to the team, from a picked .claude folder or from Claude Code (the connector's
-- share_skills tool). Nothing reaches the team before they press [팀에 공유]:
--   skill_shares: one share proposal of one person (only they see and apply it). `result` holds what the server made of
--     the candidates (JSON: their names, header descriptions, file names and sizes, group and one-line reason, the
--     CLAUDE.md team rule the AI rewrote, the remote MCP servers offered, the outcome of applying), never a file's
--     content: the kept files wait in <data>/skill-shares/<id>/ (outside the team files, deleted on apply, dismiss and
--     expiry), and a skill with a secret is never written anywhere. status: checking (the AI's judgement runs) · ready ·
--     applied · dismissed · expired (after expires_at). ai: pending · done · none (no AI answers the person) · failed.
--     where_label: how the sender names where it looked (".claude"); projects: Claude Code's project folders.
--   skill_share_judges: the chat of the AI's judgement of a share (a turn without any tool, its own instructions; the
--     candidates and the CLAUDE.md go in as data). A machine-only chat: out of the chat list, deleted once its answer
--     is read.
-- Additive only (reader 1): an older build does not know the tables and never reads them.
CREATE TABLE skill_shares (
  id TEXT PRIMARY KEY,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('browser', 'desktop', 'claude_code')),
  status TEXT NOT NULL CHECK (status IN ('checking', 'ready', 'applied', 'dismissed', 'expired')),
  ai TEXT NOT NULL CHECK (ai IN ('pending', 'done', 'none', 'failed')),
  where_label TEXT,
  projects INTEGER,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX skill_shares_by_person ON skill_shares(created_by, created_at);
CREATE INDEX skill_shares_open ON skill_shares(status, expires_at);

CREATE TABLE skill_share_judges (
  chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  share_id TEXT NOT NULL REFERENCES skill_shares(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE INDEX skill_share_judges_share ON skill_share_judges(share_id);
