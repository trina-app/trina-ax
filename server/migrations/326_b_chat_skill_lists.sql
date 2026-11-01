-- min_compatible_reader: 1
-- Component B: the skill list in the AI's instructions (server/src/chat/skill-list.ts, docs/DECISIONS.md "Skills: the
-- whole list, the skill tool"). One row per chat:
--   ranked: JSON list of skill paths, the order in which skills get their description in the list (personal skills,
--     then by the person's usage), fixed at the chat's first turn so the instructions stay the same turn to turn
--   listed: JSON [{p: path, n: name, h: hash of name, description and text}] of the skills the latest fresh
--     instructions of this chat listed; NULL: none recorded yet
--   session_id: the Claude session those instructions started (a resumed session is told what changed since); NULL for
--     engines that start fresh every turn
-- Only the chat's own person's skills (the team skills they can read, their own personal skills). Additive only.
CREATE TABLE chat_skill_lists (
  chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  ranked TEXT NOT NULL,
  listed TEXT,
  session_id TEXT,
  updated_at TEXT NOT NULL
);
