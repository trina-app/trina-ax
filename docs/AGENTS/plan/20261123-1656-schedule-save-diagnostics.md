# Make the schedule save test's failure diagnosable

- Date (UTC): 2026-11-23 16:56
- Branch: `test/schedule-save-diagnostics`
- Status: done
- Where: tests/unit/schedule-save-scope.test.ts. Why: the test helper belongs to this test file (see docs/REPOSITORY-RULES.md)
- Version impact: none, test output only

## Goal

"saves in a run > a new file in the save folder..." failed once in queue run 45211637917 with ENOENT on w1.md after
34 ms. The output does not say how the turn ended, so the failure cannot be explained afterwards.

## Scope

In: the test's `run()` prints the turn state, error and steps when a run ends without the expected result; its wait
fails with a clear message on timeout.
Out: any change to an expectation, a skip, a retry, or product code.

## Steps

1. Reproduce the Mac mini setup (shallow clone, frozen install, copied native/bin) and report the cause.
2. Add the diagnostics to `run()`.
3. Run typecheck, check:prepush and this test file 5 times.

## Decisions

- The shared `waitFor` keeps returning on timeout: other tests rely on it. Only this test's wait checks the result.

## Risks

None for the product: only this test file changes. No migration.

## Tests

`bun run typecheck`, `bun run check:prepush`, this test file 5 times.

## Result

`run()` reports the turn's state, error, tool calls and steps when a run does not end `done` or an expected file is
missing, and throws a clear error when the run does not end in 60 s. No expectation changed.

A shallow clone with a frozen install and correctly placed binaries passes. Copying the binaries' parent folder onto
`native/bin` leaves them in `native/bin/bin`; the launcher is then missing and the same ENOENT appears. The single CI
failure is not explained by this (the other tests in that shard passed); the new output will show its turn state if it
comes back.
