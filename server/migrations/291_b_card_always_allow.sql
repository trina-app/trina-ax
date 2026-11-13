-- min_compatible_reader: 1
-- Component B: "Always allow" on the AI's cards (docs/DECISIONS.md "Always allow on every card"; server/src/chat/
-- always-allow.ts). The owner, 2026-11-13: "항상 허용을 눌렀으면 안해야하는거 아니야?" One row per person and kind of card
-- (CARD_ALWAYS_KINDS in shared/src/api/ai-allowances.ts) that this person answered with "Always allow": from then on that
-- kind of card is not raised for them in the chats they watch (never in a scheduled run or another person's turn), until
-- they delete the row in Settings › 트리나에게 허용한 것 or an admin turns the team's switch off (roomAlwaysAllow; rows are
-- then ignored, not deleted). Additive only (reader 1): an older build ignores the table and asks as before.
CREATE TABLE card_always_allow (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, kind)
);
