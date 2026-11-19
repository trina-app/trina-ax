-- min_compatible_reader: 1
-- Component B: @mentions in threads under AI answers of shared chats (docs/decisions/20261118-chat-thread-mentions.md).
--   chat_thread_replies.mentions: the people a reply mentions (a JSON array of user ids), kept by the server only when
--     they saw the thread at send time (chat/threads.ts sendReply). '[]' for every older reply.
--   chat_thread_notices.mention_id: the first reply of the notice that mentions its person (NULL: replies only). The
--     Inbox row says "mentioned you" while a reply of it from there on still mentions them (chat/threads.ts mentionerOf).
-- Additive only (reader 1): an older build writes replies with the default '[]' and notices without mention_id.
ALTER TABLE chat_thread_replies ADD COLUMN mentions TEXT NOT NULL DEFAULT '[]';
ALTER TABLE chat_thread_notices ADD COLUMN mention_id TEXT;
