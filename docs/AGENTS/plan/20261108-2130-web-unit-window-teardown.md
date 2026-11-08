# Web unit tests: a late state update after a file ended no longer crashes the next file; TZ put back

- Date (UTC): 2026-11-08 21:30
- Branch: `fix/web-unit-window-teardown`
- Status: in progress
- Where: trina-ax core (`web/test/unit/`, the components found leaking). Why: the web unit test harness is core (see
  docs/REPOSITORY-RULES.md)
- Version impact: none. Tests only, plus clean-ups on unmount that change nothing a person sees.

## Goal

CI's web unit job sometimes ends "N pass, 0 fail, 1 error": an "Unhandled error between tests", `ReferenceError: window
is not defined` in React DOM's `resolveUpdatePriority` (from `dispatchSetState`), at the start of a file after one that
rendered components (run 42521419319: after `room-thread`, at `steps-subtasks`). A component from an earlier file sets
its state after that file took its fake document away (`removeDom`), and React DOM reads `window.event` before it looks
whether the component is still there. Nothing failed; the run is red anyway, depending on file order and timing.

## Scope

In:
- `web/test/unit/preload.ts` / `dom-host.ts`: whatever a test file leaves behind cannot crash a later file. A state
  update of a component that is gone does nothing, as in a browser. Tests without a document still see no `window`.
- The components found setting state after unmount (timers not cleared): cleared on unmount.
- `process.env.TZ`: the zone the run started in is put back at the start of every file (Bun 1.3: deleting TZ leaves the
  last zone in place for the rest of the run).
- A regression test: a file that schedules a state update after its last test; the run has no error.

Out: other kinds of leaks between files (a timer that fetches or writes a store after its file) stay as they are; the
stores are already reset at the start of each file.

## Steps

1. Reproduce in Docker (bun 1.3.12) in CI's file order; find the mechanism and the leakers.
2. Harness fix in `dom-host.ts` / `preload.ts`; TZ pinned and put back in `preload.ts`.
3. Clear the leakers' timers on unmount.
4. Regression test file.
5. `bun run typecheck`; full web unit suite in Docker in CI order, 3 runs, and once in the default order.

## Risks

The harness touches every web unit test file: a change that hides a real failure, or that gives files without a
document a `window`, would be worse than the flake. Store reset behaviour stays as it is.

## Tests

`bun run typecheck`; the full web unit suite in Docker (bun 1.3.12) in CI order at least 3 times with 0 fail and 0 error,
and once in the default order.

## Result

Filled in at the end.
