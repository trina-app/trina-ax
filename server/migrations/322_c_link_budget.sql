-- min_compatible_reader: 1
-- Component C: where a remembered web address came from, and the per-answer budget for opening learned links without a
-- card (docs/DECISIONS.md "Outbound web channels", server/src/tools/url-gate.ts):
--   chat_seen_urls.source: 'fetched' (a link of a fetched page), 'search' (a web search result opened through the
--     budget), 'allowed' (the person allowed it on a card, or a scheduled task's card carried it). NULL: rows written
--     before, counted as 'fetched'.
--   chat_seen_urls.free_turn_id: the answer (turn) that opened this learned address without a card. Counted against the
--     budget (8 per answer, 30 per chat); opening it again is free.
-- Personal connections can no longer send without asking (write policy "allow" is for team connections only): rows
-- that had it ask again.
-- Additive only.
ALTER TABLE chat_seen_urls ADD COLUMN source TEXT CHECK (source IS NULL OR source IN ('fetched', 'search', 'allowed'));
ALTER TABLE chat_seen_urls ADD COLUMN free_turn_id TEXT;
CREATE INDEX chat_seen_urls_free ON chat_seen_urls(chat_id, free_turn_id) WHERE free_turn_id IS NOT NULL;
UPDATE integrations SET write_policy = 'ask', version = version + 1 WHERE scope = 'personal' AND write_policy = 'allow';
