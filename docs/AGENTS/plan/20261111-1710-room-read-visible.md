# Rooms: read only what was shown; a reply from a search result lands at the newest

- Date (UTC): 2026-11-11 17:10
- Branch: `fix/room-read-visible`
- Status: done
- Where: web (pages/Room.tsx, lib/rooms.ts). Why: two room bugs from QA TC-155 (see docs/REPOSITORY-RULES.md)
- Version impact: patch — a bug fix in the web app, no API or data change

## Goal

1. Opening a room never marks read messages the person was not shown: not while the first page is still loading (only
   live messages on screen), and not when there are more unread messages than one page (the older unread ones are not
   loaded). The read goes up to the newest message that came into sight.
2. A reply sent from a window around an older message (a search result, ?m=) ends at the newest messages with the
   reply in sight, instead of mid-list with the "최근 메시지로" control gone.

## Scope

In: the timeline's read in pages/Room.tsx (a pure `readUpTo` in lib/rooms.ts); the jump to the bottom after a send or
"최근 메시지로" from a window, and dropping ?m= then. Unit tests, an e2e spec (1440 and 390).
Out: opening a room at its first unread with a divider (needs the server's "around" by seq); the notification's "Mark
as read" (unchanged: it calls the read directly, QA TC-053).

## Steps

1. lib/rooms.ts `readUpTo`: 0 while loading/failed/a window; 0 when unread messages are older than the loaded pages;
   else the newest message in sight.
2. Room.tsx tryRead uses it (message elements against the list's box); runs again when a page arrives.
3. Room.tsx: a send or "최근 메시지로" from a window remembers to land at the newest; when the newest page has replaced
   the window, stick, jump to the bottom and drop ?m=.
4. Tests: web unit (rooms-lib), e2e spec on the mock (backlog > 50, slow first page, reply from search) at 1440/390.

## Risks

A room whose unread run starts exactly at a page edge behind a thread-only reply's seq waits to be read until the reader
scrolls up (conservative). Phones and desktop share the code. No migration, no i18n change.

## Result

Done on `fix/room-read-visible`. Web unit (rooms-lib, rooms-store) and `web/test/e2e/room-read-visible.spec.ts` (1440 and
390; all 6 fail on dev before the fix). On a local server with the QA TC-155 scripts: 62 unread → nothing read until
the older page is loaded and seen; 30 unread with a 2.5 s first page → nothing read before the page; a reply from a
search result → in view at the bottom, ?m= gone. Known limit: the seq-gap-at-a-page-edge wait in Risks.
