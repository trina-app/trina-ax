# Web unit tests: a late state update after a file ended no longer crashes the next file; TZ put back

- Date (UTC): 2026-11-08 21:30
- Branch: `fix/web-unit-window-teardown`
- Status: done
- Where: trina-ax core (`web/test/unit/`, the components found leaking). Why: the web unit test harness is core (see
  docs/REPOSITORY-RULES.md)
- Version impact: patch. The copy button clears its timer on unmount (app code, nothing a person sees changes but
  a second copy keeping the mark its full 1.5 s); the rest is tests.

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

- Cause: `useCopy` (web/src/components/ui.tsx) never cleared its 1.5 s "copied" timer. In run 42521419319, first-run's
  copy button set its state 1.5 s after the file, in the gap with no document before steps-subtasks (room-thread was
  only the file before the gap). React DOM reads `window.event` for an update's priority before it looks at whether
  the component is still there. The stack stopped at `dispatchSetState` because JavaScriptCore drops the arrow's frame
  (proper tail calls).
- Found with a temporary tracer (not committed): every `useState` setter knew its component and file, and calls after
  that file ended were printed. Only `useCopy` leaked (first-run, room-links; goal-card waited 1.6 s for it). Toast
  dismiss timers outlive files but only write a store. TeamPrepared, presence and room-thread did not leak.
- `dom-host.ts`: while no document is installed, React DOM's update priority is DefaultEventPriority, so a late update
  does nothing; installDom puts back "no priority". Not done: a stub `window` (it would change 32 `typeof window`
  checks for tests without a document), and clearing or running pending timers at removeDom (it breaks module guards
  such as devEnvQueue's `timer`, or fires fetches after a test put back the real one).
- `useCopy`: its timer is cleared on unmount; goal-card no longer waits.
- `preload.ts`: TZ is pinned to the run's zone and set again at each file's start. In Bun 1.3, deleting TZ kept the last
  zone (New York after audit-dates / usage-range) for the rest of the run. team-files.test.ts is unchanged (#220).
- `test-file-end.test.tsx`: the regression test.
- Checks: typecheck; the full web suite in Docker (bun 1.3.12), in CI order and in the default order (see the PR).
