-- min_compatible_reader: 1
-- Component B: the names a person calls teammates by ("팀장님" = QA Owner), so the AI does not ask again who they mean
-- (docs/decisions/20261123-do-then-undo.md; the owner, 2026-11-23: "7번이나 묻는건 좀 그런거 아냐?"). Kept when the
-- person answered once who a title or role meant (server/src/chat/person-aliases.ts), used before asking in every chat,
-- the person's own only, listed and deleted in Settings › Allowed for Trina (GET /api/ai-allowances, kind person_alias).
--   ref: the title as matched (lower case, no spaces, no honorific: "팀장", "manager"); target_id: the teammate
-- 445: 444 (waiting_call_meta) is the highest on dev and the open branches.
-- Additive only (reader 1): an older build ignores the table and asks as before.
CREATE TABLE person_aliases (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ref TEXT NOT NULL,
  target_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, ref)
);
