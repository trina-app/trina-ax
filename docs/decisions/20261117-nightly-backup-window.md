# The nightly backup runs once a night: at the start time, or when the server is back after a night it missed

- Date: 2026-11-17
- Status: accepted
- Supersedes: the "야간 백업 시각(L09)" item of [클라우드·리눅스 서버](../DECISIONS.md#클라우드리눅스-서버-배포-형태-요금제-한도-팀-시간대-저장-공간-리눅스-진단-업데이트-featcloud-linux-server-2026-10-22) (when it runs; the start minute stays)
- Branch: fix/nightly-backup-window (QA TC-4755)

Plan: docs/AGENTS/plan/20261117-1509-nightly-backup-window.md.

- **Ask:** the nightly backup ran in working hours most days. The rule was "20 h since the last daily backup, and the
  team-local time is after the start" (03:00 self-hosted; on hosted tenants 02:00 + 0–179 min, or the start ax-hostd
  wrote to `MYCEL_BACKUP_WINDOW_START_MIN`). "After 03:00" is true until midnight, so the next backup ran 20 h after the
  last and the time walked 4 h earlier every day. Install at 14:00 (Seoul, start 03:00), 14 days:
  `14:10, 10:10, 06:10, 03:00, 23:00, 19:00, 15:00, 11:00, 07:00, 03:00, 23:00, ...`. Every start before 04:00 drifts
  this way (all self-hosted servers, about two thirds of hosted tenants).
- **Rule:** `shouldRunDailyBackup()` (server/src/system/ops.ts), checked every 10 minutes:
  1. Daily backups dated after now do not count (a clock that ran ahead and was set back).
  2. A failed try waits an hour (`DAILY_BACKUP_RETRY_MS`).
  3. No daily backup yet: run (the first one right after install).
  4. Else run when tonight is later than the night of the last one. The night of an instant is the team-local date of
     (wall time - start), from `zonedParts`. A server that is on runs at the start time every night; one that was off
     at the start time runs at the first check after it is back, whatever the hour.
- **Why "later", not "different":** on the night clocks go back, a start inside the repeated hour (02:30) reads the
  date before for the half hour after the change; "different" ran a backup there and again at 02:30. A start near
  midnight (23:59) is one night across the date change; a night that skips the start hour runs at the first check
  after it.
- **Why no time window or 30 h catch-up:** the first fix (a 3-hour window, plus any time when the last one was over
  30 h old) alternated on a server that is on 08:00–18:00 only: `08:00, 14:10 the next day, 08:00 two days later, ...`,
  half of them mid-afternoon. The night check alone gives 08:00 every day there, and still at most one a night.
- **When two backups can come close together:**
  - right after install: the first one at once, the next at the coming start time (the same night when installed
    between midnight and the start);
  - after a failed try: the retry an hour later, in the same night;
  - after a team time-zone change: the night is read in the new zone, so the next start can come sooner;
  - when the clock jumps ahead (a new night for the server) and when it is set back (its backups dated ahead do not
    count until the clock reaches them; nights whose date one of them carries are then skipped).
- **Tests:** `tests/unit/p1-backup-window.test.ts` steps a fake clock in 10-minute ticks for 14 days: 8 install times ×
  5 zones (every backup after the first at the start time), DST weeks in Berlin and New York with starts 02:00, 02:30
  and 03:00, hosted starts including 22:00, 23:30 and 23:59, a 2-day outage, a server on 08:00–18:00 only (one a day at
  08:00), a clock 2 and 30 days ahead then set back, failed tries. `tests/unit/g-queue-retention.test.ts` (L09): a 24/7
  server whose last backup was in last night's window does not run outside it.
- **Version impact:** patch.
