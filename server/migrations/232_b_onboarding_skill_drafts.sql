-- Onboarding S: chats that turn a result of the lead into a team skill (docs/DECISIONS.md "S — The lead's way becomes a
-- team skill"). A row marks a chat of an owner or admin as a skill draft: every turn of it runs with no tool at all and
-- its own short instructions (server/src/onboarding/skill-draft.ts), and its answers are read as a JSON draft. The
-- material is a snapshot of the source answer taken when the draft started (the question, the answer, the team files
-- it used, the skill it ran), so a later message in the source chat changes nothing. `rewrite_at`: the one rewrite the
-- server asked for (leftover names, dates or amounts, or no usable JSON). `saved_path`: the skill file the person
-- shared from it. The person saves; nothing here is the skill.
-- Additive only (reader 1): an older build does not know the table and runs such a chat as an ordinary one.
CREATE TABLE onboarding_skill_drafts (
  chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_chat_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  material TEXT NOT NULL,
  rewrite_at TEXT,
  saved_path TEXT,
  created_at TEXT NOT NULL
);
