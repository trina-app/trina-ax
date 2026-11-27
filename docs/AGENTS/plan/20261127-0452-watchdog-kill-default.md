# The watchdog restarts a hung server by default

- Date (UTC): 2026-11-27 04:52
- Branch: `fix/watchdog-kill-default`
- Status: in progress
- Where: native/cmd/mycel-bootstrap (the bootstrap's watchdog), server/src/office (the office supervisor's), docs.
  Why: the watchdog of #668 only logs a hang unless an operator turns the kill on; QA on qa.trina.app passed.
- Version impact: minor, part of the unreleased 0.21.0 watchdog feature: the default of a `server.json` setting and
  of `TEAMAX_WATCHDOG_KILL` changes (a root file, the bootstrap, changes).

## Goal

A server that runs but stops answering `/api/health` for about 5 minutes is restarted without an operator having to
turn the switch on first. Operators can still turn it off.

## Scope

In:
- Check from the code that nothing the server does on purpose holds its main event loop (what `/api/health`
  measures) for 5 minutes: backups, restore, file conversion, update unpacking, migrations after the first healthy
  answer, large uploads and zips, search indexing, `_FILES.md`. A blocker is fixed or reported instead of flipping.
- Bootstrap: kill unless `server.json` says `"watchdog": {"kill": false}`.
- Office Mac: kill unless `config/office.env` says `TEAMAX_WATCHDOG_KILL=0`.
- Docs: CONFIGURATION.md, the install and office docs, the decision 20261127-restart.md, the changes fragment. Say
  that the 3-an-hour count is kept in memory only (a restart of the supervisor starts it again) while the give-up is
  kept on disk.
- Tests for the default (on when absent, off with false/0).

Out: the give-up in the control plane's status report; any change of the thresholds.

## Steps

1. Audit (table in the PR).
2. `killOn()` in watchdog.go, `officeWatchdogKills()` and settings in office.
3. Docs and tests; typecheck, check:prepush, Go tests, office watchdog tests.

## Decisions

Updates docs/decisions/20261127-restart.md (kill on by default).

## Risks

A hang that is legitimate work would be cut: the audit is the guard. A restart ends running answers (they show Try
again), as a crash does.

## Tests

`go test ./cmd/mycel-bootstrap/`, `tests/unit/office-watchdog.test.ts`, `bun run typecheck`, `bun run check:prepush`.

## Result
