# Conversations by kind under Show more

- Date (UTC): 2026-11-10 17:42
- Branch: `feat/sidebar-rooms-by-kind`
- Status: done
- Where: trina-ax core (`web/src/components/rooms/SidebarRooms.tsx`, the five `web/src/i18n/*.ts`). Why: the rooms
  and their lists are core (see docs/REPOSITORY-RULES.md).
- Version impact: patch, the sidebar's expanded list is ordered differently; three new words, no API or data change

## Goal

The owner, on the computer sidebar's **Conversations** (대화) with many rooms: "너무 많아서 정리가 안되는데". **Show more**
(더 보기) opens every other room in one long list by latest activity, team rooms, group chats and DMs mixed. Slack splits
its sidebar into sections (channels, direct messages). Now the rest under an opened **Show more** is split by kind, so
it can be scanned, and nothing that was already on screen moves.

## Scope

In:
- Collapsed (the default): unchanged (pins ≤ 10, the five latest others, the room on screen, "Show more (N)" and its
  pill).
- Opened: the same top block in the same place (pins ≤ 10, the five latest others), computed without the room on
  screen; then every other room (hidden rooms stay out, an open hidden room shows) in three sections with a quiet
  subheading each: **Team rooms** ('all' first, then by the title the row shows, `localeCompare` in the UI's locale),
  **Group chats** and **Direct messages** (latest activity). Pins past ten go first in their own kind's section, the
  most recently pinned first, with their pin. No room twice; an empty section has no heading. The room on screen is
  not added on top while opened: it is in its section, so a clicked row never moves. "Less" stays while anything is
  below the top block.
- Three words in en, ko, es, id, ja.
- Docs: the file header, DECISIONS (a new section; notes in "Desktop sidebar: rooms first" and "Pinned conversations"),
  the user docs' pin paragraph, `changes/sidebar-rooms-by-kind.md`.

Out: /rooms and the phone's 대화 tab (time-ordered, unchanged); folding or counting the sections.

## Steps

1. `SidebarRooms.tsx`: `roomSections` (pure, exported for tests), the opened view, the "Less" check, the subheadings
   (`<li>` with an `<h3>` and its rows).
2. i18n keys in five languages; `bun run check:i18n`.
3. Unit tests (`web/test/unit/sidebar.test.tsx`, `room-pins.test.tsx`, `room-hide.test.tsx`), one e2e in
   `web/test/e2e/sidebar.spec.ts` (the top rows and a clicked DM row do not move; headings in order; "Less" stays).
4. Screenshots at 1440×900 and 1280×800, light and dark; spacing fixes.
5. Docs and the changelog fragment.

## Risks

No migration, no API change. The five app languages. Phone: the drawer has no rooms, /rooms is unchanged. Screen
readers: the subheadings are headings inside the list, the toggle's `aria-controls` still covers everything.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, web unit tests of the sidebar, pins and hidden rooms,
e2e `sidebar.spec.ts` and `room-pins.spec.ts`.

## Result

Built as planned in `SidebarRooms.tsx` (`roomSections`, the top rows as `sidebarRows(rooms, null)` while opened, "접기"
while anything is below them), three words in five languages, DECISIONS "Conversations by kind under Show more" (with
notes in "Desktop sidebar: rooms first" and "Pinned conversations"), a paragraph in the user docs' pins section and
`changes/sidebar-rooms-by-kind.md`. The headings use the 트리나 기록 date headings' look and spacing (`text-micro`, 500,
`text-faint`, 16 px above, 4 px below) on the left edge of the title and "더 보기", after the first screenshots showed
`pt-3` binding them too loosely to their rows; AA in both looks. The names are compared with `Intl.Collator` in the
app's language (the order of `localeCompare`, one collator per sort). Not changed: an open pin past ten still sits among
the pins while the list is closed (as before), so in that rare case the five latest move up one row when it opens.
