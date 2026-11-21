# A group chat can become a team project, with its history and its files

- Date: 2026-11-21
- Status: accepted
- Supersedes: none (builds on [A team project is its own chat room](20261120-project-is-room.md))
- Branch: feat/make-project-server, feat/structure-polish-web (plan
  [20261121-0619-structure-polish.md](../AGENTS/plan/20261121-0619-structure-polish.md) A, #212; the owner approved it
  on 2026-11-21, QA TC-6290..TC-6303)

- **Ask (the IA/UX review, owner-approved 2026-11-21):** a conversation that turns into real work cannot become a
  project; people start a new project and lose the history.
- **Rule:**
  - **Where.** "Make it a project" in a conversation's "⋯" (its header, its row in the list, the phone's long-press
    sheet), for a named private channel or an unnamed group chat (`kind = 'group'`) that is not archived and not a
    project's room yet, to a member who is not a guest and who may make team projects (`mayCreateTeamProject`; in a team
    where only admins make projects a member does not see it). A 1:1 gets "New project with {name}" instead: a new team
    project of the two (`POST /api/projects` team, then `POST /api/projects/:id/room`); the DM stays as it is.
  - **One confirm, nothing else to choose.** A name field (the conversation's name; an unnamed one: the names its row
    shows), "Its N members become the project's people. Files sent here move to {name} › Chat attachments. People added
    later see messages from now on.", and the owner's added line "People added to the project later can open these
    files." A name another project has is allowed (its folder gets "-2", and the field says so); a name a new project may
    not have is refused inline, with the same words as `POST /api/projects`. "N files stay in the conversation only" when
    some do. A guest who already holds another place blocks it before anything is sent: an admin gets a link to them in
    Admin › Members & invites, a member is told to ask an admin.
  - **The write.** `GET /api/rooms/:id/make-project` (members, guests who block, files moving and staying, the folder
    name, `membersHash`), then `POST` with `{ name, membersHash }`: 404 for anyone not in it (admins and guests
    included), 409 `not_convertible`, 403 without the right, 409 `safe_ops`, 409 `members_changed` when the members are
    not the ones shown (the web says "The people changed" and reads again), 409 `guest_one_place`. The room keeps its id,
    so pins, hidden state, mute, read place, sections, threads, reactions and apps stay; each member keeps their start
    and alert level.
  - **After.** The room stays open as the project's room (the project's folder button in the header), with one event
    line `project_made` ("{person} made this conversation the project {name}."). While the files move, the header's
    member line ends with "Moving files…" (`Room.filesMoving`). When the move ends, `project_files_moved` says "N files
    moved to {name} › Chat attachments.", plus "M stayed in this conversation." only when M > 0.
  - **Which files move.** Only files on messages every current member sees now (the room's own rule, thread roots
    included), not a private preview, not already a team file, not quarantined or download-only, and never a copy of a
    team file (`teamCopy`, an answer's attached copy). Everything else stays in room storage, labelled "Only in this
    conversation" in its chip and in the Files list; a project room keeps its Files list while it holds such files
    (`Room.roomFiles`), after the folder button. The move renames, never hard-links, and is crash-safe (the plan's table).
- **Why:** the history is the work; a new project would lose it. Moving the files makes the project the one place for
  them (the model of #168). The added line says plainly that later project people can open them.
- **Left out:** attaching a conversation to an existing project; converting a 1:1 in place; a success banner (a short
  toast and the event line say it).
- **Rollback limits (admin notes):** an older build ignores `room_file_moves` and `room_files.origin`; moved files show
  "unavailable" in the room there (no room bytes) but stay in the project's Chat attachments and open in Files; a move
  left in progress resumes after the upgrade. Older builds show both new event lines as "Something in this conversation
  changed".
- **Tests:** tests/unit/b-make-project.test.ts, tests/unit/b-room-file-moves.test.ts, tests/security/lib/rooms-cases.ts,
  web/test/unit/structure-polish.test.tsx, web/test/e2e/make-project.spec.ts.
- **Version impact:** minor (a migration readable by older builds, one endpoint pair, new optional fields, a visible
  menu item and dialog).
