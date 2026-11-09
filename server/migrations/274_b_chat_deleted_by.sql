-- min_compatible_reader: 1
-- Component B: who put a chat in the trash (docs/DECISIONS.md "Shared project chats: the trash and live lists").
--   chats.deleted_by: the person whose delete put the chat in the trash (NULL: not in the trash, or deleted by an older
--     build). A shared project chat deleted by an editor of its project is in their trash too, beside its creator's,
--     while they may still restore it. Cleared on restore.
-- Additive only (reader 1): an older build ignores the column (its trash shows the creator's chats, as before).
-- Numbered 274: 273 (shared_answer_reads) is the highest on dev.
ALTER TABLE chats ADD COLUMN deleted_by TEXT;
CREATE INDEX chats_deleted_by ON chats(deleted_by) WHERE deleted_by IS NOT NULL;
