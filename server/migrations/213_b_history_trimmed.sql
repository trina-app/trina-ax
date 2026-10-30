-- min_compatible_reader: 1
-- Component B: 1 when the AI got only the recent part of the conversation for this answer (docs/DECISIONS.md "Long
-- conversations: say when the AI got only the recent part"): a fresh engine session gets at most 40,000 characters
-- of the branch history (server/src/chat/prompt.ts historyWindow), and a session resumed from such a start keeps
-- that. The chat shows a small note under the newest such answer. 0 on every row written before. Additive only.
ALTER TABLE messages ADD COLUMN history_trimmed INTEGER NOT NULL DEFAULT 0 CHECK(history_trimmed IN (0,1));
