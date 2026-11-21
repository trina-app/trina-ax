-- min_compatible_reader: 1
-- Scheduled tasks at any frequency, and tasks made in a shared chat (server/src/chat/schedule-timing.ts,
-- docs/decisions/20261118-shared-schedules-any-frequency.md). Additive only.
-- rule: JSON of a timing the old columns cannot hold (every N minutes, several weekdays, day 29-31 or the last day of
-- the month, a cron schedule); such a row keeps a one-time task in the past in repeat/date, so an older build runs it
-- at most once more and then stops.
ALTER TABLE schedules ADD COLUMN rule TEXT;
-- chat_id: the shared chat the task was made in; its runs are turns there, with that chat's gates
ALTER TABLE schedules ADD COLUMN chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL;
