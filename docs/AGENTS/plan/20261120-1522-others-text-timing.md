# others-text.test.ts: check linear work by count, not by a wall-clock limit

- Date (UTC): 2026-11-20 15:22
- Branch: `fix/others-text-timing`
- Status: in progress
- Where: `tests/unit/others-text.test.ts`. Why: QA TC-5938. The TC-4970 test took 205 ms against its 200 ms limit on
  the CI runner and removed batch #162 from the merge queue once (2026-11-20 14:02Z).
- Version impact: none. Test only; no product code changes.

## Goal

The TC-4970 test means "each piece scans only what is new, so the work for a held run grows linearly". It checks
that with a fixed 200 ms wall-clock limit, which a slow or busy runner can break. Check the work itself instead: count
the characters `OthersText` looks up in its form-character set while the 64 KB run arrives in 7-character pieces, and
require that count to stay within twice the number of characters added. The quadratic version (the whole held run
scanned again for every piece) makes about 4,700 times as many lookups, so it still fails.

## Steps

- Replace the timer with a counting `Set` put in place of the instance's form-character set after the first call
  (the set is only rebuilt when the redactor or earlier text changes, which this test does not do). Assert the
  count is at least the characters added (so the counter is really in the path) and at most twice that.
- Show that the test fails against a deliberately quadratic scan (loop from `runAt` instead of `seen`), then revert.
- Run the test 20 times in a loop, `bun run typecheck`, `bun run check:prepush`.
