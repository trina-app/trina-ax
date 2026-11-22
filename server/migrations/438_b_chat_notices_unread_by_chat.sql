-- min_compatible_reader: 1
-- Component B: everyone's unread chat notices in one chat (server/src/chat/message-notices.ts unreadByUser, run on every
-- chat.updated of a shared or project chat: runtime.ts publishChat) read only the unread rows, never every notice the
-- chat ever had (review of #362). 438: 437 is the highest on dev and in batch 20261122-i; no open PR uses 438.
-- Additive only (reader 1): an older build never names the index.
CREATE INDEX IF NOT EXISTS chat_message_notices_unread_by_chat ON chat_message_notices(chat_id, user_id)
  WHERE read_at IS NULL AND suppressed = 0;
