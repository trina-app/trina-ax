-- min_compatible_reader: 1
-- Component B: 팀 파일 in the welcome steps (docs/DECISIONS.md "W6 — Onboarding v6: 팀 파일 recommendations";
-- server/src/onboarding/file-rank.ts). An owner or admin picks a folder on their computer; the page lists its documents
-- and the AI picks the ones the team should have, from the names, paths inside the folder, types, sizes and dates only.
--   onboarding_file_ranks: the chat of one such pick, a turn of the caller with no tool at all and its own short
--     instructions; `material` holds the entries (JSON, never a file's content) and the company profile lines, read
--     when the turn starts. A machine-only chat: out of the chat list, deleted (with this row) once its answer is read,
--     after at most 30 s; a leftover (a restart mid-pick) is deleted within minutes.
-- Additive only (reader 1): an older build does not know the table and never reads it (a leftover chat, at most 30 s
-- old at a rollback, would show there as one of the person's own).
-- Numbered 272: given to this change; 265 is the highest on dev.
CREATE TABLE onboarding_file_ranks (
  chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  material TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX onboarding_file_ranks_created ON onboarding_file_ranks(created_at);
