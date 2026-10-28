-- min_compatible_reader: 1
-- Component B: where a chat's title came from (docs/DECISIONS.md "Chat titles", server/src/chat/title.ts):
-- 'auto' (the placeholder from the first message, or none yet), 'ai' (the answering AI named it with set_title),
-- 'user' (the person named it), 'schedule' (a scheduled run), 'legacy' (made before this column: the first line or a
-- rename, unknown which). The AI may name a chat only while its title is 'auto'. Older builds never write the column.
ALTER TABLE chats ADD COLUMN title_source TEXT NOT NULL DEFAULT 'auto';
UPDATE chats SET title_source = 'legacy' WHERE title <> '';
