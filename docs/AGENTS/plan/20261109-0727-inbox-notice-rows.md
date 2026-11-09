# Inbox: the app's own notices read like conversation rows and name the scheduled task

- Date (UTC): 2026-11-09 07:27
- Branch: `fix/inbox-notice-rows`
- Status: done
- Where: trina-ax core (`web/src/components/settings/Notifications.tsx`, `server/src/notifications/service.ts`,
  `shared/src/api/notifications.ts`). Why: the Inbox and its notices are core (see docs/REPOSITORY-RULES.md)
- Version impact: patch. Additive API field (`InboxNotification.schedule`); no data change, no migration.

## Goal

The owner, on a screenshot of the Inbox: the scheduled task's row looks bad. Beside the message rows (avatar, who and
where, the time on the right, the whole row opens) it had a bell, "예약 작업이 완료됐어요.", the date on a line of its
own and a small accent link "결과 열기": not clickable like its neighbours, the time in another place, and no word of
which task finished.

## Scope

In:
- Every notice of the app's own (not a room message row) is a row like a message row: the bell, the words, the time on
  the right in the 대화 list's format. With a place to open, the whole row is one link to it, opening it reads it, a dot
  while unread; the separate links under the words go. With none: no link, no hover, 읽음 표시 stays.
- A scheduled run names its task: success, failure, problems and "needs your own key". The server adds the task's title
  to the notice when it is read, while the task is the person's and there; older notices without it keep the old text.
  All 5 languages.
- `scheduled.openResult` stays on the Scheduled tasks page.

Out: room message rows (`RoomNoticeRow.tsx`), push and lock-screen text (stays generic), a "mark all read".

## Steps

1. Server: `schedule.title` from `schedules` for the three sources of a run notice (turns, schedule_outcomes,
   schedule_template_skips), owner-checked, one plain line. Contract field and a unit test.
2. Web: `noticeText` and `noticeLink` out of the row's long ternary; `NoticeRow` with the link as the row, the log and the
   handover's buttons outside it. New strings in 5 languages; drop the labels no longer used.
3. Tests: web unit (words, links, the row in the Inbox), the inbox e2e with a schedule row among message rows, the specs
   that assert the old strings; 2 screenshots (1440 and 390, light).

## Risks

A title on a lock screen (it must not be: the push text comes from text.ts; the service worker test checks it). A
button or the log inside a link (nested interactive, unselectable log). A notice type losing its link in the refactor.

## Tests

`bun run typecheck`, `check:i18n`, `check:docs`, `test:web`, `build:web`, `tests/unit` of the notification and schedule
areas, e2e `inbox-rooms`, `schedule-notifications`, `integration-templates`, `handover`.

## Result

- Done as planned. Rows that open something lost 읽음 표시 (it would be a button inside the link; message rows have none):
  opening reads them. Not chosen: keeping it beside the time (the time would not line up with the message rows').
- The title is read when the Inbox is read, never stored with the notice ("Inbox stores only generic event metadata",
  migration 207): a renamed task shows its new name on older notices, a deleted one the generic line.
- Korean puts the title first (`"{title}" 예약 작업이 끝났어요`), so no 이(가) after it.
- See docs/DECISIONS.md "알림함의 앱 알림".
