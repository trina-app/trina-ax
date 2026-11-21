-- min_compatible_reader: 9
-- Component B: versions of a chat's files (plan docs/AGENTS/plan/20261121-0615-chat-places-as-paths.md P4, review
-- fix 2; server core docs/AGENTS/plan/20261121-0646-chat-file-versions.md). A save of a chat file (the AI's write or
-- edit, the web's save, a restore) adds a row, never overwrites one (chat/chat-files.ts putVersion, the only writer):
--   root_id: the chain's first file (its id is the chain's id: messages, links and the AI's file_id name it); NULL on the
--     root itself and on every row from before.
--   replaces: the head this version was written over (NULL on a root).
--   version: 1, 2, 3 … within the chain, kept when older versions are pruned (version: n stays the same file); NULL = 1.
--   origin: 'ai' when the AI wrote it (shown "Trina for <person>"), NULL for a person's save. A root's origin stays in
--     the message's attachment, as before.
-- The rows still go with the chat (ON DELETE CASCADE). Additive, but reader 9: an older build reads a version (root_id
-- set) as an upload of its writer never sent (no message carries a version's id), so its sweep deletes it, bytes and
-- all, a day later. A roll-back below this build needs the pre-update backup (system/update.ts).
ALTER TABLE chat_files ADD COLUMN root_id TEXT;
ALTER TABLE chat_files ADD COLUMN replaces TEXT;
ALTER TABLE chat_files ADD COLUMN version INTEGER;
ALTER TABLE chat_files ADD COLUMN origin TEXT;
CREATE INDEX chat_files_root ON chat_files(root_id) WHERE root_id IS NOT NULL;
