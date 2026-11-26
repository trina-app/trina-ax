-- min_compatible_reader: 1
-- Component B: a team project's shared chat tells nobody of someone else's message (owner 2026-11-26, docs/decisions/
-- 20261126-project-chat-mention-only.md, replacing the 11-22 rule of migration 436's project rows). The unread notices
-- made there before are read and their pushes that still wait are cancelled, so no old number stays on a project's
-- chat row, the Projects rail or the app icon. Chats shared with people (no project) keep theirs. Data only: an older
-- build reads a read notice as read.
UPDATE chat_message_push_deliveries SET state = 'cancelled', lease_until = NULL WHERE state IN ('pending', 'sending')
  AND notification_id IN (SELECT n.id FROM chat_message_notices n JOIN chats c ON c.id = n.chat_id WHERE c.project_id IS NOT NULL);
UPDATE chat_message_notices SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE read_at IS NULL
  AND chat_id IN (SELECT id FROM chats WHERE project_id IS NOT NULL);
