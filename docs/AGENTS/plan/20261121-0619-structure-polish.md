# Structure polish: make a conversation a project, department rooms use the department folder, a Projects group, two hints

- Date (UTC): 2026-11-21 06:19
- Branch: `plan/structure-polish` (build branches: `feat/make-project-server`, `feat/group-room-folder-files`,
  `feat/structure-polish-web`)
- Status: ready to build, revision 2 (one independent review, 12 findings, all applied: see "Review")
- Where: Team AX core (`server/src/rooms/`, `server/src/routes/rooms.ts`, `server/src/chat/project-access.ts`,
  `server/src/auth/guests.ts`, `shared/src/api/rooms.ts`, `web/src/components/rooms/*`,
  `web/src/components/panels/RoomsByKind.tsx`, `web/src/components/nav/{RoomsList,SidebarSections}.tsx`, the six
  `web/src/i18n/*.ts`, `docs/site`). Why: rooms, projects, files and permissions are core.
- Version impact of this PR: **none** (a plan only). Of the build: **minor** (one additive migration, one endpoint, new
  optional API fields, visible UI changes).

## Goal

"A project is its chat room" is on dev (batches #182, #188, #190, #192;
[decision](../../decisions/20261120-project-is-room.md)). The IA/UX review found four gaps that make the structure
hard to follow for people who are not developers:

1. A conversation that turns into real work cannot become a project. People start a new project and lose the history.
2. A department's room keeps its own files, apart from the department's folder, so there are two places for the same
   team's files.
3. Project rooms sit among the Channels, so a person cannot tell a project from a channel at a glance.
4. Two chats look the same and are not: a project room's ✦ side chat is private, and a project whose people equal one
   department has two rooms with the same people.

The owner approved the direction and three decisions on 2026-11-21:

1. When a conversation becomes a project, its old files move into the project's Chat attachments.
2. Admins outside a department can see that department's room uploads in its folder. This is accepted and said in the
   release notes.
3. The conversation list gets a separate, built-in "Projects" group.

## Scope

In: A, B, C and D below; their tests, QA rows, docs pages, decision files and `changes/*.md`.

Out:

- Attaching a conversation to an **existing** project (v1 makes a new project only).
- Moving the old room-stored files of department rooms into the department folder. Only new uploads go there.
- The Everyone room and the welcome steps' team group. They stay exactly as they are.
- Converting a 1:1 DM in place. A 1:1 gets "New project with {name}", which makes a new project and a new room.
- Sorting choices inside the Projects group.

## A. "Make it a project" (프로젝트로 만들기)

### What people see

- **Where:** the conversation's ⋯ menu (the header ⋯, the row ⋯ in the list and the phone's long-press sheet). It is
  shown for named private channels and unnamed group chats (`kind = 'group'`, not archived, not already a project room)
  to a member who is not a guest and who may make team projects (`mayCreateTeamProject`). In a team where only admins
  make projects, a member does not see it.
- **The confirm** (one dialog, nothing else to choose):
  - Title: **Make it a project**.
  - A name field, prefilled with the conversation's name (an unnamed group chat: the names its row shows), editable,
    required. The room is renamed to it.
  - Body: "Its N members become the project's people. Files sent here move to {name} › Chat attachments. People added
    later see messages from now on." Then the added line (owner question 1): "People added to the project later can
    open these files." (N counts active members. `{name}` follows the field as people type.)
  - The name is checked as a new project's name is: empty, too long, or an instruction file's name are refused inline. A
    name that another project already has is allowed. Its folder gets "-2", and the field says "A project called
    {name} already exists; this one will be {name}-2 in Files."
  - If some old files will not move (see "Which files move"), one more line: "N files stay in the conversation only,
    because not everyone here can see them."
  - Button: **Make project** (프로젝트 만들기). Cancel.
- **After:** the dialog closes and the room stays open. Its header now has the 📁 {project} button. One event line:
  "{person} made this conversation the project {name}." While the move runs, the header shows a quiet "Moving files…"
  line. A file keeps its chip and opens the whole time, from its staging place if needed (below).
- **When the move ends:** a second event line by the system: "N files moved to {name} › Chat attachments. M stayed in
  this conversation." The second sentence is shown only when M > 0.
  - Each file that stayed carries a small label, "Only in this conversation", in its chip and in the Files list.
  - A project room keeps its **Files** list while it has any room-stored files. The list shows only those files, and
    the 📁 button stays first. The `GET /api/rooms/:id/files` 404 for project rooms is narrowed to "no room-stored
    files".
- **Older builds** show `project_made` and the closing line as the existing "unknown event" line. The web reads the
  project's name through the server's name step, as `project_room` does (`web/src/lib/rooms.ts:84`).
