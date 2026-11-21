# Create a channel can make a project at once: one tick, the "New project with" path

- Date: 2026-11-21
- Status: accepted
- Supersedes: none
- Branch: feat/create-channel-as-project (the owner, 2026-11-22 KST; agreed with the project-rooms session)

- **Ask:** the owner: in "Create a channel" (채널 만들기), a checkbox so that creating it makes a shared project right
  away, instead of "create a channel, then ⋯ › Make it a project"
  ([20261121-make-project-from-room.md](20261121-make-project-from-room.md)).
- **Rule:**
  - One row under the channel name: a checkbox **Make it a project** (프로젝트로 만들기) with the muted line **Shared
    folder and Trina for these people** (파일 폴더와 트리나를 이 사람들과 같이 써요). Off by default. Shown only to whoever
    may make team projects (`mayMakeTeamProject`: the owner and admins, members when the team lets them), never in a
    free-roam demo, never in New message or Add people.
  - Ticked, the primary button reads **Create project** (프로젝트 만들기). Create makes the project the way "New project
    with {name}" does: `POST /api/projects` (scope team, the people picked as participants; a group picked is its
    people now, as for a channel), then `POST /api/projects/:id/room?listed=1`, and the person lands in that room, which
    is listed under Projects before its first message (`Room.listed`). If the room cannot be opened, the project page
    opens; it never tries again (a second project). No channel is made and converted.
  - The name follows the project rules while ticked: a reserved name (an AI instructions file's or the file list's)
    is refused under the field, and a name whose `projects/<name>` folder a team project the person sees already has
    gets the make-project hint "A project called {name} already exists; this one will be {name}-2 in Files"
    (`rooms.makeProject.nameTaken`), stepped as the server steps folders. Unticked, none of this shows (a channel's name
    may be anything).
  - Guests follow the project rules while ticked: a guest whose project place is free may be picked; one in another
    project is greyed out with where they are ("In the 'X' project", Make team member for admins) and unticked if they
    were picked. Unticked, the private-channel rule stands: no guest.
- **Why:** one step for the common case (a few people who want a shared folder and Trina) without a second way to make
  projects. Reusing the "New project with" path keeps one server path for a new team project and its room, so the
  project's checks (who may make one, participants, a guest's one project) stay where they are.
- **Left out:** a server name check for a project that has no room yet: the hint is worked out from the team projects
  the person sees, as New project does. A folder of a project they cannot see may still step the name to "-2" unsaid,
  as the make-project read keeps it unsaid.
- **Tests:** web/test/unit/room-picker.test.tsx (who sees the row, what Create sends, the hint, guests, the folder step);
  web/test/e2e/channel-as-project.spec.ts at 1440 light and 390 dark (off makes a channel; on makes a project and lands
  in its listed room with the same people; a taken name; guests).
- **Version impact:** minor (a new option in an existing dialog; no API change).
