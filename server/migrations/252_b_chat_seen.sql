-- min_compatible_reader: 1
-- Component B: when the chat's owner last had it on screen (docs/DECISIONS.md "Desktop sidebar: rooms first"). A chat
-- whose newest finished answer is later than this is "unseen": the sidebar's AI chats show a dot on it, in every window
-- and on every device, until the person opens it (POST /api/chats/:id/seen). Chats belong to one person, so one column
-- is the per-person mark. Older builds never read or write it. Every chat made before this column counts as seen now:
-- no dot appears on old chats after the update.
ALTER TABLE chats ADD COLUMN seen_at TEXT;
UPDATE chats SET seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
