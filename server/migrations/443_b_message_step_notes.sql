-- min_compatible_reader: 1
-- What each tool step of an answer was called with and the start of what came back (server/src/chat/step-record.ts;
-- docs/decisions/20261122-chat-step-memory.md): a fresh engine session's history lists the asker's own earlier
-- steps from it. JSON {stepId: {i, o}}, secrets hidden, never sent to an app. NULL on older rows (labels only).
-- 443: 440 is the highest on dev; open PRs #403 and #404 take 441 and 442.
-- Additive only (reader 1): an older build never names the column.
ALTER TABLE messages ADD COLUMN step_notes TEXT;
