# A team project is its own chat room

- Date: 2026-11-20
- Status: accepted
- Supersedes: [A private channel linked to a team project](20261119-channel-project-link.md), except its
  `linkedProjectPlain` no-card rule, kept as written
- Branch: feat/project-room-server (plan: docs/AGENTS/plan/20261120-1136-project-is-room.md, PR #158; the owner approved
  it on 2026-11-20). This file covers the server (PR 1 of 4); the files, AI, web and Files-list steps add to it.

- **Ask (the owner, 2026-11-20):** the "private channel linked to a project" of 0.5.21 is too hard to understand: two
  member lists, a Link step, Save to project and "N more people can see it". A team project should be its own chat
  room, as in a Basecamp project.
- **Rule:**
  - **Data.** No new room kind (`rooms.kind` has a CHECK and older clients parse the enum). A project room is a named
    `group` room with a `room_project_links` row of `mode = 'room'` (migration 430). The table stays one-to-one both
    ways. `history_floor_seq` is where a later member sees the room from. `room_file_refs` (created here, filled by the
    files step) holds a room file kept in the team folder.
  - **Made lazily.** `POST /api/projects/:id/room` gets or makes the room in one immediate write; the unique index on
    `project_id` settles a race. Only a team project in `projects/<name>` has one (409 `project_not_linkable`). Anyone
    who cannot read the project, the owner and admins outside it included, gets the missing project's 404. Its making
    is audited as `project.room` `{ via: 'created' }`.
  - **Members are derived, never chosen.** `Rooms.sync()` makes `room_members` equal to the project's readers: every
    active account whose folder rules give at least read on `projects/<name>`, guests by their person rules, nobody
    while the project is in the trash. The owner and admins outside the project are not members. No group size cap.
    A pass works on the project rooms near the folders whose access changed (`afterAccessChange`), on all of them at
    start and on the minute tick, and on a project's room after its restore. A gone account leaves on every pass. A
    member added or removed by hand (an older build) is put back. Audited as `room.members` `{ via: 'project' }` with
    the project as target and the room by its kind only.
  - **The people are managed on the project.** Add people, Remove, Rename and Leave in a project room are 403
    `project_room`; leaving is `POST /api/projects/:id/leave`. `Room.canRename` is false and `managerId` null there.
  - **Name.** `rooms.name` is the project's name, written on creation and on every project rename, so an older build
    shows it too.
  - **History.** `historyRoom(db, room)` replaces `historyKinds(kind)`: a team room, the everyone room and a project
    room. A later member sees from the room's floor (0 for a room made as a project room). A start that is set stays
    when a member is checked again.
  - **Trash and delete.** While the project is in the trash its room is held: members, mutes, read positions and alert
    levels are kept; the sync leaves it alone; it is hidden from the lists, the inbox, search and the AI, and refused
    like a missing room. Restored, its people are put right again. Deleted for good, the room is archived in its own
    write before the project row goes (`project.room` `{ via: 'archived' }`), never left as a plain channel.
  - **Guests.** A guest who reads the project is a member. A project room is never a guest's one group chat: the guest
    checks (`claimGuestRoom`, `inSlotEvenIfOff`, `placePeopleOf`) leave out rooms with a `mode = 'room'` link, and the
    sync never claims one.
  - **Read-only members** are members and post messages; a file from the computer into a project room is 403
    `shared_upload_read_only` (the project's shared chat rule), in one request and in an upload session.
  - **Alerts.** A project room's default level is like a channel's (`mentions`), since people are put in it in bulk.
  - **API.** `Room.project` gains `room: true`. `Project.room?: { id, unread }` for someone who reads the project.
    `Room.canLinkProject`, `Project.channel` and `Project.canLinkChannel` stay in the schema for older servers but are
    never sent.
  - **Retired (one release).** `PUT/DELETE /api/rooms/:id/project`, `POST /api/projects/:id/channel` and
    `POST /api/rooms/:id/save-undo` answer 410 `gone` before any check, naming nothing. No `project_linked` or
    `project_unlinked` line is written any more; old ones still render.
  - **0.5.21 links (`mode = 'linked'`), settled at start** after the gone accounts left: the room an active private
    channel, the project active in `projects/<name>`, and the members exactly the readers → it becomes the project's
    room (each member keeps their start, the floor is the room's seq then, it takes the project's name, one
    `project_room` event line by the system). Anything else → the link row is deleted and the channel stays as it is.
    Audited as `project.room` `{ via: 'converted' | 'unlinked' }`, naming the room by its kind only.
  - **Kept:** the `linkedProjectPlain` no-card rule of the room's ✦ side chat (`chat/turn.ts`) and its save place in
    the project folder (`chat/side-room.ts`), now for a project room.
- **Why:** one list of people and one place for files, as Basecamp does; links that confuse people go.
- **Left out (this step):** project-room files into Chat attachments, the AI reading the project's room, the web
  buttons, the in-room Files list (the next three steps); several rooms per project; project activity in the room.
- **Tests:** tests/unit/b-project-room.test.ts, b-project-room-migrate.test.ts, b-project-room-history.test.ts,
  b-rooms-project-link.test.ts, b-rooms-project-link-live.test.ts, b-linked-project-no-card.test.ts, b-side-chat.test.ts,
  b-rooms-save-to-team.test.ts, tests/security/lib/rooms-cases.ts.
- **Version impact:** minor (one additive migration, a new endpoint and optional fields, four endpoints retired with 410).
