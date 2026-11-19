-- min_compatible_reader: 1
-- Component B: 1 when this answer got only the recent part of the conversation because the team's AI model reads
-- only a short one (the API engine's context, server/src/chat/history-fit.ts), not because the chat is long: the
-- chat's note under the answer says that (chat.memory.smallModel). Set only with history_trimmed = 1. 0 on every row
-- written before. Additive only.
ALTER TABLE messages ADD COLUMN history_small_model INTEGER NOT NULL DEFAULT 0 CHECK(history_small_model IN (0,1));
