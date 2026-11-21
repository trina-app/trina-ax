# The Chats list has a built-in Projects group; two hints tell similar chats apart

- Date: 2026-11-21
- Status: accepted
- Supersedes: none (adds to [Each person sorts their own Chats list into sections](20261121-personal-sidebar-sections.md))
- Branch: feat/structure-polish-web (plan [20261121-0619-structure-polish.md](../AGENTS/plan/20261121-0619-structure-polish.md)
  C and D, #212; the owner approved it on 2026-11-21, QA TC-6309..TC-6314)

- **Ask (the IA/UX review, owner-approved 2026-11-21):** project rooms sat among the Channels, so nobody could tell a
  project from a channel; and two chats looked the same but were not (a project room's private ✦ side chat; a project
  whose people equal one department, with two rooms of the same people).
- **Rule (C, the Projects group):**
  - Built inside `RoomsByKind.tsx` and `RoomsList.tsx roomSections`: `ROOM_SECTIONS` is `['team', 'project', 'dm']`, and
    a room goes to Projects by its `projectRoom` flag (a member who cannot open the project folder has no
    `Room.project`). The phone's Conversations tab uses the same functions.
  - Order: Pinned › my sections › Channels › **Projects** › Direct messages. Inside Projects, by name with the Channels
    collator. A project room keeps its folder icon.
  - A project room I pinned or put in one of my sections shows there, not under Projects (one place: pinned › section ›
    kind). The Projects header is a drop-out target, as the Channels and Direct messages headers are.
  - The header shows while I have a listed project room anywhere, pinned or in a section too, so a room can always be
    dropped back. No "+" (projects are made on the Projects page and with Make it a project). Fold key
    `section:chats:project`.
  - Listed only after the first message, as before (`listedRoom`). A trashed project's room is hidden (the server's held
    rooms) and comes back on restore.
- **Rule (D, two hints, no banner):**
  - The empty ✦ side chat of a project room says "Only you see this. To ask where {project}'s people see it, ask on the
    project page.", the project page a link to `/projects/<id>`. Guests keep their own line.
  - A project room whose active members are exactly a department room's members (`Room.project.sameAsGroup`, told only
    to people in that room) says "Same people as #{group}. Keep {project} talk here." at the room's start and in its
    info, `#{group}` a link to that room. Nothing to dismiss.
- **Why:** people who are not developers read a list by what things are. A separate group answers "is this a project?"
  at a glance; the hints answer "who sees this?" where the question comes up.
- **Left out:** sorting choices inside Projects; a "+" on its header; a banner.
- **Tests:** web/test/unit/structure-polish.test.tsx, web/test/e2e/sidebar-sections.spec.ts.
- **Version impact:** minor (a visible change to the Chats list).
