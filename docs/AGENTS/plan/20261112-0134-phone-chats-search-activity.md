# Phones: search and mentions/threads on the 대화 tab, each unread counted once

- Date (UTC): 2026-11-12 01:34
- Branch: `feat/phone-chats-search-activity`
- Status: in progress
- Where: this repo, `web/` (+ one field of `GET /api/notifications` in `server/` and `shared/`). Why: the phone's tabs,
  search and Inbox are core UI (docs/REPOSITORY-RULES.md: 휴대폰 is core).
- Version impact: minor: a new phone entry point and one new optional field in an API response.

## Goal

QA TC-256 (phone, P2): on the 대화 tab there is no search (only 트리나 ☰ › 검색), mentions and thread replies live only in
나 › 활동, and the same unread mention or thread reply makes a badge on 대화 and on 나 (and a third count on 나's 활동 row).
On a phone: search from the 대화 tab, reach mentions and thread replies from it, and count each unread item once across
the tab badges. Computers stay as they are.

## Scope

In (below 768 px only):
- 대화's top bar: a 🔍 next to ⊕. It opens the one search (SearchDialog) on a new phone-only type "대화": rooms and people
  by name and room messages (with no text: my rooms). The other types stay in its type sheet.
- 대화's list: a "멘션·스레드" row on top (a dot while something there is unread, no second number). It opens Activity
  scoped to conversations (`/activity?in=chats`: 전체 · 멘션 · 스레드, rows of rooms only, title "멘션·스레드"); lib/screens.ts
  makes that address a page of the 대화 tab (parent `/rooms`), so ‹ and the phone's Back go to the 대화 list, and opened
  from outside it gets the list put under it.
- Activity stays in 나 as it is (the whole Inbox: the app's own notices too, which have no other place on a phone).
- Counts: `GET /api/notifications` also says `roomUnreadCount`, the part of `unreadCount` that is conversation rows
  (mentions, thread replies), which the 대화 tab counts already. The 나 tab and 나's 활동 row show only the rest (the
  app's own notices). The computer's sidebar keeps the whole count.

Out: the four tabs themselves (TC-255, an owner decision); the room header and viewer bar (TC-257); search's desktop
type chips; the push badge on the app icon.

## Steps

1. Plan (this file).
2. Server + shared + mock: `roomUnreadCount` in the list answer; a server unit test.
3. store/inbox.ts: the room part kept; hooks for the 나 count and the conversation dot. BottomTabs and the 나 list's 활동 row
   use the 나 count.
4. lib/screens.ts + lib/tabs.ts: `/activity?in=chats` under `/rooms` in the 대화 tab, its name; PhoneTopBar title and 🔍.
5. Rooms.tsx: the "멘션·스레드" row (phones). Activity.tsx: the `in=chats` scope.
6. SearchDialog.tsx: the phone-only "대화" type and opening on it (store/ui.ts `setSearchOpen(true, 'rooms')`).
7. i18n (5 locales), changes/phone-chats-search-activity.md.
8. Phone e2e (Chromium and WebKit) mirroring TC-256's Steps/Expected; 1440 unchanged.

## Risks

- No migration. The new response field is optional, so an older answer still parses (no count is taken off then).
- lib/screens.ts is touched by #468 (Admin parents) two lines below; kept out of its hunk.
- Back: the scoped Activity is a pushed page of the 대화 stack (#457 model); search keeps its overlay entry (#452).
- Five languages; phone only (`max-md`, `useMediaQuery`), computers unchanged.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run build:web`, `bun run test:web`, the
notifications server unit tests, and the new phone e2e in Chromium and WebKit on its own port.

## Result

(filled in at the end)
