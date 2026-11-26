# One Activity follow-ups: quiet replies don't count, the chip stays on Back, leftovers

- Date (UTC): 2026-11-26 08:35
- Branch: `fix/one-activity-followups` (stacked on #635 `feat/one-activity` until that merges)
- Status: done
- Where: trina-ax `server/` (rooms, notifications, a B migration), `web/`, `shared/`, `docs/site/`. Why: the
  Inbox count and Activity are component B's and the web app's (see docs/REPOSITORY-RULES.md)
- Version impact: patch. The Activity count stops counting replies the person silenced, the chip no longer jumps back
  on Back, and the docs are updated. There is no API change. The migration only adds a column.

## Goal

These are the review notes on #635 (docs/decisions/20261126-one-activity.md), applied after it.

1. **Quiet thread replies don't count.** With "Replies in threads I'm part of" off, a reply that doesn't mention me is
   recorded as a quiet notice (`server/src/rooms/service.ts` `silentReply`). Since #635, 활동 counts every notice,
   so these raised the count the person had turned off.
   - They stay listed in 활동's 스레드.
   - They no longer count in `unreadCount`, in `roomUnreadCount` (via `COUNTED_SQL`), or in the rail's and the
     나 tab's number.
2. **The chip jumps back.** `ActivityPanel.tsx` applied `?tab=` again on every change of the address, so Back to
   `/activity?tab=mentions` put 멘션 back after the person had picked another chip.
   - A chip click now writes the address while on `/activity` (replace, no new entry).
   - The address is read only when it changes.
3. **Leftovers.** Remove the unused `rooms`/`notices` counts in `web/src/store/inbox.ts`, and the stale
   멘션·스레드 comments in `server/src/notifications/service.ts`, `shared/src/api/notifications.ts` and
   `shared/src/api/attention.ts`.
4. **A stale e2e.** `web/test/e2e/file-share-links.spec.ts:282` waits for a `dialog-confirm` that the Share
   dialog no longer shows. It fails on dev too.
   - The test now checks the current behaviour: the "Remove those links too" box shows, already ticked, and the save
     honours it.
5. **Docs screenshots.** Retake `chats/rooms-list` and `chats/rooms-phone` (`bun run docs:reshoot --only chats`)
   without the removed row, and fix their alt text in all six locales.

## Steps

1. Add migration `457_b_room_notice_silent.sql`: `room_notices.silent` (0/1). It is 457 because the B numbers
   455 and 456 are taken by open PRs #586, #631 and #634.
2. `NotificationService.roomNotice` takes `silent`. `rooms/service.ts` passes it for `silentReply`.
   `rooms/inbox.ts` `COUNTED_SQL` leaves silent notices out.
3. Server unit test (`tests/unit/`): with thread replies off, a followed reply is listed but not counted. With them
   on, it counts.
4. `ActivityPanel.tsx`: the chip and the address, with a unit test and the e2e (pick 멘션, pick 스레드, Back).
5. Leftovers (3) and the e2e fix (4).
6. Docs reshoot (5), and the alt text in en, ko, ja, zh, es and id.
7. `changes/one-activity-followups.md`. There is no decision file: this follows the #635 decision ("listed, not
   counted" is `COUNTED_SQL`'s documented use).

## Risks

- **Migration number:** 457, checked against dev and the open PRs. It is additive (`ALTER TABLE … ADD COLUMN`
  with a default), so older readers are fine.
- **Older notices:** a quiet notice recorded before this change (`quiet=1`, `silent=0`) still counts until it is
  read. A quiet-hours notice must still count, and the two can't be told apart.
- **Desktop and phone counts:** both read `unreadCount`, so this is one rule for both.

## Tests

`bun run typecheck`, `bun run check:prepush`, the web unit suite, the server unit tests for rooms and
notifications, and the e2e for activity-panel and file-share-links.

## Result

Built as planned:
- **Silenced replies.** Migration `457_b_room_notice_silent.sql`. `roomNotice(…, silent)` keeps runs of silent notices
  apart from counted ones. `COUNTED_SQL` leaves them out.
  - Test: `tests/unit/b-rooms-notify.test.ts`. A silenced reply is listed and counts 0; a mention in a reply counts 1.
- **The chip.** A chip click writes `?tab=` (a replace), and Back/Forward (POP) never puts an older chip back.
  - Unit test: `activity-panel-one`.
  - e2e: `activity-panel`, which picks 트리나 after a 스레드 link, opens a notice and goes Back.
- **Leftovers.**
  - `store/inbox.ts` keeps only `unread`.
  - `markAllNoticesRead` lost its `only` argument (no caller used it).
  - The 멘션·스레드 comments are rewritten.
- **The stale e2e.** `file-share-links.spec.ts:282` now checks that removing a person asks no confirm, and that the
  box is ticked and honoured.
- **Screenshots.**
  - `bun run docs:reshoot --only chats/rooms-` retook `chats/rooms-list` and `chats/rooms-phone`, in en and zh.
  - The Acme scene has no group chat any more: its Launch email is a private channel. So the alt text in all six
    languages now says what the shot shows.
