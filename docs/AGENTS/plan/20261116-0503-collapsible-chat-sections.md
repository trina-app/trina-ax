# Fold every section and folder of the Chats list, on a phone too, remembered on every device

- Date (UTC): 2026-11-16 05:03
- Branch: `feat/collapsible-chat-sections`
- Status: done
- Where: web (`web/src/components/list/List.tsx`, `panels/folds.ts`, `panels/RoomsByKind.tsx`, `pages/Rooms.tsx`),
  shared (`UserPrefs`), server (PATCH /api/me already merges prefs). Why: the list pieces and the person's preferences are core.
- Version impact: minor, a new preference on the account and a visible change on the phone's Chats tab

## Goal

The owner (2026-11-16, phone 390 px): on the phone's Chats tab the sections (Team rooms, Group chats, Direct messages,
Pinned) and the person's own folders cannot be folded, though people make folders to fold them. A folded section or
folder must say what waits inside (unread, a mention) and stay folded the next time, on every device.

## What Slack does (checked 2026-11-16 in the test workspace, web app)

- The ▸ beside a section's name folds it. Folded, read conversations go; **only the conversation that is open stays**
  under the header. Unread conversations do **not** stay as rows (the "Unread conversations only" filter is a separate,
  per-section "Show and sort" option, not the default).
- A folded section with unread conversations: its name turns **bold** and a **badge with a count** sits at the header's
  right end. Read and folded: a plain header, no number.

## States

| State | Header | Rows under it |
| --- | --- | --- |
| Open | ▾ name (as today) | all its rooms |
| Folded, nothing unread | ▸ name, the faint room count as today (desktop) | none, except the room open on screen (desktop) |
| Folded, unread (no mention) | ▸ **name in ink, bold**, a pill with how many of its rooms have unread messages | the same |
| Folded, a mention among them | ▸ **name bold**, the pill shows "@" (the rows' own mark for a mention) | the same |

Muted rooms are left out of the pill, as the Chats tab count leaves them. The pill is the folder pill that exists today
(`RoomFolderPillView`), now on every section header of the Chats list (Pinned, the folders' section, each folder,
Team rooms, Group chats, Direct messages), on the phone list and the desktop panel alike.

## Steps

1. `ListSection` (shared list piece) takes `pill` (shown while folded), `unread` (bold name while folded), `keep`
   (rows still drawn while folded: the open room) and `foldId` (a fold key of its own, so a folder's phone section and
   its desktop group share one). Keyboard: the header is a `<button aria-expanded aria-controls>`; the pill's words are
   in the button's name for screen readers.
2. Desktop panel (`RoomsByKind`): every section and the folders' section pass the pill; a folded section keeps the room
   on screen, as a folded folder does today.
3. Phone (`pages/Rooms.tsx`): the headings become `ListSection`s with the same fold keys as the desktop panel
   (`section:chats:<kind>`, `room-folder:<id>`), so folding on one shows folded on the other.
4. Where the folds are kept: `UserPrefs.listFolds` on the account (`PATCH /api/me`, merged with the other preferences;
   JSON in `users.prefs`, so **no migration**). At most 200 keys, each `open` or `folded`. This browser keeps a copy
   (as today) so a server without the field or a failed save still remembers here. The first time a person with folds
   only in this browser opens the app, they are sent up once. Other open windows see the change on their next load.
   All lists that fold (Trina, Projects, Files, Activity) use the same store, so they are kept on the account too.
5. Six languages for any new string; tests; docs decision `docs/decisions/20261116-collapsible-chat-sections.md`.

## Decisions

- `docs/decisions/20261116-collapsible-chat-sections.md`: folds live on the account; folded sections follow Slack's
  default (only the open room stays), with our own pill (count of unread rooms, "@" for a mention) in the rows' colour,
  not Slack's red.

## Risks

- `UserPrefs` is parsed whole: a bad stored `listFolds` must not wipe the other preferences (`.catch(undefined)`).
- Shared component change (`ListSection`): every panel uses it; full web e2e before merge.
- Phone header looks: the phone's list-head tokens stay; the ▸ adds 24 px before the name.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`; web unit (pill counts per section, the folds store:
account first, browser copy, the one-time send-up); server unit (PATCH /api/me keeps `listFolds`, refuses a bad one,
keeps the other prefs); e2e at 390 and 1440 (fold, reload keeps it, the other width sees it, a message arriving in a
folded section lights the pill, a mention shows "@"); full web e2e.

## Result

Merged to dev in batch #1102 (3ac2496a3); QA TC-3770..3782 Pass.
