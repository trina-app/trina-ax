-- min_compatible_reader: 1
-- Component B: who may see an answer of a shared project chat (docs/DECISIONS.md "Shared project chats", "People who
-- see a shared chat later"; server/src/chat/shared-answers.ts). Additive only.
--   shared_answer_reads: one row per answer of a shared chat (made with the answer, at createTurn; for every earlier
--     answer when a private chat is shared; once at start for an answer made before this table): what it read and who
--     saw the chat then.
--     reads: JSON [{c: [user ids], s: [ReadSource…], x?: 1}]: each group is the people who saw the chat when the
--       sources were read (the read card's audience, or everyone when nobody missed them); x: what it read is not all
--       known (a chat shared later whose check could not tell, an answer from before this table): only `c` sees it.
--     left_out: JSON [message ids]: answers above it on its branch that its runner did not see (not in its context).
--   A viewer sees an answer when it is their own turn's, or for every group they are in `c` or read every source, and
--   no answer above it in its context is hidden from them. No row: hidden from everyone but its runner.
-- An older build ignores the table. One from before 265 knows no shared chats (its turns there unshare the chat when
-- this build comes back: the 265 rollback guard). One with 265 and without this table shows every answer to everyone
-- who sees the chat again, as before this change: rolling back undoes the rule while it runs (written down in
-- docs/DECISIONS.md); when this build comes back, the answers that build made get a record for the people who see the
-- chat then (chat/shared.ts recordOlderAnswers), so nobody who joins later sees them.
-- Numbered 273: 266 and 272 are on dev, 267 and 270 are taken by open branches.
CREATE TABLE shared_answer_reads (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  reads TEXT NOT NULL DEFAULT '[]',
  left_out TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX shared_answer_reads_chat ON shared_answer_reads(chat_id);
