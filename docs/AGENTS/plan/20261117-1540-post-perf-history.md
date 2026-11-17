# A post in a long conversation: what still grows with its history

- Date (UTC): 2026-11-17 15:40
- Branch: `fix/post-perf-history`
- Status: done
- Where: trina-ax `server/src/rooms/store.ts` (unreadCount) and a migration in `server/migrations/`. Why: room reading
  and sending are Team AX core, and the slow query lives there.
- Version impact: patch, a speed fix with no change to what people see.

## Goal

After #1230 (TC-4772), QA (TC-4796) still saw a POST of a room message grow with the room's history, and
`unreadCount`'s mention check read the rest of the room when none of the first 1000 unread messages mentioned the
person: 47-73 ms at 100k messages, about 120 ms at 300k.

## Scope

In:
- Profile the whole POST path at 1k, 100k and 300k messages (per step and per SQL statement) on Bun 1.3.12.
- Fix what grows with the smallest correct change.
- The mention check: an index lookup of where the person is mentioned, with the same answer.
- Tests: correctness against reading every unread message, and query-plan guards.

Out:
- Reusing room_notices (room.mention) for the check: notices follow the person's level and runs, so the answer would
  change (see the decision).

## Steps

1. Profile; find what grows.
2. Migration 416: room_message_mentions kept by triggers, plus a partial index for "@everyone"; unreadCount uses them.
   (A partial index on "mentions anyone" was tried first: exact, but still a walk, 5-17 ms at 300k.)
3. Tests, typecheck, room/notification/unread and security tests under Bun 1.3.12.

## Decisions

docs/decisions/20261117-post-perf-history.md

## Result

Measured under Bun 1.3.12 (SQLite 3.51.0): the real app through HTTP (tests/unit harness, file database, response
validation off, a hub that builds and serializes every member's event), a group chat of 10, half of them with half the
history unread, every 3rd post mentioning someone, 30 posts per size, medians. The machine was shared (load 15-40).

- Plain POST of a message: 2.9 / 2.8 / 2.7 ms at 1k / 100k / 300k before, 3.2 / 3.4 / 2.6 ms after. Flat both times
  (the insert with its FTS trigger, seq, notices, read state, realtime build and markNoticesRead stay at 0.02-1.3 ms
  each at every size). Nothing in a plain post grows with history since #1230.
- What grew: `unreadCount`'s mention check whenever it runs for someone far behind. In a POST that is `roomOut` for
  each thread follower after a reply (afterReply → roomEvent) and for members a message brings a hidden room back to.
  Thread reply with 3 followers far behind: 6.4 / 122 / 360 ms before, 6.5 / 9.0 / 6.5 ms after.
- `unreadCount` for a person far behind with no mention among the first 1000 unread: 0.43 / 38.5 / 170 ms before,
  0.44 / 0.57 / 0.54 ms after (the rest is the 1000-row count).
- Insert of a message: 0.03 ms before and after (the new trigger adds nothing measurable).
- Tests: tests/unit/b-rooms-mention-index.test.ts.
