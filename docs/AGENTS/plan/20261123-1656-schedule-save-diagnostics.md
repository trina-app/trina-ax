# Make the schedule save test's failure diagnosable

- Date (UTC): 2026-11-23 16:56
- Branch: `test/schedule-save-diagnostics`
- Status: in progress
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
