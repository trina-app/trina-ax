# A post in a long conversation: what still grows with its history

- Date (UTC): 2026-11-17 15:40
- Branch: `fix/post-perf-history`
- Status: in progress
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
- The mention check: walk only the messages that mention anyone (a partial index), with the same answer.
- Tests: correctness against reading every unread message, and query-plan guards.

Out:
- A per-person mentions table (only if the partial index is not enough).

## Steps

1. Profile; find what grows.
2. Migration: partial index on room_messages(room_id, seq) for messages that mention anyone; unreadCount uses it.
3. Tests, typecheck, room/notification/unread and security tests under Bun 1.3.12.

## Decisions

docs/decisions/20261117-room-mentioning-index.md

## Result

(filled in at the end)
