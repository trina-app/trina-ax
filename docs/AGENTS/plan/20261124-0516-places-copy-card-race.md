# places-copy: the "job runs" card test survives a tracker tick

- Date (UTC): 2026-11-24 05:16
- Branch: `fix/places-copy-card-race`
- Status: done
- Where: Team AX core, `tests/unit`. Why: the flaky test is there (see docs/REPOSITORY-RULES.md)
- Version impact: none, test only

## Goal

`tests/unit/places-copy.test.ts` "while a job of this chat runs…" failed the 0.17.0 release run (expected one card, got 0) and about 1 in 5 local runs.

## Cause

The test inserted a `dev_env_runs` row as `running` with no unit, and as `waiting` with free slots. The server's job tracker polls every 10 s (`startJobTracker` → `pollSrt`; also after access changes). It correctly ends a running row whose unit is gone (`rowStatus` → `lost`) and starts a waiting job when a slot is free. When a tick landed between the insert and the command's check (`chatRunsLive`), the row had ended and no card was asked. A forced `pollSrt` right after the insert fails 3 of 3.

Product: not affected. The runner sets a running row's unit when it starts it (`runner.ts` startWaiting). A row ends only with an exit file, or when the system says the unit is not active (macOS: no process of the run's account). `pruneLive` (#480) only drops in-memory entries of rows already ended.

## Scope

In: the test's rows look to the tracker as real ones do (a live unit; a waiting job behind full slots), with a tracker poll right after the insert, and the state checked.
Out: product code.

## Steps

1. Reproduce with a forced tick.
2. Fix the test setup; loop before and after.

## Decisions

None.

## Result

See the PR.
