-- People-fair queue. Additive; one ChatRuntime owns dispatch for each team DB.
ALTER TABLE turns ADD COLUMN queue_seq INTEGER;
ALTER TABLE turns ADD COLUMN dispatched_at TEXT;
ALTER TABLE turns ADD COLUMN wall_deadline_at TEXT;
ALTER TABLE turns ADD COLUMN schedule_id TEXT;
ALTER TABLE turns ADD COLUMN scheduled_for TEXT;
WITH old AS (SELECT id, ROW_NUMBER() OVER (ORDER BY COALESCE(queued_at, started_at), id) AS seq FROM turns WHERE status = 'queued')
UPDATE turns SET queue_seq = (SELECT seq FROM old WHERE old.id = turns.id) WHERE status = 'queued';
CREATE UNIQUE INDEX turns_queue_seq ON turns(queue_seq) WHERE queue_seq IS NOT NULL;
CREATE UNIQUE INDEX turns_schedule_occurrence ON turns(schedule_id, scheduled_for) WHERE schedule_id IS NOT NULL AND scheduled_for IS NOT NULL;
CREATE TABLE chat_queue_state (id INTEGER PRIMARY KEY CHECK (id = 1), next_seq INTEGER NOT NULL);
INSERT INTO chat_queue_state SELECT 1, COALESCE(MAX(queue_seq), 0) FROM turns;
CREATE TABLE chat_queue_users (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  rr_ticket INTEGER NOT NULL UNIQUE
);
ALTER TABLE schedules ADD COLUMN pending_due_at TEXT;
ALTER TABLE schedules ADD COLUMN retry_at TEXT;
ALTER TABLE schedules ADD COLUMN deferred_count INTEGER NOT NULL DEFAULT 0;
