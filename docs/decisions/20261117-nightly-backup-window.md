# The nightly backup starts only inside a 3-hour night window, once a night

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
- **Rule:** `shouldRunDailyBackup()` (server/src/system/ops.ts), checked every 10 minutes, runs a daily backup when
  1. there is no daily backup yet (the first one right after install), or
  2. the last one is over 30 h old (catch-up: the server was off at night; any time of day), or
  3. the team-local time is inside `[start, start + 3 h)` (`DAILY_BACKUP_WINDOW_MIN`, taken modulo 24 h, so a start at
     22:00 gives 22:00–01:00) and the last daily backup was not in the same night. The night of an instant is the
     team-local date of (wall time - start), from `zonedParts`; a window across midnight is one night, and the hour a
     DST night repeats does not run a second backup.
  A failed try still waits an hour (`DAILY_BACKUP_RETRY_MS`) before the next, inside the window or not.
  After: `14:10, 03:00, 03:00, 03:00, ...`.
- **Why "same night", not "20 h since the last":** a catch-up at 08:00 would block the next 03:00 (19 h), then catch up
  again at 14:00 the day after, and the time drifts again. The night key lets the next window run after any catch-up.
- **Left out:** a minimum gap after a catch-up: a catch-up at 01:00 can be followed by the 03:00 window run the same
  night. That only happens after an outage, and two backups are harmless.
- **Tests:** `tests/unit/p1-backup-window.test.ts` steps a fake clock in 10-minute ticks for 14 days (8 install times ×
  5 zones, DST weeks in Berlin and New York with starts 02:00 and 03:00, hosted windows including 22:00, 23:30 and
  23:59, a 2-day outage, a server that is on only 08:00–18:00, failed tries). `tests/unit/g-queue-retention.test.ts`
  (L09) now expects 17:30 UTC and 06:05 KST to be outside the window.
- **Version impact:** patch.
