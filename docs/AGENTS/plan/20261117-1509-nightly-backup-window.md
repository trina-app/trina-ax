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
- A daily backup runs when there is none yet (right after install), when the last one is over 30 h old (catch-up after
  a server that was off at night), or inside the window [start, start + 3 h) in team time when the last daily backup
  was not in this same night. "Night" = the team-local date of (wall time - start), so a window that crosses midnight
  (a start set to 22:00 by `MYCEL_BACKUP_WINDOW_START_MIN`) counts as one night, and a DST night that repeats an hour
  does not run twice.
- The 1-hour wait after a failed try stays.
- Doc comment, INSTALL docs, decision file, changes fragment.

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

Built as planned: rule in `shouldRunDailyBackup`, `DAILY_BACKUP_WINDOW_MIN` = 180, docs in INSTALL.md and
INSTALL-LINUX.md, decision `docs/decisions/20261117-nightly-backup-window.md`. Seoul, install 14:00, 14 days: before
`14:10, 10:10, 06:10, 03:00, 23:00, 19:00, 15:00, ...`, after `14:10, 03:00, 03:00, ...`. PR to dev.
