# A team project is its own chat room

- Date (UTC): 2026-11-20 11:36
- Branch: `plan/project-is-room` (build branches: `feat/project-room-server`, `feat/project-room-web`,
  `feat/project-room-migrate`, `feat/room-files-list`)
- Status: draft, revision 2 after an independent review (the owner set the direction on 2026-11-20)
- Where: Team AX core (`server/src/rooms/`, `server/src/chat/`, `server/src/uploads/`, `shared/src/api/`,
  `web/src/pages/Room.tsx`, `web/src/pages/Projects.tsx`, `web/src/components/rooms/*`, the six `web/src/i18n/*.ts`,
  `docs/site`). Why: rooms, projects, files and permissions are core.
- Version impact: **minor** (0.x: one additive migration, new optional API fields and one endpoint, visible UI change;
  three endpoints from #69 retired with a 410 answer for one release, said in the admin notes).

## Goal

The owner said on 2026-11-20 that the "private channel linked to a project" from 2026-11-19
([decision](../../decisions/20261119-channel-project-link.md), #69, shipped in 0.5.21) is too hard to understand. It has
two member lists, a Link step, a Save to project button and cards that say "N more people can see it".

After this change **a team project is its own chat room**, as in a Basecamp project:

- **One list of people.** The project's people are the room's members. Adding someone to the project adds them to the
  room, and removing someone from the project removes them from the room. Nobody is asked about it.
- **One place for files.** A file sent in the room goes straight into the project's `Chat attachments` folder, the same
  folder the project's shared AI chat already uses. It shows on the Files page. The room keeps no copy of its own.
- **The project's AI can read the project's room.** Both have the same people, so no share card is needed.
- **Buttons both ways.** The project page, its sidebar row and its AI chats get a **Chat room** button. The room's
  header gets the project's button, which opens the project page (its folder and AI chats).
- **Channels and DMs stay as they are.** They also get an in-room **Files** list, and ⌘K shows recent room files
  before anything is typed.

## What is removed (lean UI: said plainly)

| Removed | Where today (origin/dev) |
| --- | --- |
| Link to a project / Unlink (channel info row, pickers, confirms) | `web/src/components/rooms/ProjectLink.tsx` (whole file), `MembersDialog.tsx:27,49-50` |
| Project page "Channel" box: Create a channel, Link a channel, "Ask someone in the channel to add you" | `web/src/pages/Projects.tsx:1105-1108`, `ProjectChannelBox` `:1156-1180` |
| Create-a-channel people pre-tick and member checkboxes for a project | `web/src/components/rooms/PeoplePicker.tsx` `forProject` `:91-99,133,165,195,211-213` |
| One-click **Save to project**, its toast with the outside count, **Undo** | `RoomMessages.tsx:314-335,360-362`, `FileMenu.tsx:54-58`, `store/roomSaves.ts:84-130`, `lib/roomSave.ts:65-80`, `rooms/save-to-team.ts:231-246,310-359` |
| "N people outside this channel can open it" hints and the wider-audience card **in a project room** | `rooms.save.savedProject*` keys; the card does not fire when the audiences are equal (D6) |
| Endpoints `PUT/DELETE /api/rooms/:id/project`, `POST /api/projects/:id/channel`, `POST /api/rooms/:id/save-undo` | `server/src/routes/rooms.ts:75-79`: 410 `gone` for one release, then deleted |
| Add people, Remove, Leave and Rename **inside a project room** | They become **Manage people** (the project's members dialog) and **Leave project** |

Kept: the `project_linked` / `project_unlinked` event lines still render in old messages but are no longer written.
`Save to team folder…` (the sheet) stays for old room-stored files and for plain rooms.

## Scope

In: the project room (made, members derived, named after the project), project-room files in the project folder, AI read
access both ways, buttons both ways, migration of the linked channels from 0.5.21, the in-room Files list for every room,
recent room files in ⌘K, and the docs, tests and QA rows.

Out: several rooms per project; project activity posted into the room; a room for a personal project or for an older
team project outside `projects/` (it keeps none); moving old room-stored files into the project by themselves.

## Decisions

### D1. Data model: keep `room_project_links`; a project room is a named `group` room whose members are derived

Evidence:

- `rooms.kind` has a SQL CHECK: `'team','all','dm','group'` (`server/migrations/240_b_team_rooms.sql:18`). SQLite cannot
  change a CHECK without rebuilding the table.
- `shared/src/api/rooms.ts:85` `RoomKind = z.enum([...])`: a client with that enum, or a cached web bundle, would fail to
  parse a new kind.

So **no new kind**. A project room is a named `group` room (an older build shows it as a private channel) with an
active `room_project_links` row. That table is already one-to-one both ways: room id is the key, and
`room_project_links_project` is a unique index.

Migration **428** (B; 427 is the highest B on dev, and 600/701/702 belong to other components; check again at build time):

```sql
-- min_compatible_reader: 1
ALTER TABLE room_project_links ADD COLUMN mode TEXT NOT NULL DEFAULT 'pending' CHECK (mode IN ('pending', 'room'));
-- 'room': members follow the project; 'pending': a channel linked in 0.5.21 whose people differ (D7)
ALTER TABLE room_project_links ADD COLUMN pending_since TEXT;   -- D7: a pending link is kept separate after 14 days
-- a room file stored in the team folder (D3): where it is and how to follow it, like a chat's team reference
CREATE TABLE room_file_refs (
  room_file_id TEXT PRIMARY KEY REFERENCES room_files(id) ON DELETE CASCADE,
  path TEXT NOT NULL, inode TEXT, sha256 TEXT, trash_id TEXT, events_seen INTEGER NOT NULL DEFAULT 0
);
```

`team_file_refs` (migration 310) cannot be reused as is: each row is tied to one AI chat (`chat_id NOT NULL`,
`310_c_team_file_refs.sql:8`), and its viewer check goes through that chat (`uploads/team-refs.ts:280,311`; review
finding 1). PR 2 moves the "follow moves, renames and the trash" part of `TeamRefs` into a helper both use. A room
file's viewer check is "a member of the room now **and** reads the path now".

- **When the room is made: lazily.** It is made the first time someone opens **Chat room** for a project
  (`POST /api/projects/:id/room`). That call is get-or-create under the unique index and answers with the `Room`. A
  project nobody talks in has no room, and nobody's sidebar fills up with empty rooms. Making it inside project creation
  was rejected in #69's review: the project and the room cannot be one transaction.
- **Who is in it** is never stored as a choice. The project-room step of `Rooms.sync()` (`rooms/service.ts:1278`, the
  same want/have diff the team rooms use for their groups at `:1317-1320`) makes `room_members` equal to the project's
  readers for every `mode='room'` link:
  - **Truth:** the folder rules on `projects/<name>` (`folder_rules`). The readers are worked out with
    `Audiences.of(p)` (`chat/shared.ts:82`): every active person whose `RuleSet.access` on the folder is at least
    `read`, and nobody while the project is in the trash.
  - **When it runs:** after every access change (`afterAccessChange` already calls `syncRoomsNow`,
    `admin/folders.ts:571`), after `saveParticipants` (`chat/project-access.ts:527`), after `leaveProject`
    (`chat/project-leave.ts:54`), and on restore.
  - **Cost:** the readers are worked out in code (`activePrincipals` × `RuleSet.access`), not in one SQL query, and
    guests must be kept, so the team rooms' SQL (`service.ts:1317`, which drops guests) is not reused. Each pass works
    out readers only for the project rooms whose folder is at, under or above a changed path (`changedPaths`), plus a
    full pass at start. That is one rules load per pass and one access check per person per affected project.
  - **Trash:** `Audiences.of` is `[]` while the project is in the trash (`chat/shared.ts:91`). **The sync skips a trashed
    project's room** (members, mutes, read positions and alert levels are kept), and the room is hidden and refused by
    the access check (`mine()` answers 404 while the link's project is trashed). On restore the sync runs again.
  - **Delete for good:** `deleteProjectForGood` archives the room in its own transaction **before** the project row
    goes, because `room_project_links` cascades on the project (`427:11`). Otherwise the room would become a plain
    channel that keeps all its members.
  - **An older build or a hand edit** that added or removed a member is put back by the next pass (audited
    `room.members` with `via: 'project'`).
- **Groups and departments** are groups in Trina (`groups`/`group_members`). A project shared with a group, with
  "everyone" or with a role gets every such person. They are added and removed as the group changes, like a team room.
- **No 100-person cap.** `ROOM_GROUP_MAX` is for hand-picked group chats. A project room follows the project, as a team
  room follows its group. The live passes are already bounded to the changed people.
- **Read-only project people are members and can post messages.** Sending a file writes into the project folder, so they
  cannot attach. The composer's attach button says "You can view this project but not add files". The server refuses with
  the existing 403 `shared_upload_read_only` (`uploads/shared-chat.ts:65-75`), the same rule as the project's shared
  chat.
- **Guests.** A guest who reads the project through a person rule (their project, `guests.project_id`,
  `claimGuestProject`) is a member: the room is part of the place they were invited to. Their access stays person rules
  only (`policy/access.ts:405-414`).
  - The guest checks count group rooms: `claimGuestRoom` refuses a guest who is already in another live `group` room
    (`auth/guests.ts:274`), and `inSlotEvenIfOff` and `placePeopleOf` count them too (`:101,132`). A project room is a
    `group` room, so **these three queries leave out rooms with an active `mode='room'` link**, and the project-room
    sync never calls `claimGuestRoom`.
  - A guest who has both a group chat and this project keeps both (review finding 2; tested).
- **Owners and admins outside the project are not members.** Inside `projects/<name>` they are judged as ordinary
  members (`access.ts:41-46,417-425`). They can still manage the project's people, as today.
- **Name.** The room's `rooms.name` is the project's name. It is written on create and on every project rename
  (`PATCH /api/projects/:id`), so an older build also shows the right name. The room cannot be renamed by itself.
- **API.** `Room.project` stays and gains `room: true` for a project room. `Project.room?: { id, unread }` is set for
  anyone who reads the project (it replaces `Project.channel` and `canLinkChannel`). Both are built per viewer as today.

### D2. History: a later member sees the whole history; someone removed loses it at once

- People who join later **see the whole history**, as in a Slack channel and in a team room. `historyKinds(kind)`
  (`rooms/history.ts:37`) becomes `historyRoom(db, room)`, which is true for `team`, `all` and a `mode='room'` project
  room, so the existing walk opens the history (`history_from_seq = 0`). Every caller changes, each with a test:
  - `service.ts:122` (`mine()`, opens history on read);
  - `history.ts:78` and `:181` (the walk, and when a read room counts as "another room");
  - `post-to-room.ts:471` (the "people who join later see it" wording);
  - `answer-share.ts:370` (opens history before deciding a share).
- **Only for people added after the room became a project room.** A converted 0.5.21 channel (D7) keeps each current
  member's start: at conversion `history_from_seq` is set to their `visible_from_seq`, so nobody suddenly sees messages
  from before they joined (review finding 4).
  - Why: the project's people already read every file the room talks about. A new teammate needs the background.
  - The add itself says so: the members dialog's preview line reads "They'll see the project's files and its chat
    room's history".
- Someone removed (from the project, from its group, by leaving, or with a disabled account) is dropped from the room by
  the sync. They also lose its notices and replay buffer (`forgetMember`; `realtime.forgetReplay`; `room.updated
  removed`), and they lose the files through the folder rules. Nothing is left behind that they can open.

### D3. Files: a project-room file is a project file

- **Where it goes.** A file sent in a `mode='room'` room is placed in `<project folder>/<Chat attachments>`. It uses the
  shared chat's place and checks: `sharedUploadPlace` (`uploads/shared-chat.ts:46-77`), `placeUpload` with
  `'rename'`, "(2)" names, instruction file names taken (`team-files/place.ts:228-239`), and write access needed. The
  message's `room_files` row gets a `room_file_refs` row (D1). That row follows moves, renames and the trash, and is
  checked with today's rules on every show. The room keeps no bytes in `.system/rooms`.
- **"Files you sent"** (`/api/room-files/mine`, `shared/src/api/rooms.ts:938`) promises that deleting a file there
  deletes its message and frees room storage. Project-room files are therefore left out of that list. They are project
  files, managed in Files (review finding 9).
- **Size.** The room's limits stay: 50 MB in one request, up to 1 GB through an upload session, and 100 MB for a guest.
  The session writes into the team folder (`uploads/sessions.ts` gets a team target). The storage check is the team's
  `assertStorageRoom`.
- **Who may open it.** Being a room member and the file's folder rules. Both are checked; they normally agree. A
  `Chat attachments` subfolder that someone narrowed shows the file as "unavailable" to the people it excludes, as a
  team reference does today.
- **Deleting a message keeps the file in the project.** The confirm says: "The file stays in this project's Chat
  attachments." Deleting the file (in Files, or with the file's own menu in the room) moves it to the team trash. The
  message then shows "File deleted", and restoring it from the trash brings the chip back (team-refs follow the trash
  id). Why one rule: the file is a project file the moment it is sent. Others or the AI may already use it, it is
  restorable, and a message delete that silently removes a shared file surprises people more than a file that stays.
- **Quota.** It counts under "Team files", not under the rooms line (`system/storage.ts:353-364`). Old room-stored
  files stay on the rooms line.
- **Team export ZIP** (`system/team-export-zip.ts`). The files are already in `files/projects/...` (`:150`). The room's
  text file names them by their team path instead of copying them again into "<name> - files" (`:212-221`). Old
  room-stored files are copied as today.
- **`_FILES.md`, Files page and Recent.** These already include `Chat attachments` (`file-list/units.ts:54-63`,
  `team-files/find.ts:106`), which the owner wants. The upload's file event carries `{ attachment, roomId }`, so the
  file's history line reads "Sent in the chat room".

### D4. AI

- **The project's shared AI chat reads its own room.** `tools.ts:239` stops `roomReadTools` in a shared chat. A shared
  chat of a project with an active `mode='room'` room gets `room_read` and `room_file`, **scoped to that one room id**
  (`reader.ts myRooms` filtered to it). The `rooms` list tool is not given, and other rooms are never named. Rules:
  - The reader also requires that the asking person is a member now (they are, because the audiences are equal; this is
    checked anyway).
  - **What it reads is what every current audience member sees.** `room_read` normally reads as the asking person
    (`rooms/reader.ts:108-117`). The answer, though, goes to the whole shared chat. Some members may have a later start
    (`visible_from_seq`) or an old hidden answer. So in a shared chat the reader returns only messages visible to
    **every** current member of the chat's audience: the latest start of all of them, and no answer hidden from anyone.
    It says when it cut something ("Earlier messages are left out because not everyone here can see them"). Review
    finding 5; a security case.
  - Because of that cut, reading it does not mark the chat as "read a room", and no card follows. A guest's message in
    the room is read like any member's. Guests do not see shared AI chats (`Audiences.ofChat`, `shared.ts:99`), so
    nothing reaches them this way.
  - `post_to_room` keeps its card: posting is an action on the person's behalf, not a read.
  - The prompt names the room as "this project's chat room".
- **The room's ✦ side chat** is the person's own chat (`side-room.ts:1-20`), so every member already sees the project
  folder. The save place stays the project folder (`savePlaceFor`). The `linkedProjectPlain` no-card rule
  (`turn.ts:3161-3200`) stays as written. In a project room the wider-audience card does not fire, because the readers
  are the members.
- The Send-to-room check (`answer-share.ts`, [20261120-send-to-room-who-can-see](../../decisions/20261120-send-to-room-who-can-see.md))
  is unchanged. A source read from the project folder never counts in its own room.

### D5. Buttons both ways

- **Project → room.** The project page header gets **Chat room** with an unread count, in place of the Channel box. The
  sidebar's project row gets a small chat icon with an unread dot. The project's AI chat header gets **Chat room**. Each
  calls `POST /api/projects/:id/room` the first time, then opens `/rooms/<id>`.
- **Room → project.** A project room's header has **one** button: the existing Files button's place
  (`Room.tsx:589-601`) becomes **📁 {project}**, which opens the project page with its folder (Chat attachments
  included) and AI chats. A project room gets no separate Files button, because its files are the project's.
  - The room's info shows "This is the chat room of the project {name}. Its people are the project's people.", with
    **Manage people** (the project's members dialog, `ProjectMembersDialog.tsx`, for those who may edit), **Mute** and
    **Leave project**. Mute is the quiet way out; leaving the project is the full one.
- **Read-only members:** the attach button is disabled with "You can't add files to this project" (or "…to its Chat
  attachments folder" when only that folder is narrowed).
- **Where the room is listed.** In Channels, with a folder icon in place of the lock, after its first message. Until
  then it is reached from the project. (Open question 1.)
- Words (en is the source, then the other five): Chat room, Open chat room, Manage people, Leave project, "The project's
  people are this room's members." ko 채팅방, 채팅방 열기, 사람 관리, 프로젝트 나가기.

### D6. Notifications, phone, desktop, search, ⌘K, unread

- **Default alert level: like a channel** (`roomLevel`, `shared/src/api/room-alerts.ts:50`: `mentions` for `team`/`all`).
  Project rooms are added to it, because people are added in bulk without choosing the room. Each person can change it
  as today. Push goes through the same `roomNotice` and `room_push_deliveries`.
- **Unread** is the room's `unreadCount` (`store.ts:482`), also shown on the project row and the Chat room button.
- **Phone and desktop** wrap the web app (`mobile/README.md`, `desktop/README.md`), so nothing native changes. The phone
  at 390: the header shows a folder icon and a files icon; the project page's Chat room is a full-width row.
- **Search.** Room message search is unchanged (`rooms/search.ts`). Project-room files are team files, so file search
  and ⌘K find them as team files. `searchRoomFiles` (`:286`) also returns them through `room_file_refs`, readable rows only.
- **⌘K before typing** (`web/src/components/SearchDialog.tsx`) shows up to 5 recent room files from the person's
  rooms (D8), with the same per-row checks as the search.

### D7. Migration of the channels linked in 0.5.21

Every existing link row starts as `mode='pending'`. Rooms do not change by themselves, because either direction
discloses something:

- adding project readers to the channel shows them its private history;
- removing channel-only people takes their room away.

1. **Same people: converted automatically.** On start (a one-time pass in `Rooms.sync()`), a pending link whose room
   members are exactly the project's readers becomes `mode='room'`, with one event line: "This channel is now the
   project's chat room".
2. **Different people: frozen as a linked private channel**, with no member sync, until someone who may edit the
   project's people decides. They see one card, at the top of the channel if they are in it, and on the project page
   otherwise:

   > "This channel and the project {name} have different people."
   > **Make it the project's room** · **Keep separate** · *Who changes?*

   *Who changes?* opens the details:
   - "2 people here aren't in the project: they leave the room unless you add them to the project" (**Add them to the
     project** opens the members dialog with them filled in and the usual preview);
   - "3 project people aren't here: they join and see this channel's messages";
   - guests are listed on their own line with the result for each. A guest whose one place is this channel and who is
     not in the project would be switched off (`runAccessHooks`, `admin/folders.ts:576`). A guest who already has
     another project cannot be added (409 `guest_one_place`). The card says so, and **Make it the project's room** is
     refused until each such guest is added or removed by hand (review finding 7).

   The actions:
   - **Make it the project's room:** becomes `mode='room'`, and the sync runs. Current members keep their start (D2).
     The project people who join see the history; the details said so.
   - **Keep separate:** the link is deleted and the channel becomes a plain private channel. The project gets a fresh
     room the first time someone opens Chat room.
   - **Nobody decides within 14 days** (`pending_since`): the link is kept separate by itself, with one event line. This
     is the choice that discloses nothing and takes nothing away (review finding 6).

   While a link is pending, **Chat room** on the project page opens the channel for its members. Project people outside
   it see "This project's chat room is being set up. Ask {an editor's name} to finish it." The plain answer is not a
   409 from the unique index.
3. **Old room files** stay in `.system/rooms`, readable as today and still counted on the rooms line. Their menu keeps
   **Save to team folder…**. There is no bulk copy.
4. Audit: `project.room` with `{ via: 'auto' | 'decided' | 'kept_separate' }`, naming the room by its kind only, as
   #69's audit rows do.

### D8. In-room Files list (every room)

For plain channels, DMs and group DMs only (a project room's files are its project's). `GET /api/rooms/:id/files`
returns the room's files, newest first and paged, each row checked as on read: still a member, and can see the message.
The header's **Files** opens a side panel with name, sender, date and size, and clicking a row opens the preview.

⌘K before typing uses a separate `GET /api/room-files/recent`, because `RoomSearchQuery` requires `q`
(`shared/src/api/rooms.ts:689`). Guests get both endpoints on `auth/guest-endpoints.ts`, limited to their one room.

## Steps (PRs, in order; each batched with the day's reviewed PRs per the batch rule)

1. **Server: project room** (~900 lines + tests). Migration 428; `rooms/project-room.ts` (get-or-create, the derived
   members step in `sync()`, `historyRoom`, name follows rename); `POST /api/projects/:id/room`; `Room.project.room`,
   `Project.room`; lifecycle (trash: members kept, room refused; restore; delete for good: archived before the cascade); the guest checks leave project rooms out; the three #69
   endpoints answer 410; read-only can't attach; guest membership.
2. **Server: files and AI** (~600 lines + tests). Project-room uploads into Chat attachments (one request and session),
   `room_file_refs` and the shared reference helper, "Files you sent" without them, message delete keeps the file, "File deleted" state, export ZIP naming, the scoped room tools (only what every audience member sees) in the
   project's shared chat, the prompt line.
3. **Server + web: migration of linked channels** (~400 lines). The auto pass, the pending card and its two actions,
   audit.
4. **Web: the project room** (~800 lines). Buttons both ways, room info, Manage people and Leave project, the composer
   note, the removals in the table above, Channels listing with the folder icon, 390 and dark, six languages.
5. **Web + server: Files list and ⌘K recent** (~500 lines). `GET /api/rooms/:id/files`, `?recent=1`, panel and ⌘K
   section.
6. **Docs.** The decision `docs/decisions/<date>-project-is-room.md` (supersedes 20261119-channel-project-link, and keeps
   its `linkedProjectPlain` rule), `changes/project-is-room.md`, `docs/site/use/chats-and-projects.md` "A channel for a
   project" rewritten as "A project's chat room" in six languages, the generated API page (`docs:api`). Written with PR 4.

Size: about 3,600 lines with tests (PR 2 grows by the shared reference helper), 5 PRs plus docs, about 4 builder days.

**PRs 1 to 4 go to dev in one batch, one queue run.** Every dev merge installs on qa.trina.app, and a release can be cut
from dev in between. PR 1 alone would answer 410 to the 0.5.21 link UI and make rooms that UI cannot explain (review
finding 11). PR 5 can go separately.

## Risks

- **Disclosure through history** (D2, D7): a person added to a project now sees the room's past. This is said in the
  members preview. Pending channels never open history without a person's decision.
- **Permissions drift between room and folder:** both checks run on every file read (D3). The sync runs on the same
  hooks as the folder-button live pass (`groupFoldersChanged`), so a removed person loses the room in the same request.
- **Large projects:** a project shared with "everyone" makes a big room. The fanout is like the everyone room's. The
  sync cost is bounded to the changed projects (D1).
- **Rollback:** reader 1. In an older build:
  - project rooms show as linked private channels with their link UI, the 100-person limit and the old guest checks;
  - a member added or removed there by hand is put back by the next upgrade;
  - files sent after the upgrade (no `.system/rooms` bytes) show "unavailable" there but stay in the project folder;
  - the export ZIP must skip a `room_files` row without bytes (`team-export-zip.ts:212`), which PR 2 tests against the
    old export code path.

  These limits go in the release's admin notes.
- **Migration number:** 428 now. Check dev and open PRs again before PR 1 (`check:prepush`).
- **Six languages, phone 390, light and dark** on every changed screen.

## Tests

- Checks: `bun run typecheck`, `check:i18n`, `check:docs`, `check:prepush`, `docs:api`; server tests under Bun 1.3.12.
- **Unit** (`tests/unit/`):
  - `b-project-room.test.ts`: get-or-create idempotent under a race; members equal readers after add, remove, a group
    change, an everyone rule, a read-only rule, leave, a disabled account, trash, restore and delete; guest of this
    project in, guest of a group chat not; admin outside not; no 100 cap; name follows rename; history open for a later
    member; removal drops notices and replay.
  - `b-project-room-files.test.ts`: upload lands in Chat attachments with "(2)" names; read-only 403; guest 100 MB;
    session upload over 50 MB; message delete keeps the file; trash shows deleted and restore brings it back; a narrowed
    subfolder shows unavailable; quota line; export names the team path.
  - `b-project-room-ai.test.ts`: the shared chat reads only its own room; no `rooms` tool; another room id refused as
    missing; only messages every audience member sees (a member with a later start, an old hidden answer); no card after
    reading; `post_to_room` still asks; a chat of another project gets nothing.
  - `b-project-room-migrate.test.ts`: equal people → auto, and each member keeps their start (no older messages
    appear); different people → pending and frozen (no sync); each action and who may take it (also from the project
    page); guest lines and the refusal; 14 days → kept separate; audit shape with no room id.
  - `b-project-room.test.ts` also covers: a trashed project keeps members, mutes and read positions and is refused while
    trashed; delete for good archives the room before the cascade; a guest with a group chat and this project keeps
    both; a hand-added member is put back; only changed projects are recomputed.
  - Every `historyRoom` caller (D2).
  - `b-rooms-files-list.test.ts`.
  - Update `b-rooms-project-link*`, `b-side-chat`, `b-rooms-save-to-team` for the removals.
- **Security** (`tests/security/lib/rooms-cases.ts`, matrix rows):
  - `POST /api/projects/:id/room` for a guest of another place, a non-member, an admin outside and a reader;
  - `GET /api/rooms/:id/files` and `?recent=1` for a former member, a member when the folder is narrowed, and a guest;
  - the shared chat's room tool for another room;
  - the pending card's actions for a channel member who is not in the project, and for an admin outside;
  - the retired endpoints answer 410 without naming anything.
- **Web unit:** the header buttons, room info and the pending card; the old event lines still render.
- **Web e2e** `web/test/e2e/project-room.spec.ts`:
  - open Chat room from the project, post a file, see it in Files and back;
  - add a person on the project, who sees the room and its history live; remove them, and the room goes;
  - read-only cannot attach;
  - the pending card in both actions;
  - 1440 and 390, light and dark.
- **AI scenario** `ROOM-PRJ-01`: in the project's AI chat, "what did we decide in the chat room yesterday?" reads only that
  room, with no card.

### QA rows to add (QA tab, English, one case per row)

| Case | Expected |
| --- | --- |
| Open Chat room from a project with no room yet | Room is made, named after the project, all project people in it |
| Open Chat room from the project's AI chat header | Same room opens |
| Room header project button | Opens the project page (folder and AI chats) |
| Send a PDF in the project room | Lands in Chat attachments; shows on Files; chip opens it |
| Read-only project member tries to attach | Attach disabled with the note; can still post text |
| Add a person to the project while the room is open | They appear in the room and see its history |
| Remove a person from the project | The room leaves their list without reload; the file links stop working for them |
| Project shared with a whole group, then a member joins the group | They are in the room |
| Guest invited to the project | In the room; cannot open other rooms |
| Admin outside the project | Not in the room; can still manage people |
| Delete a message with a file | Message gone; file stays in Chat attachments |
| Trash the file in Files | The room shows "File deleted"; restore brings it back |
| Project AI chat: "summarise the chat room" | Reads only this room, no card |
| Rename the project | Room name follows |
| Trash, then restore the project | The room hides, then comes back |
| Linked channel from 0.5.21 with the same people | Became the project room with one line |
| Linked channel with different people | Card for a project editor; both actions work; others see nothing |
| Files list in a plain channel and a DM | Lists the room's files; preview opens |
| ⌘K before typing | Recent room files listed |
| Project room at 390, light and dark | Header icons fit; Chat room row; nothing cut off |

## Open questions for the owner

1. **Where is a project room listed?** Recommended: in Channels with a folder icon, after its first message (one place to
   see unread). The other choice is only under the project in the sidebar.
2. **Message delete vs file.** Recommended: deleting the message keeps the file in the project; delete the file in
   Files. The other choice: deleting your own message also trashes the file you sent, if nobody changed it.
3. **Linked channels with different people** (D7). Recommended: a one-time card for a project editor in that channel.
   The other choice is to unlink them all, so they become plain channels and each project starts a new room.

## Review (2026-11-20, an independent reviewer, fresh context)

There were 14 findings and all of them changed the plan:

1. `team_file_refs` is tied to a chat, so a new `room_file_refs` table (D1).
2. Guest group-room checks leave project rooms out (D1).
3. Trash keeps members, and delete-for-good archives first (D1).
4. A converted channel keeps each member's start (D2).
5. The shared chat reads only what every audience member sees (D4).
6. Pending links can be resolved from the project page and are kept separate after 14 days (D7).
7. Guests on the pending card (D7).
8. The sync cost is bounded to changed projects (D1).
9. "Files you sent" leaves project files out (D3).
10. Every `historyKinds` caller is listed (D2).
11. PRs 1 to 4 go in one batch (Steps).
12. Rollback limits go in the admin notes (Risks).
13. A separate `recent` endpoint, and guest endpoints (D8).
14. Leaner UI: one header button in a project room, a one-line pending card, Mute beside Leave project, exact attach
    wording (D5, D7).

## Result

Filled in at the end.