- **A 1:1 DM:** the ⋯ menu offers **New project with {name}** instead. The same dialog has a name field prefilled with
  `{name}`, the body "You and {name} become the project's people. It gets its own chat room." and the button **Make
  project**. It makes a new team project with the two people and opens its room. The DM stays as it is, and nothing
  moves.
- **Guests in the conversation:**
  - A guest who holds no project takes this one as their project, as a person rule on a new project does today
    (`claimGuestProject`).
  - If a guest already holds another project, the confirm button is disabled before anything is sent. It shows "Make
    {guest} a team member first." Admins also get a link to that person in Admin › People. Members get "Ask an admin to
    make {guest} a team member first." The server refuses the same case with 409 `guest_one_place` (`reason`,
    `guestId`), in case the page was out of date.

### Server: `POST /api/rooms/:id/make-project`

A new path, so nothing collides with the retired `PUT/DELETE /api/rooms/:id/project` (410). The body is
`{ name, membersHash }`. `membersHash` is the hash of the member ids that the confirm showed, given by a new read
`GET /api/rooms/:id/make-project` (`{ members, guestsBlocked[], filesMoving, filesStaying, membersHash }`). The answer
is the new `Project` and the updated `Room`.

Checks, in this order, each a test:

1. The caller is an active member of the room now and not a guest. Otherwise the answer is 404, for an outsider, an
   admin outside the room and a guest alike.
2. The room is `group`, not archived, and has no `room_project_links` row of either mode. Otherwise 409
   `not_convertible`. A DM, a team room and the everyone room get the same 409. This check runs before the folder is
   made, and **again inside the write**: two people converting at once get one project and one 409, never a 500 from
   the link's key. The loser's folder is unmade.
