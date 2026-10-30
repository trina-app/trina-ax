-- min_compatible_reader: 1
-- Component B: scheduled runs no longer launder web addresses (docs/DECISIONS.md "Outbound web channels"). A free-text
-- scheduled task is written by the AI; its run puts that text in as a user message, where web_fetch used to take every
-- address as one the person had typed. Now:
--   messages.auto_sent = 1: the server sent this user message for the person (a scheduled run). Its addresses are not
--     "seen" (server/src/tools/url-gate.ts). Marked per message, so it holds after the schedule is deleted and when the
--     person writes more in the run's chat. 0 on every row written before.
--   schedules.allowed_urls: JSON list of the addresses the person saw on the schedule's confirmation card; each run
--     copies them into its chat's chat_seen_urls as allowed. NULL: none (templates, schedules made before the card).
--   schedules.write_connections: JSON list of the ids of "allow" team connections the person let this schedule write to
--     without asking (the card's choice). NULL / []: none; such writes in a run are refused (nobody to ask).
-- Additive only.
ALTER TABLE messages ADD COLUMN auto_sent INTEGER NOT NULL DEFAULT 0 CHECK (auto_sent IN (0, 1));
-- runs before this: the user message of every scheduled turn, and the first message of a scheduled run's chat (its
-- turn row may be gone; chats from before 209 carry their "⏰ " title as 'legacy'). Marking too much only means an
-- address there needs a card.
UPDATE messages SET auto_sent = 1 WHERE role = 'user' AND (
  id IN (SELECT user_message_id FROM turns WHERE client_kind = 'schedule' AND user_message_id IS NOT NULL)
  OR (parent_id IS NULL AND chat_id IN (SELECT id FROM chats WHERE title_source = 'schedule' OR (title_source = 'legacy' AND title LIKE '⏰ %'))));
ALTER TABLE schedules ADD COLUMN allowed_urls TEXT;
ALTER TABLE schedules ADD COLUMN write_connections TEXT;
