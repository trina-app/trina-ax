# A group's room links to the group's folder, for those who can open it

- Date: 2026-11-16
- Status: accepted
- Supersedes: none
- Branch: feat/room-group-folder-button (the owner, from a teammate, QA TC-3834)

- **Ask:** in a team room that belongs to a group ("# leads", folder `groups/leads`), people want to jump to the group's
  folder, where meeting notes and the like are kept.
- **Rule:** the room header has one button, next to the room's name and member count: a folder icon and **Files**
  (ko 파일), the icon alone on a phone, with a tooltip ("Open the leads folder") and the accessible name "Files". It is a
  link to `/files?path=<the group's folder>`, pushed on the history, so Back returns to the room.
- **Who sees it:** only in a team room whose group has a folder row, and only for someone the folder rules let open that
  folder: `RuleSet.canList`, the test the Files page uses to list a folder. No new permission path. The server says it as
  the optional `Room.groupFolder` (absent otherwise), computed in `roomOut` (`rooms/store.ts groupFolderFor`), so the
  room list, one room and the `room.updated` fan-out agree; the list and a fan-out read the rules once.
- **Not for:** the everyone room, 1:1s, group chats, side chats (no group, no folder). A member outside the group is not
  in the room, so never sees it. An admin in the group sees it (admins open every folder).
- **Left out:** a rule change does not push a room update; the button follows on the next room list load. A click
  after access was just taken lands on the Files page's own "can't open" state, like any old link.
- **Tests:** `tests/unit/b-rooms-group-folder.test.ts` (member, admin, outside the group, the rules taking the group's
  access away, the other kinds, the fan-out, no folder row); web e2e `web/e2e/room-group-folder.spec.ts`.
- **Version impact:** patch (one optional API field, one button).
