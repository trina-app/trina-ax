-- min_compatible_reader: 1
-- Component B: "Replies in threads I'm part of" (notification_preferences.room_thread_replies) is on by default again,
-- as in Slack (owner 2026-11-23, docs/decisions/20261123-thread-replies-default-on.md; supersedes the default-off part
-- of 20261122-project-chat-notices-threads-mention-only.md). A reply in a thread I follow (I wrote the root, replied, or
-- was mentioned in the root or a reply) rings again; people who follow nothing still get nothing. This undoes migration
-- 437's turn-off for everyone: the table keeps no time of a save, so a person who turned it off on purpose after 437
-- cannot be told apart and is turned on too (they can turn it off again). Data only: an older build reads 1 as "on".
UPDATE notification_preferences SET room_thread_replies = 1 WHERE room_thread_replies = 0;
