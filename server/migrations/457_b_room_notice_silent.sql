-- min_compatible_reader: 1
-- Component B: a room notice the person turned off (docs/AGENTS/plan/20261126-0835-one-activity-followups.md). A reply
-- in a thread they follow that does not mention them, with "Replies in threads I'm part of" off, is still recorded as a
-- quiet notice (listed in Activity's Threads), but since Activity is one place with every notice
-- (docs/decisions/20261126-one-activity.md) it must not raise the unread number they silenced. silent = 1: listed, never
-- counted (server/src/rooms/inbox.ts COUNTED_SQL). Older quiet notices keep 0: a quiet-hours notice still counts.
ALTER TABLE room_notices ADD COLUMN silent INTEGER NOT NULL DEFAULT 0 CHECK(silent IN (0,1));
