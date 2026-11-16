-- min_compatible_reader: 1
-- Component B: a thread's notices go with its answer and its chat (QA TC-3785, follow-up of migration 408 and
-- docs/decisions/20261116-chat-answer-threads.md). chat_thread_notices has no foreign key to messages or chats (the
-- Inbox reads every notice table through one union), so purging a chat (chat/runtime.ts purgeChat, the account sweeper,
-- a project deleted for good) left its rows behind: shown as "You can't see this anymore" until they aged out. These
-- triggers delete them with the answer (also when a chat's messages go by its cascade) and with the chat; their pushes go
-- by their own cascade. Additive only (reader 1): an older build just has the rows cleaned for it.
CREATE TRIGGER chat_thread_notices_answer_gone AFTER DELETE ON messages
BEGIN
  DELETE FROM chat_thread_notices WHERE source_id = OLD.id;
END;
CREATE TRIGGER chat_thread_notices_chat_gone AFTER DELETE ON chats
BEGIN
  DELETE FROM chat_thread_notices WHERE chat_id = OLD.id;
END;
-- rows left by a purge before this migration
DELETE FROM chat_thread_notices WHERE NOT EXISTS (SELECT 1 FROM chats c WHERE c.id = chat_thread_notices.chat_id)
  OR NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = chat_thread_notices.source_id);
