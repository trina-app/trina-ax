# Scheduled tasks: "frequent" depends on the schedule's interval, not on the time of day

- Date (UTC): 2026-11-21 00:25
- Branch: `fix/schedule-frequent-by-interval`
- Status: done
- Where: trina-ax server (`server/src/chat/schedules.ts`), two unit tests.
- Version impact: patch. A wrong chat choice is fixed; no API or data change.

## Problem

`isFrequent()` asks whether the next run is less than an hour after this due time. "Run now" passes the current time as
the due time, so a daily task at 09:00 run between 08:00 and 09:00 (team zone) counts as frequent and keeps one chat
instead of starting a new chat per run. Two tests fail for that hour every day.

## Steps

1. `isFrequent` takes the two next occurrences after the due time and compares them to each other (the schedule's
   interval), not to the due time. Daily, weekdays, weekly, monthly, once and hourly-or-slower are never frequent; an
   interval or cron under an hour is.
2. New unit test in `tests/unit/schedule-timing.test.ts`: clock inside the hour before a daily 09:00 is not frequent.
3. Make the two flaky tests run at a pinned clock so they do not depend on the wall clock.
4. `changes/` note; typecheck, `check:prepush`, schedule unit tests under Bun 1.3.12.
