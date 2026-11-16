# A "Files" button in a group's room opens the group's folder

- Date (UTC): 2026-11-16 06:15
- Branch: `feat/room-group-folder-button`
- Status: in progress
- Where: Team AX core (`server/src/rooms/`, `shared/src/api/rooms.ts`, `web/src/pages/Room.tsx`). Why: rooms and files are core (see docs/REPOSITORY-RULES.md)
- Version impact: patch, one button and one optional API field

## Goal

A team room belongs to a group (e.g. "# leads"), and the group has a folder (`groups/leads`) where its meeting notes and
other files live. People in the room want to get there in one click (owner, 2026-11-16, from a teammate; QA TC-3834).

## Scope

In: one button in the room header next to the title and member count: a folder icon and "Files" (icon only on a phone,
with a tooltip and an accessible name). It opens `/files?path=<group folder>`; Back returns to the room. Shown only in a
team room whose group has a folder, and only to someone the folder rules let open that folder.
Out: everything else in the header; a button for the everyone room, 1:1s, group chats or side chats; a new permission.

## Steps

1. `Room.groupFolder` (optional): the server sets it in `roomOut` for a team room whose group has a folder row and
   whose folder the viewer can open (`RuleSet.canList`, the same test the Files page uses). The list loads the rules once.
2. The header button (shared `buttonClass` + `Tooltip`), en first, then ko, es, id, ja, zh.
3. Unit test for the field (member, admin, member outside the group, other kinds), a targeted e2e, docs, a changes/
   fragment and a decision file.

## Decisions

`docs/decisions/20261116-room-group-folder-button.md`.

## Risks

A rule change does not push a room update: the button shows or hides on the next room list load. Opening it when the
access was just taken away lands on the Files page's own "can't open" state, as any old link does.

## Tests

`bun run typecheck`, `check:i18n`, `check:docs`, `features:check`, `docs:api`, the rooms unit tests under Bun 1.3.12,
a targeted web e2e for the button, its target and the no-button cases.

## Result

(filled in at the end)
