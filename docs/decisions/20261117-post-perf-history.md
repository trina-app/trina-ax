# Who a room message mentions is kept in its own table, for the unread "@" mark

- Date: 2026-11-17
- Status: accepted
- Supersedes: none
- Branch: fix/post-perf-history (QA TC-4796, after #1230 / TC-4772)

Plan: docs/AGENTS/plan/20261117-1540-post-perf-history.md.

- **Ask:** the mention check in `unreadCount` (rooms/store.ts) must be cheap and stay exactly right. When none of the
  first 1000 unread messages mentioned the person, it read every other unread message of the room: 39-50 ms at 100k
  messages, 120-170 ms at 300k. It runs for the rooms list (each room of each person), the read state after a send,
  each thread follower's room after every reply (3 followers far behind: 122 ms per reply at 100k, 360 ms at 300k) and
  each phone push's badge.
- **Rule:** `room_message_mentions(room_id, user_id, seq)` (migration 416) has one row per person picked in a message.
  SQLite triggers on `room_messages` keep it from `room_messages.mentions` on insert, on an update of `mentions` (an
  edit, `Rooms.remove` clearing it) and on delete (a room deleted with its messages), whoever writes the row; the
  migration fills it from the messages written before. "@everyone" (`mentions_all`) gets a partial index
  `room_messages_mention_all` on `(room_id, seq)`. The check reads the person's rows after their read position, then the
  "@everyone" messages after it, and checks each candidate message with the whole rule (`UNREAD_SQL` and `MENTIONS_SQL`:
  what they may see, deleted, own message, thread-only reply, quiet app line, private preview, hidden old answer). The
  table only says where to look, so a stale or extra row can never make `mentioned` true by itself.
- **Why not reuse `room_notices` (room.mention):** a mention notice is made only when the person's level allows it, one
  unread notice stands for a run of messages, an edit that adds a mention makes none, and a hidden room makes none. The
  "@" mark reads the stored mentions, so notices would change the answer.
- **Why not one partial index on "mentions anyone":** tried first. It is exact and one line, but it still walks every
  unread message that mentions anybody (300k messages with 2% mentions: 5 ms in memory, 17 ms on a file database under
  load); the table is a lookup of the person's own mentions (0.5 ms at any size, most of it the 1000-row count).
- **Cost:** one small row per picked person, written by the trigger in the send's transaction (insert 0.03 ms before and
  after). `room_message_mentions.user_id` is named in auth/account-removal.ts as kept (it mirrors `mentions`, which keeps
  the id like `author_id`).
- **Tests:** tests/unit/b-rooms-mention-index.test.ts (each case against reading every unread message; the trigger on
  insert, edit, delete and room delete; the backfill; query plans with and without ANALYZE).
- **Version impact:** patch; additive migration (reader 1).
