-- min_compatible_reader: 1
-- Component B: a free-text scheduled task runs only after its owner confirmed it on the schedule card
-- (docs/DECISIONS.md "Scheduled tasks nobody confirmed"). Since migration 215 the AI's schedule_create asks first, but
-- tasks made before that (or by an older build after a rollback) were never confirmed by anyone and kept running
-- unattended. Now:
--   schedules.confirmed_at: when the person approved this task on its card (schedule_create, or "다시 확인" in
--     Settings > Scheduled tasks). NULL on templates (they never need the card: an admin-fixed instruction, folders the
--     person picked) and on free-text tasks nobody confirmed; those never run and cannot be resumed with the switch.
--   schedules.review_since: when the server paused it for that reason (here, on upgrade). Its owner gets one notice per
--     pause (in the app always, by push per their "scheduled task failed" setting), admins see it in Admin > Members.
--     Cleared when the owner confirms it again.
-- Tasks made since the card carry its record in allowed_urls / write_connections (only the card writes them); a
-- confirmed task without addresses or connections left no record and is paused too: unknown = paused. A one-time task
-- that already ran is left alone (it never runs again). Additive only.
ALTER TABLE schedules ADD COLUMN confirmed_at TEXT;
ALTER TABLE schedules ADD COLUMN review_since TEXT;
UPDATE schedules SET confirmed_at = created_at
  WHERE template_id IS NULL AND (allowed_urls IS NOT NULL OR write_connections IS NOT NULL);
INSERT INTO audit_log (actor_id, action, target, detail)
  SELECT NULL, 'schedule.review_paused', id, json_object('userId', user_id, 'wasEnabled', json(CASE WHEN enabled = 1 THEN 'true' ELSE 'false' END), 'reason', 'upgrade')
  FROM schedules WHERE template_id IS NULL AND confirmed_at IS NULL AND NOT (repeat = 'once' AND last_run_at IS NOT NULL);
UPDATE schedules SET enabled = 0, next_run_at = NULL, pending_due_at = NULL, retry_at = NULL,
  review_since = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE template_id IS NULL AND confirmed_at IS NULL AND NOT (repeat = 'once' AND last_run_at IS NOT NULL);
