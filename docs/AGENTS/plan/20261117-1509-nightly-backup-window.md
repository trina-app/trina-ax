# The nightly backup runs inside a night window

- Date (UTC): 2026-11-17 15:09
- Branch: `fix/nightly-backup-window`
- Status: done
- Where: trina-ax `server/src/system/ops.ts` (`shouldRunDailyBackup`). Why: the backup schedule is Linux run-base core.
- Version impact: patch, the nightly backup no longer drifts into working hours.

## Goal

QA TC-4755. The rule was "at least 20 h since the last daily backup, and the time of day is after the start time
(03:00, or the hosted tenant's 02:00–04:59 start)". "After 03:00" is true until midnight, so each backup ran about
20 h after the one before and the time walked 4 h earlier every day (install at 14:00: 14:10, 10:10, 06:10, 03:00,
23:00, 19:00, 15:00, ...). Heavy backups (folder compression) landed in working hours most days.

## Scope

In:
- A daily backup runs when there is none yet (right after install), or when tonight is later than the night of the
  last daily backup. "Night" = the team-local date of (wall time - start): a server that is on runs at the start time,
  one that was off then runs at the first check after it is back. Backups dated after now do not count.
- The 1-hour wait after a failed try stays.
- Doc comment, INSTALL docs, decision file, changes fragment.
- Review of #1229: no 3-hour window and no 30 h catch-up (they alternated 08:00 / 14:10 on an 08:00–18:00 server);
  future-dated backups ignored.

Out:
- No change to the start minute (`backupStartMinute`) or to "Back up now".

## Steps

1. Rewrite `shouldRunDailyBackup` with the rule above.
2. Fix the L09 test (it relied on the 20 h rule) and add a 14-day simulation test (10-minute ticks, install times,
   zones, the hosted window, an outage, a failure).
3. Docs: `docs/INSTALL.md`, `docs/INSTALL-LINUX.md`, decision file `docs/decisions/20261117-nightly-backup-window.md`.

## Decisions

`docs/decisions/20261117-nightly-backup-window.md`.

## Risks

None in data: the backup itself is unchanged. A server that is off every night still gets a catch-up backup every 30 h.

## Tests

`bun run typecheck`, `bun run check:docs`, `tests/unit/g-queue-retention.test.ts`, `tests/unit/p1-backup-retry.test.ts`,
the new `tests/unit/p1-backup-window.test.ts`, under Bun 1.3.12.

## Result

Rule in `shouldRunDailyBackup`, docs in INSTALL.md and INSTALL-LINUX.md, decision
`docs/decisions/20261117-nightly-backup-window.md`. Seoul, install 14:00, 14 days: before
`14:10, 10:10, 06:10, 03:00, 23:00, 19:00, 15:00, ...`, after `14:10, 03:00, 03:00, ...`. An 08:00–18:00 server: 08:00
every day. PR #1229 to dev.
