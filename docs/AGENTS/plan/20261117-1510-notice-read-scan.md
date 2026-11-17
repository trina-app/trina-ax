# Reading a room no longer scans every message in it

- Date (UTC): 2026-11-17 15:10
- Branch: `fix/notice-read-scan`
- Status: done
- Where: trina-ax `server/src/rooms/service.ts` (markNoticesRead, markThreadNoticesRead) and `server/src/rooms/store.ts`
  (unreadCount). Why: room reading is Team AX core and the slow queries live there.
- Version impact: patch, a speed fix with no change to what people see.

## Goal

Every post and every room open marks the person's notices read with
`source_id IN (SELECT m.id FROM room_messages m WHERE m.room_id = ? AND m.seq <= ? ...)`. SQLite builds the list of every
message id in the room up to `seq` first, so the cost grows with the room: 0.3 ms at 1k messages, 47 ms at 100k,
152 ms at 300k, about 0.5 s at 1M, and it holds the one SQLite thread the whole time. QA row TC-4772.

## Scope

In:
- markNoticesRead and markThreadNoticesRead: a correlated `EXISTS` that looks up each unread notice's message by its
  primary key (the person has at most a few unread notices per room). Same rows marked, no migration.
- unreadCount: count at most 1000 unread messages (the answer is capped at 999 already). Whether one mentions the person
  stays exact: it is read from the same 1000 rows, and only when there are more and none of those mentions them, from
  the rest.

Out:
- An index for mentions (the mention check past 1000 unread still reads the rest of the room; it needs a migration).

## Steps

1. Change the three queries.
2. Unit tests: which notices are marked (room and thread), the unread cap, and a query plan guard for markNoticesRead.
3. Run the rooms, notices, unread and badge tests under Bun 1.3.12, and typecheck.

## Decisions

None new.

## Result

Measured under Bun 1.3.12 (SQLite 3.51.0), in-memory DB with the real migrations:

- markNoticesRead: 0.38 / 4.3 / 49 / 157 ms at 1k / 10k / 100k / 300k messages before, 0.02 ms at every size after;
  the same notices marked. The plan is now a search of room_messages by id per unread notice.
- markThreadNoticesRead: the same change (it listed every reply of the thread).
- unreadCount with everything unread: 4 / 58 / 121 ms at 10k / 100k / 300k before, 0.4 ms after when a mention is among
  the first 1000 rows. When none of them mentions the person the mention check still reads the rest (4 / 39 / 103 ms):
  a later fix needs an index for mentions (a migration).
- Tests: tests/unit/b-rooms-notice-read.test.ts.
