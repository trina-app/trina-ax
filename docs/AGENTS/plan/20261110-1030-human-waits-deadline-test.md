# The successive human waits test survives a slow CI runner

- Date (UTC): 2026-11-10 10:30
- Branch: `fix/human-waits-deadline-test`
- Status: in progress
- Where: Team AX core, `tests/unit/turn-deadline.test.ts`. Why: the failure is in a unit test's timing; the code it covers works.
- Version impact: none, a test-only change

## Goal

`successive human waits share one absolute deadline` failed on CI unit shard 5 of PRs #310 and #326 (Expected length:
2, Received length: 1). Both first attempts failed in the same minute; the re-runs of the same commits, with the same
83 files in the shard, passed. The test gives the turn a 90 ms wall deadline and the first card a 20 ms wait, so the
second card opens only if the event loop gets to the first card's timer within 70 ms. When the loop is held up longer
(a garbage collection or a busy runner), the 20 ms timer fires after the deadline, the turn ends, and the second card
never opens. The code under test is unchanged on dev: `waitForPerson`'s path for a card that is not `exclusive` does
the same as before #277 added the exclusive queue.

## Scope

In: give the test enough room that a stall of a few hundred milliseconds cannot end the turn before the second card
opens. Every assertion stays as it is.
Out: the other tests in the file (their short deadlines are the outcome they check, not a race), and fake timers (the
turn reads `performance.now()` and `Date.now()` as well as timers).

## Steps

1. Raise the test's wall deadline from 90 ms to 500 ms (the first wait stays 20 ms), with a comment that says why.
2. Check the old timing fails and the new one passes with a stall injected after the first card opens.
3. Run the file 20 times in Linux Docker (`oven/bun:1.3.12`), then the chat suites and typecheck.

## Risks

None for the product. The test takes about 0.4 s longer.

## Tests

`bun run typecheck`, `bun test tests/unit/turn-deadline.test.ts` 20 times in Linux Docker, the chat unit suites.

## Result

Filled in at the end.
