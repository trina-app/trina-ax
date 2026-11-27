# The watchdog restarts a hung server by default (office Mac), and long work leaves the event loop

- Date (UTC): 2026-11-27 04:52
- Branch: `fix/watchdog-kill-default`
- Status: in progress
- Where: server/src/office (the office supervisor's watchdog), server/src/system/backup.ts, server/src/file-list, docs.
  Why: the watchdog of #668 only logs a hang unless an operator turns the kill on; QA on qa.trina.app passed.
- Version impact: minor, part of the unreleased 0.21.0 watchdog feature: the default of `TEAMAX_WATCHDOG_KILL`
  changes (an office setting); the rest are fixes. No root file changes.

## Goal

A server that runs but stops answering `/api/health` for about 5 minutes is restarted without an operator having to
turn the switch on first. Operators can still turn it off.

## Scope

In:
- Check from the code that nothing the server does on purpose holds its main event loop (what `/api/health`
  measures) for 5 minutes: backups, restore, file conversion, update unpacking, migrations after the first healthy
  answer, large uploads and zips, search indexing, `_FILES.md`. A blocker is fixed or reported instead of flipping.
- Office Mac: kill unless `config/office.env` says `TEAMAX_WATCHDOG_KILL=0`.
- Bootstrap (Linux, Docker, Mac installs): only if the audit is clear. It is not: a big file is copied with
  `copyFileSync` (ext4 has no clones), which can hold the loop for over 5 minutes. The default stays log-only there;
  the reason is in the decision and CONFIGURATION.md.
- Fixed on the way: the restore's integrity check of the staged copy runs in a child process; the file list's
  reconcile pauses every 100 files and its sidecar does not sync every commit; a moved folder is one commit.
- Docs: CONFIGURATION.md, the install and office docs, the decision 20261127-restart.md, the changes fragment. Say
  that the 3-an-hour count is kept in memory only (a restart of the supervisor starts it again) while the give-up is
  kept on disk.
- Tests for the office default (on when absent, off with 0).

Out: the give-up in the control plane's status report; any change of the thresholds; moving the big copies off the
event loop (a follow-up, then the bootstrap default flips).

## Steps

1. Audit (table in the PR).
2. `officeWatchdogKills()` and settings in office; the three loop fixes.
3. Docs and tests; typecheck, check:prepush, office watchdog, backup and file-list tests.

## Decisions

Updates docs/decisions/20261127-restart.md (office Mac kills by default; why the bootstrap does not yet).

## Risks

A hang that is legitimate work would be cut: the audit is the guard. A restart ends running answers (they show Try
again), as a crash does.

## Tests

`tests/unit/office-watchdog.test.ts`, the backup and file-list tests, `bun run typecheck`, `bun run check:prepush`.

## Result
