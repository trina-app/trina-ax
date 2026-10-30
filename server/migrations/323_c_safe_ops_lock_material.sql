-- 1A confidential lock only where 1A worked (docs/DECISIONS.md, 2026-10-30; QA 2026-10-30 D1). Until now every
-- conversation used while MYCEL_SAFE_OPS_1A=1 was locked from the web for good, even one that never ran a 1A workflow.
-- From now on a conversation stays locked after 1A is turned off only when a 1A workflow was admitted in it
-- (material=1, written by workflow admission before any source is read). While 1A is on, every conversation stays
-- locked as before.
-- Fail-closed: the column defaults to 1, so rows written by an older build (after a roll-back) stay locked; existing
-- rows are unlocked only when nothing ties 1A work to the conversation and nothing of its owner is unattributable.
-- An older reader ignores the column and keeps every row locked: no reader level change.
ALTER TABLE safe_ops_chats ADD COLUMN material INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS safe_ops_workflows_turn ON safe_ops_workflows(turn_id);
CREATE INDEX IF NOT EXISTS safe_ops_publications_turn ON safe_ops_publications(turn_id);
CREATE INDEX IF NOT EXISTS safe_ops_sources_turn ON safe_ops_sources(turn_id);
UPDATE safe_ops_chats SET material = 0
WHERE NOT EXISTS (
    SELECT 1 FROM turns t WHERE t.chat_id = safe_ops_chats.chat_id AND (
      EXISTS (SELECT 1 FROM safe_ops_workflows w WHERE w.turn_id = t.id)
      OR EXISTS (SELECT 1 FROM safe_ops_publications p WHERE p.turn_id = t.id)
      OR EXISTS (SELECT 1 FROM safe_ops_sources s WHERE s.turn_id = t.id)))
  -- 1A work whose turn row is gone (retention keeps the last turn of a chat, not older ones) cannot be tied to a
  -- conversation: every marked conversation of that person stays locked
  AND NOT EXISTS (
    SELECT 1 FROM chats c WHERE c.id = safe_ops_chats.chat_id AND (
      EXISTS (SELECT 1 FROM safe_ops_workflows w WHERE w.user_id = c.user_id AND w.turn_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.id = w.turn_id))
      OR EXISTS (SELECT 1 FROM safe_ops_publications p WHERE p.user_id = c.user_id AND p.turn_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.id = p.turn_id))
      OR EXISTS (SELECT 1 FROM safe_ops_sources s WHERE s.user_id = c.user_id AND s.turn_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.id = s.turn_id))));
