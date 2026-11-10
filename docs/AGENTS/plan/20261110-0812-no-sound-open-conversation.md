# No sound for the conversation on screen in a focused window

- Date (UTC): 2026-11-10 08:12
- Branch: `fix/no-sound-open-conversation`
- Status: done
- Where: trina-ax core (`web/src/lib/attention.ts`, `web/src/lib/roomSound.ts`, `web/src/store/roomSound.ts`,
  `web/src/store/sessionMarkers.ts`, the room page and thread panel, `desktop/src/main` for the focus word, their
  tests, docs/DECISIONS.md, CHANGELOG). Why: the room sound and reading a room are the web app's (see
  docs/REPOSITORY-RULES.md).
- Version impact: patch. No API or data change.

## Goal

The owner: the Trina AX desktop app is open on a conversation, and a new message there still plays the notification
sound. In a focused window that shows the conversation, a new message should only appear, as in other chat apps: no
sound, no notification, no badge.

Cause (checked in the desktop e2e harness with Playwright's focus emulation turned off): the room sound and the
read marking go by the page's own `document.hasFocus()` (`lib/attention.ts lookingAt`). In the desktop app the team page
is one of several views in the window. After the app starts with a team (a login start, a relaunch after an update) the
window is focused and the page has no focus until the person clicks into it; the same while the in-app browser pane or
the address strip has the keyboard. The page then counts as "not looking": the chime rings for the room on screen, and
the room is not marked read (so the person's other windows and devices ring too). The session markers already use the
desktop app's word on its window's focus (`DesktopBridge.focus`); the sound and reading did not.

## Scope

In:
- `lookingAt()` follows the desktop app's window focus where the app gives it (the page's own focus elsewhere, as now).
  One place keeps that word (`lib/attention.ts`); the session markers read it from there.
- The room on screen, or the thread a panel shows for a reply in it, counts as the conversation on screen (a thread
  beside a file in the viewer opened outside its room too). A pure function says it; the sound uses it.
- The room page and the thread panel read again when the desktop window's focus comes back.
- Unit tests per row of the rule (focused + on screen, focused + another conversation, not focused or hidden; thread;
  DM), an e2e with Web Audio and Notification stubbed (a browser and a stand-in desktop bridge).

Out:
- The service worker's Web Push for a browser tab that shows the room: it is normally read before the worker checks
  (the worker shows nothing for a read notice); an unread one is shown silently. Not skipped: Safari takes a push
  subscription away after a few pushes that show nothing.
- The phone app: in the foreground it shows no banner and plays no sound (`quietForeground`), and the page does not ring
  for the room on screen: no bug there. Its silent list entry stays.
- The desktop app giving the team page its focus back when the window is focused (not needed here).

## Steps

1. e2e that reproduces it (stand-in desktop bridge: window focused, page without focus, room open: the chime plays).
2. `lib/attention.ts`: the window focus word and `conversationOnScreen`; `lookingAt` uses the word.
3. `lib/roomSound.ts` / `store/roomSound.ts`: the view carries the threads on screen; republish on window focus.
4. `store/sessionMarkers.ts` reads the word from attention; Room.tsx and ThreadPanel.tsx read again on it.
5. Unit tests, DECISIONS, CHANGELOG.

## Risks

Reading a room now happens in the desktop app while its window is focused even when the keyboard is in the in-app
browser: that is what "looking at the window" means for the session markers already. No server, migration or
permission change. No user-facing text.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, web unit tests (attention, room-sound, session-markers,
desktop-notifications, rooms-store, room-thread), `bun run build:web`, e2e: the new spec, room-sound, session-markers,
the room-* specs, inbox-rooms.

## Result

Built as planned (PR #317), plus one desktop change found in review: the app's focus word is false while the team list
covers the team page (the page still reports itself visible there). `lib/attention.ts` keeps the desktop app's window focus (`watchWindowFocus`,
read by the session markers) and the rule's two parts (`lookingAt`, `conversationOnScreen`); the room sound's view and
the tabs' localStorage word carry the threads on screen. Reproduced first in `room-sound-on-screen.spec.ts` (4 notes
before the fix, none after). Added a desktop e2e (`page-focus.spec.ts`, by hand on a Mac) for the premise. Differs from
the plan: the desktop app's own notification for the room open in a window in the back stays as before (none: the
room's messages count nothing in that window while it is open); written down in DECISIONS.
