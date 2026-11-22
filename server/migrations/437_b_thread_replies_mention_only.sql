-- min_compatible_reader: 1
-- Component B: a reply in a thread rings only when it mentions me (owner 2026-11-22, docs/decisions/
-- 20261122-project-chat-notices-threads-mention-only.md). "Replies in threads I'm part of"
-- (notification_preferences.room_thread_replies, migration 255) is off by default from now on (server/src/notifications/
-- preferences.ts preferencesOf), and off for everyone who saved their settings before: it was on by default and could
-- only be turned off, so a saved 1 is the old default, not a choice. Rooms keep a followed reply as a quiet row in
-- Mentions & threads; chat threads keep theirs. Data only: an older build reads 0 as "off", as before.
UPDATE notification_preferences SET room_thread_replies = 0 WHERE room_thread_replies = 1;
