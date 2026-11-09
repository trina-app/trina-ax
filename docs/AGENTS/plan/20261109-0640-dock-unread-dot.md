# A dot on the Mac Dock icon when rooms have unread messages that the number does not count

- Date (UTC): 2026-11-09 06:40
- Branch: `fix/dock-unread-dot`
- Status: in progress
- Where: trina-ax core (`web/src/lib/sessionMarkers.ts`, `web/src/store/sessionMarkers.ts`, `desktop/src/`,
  `shared/src/desktop-bridge.ts`). Why: the one count and the desktop shell are core (see docs/REPOSITORY-RULES.md)
- Version impact: patch. A dot on the Dock where there was nothing; no API, setting or data change.

## Goal

On the Mac desktop app the sidebar shows unread messages on a team room (a red "2" on #leads), but the Dock icon shows
nothing. Discord and Slack show a plain red dot for unread messages that are not for you.

The Dock number is the one count n (lib/sessionMarkers.ts `attentionCount`): AI chats that need me and rooms that want
me (`roomWantsMe`: by default a DM or group chat message, an @mention, a reply in a thread I follow). A plain new message
in a team room at its default level (mentions only) is unread in the sidebar but not in n, so the Dock stays empty.

## Scope

In:
- n stays as it is. `attentionCount` also says whether a room I did not set to 끄기 (own level off, or my default
  "nothing") and did not hide has unread messages that n does not count.
- When n is 0 and such a room exists, the Mac Dock shows a dot "•"; when everything is read, it clears.
- The bridge: `setBadgeCount(n, dot?)`. The main process checks it (a whole number, or the dot only at 0) and shows the
  dot with `app.dock.setBadge('•')`. Older desktop apps ignore the flag (nothing at 0, as before).
- The installed web app (Badging API) follows: `navigator.setAppBadge()` with no number is the browser's dot.

Out: the tab title and the phone ☰ dot keep their rules; the 대화 tab's count is unchanged; Windows (no Dock) unchanged;
no new setting.

## Steps

1. `attentionCount` returns `unread` (n unchanged); unit tests.
2. `store/sessionMarkers.ts`: the dock gets the dot flag at n 0; the web badge shows the dot.
3. `shared/src/desktop-bridge.ts`, `desktop/src/preload/app.ts`, `desktop/src/common/notify.ts` (`dockBadgeOf`),
   `desktop/src/main/main.ts`.
4. Desktop unit tests (`tests/unit/e-notify.test.ts`), web unit tests.
5. CHANGELOG, DECISIONS.

## Risks

- The page only sends a number and a flag; the main process accepts a whole number or the dot, nothing else.
- `app.setBadgeCount(0)` writes the same Dock label as `dock.setBadge`, so the team switch's clear still clears the dot.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `tests/unit/e-*.test.ts`, `bun run test:web`,
`bun run build:web`.

## Result

Filled in at the end.
