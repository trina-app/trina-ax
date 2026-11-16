-- min_compatible_reader: 1
-- Component C: one-tap next steps after an AI share or post (docs/decisions/20261116-ai-share-who-can-open.md, plan
-- docs/AGENTS/plan/20261116-1150-ai-share-who-can-open.md; server/src/files/share-fixes.ts).
--   share_fix_offers: what a button under an AI step may do, kept by the server so the tap runs the server's record and
--     never the AI's text: who it is for (user_id: only they may run it), the chat it shows in, the kind (let_view: view
--     access for the listed people; ask_owner: an access request to the file's owner for them; ask_admin: a message to
--     an admin about a folder; share_project: the app's own share flow, nothing runs here) and its payload (JSON: the
--     files' link ids, the people's ids, the room). Run once (state done), or found to have nothing left (gone). Rows
--     older than 30 days are deleted when a new one is made.
--   file_access_requests.asked_by: a request someone asked for other people ("Ask Mina" after a post to a room): who
--     asked. NULL: the requester asked for themselves, as before.
-- Additive only (reader 1): an older build ignores the column and does not know the table.
CREATE TABLE share_fix_offers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('let_view','ask_owner','ask_admin','share_project')),
  payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','done','gone')),
  done_count INTEGER,
  created_at TEXT NOT NULL,
  done_at TEXT
);
CREATE INDEX share_fix_offers_user ON share_fix_offers(user_id, created_at);
CREATE INDEX share_fix_offers_created ON share_fix_offers(created_at);

ALTER TABLE file_access_requests ADD COLUMN asked_by TEXT;
