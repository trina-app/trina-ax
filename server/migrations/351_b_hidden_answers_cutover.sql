-- min_compatible_reader: 1
-- Component B: no new hidden answers (docs/DECISIONS.md "People who see a shared chat later: nothing new is hidden",
-- docs/AGENTS/plan/20261114-shared-chats-everywhere.md, QA TC-1404). Data and an index only: nothing is dropped,
-- renamed or rebuilt.
--   settings 'hidden_answers_cutover': the time this build first ran (ISO, like messages.created_at). An answer of a
--     shared project chat (chat/shared-answers.ts) or a team room's message (rooms/history.ts) made from then on is never
--     hidden from a later viewer; older ones keep the old rule only where no read card covered them. Written once.
--   shared_answer_reads.reads: each group of an answer whose turn had a read card answered "Read and share" (the audit
--     row chat.shared_read with decision 'shared') gets y: 1, unless it is x: 1 (what it read is not all known). y marks
--     a group a card covered: an older answer is not hidden for it. New answers get y from the card itself
--     (chat/turn.ts noteSharedReads). An older build ignores y.
--   shared_answer_reads_chat_msg: each chat's records in order, for the widening list (chat/widening.ts).
-- Rollback: an older build ignores the setting and y and applies the full old rule (hides more, never less).
-- Numbered 351: 350 (c_slack_bot_reading) is the highest on dev.
INSERT OR IGNORE INTO settings (key, value) VALUES ('hidden_answers_cutover', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

UPDATE shared_answer_reads SET reads = (
  SELECT json_group_array(CASE WHEN g.type = 'object' AND json_extract(g.value, '$.x') IS NULL THEN json_set(g.value, '$.y', 1)
    WHEN g.type IN ('object', 'array') THEN json(g.value) ELSE g.value END)
  FROM json_each(shared_answer_reads.reads) g
)
WHERE (CASE WHEN json_valid(reads) THEN json_type(reads) = 'array' AND json_array_length(reads) > 0 ELSE 0 END)
  AND (SELECT m.turn_id FROM messages m WHERE m.id = shared_answer_reads.message_id) IN (
    SELECT CASE WHEN json_valid(a.detail) THEN json_extract(a.detail, '$.turnId') END FROM audit_log a
    WHERE a.action = 'chat.shared_read' AND (CASE WHEN json_valid(a.detail) THEN json_extract(a.detail, '$.decision') END) = 'shared'
  );

CREATE INDEX shared_answer_reads_chat_msg ON shared_answer_reads(chat_id, message_id);
