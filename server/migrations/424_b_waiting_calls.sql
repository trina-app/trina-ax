-- min_compatible_reader: 1
-- Component B: the server's safety cards wait as long as it takes too (docs/decisions/20261119-safety-cards-wait.md,
-- server/src/chat/open-questions.ts). A delete, share, website or browser-site card raised inside a tool call is kept
-- in open_questions with the call that raised it: call_tool and call_args (the call as the tool got it: keys already
-- hidden), and window_id (a card for one desktop window: the browser's). The call ended without doing anything and the
-- answer ended; the person's answer starts the next turn, which runs that call again once, with every check of that
-- moment, and gives the saved answer to the same card. A card that reads differently then is asked again.
-- Additive only (reader 1): an older build reads open_questions without these columns (its rows are AI questions).
ALTER TABLE open_questions ADD COLUMN call_tool TEXT;
ALTER TABLE open_questions ADD COLUMN call_args TEXT;
ALTER TABLE open_questions ADD COLUMN window_id TEXT;
