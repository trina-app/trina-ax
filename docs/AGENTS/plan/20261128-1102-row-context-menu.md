# A right-click on a list row opens its "···" menu, everywhere

- Date (UTC): 2026-11-28 11:02
- Branch: `feat/row-context-menu`
- Status: in progress
- Where: web (web/src/components/rooms/MenuButton.tsx and the rows that use it). Why: the owner asked for the "···"
  items on a right-click in the Projects panel ("여기서 오른쪽 클릭 하면, 더보기에 나오는 것들이 나오면 좋을듯"); one
  shared way for every row, not code per row.
- Version impact: patch. A behaviour fix on existing menus; no new API, setting or data.

## Goal

A right-click on any list row with a "···" opens exactly that menu (same items, same order, from the one list in
components/menus/entityMenu.tsx) at the pointer, kept inside the window. A long press with a finger does the same, and
Shift+F10 or the menu key opens it from the keyboard on the focused row. Text boxes and rows without a menu keep the
browser's own menu; in the desktop app the app's native menu does not open as well.

## Scope

In:
- `useRowMenu` (rooms/MenuButton.tsx) becomes the one row context-menu hook: right-click at the pointer, long press at
  the finger, Shift+F10 / ContextMenu key by the row's "···"; never in an input, textarea or contenteditable, nor over a
  picture or file chip with its own menu (`data-own-menu`); Shift+right-click keeps the browser's menu as before. It
  hands the menu one bundle (`open`: openSignal, openRequest, at, rowBack) that MenuButton and RoomMenu take.
- MenuButton: `rowBack`: a menu a row opened gives the keyboard back to that row (its link) on Esc or a pick.
- Rows: the Projects panel's project rows (ListRow rowMenu) and its project chat rows (new: the history row's "···",
  useChatMenuItems), the Trina history rows (ChatItem), the project page's chat rows (ListRow), the Projects page's
  cards, the Chats panel's room and DM rows (RoomsList), the Rooms page rows, the Files page's file and folder rows,
  the personal section headers (SectionMenu, in Chats and in the Trina history) and the Trina history header's "···".
- A guard test: every row menu (a MenuButton or RoomMenu with a row's `sheetTitle`) takes the hook's bundle, with a
  short list of named exceptions; and unit tests of the hook's behaviour.

Out:
- Activity rows: they have no "···" (the chips' "···" is a filter).
- Menus that are not a list row's: a message's menu (its own long press), title menus, the search dialog's result
  popup (a combobox with its own keys), picture and file chips (components/FileMenu.tsx, already at the pointer).
- Rows with a dropdown of their own, not MenuButton: Admin › Members and Groups (pages/admin/RowMenu.tsx), the skills
  list (AvailableSkills.tsx), a room's member list. A follow-up can move them onto MenuButton and the hook.
- A phone's file row: its long press selects the row (pages/Files.tsx pressSelect) and stays so; its "···" is always
  shown there.

## Steps

1. Plan (this commit) and changes/row-context-menu.md.
2. The hook and MenuButton's `rowBack`; ListRow, RoomMenu, SectionMenu, ListSection (`headProps`) take the bundle.
3. Wire the rows above; Files rows move from their own handlers onto the hook.
4. Unit tests (hook behaviour, guard) and e2e at 1440 (project chat row, history row, file row) and a 390 long press.
5. typecheck, check:prepush, check:i18n, web unit tests, the touched e2e under Bun 1.3.12; PR into dev.

## Decisions

None new; follows docs/decisions/20261126-shared-menus.md (one list, one order) and docs/DECISIONS.md "A right-click
menu on pictures and files" (at the pointer, Shift keeps the browser's, the desktop app's menu stays away).

## Risks

- A long press that opens a menu must not also follow the row's link or toggle a section (the click after it is
  swallowed, never one inside the menu).
- Electron: the native menu is skipped only because the page cancels the contextmenu event; every path that opens our
  menu calls preventDefault.
- No server, migration or locale change.

## Tests

`bun run typecheck`, `bun run check:prepush`, `bun run check:i18n`, web unit tests (list-pieces, nav-menus,
shared-menus-guard, the new row-context-menu test), e2e row-context-menu.spec.ts.

## Result

(filled in at the end)
