-- min_compatible_reader: 1
-- Component B: the shared chat a memory was last written in by the AI (docs/decisions/20261125-auto-memory-shared-chats.md).
-- In a shared or project chat the AI keeps what the asker said there in the asker's own memory; that chat's turns of the
-- same person get only the memories whose shared_chat_id is that chat (their words are in its transcript already), never
-- the person's private ones. Any write elsewhere (a private chat's remember, Settings › Memory) sets it back to NULL.
-- 452: 451 is the highest b on dev; no open PR adds a migration.
-- Additive only (reader 1): an older build ignores the column (and offers no memory in shared chats, as before).
ALTER TABLE memories ADD COLUMN shared_chat_id TEXT;
