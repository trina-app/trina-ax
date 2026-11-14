-- min_compatible_reader: 1
-- Component B: a chat outside projects shared with chosen people and groups (docs/DECISIONS.md "Chats shared with
-- people and groups", QA TC-1405; plan docs/AGENTS/plan/20261114-shared-chats-everywhere.md phase 3).
--   chats.people_shared_at: set while the chat is shared with the people and groups in chat_audience (its project_id is
--     NULL and shared_at stays NULL: an older build sees an ordinary private chat of its creator, so its lists and
--     searches never show the chat to anyone else, and it never makes it a shared project chat).
--   turns.people_checked: 1 = this build ran the turn (it knows people-shared chats: the read gate, SHARED_TOOLS, no
--     memories); 2 = the turn ran before the chat was shared (checked by the share). At start a people-shared chat with
--     a turn 0 (an older build ran it after a rollback) stops being shared (chat/people-share.ts).
--   chat_audience: who the creator shared the chat with, by name or by group; the people who see it are the creator,
--     the active people listed and the active members of the listed groups, read per request.
--   chat_list_hidden: "Hide from my list", per person (a recipient's own lists); opening the chat brings it back.
--   chat_share_notices: "{name} shared a chat with you" in the Inbox (source_id = the chat.audience audit row, never any
--     text; the chat id so the notice can name the chat while the reader still sees it). notification_inbox has a fixed
--     event_type CHECK list and tables are never rebuilt, so these notices get their own table, as project_notices
--     (284) do. At most one per chat, person and day (the `day` column and its unique index).
-- Additive only (reader 1). Numbered 298: 294 (b_project_leavers) is the highest component B migration on dev before this
-- round; 295 is taken by another open branch, 296 by the phase 1 cutover (b_hidden_answers_cutover) and 297 by
-- b_account_deletion_due.
ALTER TABLE chats ADD COLUMN people_shared_at TEXT;
ALTER TABLE turns ADD COLUMN people_checked INTEGER NOT NULL DEFAULT 0;

CREATE TABLE chat_audience (
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('user', 'group')),
  subject_id TEXT NOT NULL,
  added_by TEXT,
  added_at TEXT NOT NULL,
  PRIMARY KEY (chat_id, subject_type, subject_id)
);
CREATE INDEX chat_audience_subject ON chat_audience(subject_type, subject_id);

CREATE TABLE chat_list_hidden (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  PRIMARY KEY (user_id, chat_id)
);
CREATE INDEX chat_list_hidden_chat ON chat_list_hidden(chat_id);

CREATE TABLE chat_share_notices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('chat.shared')),
  source_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  by_user TEXT,
  named INTEGER NOT NULL DEFAULT 0 CHECK(named IN (0,1)),
  day TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT,
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK(suppressed IN (0,1)),
  UNIQUE(user_id,event_type,source_id)
);
CREATE UNIQUE INDEX chat_share_notices_day ON chat_share_notices(user_id, chat_id, day);
CREATE INDEX chat_share_notices_user_page ON chat_share_notices(user_id,suppressed,created_at DESC,id DESC);
CREATE INDEX chat_share_notices_retention ON chat_share_notices(created_at);
CREATE INDEX chats_people_shared ON chats(people_shared_at) WHERE people_shared_at IS NOT NULL;
