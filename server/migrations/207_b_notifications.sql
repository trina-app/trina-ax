-- Inbox stores only generic event metadata; suppressed receipts prevent later opt-in backfills.
CREATE TABLE notification_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  schedule_success INTEGER NOT NULL DEFAULT 1 CHECK(schedule_success IN (0,1)),
  schedule_failure INTEGER NOT NULL DEFAULT 1 CHECK(schedule_failure IN (0,1)),
  connection_reconnect INTEGER NOT NULL DEFAULT 1 CHECK(connection_reconnect IN (0,1))
);
CREATE TABLE notification_inbox (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('schedule.success','schedule.failure','connection.reconnect')),
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT,
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK(suppressed IN (0,1)),
  UNIQUE(user_id,event_type,source_id)
);
CREATE INDEX notification_user_page ON notification_inbox(user_id,suppressed,created_at DESC,id DESC);
CREATE INDEX notification_retention ON notification_inbox(created_at);
CREATE INDEX notification_terminal_turns ON turns(ended_at) WHERE schedule_id IS NOT NULL;
