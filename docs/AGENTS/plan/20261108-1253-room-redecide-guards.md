# Room preview re-decide: never over a posted answer, and spread over time

- Date (UTC): 2026-11-08 12:53
- Branch: `fix/room-redecide-guards`
- Status: in progress
- Where: trina-ax core, `server/src/rooms/ai-redecide.ts`. Why: a follow-up of #212 (the room AI's share rule is core;
  see docs/REPOSITORY-RULES.md)
- Version impact: patch. Server-side robustness; nothing visible changes.

## Goal

Two should-fixes from the re-review of #212 ("방에 올리기…"):

1. Deciding a refused preview again saves its new decision with `UPDATE … WHERE turn_id = ?`. If the asker posted the
   preview in between, a posted turn would get a private decision again. The save must only touch a turn that is still
   private.
2. People leaving rooms in bulk (a group's members changed, accounts removed: `Rooms.sync` calls `forgetMember` per row)
   fires `redecideRoomSoon` for many rooms at once, each a `setTimeout(0)` of up to 20 `decide()` calls (each up to
   ~100 ms for histories). They all run back to back and block the event loop.

## Scope

In:
- The save is `… WHERE turn_id = ? AND status = 'private'`; nothing is sent when no row changed.
- Rooms to decide again go into one queue per server: one room per step, its refused previews (now at most 10) for at
  most `REDECIDE_STEP_MS` (at least one), the rest of that room in the next step, steps `REDECIDE_ROOM_GAP_MS` apart.
  The first step is on the next turn of the event loop, never inside the request.
- Tests (`tests/unit/b-rooms-history.test.ts`): a preview posted while it is decided again keeps its posted state; a
  burst across five rooms runs one room per step, each room once.
- DECISIONS.md: the "When people leave" bullet of "방에 올리기…" says how it is spread.

Out: the pass after an upgrade (already in steps with a cursor).

## Steps

1. Plan (this commit).
2. `ai-redecide.ts`: the guarded save; the room queue.
3. Tests, DECISIONS.md.

## Risks

None for data: decisions of private previews only. No migration, no API change.

## Tests

`bun run typecheck`, `tests/unit/b-rooms-history.test.ts`, `tests/unit/b-rooms-ai.test.ts`.

## Result

Filled in at the end.
