-- min_compatible_reader: 1
-- Component B: shared project chats (docs/DECISIONS.md "Shared project chats"). Additive only.
--   projects.share_chats: 1 = new chats in this project are shared with its people (team projects only; never set on
--     a personal project). Turning it off keeps the chats already shared.
--   chats.shared_at: when the chat was made as a shared chat of its project (only at creation; NULL = one person's).
--     The people who can see the project see it and may continue it, each turn as the person who sent it.
--   turns.shared_checked: 1 = this build ran the turn (with the read gate of shared chats). At start a chat with a
--     turn after shared_at that is not checked (an older build ran it, without the gate) stops being shared.
-- An older build ignores the columns: a shared chat is its creator's own chat there (nobody else reaches it, and the
-- guard above unshares it when this build comes back).
-- Numbered 265: 263 is on dev (push device labels) and 264 is feat/room-history-for-later-members's.
ALTER TABLE projects ADD COLUMN share_chats INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chats ADD COLUMN shared_at TEXT;
ALTER TABLE turns ADD COLUMN shared_checked INTEGER NOT NULL DEFAULT 0;
CREATE INDEX chats_shared_project ON chats(project_id) WHERE shared_at IS NOT NULL;
CREATE INDEX messages_author_chat ON messages(author_id, chat_id) WHERE role = 'user';
