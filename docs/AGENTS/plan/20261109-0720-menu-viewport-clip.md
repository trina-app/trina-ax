# Menus stay inside the window: a sidebar row's notification menu no longer runs off the left

- Date (UTC): 2026-11-09 07:20
- Branch: `fix/menu-viewport-clip`
- Status: done
- Where: trina-ax core (`web/src/components/rooms/MenuButton.tsx`). Why: the shared "…" menu is core web UI (see
  docs/REPOSITORY-RULES.md)
- Version impact: patch. A layout fix; no API, data or text change.

## Goal

The owner (English UI) opened a sidebar room row's "…" › Notification settings. The menu ("Notify me about": "Default
(from settings) · All messages", "All messages", "Mentions only", "Off") opened under the row with its right edge at the
"…", so it ran off the window's left edge and the first words of each item were cut ("…ult (from settings)"). Since
PR #221 the shared menu is as wide as its longest item; with the English words that is wider than the room left of a
sidebar row's "…". The sidebar's list also scrolls, so it cut anything outside its own box.

## Scope

In:
- `MenuButton` on a computer (768 px and wider): the menu is fixed to the window and placed by measuring it, under the
  button with right edges in line; above it where it would run off the bottom; moved in to stay 8 px clear of each
  side. Wider than the window: capped to it, the words wrap. Taller: capped, it scrolls. It follows the button when
  something scrolls or the window changes size, and closes once the button is scrolled out of its list's sight.
- Every menu built on it: the sidebar's room and chat rows, a room's header (the bell and "⋯"), the conversations page's
  rows, the project cards' "…", the message hover bar's "⋮", a room member's "…".
- A unit test of the placement rule and e2e tests in English at 1440 and 900 px.

Out:
- Phones (below 768 px): the bottom sheet, unchanged.
- Menus with their own code (Files rows, admin rows, the account menu, the recents filter): fixed widths, not part of
  the bug.

## Steps

1. `menuSpot` (pure): where the menu goes for a button's box, the menu's size and the window's.
2. `MenuButton`: `position: fixed` on a computer, placed in a layout effect (before it is drawn), again on scroll and
   resize; `open` becomes a plain on/off (the up/down guess from the item count goes).
3. Tests, screenshots (1440 light, English), a CHANGELOG line and a DECISIONS entry.

## Risks

- A parent with a transform holds fixed boxes: the menu is measured at 0,0 first, so its place is still right.
- The menu stays in the DOM where it was (tests scope it to its card or row; clicks inside it are not "outside").
- Overlap: a sidebar menu may now sit over the main column's edge (z-30, as before).

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run test:web`, `bun run build:web`; e2e: the
room, sidebar and menu specs (room-*, sidebar, project-list-menu, project-page, phone-nav, inbox-rooms, chat, files).

## Result

Built as planned in `MenuButton.tsx` (`menuSpot` and `fit`). Two additions: the menu has no transition (with reduced
motion index.css gives every property a short one, which held it at 0,0 in the screenshot run), and it closes when its
button is scrolled out of its list's sight (review: a fixed menu would otherwise follow a row over the sidebar's
header). Not done: following a layout shift without a scroll or resize (a banner appearing). PR: not opened yet (the
GitHub account was unavailable); branch `fix/menu-viewport-clip`.
