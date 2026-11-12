# Phones: 멘션·스레드 finds its rows past the first page; its dot and the 대화 count agree

- Date (UTC): 2026-11-12 02:27
- Branch: `fix/phone-mentions-threads-paging`
- Status: in progress
- Where: this repo, `web/` and `server/` + `shared/` (`GET /api/notifications`). Why: follow-up of #530 (QA TC-256),
  core UI.
- Version impact: patch: fixes to #530's view and counts; one more optional query value.

## Goal

Review findings on #530:
1. 멘션·스레드 (`/activity?in=chats`) filtered the first 30 Inbox rows on the client. A person with 30+ newer notices of
   the app's own (an admin) tapped the lit row and read "아직 멘션이나 스레드 답글이 없어요" above "더 보기".
2. A mention made before the room was muted still counted in `roomUnreadCount` (the dot), while the 대화 badge skips
   muted rooms: counted nowhere, the dot lit.
3. Settings › 알림's way to Activity showed the whole count (check that it stays out of a phone's way).

## Scope

In:
- `GET /api/notifications?only=rooms`: conversation rows only, paged as today, for the person asking (same auth). The
  view from 대화 asks for that.
- Activity: never says "nothing here" while more pages exist; with a tab or "unread" that shows nothing loaded, it reads
  the next pages by itself (up to 10 pages), else it shows only "더 보기".
- `roomUnreadCount` leaves out rooms I muted (as the 대화 badge does); `unreadCount` stays whole, so such a mention
  counts once, on 나. Muting or unmuting a room with a counted row tells my windows to read the count again.
- Settings › 알림: the link with the count stays hidden on phones (asserted); computers keep the whole count.

Out: the four tabs (TC-255).

## Steps

1. Plan (this file).
2. Server + shared + mock: `only=rooms`, muted rooms out of `roomUnreadCount`, the signal on mute; server tests.
3. Activity: `only=rooms` from 대화; reads pages while empty; no empty text while a cursor is left.
4. Phone e2e: 35 app notices + 1 mention (from 대화, and 나's 멘션 tab); Settings › 알림 on a phone.

## Risks

No migration. The query value is optional; an older client never sends it. Desktop Activity unchanged except that a
filtered tab no longer says "nothing here" while older pages exist.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run build:web`, `bun run test:web`, the
notifications server tests, the new phone e2e in Chromium and WebKit, and phone-chats-tab / inbox-rooms /
activity-tabs again.

## Result

(filled in at the end)