3. `assertMayCreateTeamProject`.
4. Safe operations are off (the project's upload place refuses with 409 `safe_ops` otherwise).
5. Inside the write: the active member ids hash to `membersHash`. Otherwise 409 `members_changed`, and the web reloads
   the confirm. Someone added between the confirm and the click is never made a project person without being shown.

Steps (the same order as `POST /api/projects` team, `routes/chats.ts:1012-1033`):

1. `captureState` (as `routes/chats.ts:1018`), then `makeProjectFolder` (outside the write: it touches the disk). On any
   later failure, `unmakeProjectFolder`.
2. One immediate write:
   - Check 2 again. Remove the members whose accounts are disabled or deleted (the sync's gone-account step,
     `service.ts:1309-1321`, for this room only). Otherwise `settleLinkedInTx`, which compares every `room_members` row
     (`project-room.ts:101`), would see a stale row and unlink.
   - Read the active members again and check the hash.
   - Insert the project row, then `checkParticipants` with every active member as a person (the creator is the
     caller), `newProjectRules`, `validateRules` and `writeFolderAccess(…, { limited: true })`. A guest among them goes
     through `claimGuestProject` here, so a guest who holds another project fails the whole write with
     `guest_one_place`.
   - Rename the room to the project's name.
   - Insert a `room_project_links` row in mode `'linked'`. Then call **`settleLinkedInTx`**
     (`rooms/project-room.ts:92`) with a `RuleSet.load` and an `activePeople` read **after** the rules write and
     `claimGuestProject`. A guest's reach (`guestProjects`) is loaded inside `RuleSet.load`
     (`policy/access.ts:258`), so rules read before the claim would leave the guest out. Its checks are the conversion's guarantee: the room is
     an active named `group` room, the project is active in `projects/<name>`, and the members are exactly the
     project's readers. Each member keeps their start (`history_from_seq = visible_from_seq`), and `history_floor_seq`
     becomes the room's current seq. Anything other than `'converted'` throws 409 `members_changed` and rolls the whole
     write back. Nothing is half made.
   - `settleLinkedInTx` gets an optional `{ actor, via: 'made' }`. With it, the event line is
     `{ type: 'project_made', projectId, by }` (the new line above, by the person), and the audit is
     `project.room { via: 'made' }`, which names the room by its kind only (`roomAuditRef`). Without it, nothing
     changes for the start pass.
   - Each member's alert level stays what it was. For each member with no level of their own, work out
     `roomLevel('group', null, def, false)` before the conversion and `roomLevel('group', null, def, true)` after
     (`shared/src/api/room-alerts.ts:47`). Only when the two differ is the earlier level written as their own. So a
     member whose default is `none` stays `off`, a member who had `all` keeps `all`, and nobody gets louder or quieter
     alerts without choosing it.
   - A guest whose `guests.room_id` is this room has it cleared. A project room is never a guest's group-chat place
     (`NOT_PROJECT_ROOM`), and their project slot now holds it.
   - Write one `room_file_moves` row per file that moves (below).
   - Audit `project.create` with `{ via: 'room' }`.
3. After the write: `markTeamShares`, `afterAccessChange` (which runs `syncRoomsNow`, and the members are already
   equal), `room.updated` to every member, and a kick to the file mover.

Kept through the conversion, by design: the room id. So each person's pin, hidden state, mute, read position, section
placement (`folderOf`, keyed by room id: 78's rule), threads, reactions and apps all stay. A test checks the section
placement.

### Which files move

A `room_files` row moves when **all** of these hold. Everything else stays in room storage, readable as today, with
**Save to team folder…** in its menu.

- It is on a message (`message_id` not null), the message is not deleted, and its `visibility` is `room` (a private AI
  preview stays: plan D3 of project-is-room).
- **Every current member can see the message now**, by the room's own rule. That is `SEE_SQL`
  (`rooms/store.ts:133`: `m.seq > from AND COALESCE(m.thread_root_seq, m.seq) > from`) with `seesFrom` for **each**
  member. So a thread reply under a root older than someone's start counts as not seen. No member may have the answer
  hidden either. A private channel does not open its history, so someone added later never saw the older files. Moving
  those would show them to people who could not see them before.
- It has no `room_file_refs` row (it is not already a team file).
- Its bytes are not on the quarantine or download-only list. Those never become team files the AI could be handed, the
  same rule as `createInProject`.
- **It is not a copy of a team file**, made either way:
  - `teamCopy` (a phone's team pick) marks it with `team_path` (`files.ts:461`).
  - `fromTeamFile` ("Send to a chat room" attaching an answer's files, `chat/answer-share.ts:716`) does **not** mark
    it. Its message carries `scope.attached` instead (`answer-share.ts:719`).

  Both are excluded. Migration 432 also adds `room_files.origin` (`'upload' | 'team_copy' | 'answer_copy'`), written for
  every new row, so later code does not need the message scope. For old rows the mover uses both signals and, in doubt,
  keeps the file. These copies exist for members who cannot open the team file. Putting them in the project folder
  would hand the original's content to later project people.

### The file move: crash-safe and idempotent

Migration **432** (`432_b_room_file_moves.sql`; 431 is the highest B on dev, and no open PR adds a migration as of
2026-11-21. Check again before PR 1):

```sql
-- min_compatible_reader: 1
ALTER TABLE room_files ADD COLUMN origin TEXT CHECK (origin IN ('upload', 'team_copy', 'answer_copy'));
-- NULL on rows from before this migration: the mover then reads team_path and the message's scope.attached
CREATE TABLE room_file_moves (
  id TEXT PRIMARY KEY,
  -- no cascade: a message deleted mid-move must not erase the record of a file already placed (review finding 3)
  room_file_id TEXT REFERENCES room_files(id) ON DELETE SET NULL,
  room_id TEXT NOT NULL, project_id TEXT NOT NULL, actor TEXT NOT NULL, sender TEXT,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'placing', 'cleanup', 'done', 'kept', 'cancelled')),
  staged TEXT, placed_path TEXT, ino INTEGER, dev INTEGER, sha256 TEXT NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0, reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX room_file_moves_file ON room_file_moves (room_file_id) WHERE room_file_id IS NOT NULL;
CREATE INDEX room_file_moves_open ON room_file_moves (state) WHERE state IN ('pending', 'placing', 'cleanup', 'cancelled');
```

`rooms/file-moves.ts` is a mover that runs after the conversion, at start and on the rooms' one-minute tick, one file at
a time within a time budget. The conversion request never waits for bytes.

**No hard links.** Many readers refuse a file with `nlink > 1`: `chat/chat-files.ts:268,282`, `tools/make-zip.ts:168`,
`connectors/remote-mcp/download-link.ts:55`, `tools/isolate.ts:420` and `link-names/resolve.ts:98`. So the bytes are
moved with `rename`, never linked. A staging folder `<team>/.system/room-moves/` sits on the same disk as
`.system/rooms`, and the mover renames the file into it. Nothing is copied and no disk space doubles. While a file is
staged, `RoomFiles.open` reads it from the staged path, with the same checks, so the chip keeps opening.

Per row:

1. **Still wanted?** The row's file still exists, the room is still the project room of `project_id`, and the project
   is active (a held project waits; deleted for good → `kept`). The file must still pass "Which files move". Otherwise
   the state is `kept`.
2. **Where:** the project's Chat attachments through `sharedUploadPlace`, in the team's language and made when missing,
   checked for the **sender** while they can still write there, else for the `actor`. The file's history then names
   the person who sent it. Every current member must be able to read that folder. If someone narrowed it, or neither
   person can write, the state is `kept` and the reason is recorded. People would otherwise lose a file they can open
   today.
3. **Stage:** in one short write, set `state = 'placing'`, `staged = .system/room-moves/<move id>` and add one to
   `tries`. Then `rename` the room bytes to `staged` and remove the thumbnails.
4. **Place:** `team.placeUpload(who, folder, name, staged, 'rename', sha256, { action: 'upload', detail: { attachment:
   fileId, roomId, moved: moveId, sentBy } }, { taken })`. That gives:
   - "(2)" names for a taken name, and case-folded names on a case-insensitive disk;
   - never an overwrite.

   `taken` is `instructionFile` plus `_FILES.md`. The same rule is added to `createInProject` (`files.ts:264`) and to
   B's path, so an instruction file's name (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `SKILL.md`) or the file list's name
   takes the next free name. A moved file never becomes the project AI's instructions or the file list. A name that the
   team folder refuses (`badSegment` on the team side) gets a safe name ("file", plus its extension) rather than
   `kept`.
5. **Commit**, in one write: record `placed_path`, `ino`, `dev`. Insert the `room_file_refs` row, then set
   `room_files.name` to the placed name, `thumb = 0` and `state = 'done'`. From this moment the chip reads the team
   file with today's checks (a member now **and** reads the path). If `room_file_id` became NULL meanwhile (the message
   was deleted), the state is `cancelled` instead (step 7).
6. **Done:** the file has exactly one link, at its team path. A test checks `nlink === 1` and that the AI's file read
   and a zip of the folder work.
7. **`cancelled`:** the placed file goes to the team trash, but only the file this move placed (same `ino`/`dev` at
   `placed_path`). A staged file not yet placed is deleted. That matches "deleting a message deletes it from the room"
   for a file that never became a project file.

Each crash or failure ends in one known state:

| What happens | Result |
| --- | --- |
| Crash before step 3's write | The row is still `pending` and runs again. |
| Crash after the write, before the rename | `placing`. The staged file is absent and the room bytes are there: the rename runs again. |
| Crash after staging, before placing | `placing`. The staged file is there: it is placed. |
| Crash after placing, before the commit | `placing`. The staged file is gone. The upload event with `detail.moved = moveId` is found. The file at its path has the same `sha256` (and `ino`/`dev`): it is **adopted**, and step 5 runs. No second copy. |
| Crash between placeUpload's rename and its event row | `placing`, with no staged file and no event. The mover looks in Chat attachments for a file with this `ino`/`dev`: a rename keeps the inode, so it is found and adopted. Nothing is left over. |
| The message is deleted during the move | `room_file_id` becomes NULL (no cascade). The mover sees it and goes to `cancelled` (step 7). Nothing stays behind in the project folder. |
| Disk full, quota, or the same error 5 times | Staged bytes are renamed back to room storage, the state is `kept` with the reason, the file stays readable in the room, and the closing line counts it. |
| `reconcile` at start meets a staged or room-storage leftover | A file whose inode matches a `done` move's `room_file_refs` row is unlinked, not set aside. Files under `.system/room-moves/` belong to the mover and are not orphans. |
| A rollback to an older build | `room_file_moves` and `origin` are ignored. Moved files show "unavailable" there (no room bytes) but stay in the project folder, the limit of 0.5.21 rollbacks that plan D3 already states. A move left in progress resumes after the upgrade. |

Quota: a moved file leaves the rooms line and counts under Team files. The total on disk does not change. The
storage check is not run again, because the file is on the same disk already.

## B. A department room's uploads go to the department folder

A department is a group, and its team room (`kind = 'team'`, `group_id`) gets the same file model as a project room.
This supersedes the group-folder part of [20261121-room-files-list.md](../../decisions/20261121-room-files-list.md)
(the folder as the list's first row).

- **Where a file goes.** A file sent from the computer in a team room is placed in
  `<group folder>/Chat attachments/` and gets a `room_file_refs` row, the mechanism of project rooms (#168). The upload
  uses the same place logic, generalized: `chatAttachmentsPlace(folderPath, userId)`. `sharedUploadPlace` becomes a
  wrapper over it for a project. `RoomFiles.create` asks `teamPlaceFor(roomId, userId)`, which returns the project's
  place, the group's place or `null` (room storage).
- **Room storage per upload** (`teamPlaceFor` answers `null`, nothing is refused) when:
  1. the group has no folder (`groups.folder_id` is NULL), its folder is missing on disk, or it is in the trash;
  2. **the folder rule is wider than the members**: someone who is not the owner or an admin, is active and is not in
     the room reads the group folder (any rule: everyone, a role, another group or a person);
  3. **Chat attachments was narrowed**: the folder exists and a room member cannot read it;
  4. the uploader cannot write there (a read-only person rule): their file stays in the room as today. There is no
     403, unlike a project room, because a department room has never refused a file.
  5. Also: a message not seen by the whole room (a private AI preview), a `fromTeamFile` copy and safe operations, as
     for project rooms.

  - **Cost.** `activePeople` loads every account (`project-room.ts:57-60`, O(N) queries), so it is not run per upload.
    The check reads only the subjects of the rules on the folder's path and on Chat attachments (root, `groups/`, the
    group folder). Wider means one of these: an `everyone` rule; a role rule at read or above; another group with an
    active non-admin member outside the room; or a person outside the room. That is one rules load and a few indexed
    queries. Tested with 2,000 people, within 20 ms.
  - **Group folders are not limited** (`admin/groups.ts:116`) and inherit from the root and `groups/`. A team whose root
    gives everyone read therefore keeps every department upload in room storage. That is correct, because everyone
    could read that folder. It is said in the decision, and a test covers it.
  - **The uploader is told.** A file that stayed in room storage shows "Only in this conversation" on its chip, the
    same label as A. A file that went to the folder shows "{group} › Chat attachments" under its name.
- **Admins outside the department** read the group folder, as they do today (admins open every folder outside
  `users/`). So they can open room uploads in Files, which they could not before. **Accepted by the owner on
  2026-11-21. Said in the release notes and the admin notes.** They do not become room members.
- **Header:** a team room shows **📁 {group}** first (`Room.groupFolder`, the 2026-11-16 rule of who sees it). The
  room's **Files** list stays only while the room has room-stored files: its old ones, and uploads that fell back. The
  list then shows only those, labelled "Only in this conversation". A room whose files are all in the folder has the
  one 📁 button and no list. The rule is the same for project rooms (A), so old files are never reachable only by
  scrolling.
- **Old files** of department rooms stay in room storage. They are in that list, in room search and in ⌘K recent.
- **Deleting a message** deletes only the message. For each of its files that went to the folder, the confirm adds the
  line "The file stays in {group} › Chat attachments." A room-stored file goes with the message as today.
- **Edge cases**, each a test:
  - **A person in two departments:** each room puts files in its own group's folder.
  - **Someone leaves a department:** the sync takes them out of the room, and the folder rules take the files away.
    Their own uploads stay in the folder.
  - **An admin outside:** reads the files in Files (accepted), is not in the room, and gets 404 for the room's file
    endpoint.
  - **Guests:** never in team rooms (`service.ts:1359`), and their policy never reads `groups/`. Nothing changes; a test
    checks it.
  - **A group renamed:** the folder follows `folder_id`, and the refs follow the move.
  - **A group deleted:** the room is archived as today, and the files stay in the folder.
  - **The folder widened after an upload:** the file is a group-folder file now, so the new readers see it in Files.
    Said in the decision.
  - **The welcome steps' team group:** it has no room. The Everyone room never has a folder. A test checks both.

## C. A built-in "Projects" group in the conversation list

- Built inside `RoomsByKind.tsx` and `RoomsList.tsx roomSections`, not next to them. `ROOM_SECTIONS` becomes
  `['team', 'project', 'dm']`, and `sectionOf` returns `'project'` for a room with the `projectRoom` flag. It is not
  `project.room`, because a member who cannot open the project folder gets no `Room.project` (`web/src/lib/rooms.ts:21-27`)
  and their room would land under Channels. `roomSections`' type (`RoomsList.tsx:60`) widens to carry `projectRoom`. The phone's
  Conversations tab (`pages/Rooms.tsx`) uses the same functions, so it gets the group too.
- **Order:** Pinned › my sections › Channels › **Projects** › Direct messages. Inside Projects, rooms sort by name,
  with the Channels collator. A project room shows a folder icon (as today).
- **78's rules** ([20261121-personal-sidebar-sections.md](../../decisions/20261121-personal-sidebar-sections.md)):
  - a project room that the person pinned or placed in one of their own sections shows there, not under Projects (a
    conversation shows in one place: pinned › its section › its kind);
  - the Projects header is a drop-out target, the same `useSectionDrop(null)` as the Channels and DM headers. A room
    dropped on any kind header leaves its section and goes back to its own kind.
- **When the header shows:** while the person has at least one listed project room anywhere, in a section or pinned
  too, so a room can always be dropped out. The header has no "+" in v1: projects are made on the Projects page and
  with A. Its fold key is `section:chats:project`.
- **Listed only after the first message:** kept (`listedRoom`). Until then the room is reached from the project.
- **A trashed project's room:** hidden from the list, which the server already does (held rooms, `NOT_HELD_SQL`). This
  matches #206, where trashed projects leave the Projects list. It comes back on restore. A web unit test and an e2e
  step check it.

## D. Hint lines

- **The ✦ side chat in a project room**, when empty, replaces `sideChat.empty` with: "Only you see this. To ask where
  {project}'s people see it, ask on the project page." "the project page" links to `/projects/<id>`. Guests, who do not
  see project AI chats, keep their own line.
- **A project room whose people equal one department:** the room's start block and its room info say "Same people as
  #{group}. Keep {project} talk here." `#{group}` links to that team room.
  - The server sends `Room.project.sameAsGroup?: { groupId, name, roomId }` when the project room's active members are
    exactly the members of a group's live team room.
  - It is computed only for project rooms, against groups with the same member count, and only for a viewer who is a
    member of that team room. They are, by definition, so nothing is told that they do not already see.
  - It is worked out once per room per pass, not again for each member in a list or a `room.updated` fan-out.
  - There is no banner and nothing to dismiss (lean UI).
- **Words:** English first in `web/src/i18n/en.ts`, then es, id, ja, ko and zh. Korean uses **대화방**
  (changes/ko-daehwabang-wording.md):
  - "프로젝트로 만들기", "프로젝트 만들기";
  - "나만 보는 채팅이에요. {project} 사람들이 함께 보는 곳에서 물어보려면 프로젝트 페이지에서 물어보세요.";
  - "#{group}과 같은 사람들이에요. {project} 이야기는 여기서 해요."

## Steps (PRs, one batch, one queue run)

1. **`feat/make-project-server`** (~1.5 days; `rooms/file-moves.ts` and its crash tests get their own review pass):
   - migration 432;
   - `GET`/`POST /api/rooms/:id/make-project`;
   - the `settleLinkedInTx` option;
   - guests, alert levels, the file selection and `rooms/file-moves.ts` with its start and tick hooks;
   - the DM path needs no new endpoint (`POST /api/projects` team + `POST /api/projects/:id/room`);
   - shared schemas and `docs:api`;
   - unit and security tests.
2. **`feat/group-room-folder-files`** (~0.5 day): `chatAttachmentsPlace`, `teamPlaceFor`, the fallbacks, the Files list
   only for room-stored files, the delete confirm's line per file, `Room.project.sameAsGroup`, tests.
3. **`feat/structure-polish-web`** (~1.25 days, plus the labels and the closing line):
   - A's menu items, confirm and DM offer, the toast and the event line;
   - B's header;
   - C's Projects group;
   - D's two hints;
   - six languages, 1440 and 390, light and dark;
   - docs, decisions and changes (below).

About 2,700 lines with tests, 3 to 3.5 builder days. PR 3 needs PR 1's API, so the three go in **one batch PR off fresh
origin/dev, one queue run**. Each is reviewed separately first.

## Decisions (written in the build PRs)

- New `docs/decisions/<date>-make-project-from-room.md` (A).
- New `docs/decisions/<date>-department-room-files.md` (B), with the admins-outside line.
- New `docs/decisions/<date>-sidebar-projects-group.md` (C, D).
- [20261121-room-files-list.md](../../decisions/20261121-room-files-list.md): its `Status` becomes `accepted`, with a
  line that its group-folder part is superseded by department-room-files (the Files list itself shipped).
- [20261120-project-is-room.md](../../decisions/20261120-project-is-room.md): unchanged. The new files link to it.
- `changes/make-project-from-room.md`, `changes/department-room-files.md` (including "Admins can open a department
  room's new uploads in its folder"), `changes/sidebar-projects-group.md`.

## Docs pages

- `docs/site/use/chats-and-projects.md` and its five translations: "Make a conversation a project", "A department's
  room and its folder" and "Where your conversations are listed".
- `docs/site/use/files-and-permissions.md`: Chat attachments in group folders, and who sees them (admins).
- `docs/site/use/guests.md`: what happens to a guest when their group chat becomes a project.
- The generated API page (`bun run docs:api`).

## Risks and security cases

- **Disclosure through moved files.** Only files that every current member sees move (`SEE_SQL` per member). Copies of
  team files (`teamCopy`, answer-share `fromTeamFile`) never move. People added to the project later see the moved files
  in Chat attachments, though not the old messages. The confirm says so in its added line (owner question 1).
- **Two links to one file:** none. The mover renames and never hard-links, because six readers refuse `nlink > 1`.
- **Members changed between the confirm and the click:** `membersHash`, 409.
- **A guest's second project:** refused in the confirm and in the write.
- **Instruction files and the file list:** a moved file never takes `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `SKILL.md` or
  `_FILES.md`. A moved file never lands in a skills folder (`inSkills`).
- **Admins outside a department** read its new room uploads. Accepted by the owner and said in the notes. **Wider
  folder rules** keep uploads in room storage at upload time.
- **Folder narrowed later:** the ref's per-read check shows "unavailable" to those excluded, as for project rooms.
- **Audit rows** name rooms by kind only. `project.create { via: 'room' }` names no room id.
- **Migration 432:** reader 1, additive. Check the number again before PR 1.
- **Rollback:** see the table in A. These limits go in the admin notes.
- **Six languages, phone 390, light and dark** on every changed screen.

Security matrix rows (`tests/security/lib/rooms-cases.ts`):

- `POST /api/rooms/:id/make-project` as a non-member, an admin outside, a guest member, on a DM, a team room, the
  everyone room, a project room, an archived room, and with a stale `membersHash`;
- `GET /api/rooms/:id/make-project` as a non-member (404);
- a moved file's endpoint for a former member (404) and for a member excluded from a narrowed Chat attachments
  ("unavailable");
- a team room upload by a member when the group folder has an outside reader (room storage, no ref);
- a team room file endpoint for an admin outside (404);
- `sameAsGroup` never sent to someone who is not in that team room.

## Tests

- **Checks:** `bun run typecheck`, `check:i18n`, `check:docs`, `check:prepush`, `docs:api`; server tests under Bun
  1.3.12.
- **Unit** (`tests/unit/`):
  - `b-make-project.test.ts`:
    - a named channel and an unnamed group chat convert, and a DM, team room, everyone room, project room and archived
      room are refused;
    - people equal members; the creator writes; admins outside are not people;
    - the room is renamed, the history floor is set and each member keeps their start; a later member sees from the
      floor;
    - each member's alert level is kept;
    - the section, pin, hidden state and mute are kept (78's rule);
    - one event line and the audit shape;
    - `membersHash` stale → 409;
    - two conversions at the same moment → one project, one 409, the loser's folder unmade;
    - a disabled member still in `room_members` is removed first and the conversion succeeds;
    - a member whose alert default is `none` stays `off`; one at `all` stays `all`;
    - a guest with no project takes it and their room slot clears; a guest with a project → 409 and nothing is written;
    - a failure in the write leaves no project, no folder and no link;
    - a team where only admins make projects refuses a member.
  - `b-room-file-moves.test.ts`:
    - which files move (room-visible, seen by all, not a ref, not quarantined);
    - what stays: a `team_path` copy, an answer-share copy (old row by `scope.attached`, new row by `origin`), a
      thread reply under a root older than a member's start;
    - collisions: "(2)" names, the same name twice, a case-only collision, `CLAUDE.md` and `_FILES.md` names, a name
      the team folder refuses;
    - a crash at each step (injected), including after the commit and between placeUpload's rename and its event,
      ends as in the table. A rerun is a no-op, and no file is left with `nlink > 1`;
    - after the move, the AI's file read, a zip of the folder and an MCP download link work on a moved file;
    - adopting a placed file; a message deleted mid-move → `cancelled`, nothing left in the folder; a narrowed Chat
      attachments → `kept`; the sender as the uploader, the actor when the sender cannot write;
    - the chip opens from the staged path; the closing event line counts moved and kept files;
    - a held project waits, and a project deleted for good → `kept`;
    - the reconcile of leftovers; the quota line moves.
  - `b-group-room-folder-files.test.ts`:
    - an upload lands in `<group>/Chat attachments` with a ref;
    - each fallback (no folder, a wider rule by everyone, a role, another group or a person, a root rule;
      narrowed; read-only);
    - two groups; leaving a group; an admin outside reads it in Files but gets a room 404; no guest;
    - a deleted message keeps a folder file and removes a room-stored one; the Files list holds only room-stored
      files and is gone when there are none; `sameAsGroup`;
    - 2,000 people within 20 ms.
  - Update `b-project-room*.test.ts` for the `settleLinkedInTx` option (the start pass is unchanged).
- **Web unit:**
  - `roomsByKind` with Projects (order; filed or pinned project rooms stay out of Projects; the header shows while one
    is filed; a trashed one is hidden);
  - the drop-out on the Projects header;
  - the menu items per kind and role;
  - the confirm's lines and the guest block;
  - the two hints.
- **Web e2e:**
  - `web/test/e2e/make-project.spec.ts`: convert a channel with a PDF and an image, see them in Chat attachments, see
    the 📁 button and the event line; a DM → New project with; 1440 and 390, light and dark;
  - `group-room-folder.spec.ts` (extended): an upload lands in the folder, and the header has one button;
  - `sidebar-sections.spec.ts` (extended): Projects between Channels and DMs; drag a project room into a section and
    back out onto the Projects header.

### QA rows to add (QA tab, English, one case per row)

| Case | Expected |
| --- | --- |
| ⋯ on a named private channel | "Make it a project" is there |
| ⋯ on an unnamed group chat | "Make it a project" is there, and the name field shows the members' names |
| ⋯ on a 1:1 DM | "New project with {name}" instead |
| ⋯ on a channel as a guest, or in an admins-only team as a member | No item |
| Make a channel with files a project | Renamed; one event line; files appear in {name} › Chat attachments; chips keep opening |
| A file sent before a member joined the channel | Stays in the conversation; the confirm said how many stay |
| Someone is added to the channel while the confirm is open | "The people changed" and the confirm reloads with the new count |
| A guest who already has a project is in the channel | Button disabled: "Make {guest} a team member first" |
| A guest with no project is in the channel | Converts; the guest sees the project and its room only |
| Room was in my own section before converting | Still in my section afterwards |
| A file named CLAUDE.md in the converted channel | Lands as "CLAUDE (2).md" or similar, never as instructions |
| Restart the server during a large move | After start, the move finishes with no duplicates |
| A file sent with "Send to a chat room" from an AI answer, then convert | It stays in the conversation, labelled "Only in this conversation" |
| The person who converted leaves the project during the move | The move finishes, with each file placed by its sender |
| After the move | Closing line "N files moved…, M stayed…"; a moved file opens in Files and the AI can read it |
| Upload in a department room | Lands in {group} › Chat attachments; header has one 📁 {group} button |
| Department folder shared with another group, then upload | Stays in the room, labelled "Only in this conversation"; the room's Files list shows it |
| Admin outside the department opens the group folder | Sees the room uploads (as accepted) |
| Leave the department | The room and the files are gone for me |
| Conversation list with project rooms | Projects group between Channels and DMs; no empty room before its first message |
| Drag a project room into a section, then onto the Projects header | Goes in, then back under Projects |
| Trash a project | Its room leaves the list; restore brings it back |
| Empty ✦ side chat in a project room | The "Only you see this…" line with a working project page link |
| Project with the same people as a department | "Same people as #{group}…" in the room's start and info |
| Each screen above at 390, light and dark, in ko | Nothing cut off; Korean says 대화방 |

## Owner questions

1. **One added line in the approved confirm.** People added to the project later can open the moved files, but not
   the old messages. **Recommendation:** add "People added to the project later can open these files." to the confirm,
   which the plan already does. A project's files belong to its people, the model of #168. Without the line, the copy
   "People added later see messages from now on" reads as if the old files stay private.

## Review (2026-11-21, an independent reviewer, fresh context)

There were 12 findings (3 blocking) and every one changed the plan:

1. **Blocking.** Answer-share copies (`fromTeamFile`) have no `team_path`, so they would have moved. Fixed: they are
   excluded by `scope.attached`, and a new `origin` column covers new rows.
2. **Blocking.** A hard link leaves the team file with `nlink > 1`, which six readers refuse. Fixed: the mover stages by
   `rename` under `.system/room-moves/`, there are no links, and `reconcile` unlinks leftovers that match a ref.
3. **Blocking.** The cascade on the move row would lose track of a placed file whose message was deleted. Fixed:
   `ON DELETE SET NULL`, and a `cancelled` state that trashes the placed file.
4. "Seen by everyone" now uses `SEE_SQL`, thread roots included.
5. Gone members are removed in the write, the rules are reloaded after the guest claim, and `unlinked` becomes 409.
6. A second conversion at the same time gets a 409, not a 500, and `captureState` runs first.
7. B: wide inherited rules are said and tested. The Files list stays for room-stored files, the uploader sees where a
   file went, and the delete line is per file.
8. B: the cost check reads only the rule subjects, not every account.
9. Alert levels: the earlier computed level is written only when it changes, so `none` stays `off`.
10. C: `sectionOf` uses the `projectRoom` flag.
11. Words: a closing line counting moved and kept files, the "Only in this conversation" label, the added confirm line,
    and the sender as the uploader.
12. Nits: `_FILES.md` is taken everywhere, refused names get a safe name, the event lines' older-build look, name
    checks, and `sameAsGroup` once per pass. Missing tests and QA rows were added.

## Result

Filled in at the end.
