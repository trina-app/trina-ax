# A channel linked to a project: one folder, the project's

- Date (UTC): 2026-11-19 14:43
- Branch: `plan/channel-project-link` (build branches: `feat/channel-project-link-server`, `feat/channel-project-link-web`)
- Status: draft (the owner approved the direction on 2026-11-19; this plan settles the details)
- Where: Team AX core (`server/src/rooms/`, `server/src/chat/projects.ts`, `server/src/chat/side-room.ts`,
  `server/src/admin/folders.ts`, `shared/src/api/rooms.ts`, `shared/src/api/entities.ts`, `shared/src/api/chats.ts`,
  `web/src/pages/Room.tsx`, `web/src/components/rooms/*`, `web/src/pages/Projects.tsx`,
  `web/src/components/NewProjectDialog.tsx`, the six `web/src/i18n/*.ts`, `docs/site`). Why: rooms, projects, files
  and permissions are core.
- Version impact: **minor**: one additive table, new endpoints, optional API fields, a new way to do something.

## Goal

Teams make one channel per project. Today a file posted in that channel stays in the conversation storage
(`.system/rooms`), and the project keeps its files in `projects/<name>`. The two know nothing of each other. The
only link that exists is a group channel's header **Files** button, which opens the group's folder
([20261116-room-group-folder-button](../../decisions/20261116-room-group-folder-button.md)).

After this change there is one folder, the project's. A channel can be **linked to a project**. Its header Files
button opens the project folder. A file posted there gets **Save to project** in one click. The AI in the channel's
✦ side chat saves new documents to the project folder by default. A project's page shows its channel, or offers
**Link a channel** and **Create a channel**.

## Scope

In:
- A link between one private channel and one team project, made or removed from either side.
- Creating a channel from a project's page, and an optional "Also create a channel" when a project is made with
  people.
- The header Files button, Save to project, and the side chat's default save place for a linked channel.
- Live updates when a link, a project's access or a project's state changes.

Out (the owner said no):
- Copying every channel file into the folder by itself.
- Syncing channel members with project access, either way, at any time after the channel is made.

Out (later, if asked for):
- Joining a linked channel from the project page (see Open questions).
- Posting project activity into the channel (Linear/Asana style notifications).
- The project's instructions or files reaching the side chat as context. A side chat still never joins a project
  ("A room's side chat never joins a project", docs/DECISIONS.md, `side_chat_no_project`).

## Reference check (the idea, not the wording)

- **Slack**: every channel has its own Files tab and one channel canvas. Files belong to the channel; there is no
  outside folder. We keep "the channel has one place for its files" and point that place at the project folder.
- **Linear** ([docs](https://linear.app/docs/slack), [changelog 2026-05-21](https://linear.app/changelog/2026-05-21-project-slack-channels)):
  a project can have its own Slack channel. An admin can make Linear create one for each new project, and the
  project's members are added to it. After that the two lists are separate. We keep three things from Linear:
  create from the project, pre-fill the project's people, and no sync afterwards. We do not make it a team-wide
  automatic setting: the choice is per project.
- **Asana** ([help](https://help.asana.com/s/article/slack-and-asana)): a project is linked to a channel from the
  project's settings, or from the channel with `/asana link`. Only the project's editors can link. We keep "both
  sides can link" and "only someone who may edit the project links".
- **Notion teamspaces**: the teamspace's members are its own list, not a chat's. This supports keeping channel
  membership and project access apart.

## Decisions to settle

### D1. One channel per project, one project per channel (recommended)

- **Why one:** the Files button and Save to project must have a single answer: "the project's folder". On the
  project side, "the channel" is one row, not a list to manage, which fits the owner's preference for lean UI.
  Slack and Linear also have one primary channel per project. A second channel ("#proj-x-design") can still work:
  its people use Save to team folder… and pick the project folder, as today.
- **Stored** in a new table, so older builds ignore it and a rollback loses nothing:

  ```sql
  -- min_compatible_reader: 1
  CREATE TABLE room_project_links (
    room_id    TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
    linked_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
    linked_at  TEXT NOT NULL
  );
  ```

  Migration number: the next free number in the B range. On dev today the highest is 426, so the next is **427**.
  Check `server/migrations/` on dev and the open PRs (`check:prepush` warns) at build time.
- **Why a table, not `rooms.project_id`:** both sides have a unique key, deleting a project removes the link by
  cascade, and `linked_by`/`linked_at` have a place to live.

### D2. What can be linked

- **Channel side:** only a **private channel**, meaning a named group room (kind `group` with a name, see
  [20261117-named-groups-private-channels](../../decisions/20261117-named-groups-private-channels.md)). This is
  what "Create a channel" makes, so it is what people make per project.
  - Not a group DM: it has no name, and Slack does not link those either. Its "⋯ › Turn into a private channel"
    comes first.
  - Not a DM.
  - Not the Everyone room.
  - Not a **team channel** (`# leads`): it belongs to its group and already opens the group folder. One Files
    button per header.
- **Project side:** only a **team project** in `projects/<name>`, not in the trash. A personal project is "only me",
  so a channel cannot share its folder. When a personal project gets people ("Add people"), it becomes a team project
  and can then be linked.

### D3. Who may link, unlink and create

- **Link:** a person who is both:
  - a member of the channel and not a guest; and
  - a reader of the project (`canSeeProject`) who can write its folder (`canWrite` on `folder_path`).

  An owner or admin who manages a project without being a member (`member: false`) cannot link it. They do not read
  its contents, and the link would open a door they cannot see behind ("Project contents only for members").
- **Unlink:** anyone who could link it, or whoever manages the project (`mayManageProject`: its creator, the owner,
  admins). Unlinking changes no files and no members.
- **Create a channel for this project:** a member of the project who may link it (above), and is not a guest. The
  server makes the private channel and the link in one transaction. The usual room checks apply: the hourly limit
  `roomChannelLimit`, the guest rules, and active people only.
- **Never audited by name.** Rooms are not audited ("admins do not learn who talks to whom"). One audit row
  `room.project_linked` / `room.project_unlinked` with ids only, as the project area does for its own changes.
  Recommended because a project's folder now has a new way in through the channel's ✦ save default.

### D4. Who sees the link (the only permission is the folder rule)

- `Room.project` is `{ id, name, folderPath }`. The server sends it only to a viewer for whom
  `canSeeProject(project)` and `RuleSet.canList(folderPath)` both hold. This is the same test the group Files button
  uses (`groupFolderFor`), with `projectFor(db, room, userId, rules)` beside it in `rooms/store.ts`.
- A channel member who cannot open the project folder gets no `Room.project`. Their header has no button, their
  files have no Save to project, their channel info has no project row, and the link is never mentioned to them. They
  also get `canLinkProject: false` while the channel has a link, so they are never offered "Link to a project" and
  then refused. This tells them only that they cannot link, never that a project exists.
- On the project side, `Project.channel` is `{ roomId, name, memberCount, inIt: boolean }` for whoever reads the
  project. A project member who is not in the channel sees its name and "You're not in this channel". There is no
  join button (see Open questions). A private channel's name becomes visible to the project's members. The person
  linking is told so in the confirm.
- **Live:** the existing `afterAccessChange` → `groupFoldersChanged` path grows to cover linked channels. Before and
  after a folder change, the people whose access changed and who sit in a linked channel whose project folder is at,
  under or above a changed folder get `room.updated` when their answer changed. This is bounded the same way as
  [20261116-live-folder-button](../../decisions/20261116-live-folder-button.md). Link, unlink, project rename, trash
  and restore send `room.updated` to the channel's members, each event built by `roomOut` for its recipient, so
  people who cannot see the project get an event with no `project`.

### D5. Lifecycle

| Event | What happens to the link | What people see |
| --- | --- | --- |
| Channel renamed | kept | the project row shows the new name on next load |
| Channel archived (last person leaves) | deleted in the same transaction (`rooms/service.ts` archive paths) | the project page offers Link / Create again |
| Project renamed | kept | tooltip and info row follow (`room.updated`) |
| Project folder repointed by an admin | kept (by project id) | Files opens the new folder |
| Project to the trash | kept, inactive: `canSeeProject` is false while `trashed_with` is set | no button, no Save, no AI default; the project page's trash note does not mention the channel |
| Project restored | active again | everything returns, live |
| Project deleted for good | deleted (cascade) | channel back to a plain private channel |
| Member removed from project / leaves it | kept | that person loses the button live |
| Channel member removed / leaves | kept | normal room behaviour |
| Project becomes members-only for fewer people | kept | only the people still allowed keep the button |

A team project cannot go back to "only me" ("This can't go back to only you"), so no row is needed for that.

### D6. Save to project (the file action)

- In a linked channel, for someone with `Room.project` who can **write** the project folder root, the file chip's
  save icon (hover/focus on a computer, see
  [20261117-room-file-save-btn](../../decisions/20261117-room-file-save-btn.md)) becomes **Save to project**:
  - one click, no sheet, no folder picker;
  - the file goes into the **root of the project folder**;
  - it uses the same server path as Save to team folder, so there is no new copy code.
- The client calls `POST /api/rooms/:id/save-plan` with `folder` set to the project folder (an existing feature),
  then `save-to-team`. This keeps every check: membership, message visible, not quarantined, ≤ 50 MB, never an
  overwrite, `freeName` "(2)", same bytes saved once, file history.
- **Why the root, not a suggested subfolder:** one click must land in a predictable place. The person moves it later
  in Files. Hidden subfolders (a "Limit access" folder inside the project) are never a target.
- **Falls back to the existing sheet**, with the project folder pre-selected and "Choose another folder…" still
  available, when:
  - any file looks personal (`files[].sensitive`, the existing per-file rule);
  - the message has several files and some are already saved elsewhere;
  - the plan says the root cannot be written.
- **Toast:** "Saved to {project} · Open". Already saved: the chip shows "In project · {path}" (the existing "In team
  folder" link, with project wording when the path is inside the linked project).
- **The menu** (right-click, long press) has **Save to {project}** first, then **Save to another folder…** (today's
  sheet, renamed only in a linked channel). Not linked: unchanged, **Save to team folder**.
- **Who it is hidden from:**
  - guests (they never save, as today);
  - members without `Room.project`;
  - members who can read but not write the root. They keep Save to team folder….
- **The audience:** the sheet's "N people outside this conversation can see this folder" was the confirmation for a
  hand-picked folder. Here the folder is the one the channel was deliberately linked to, so one click is like naming
  the place. The link confirm (S2 below) says who can open the project, once. Recommended; listed as Q2 for the owner.

### D7. The AI in a linked channel (side chat save place)

- `savePlaceFor` (`chat/side-room.ts`) checks first: when the room has a link that is active for the asker, and the
  asker can write the project folder, the place is the **project folder** (`{ path: folderPath }`). After that it
  continues with today's order (group folder, Everyone → `shared/`, smallest group, own folder + share).
- This is a "place the task names", so it is consistent with
  [20261117-ai-save-my-files-default](../../decisions/20261117-ai-save-my-files-default.md) and the room save-place
  decisions. They gain one line each.
- The wider-audience card is unchanged in when it asks. A project has people outside the channel → the card asks
  with its usual counts ("Save it to {project} (8 people, 5 of them can't see where it came from)?"), and Always
  allow works as before. The save result's "Who can open the new file now …" line reports room people who cannot
  open it. The AI says that line and does not share the file with them: no new permission path.
- The `sideRoomSection` prompt line names the place as "this channel's project folder ({name})". The side chat
  still does not read the project's instructions, files or chats, and stays out of `projects`.
- An explicit save in the side chat (`askedToSave`, "one prompt at most") behaves as today, now into the project
  folder.

### D8. Creating a channel from a project: pre-fill the project's people (recommended)

- The Create dialog opens with the project's **members ticked**: the people who read it by its own rules, groups
  expanded (`GET /api/projects/:id/people`). The owner and admins who only manage it are not ticked. The creator is
  always in.
- **Project guests** are listed **unticked**, with the existing guest line. A guest can be in one group chat, so
  ticking them makes this their one group chat. A guest already in another group chat is greyed out with "A guest
  can be in one group chat and one project."
- People can untick or add others. This is a copy at creation time, never a sync afterwards (Linear does the same).
- **Why pre-fill:** the owner's case is "the project's people talk in the project's channel". Starting from an empty
  picker would make them retype a list the server already has.

### D9. Naming

- The default name is the **project's name as typed**. It is not lowercased and spaces are not turned into hyphens.
  Trina channel names are free text, and Korean names have no case. Slack's lowercase-hyphen rule would turn
  "라마바 카페" into something people do not recognise.
- The name is still editable before Create. Max `ROOM_NAME_MAX`. The same name as another channel is allowed, as
  today.
- Words (English first, Slack's terms):
  - Channel, Private channel, Create a channel, Link a channel, Link to a project, Unlink;
  - Files;
  - Save to project, Save to another folder…;
  - "Also create a channel".
  - ko 채널 / 채널 만들기 / 채널 연결 / 프로젝트에 연결 / 연결 해제 / 프로젝트에 저장. ja, zh, es, id follow the
    existing channel words of 20261116-sidebar-channels-dms.

## API

New optional fields:
- `Room.project?: { id, name, folderPath }`: D4. Absent when there is no link, the viewer cannot open the project,
  or the server is older.
- `Room.canLinkProject?: boolean`: true for a private channel with no link (or a link the viewer can see), for a
  non-guest member.
- `Project.channel?: { roomId, name, memberCount, inIt }`: for project readers. `Project.canLinkChannel?: boolean`.

New endpoints (owner `B`, not in `auth/guest-endpoints.ts`):
- `PUT /api/rooms/:id/project` `{ projectId }`: link. Error answers:
  - 409 `channel_linked`: this channel already has a link;
  - 409 `project_has_channel`: the project already has a channel. When the caller can see that channel, its name is
    in `params`;
  - 409 `not_private_channel`;
  - 409 `project_personal`;
  - 409 `project_in_trash`;
  - 404 for a project the caller cannot read, the same body as a missing one;
  - 403 for a guest.
- `DELETE /api/rooms/:id/project`: unlink. The same answer when there is no link.
- `POST /api/projects/:id/channel` `{ name, memberIds }`: create a private channel and link it, 201 `Room`. Uses
  `createGroup`'s checks, then inserts the link. Rolled back together.
- Optional for the picker: `GET /api/rooms?linkable=1` returns my private channels with no link, and
  `GET /api/projects?linkable=1` returns team projects I may link with no channel. Each is the existing list with a
  filter, so there is no new read.

Unchanged: `save-plan`, `save-to-team`, `saved-files`.

`POST /api/projects` gains `channel?: { name?: string }`. When present and the project is made as a team project
(people picked), the channel is made right after, with the same people, and linked. If channel creation fails, the
project stays and the response carries `channelError` (the dialog says "The project was made; the channel wasn't.
Try Create a channel on its page.").

## Screens (per item; computer 1440, phone 390, light and dark)

### S1. Channel header (linked, viewer can open the project)

```
1440
┌──────────────────────────────────────────────────────────────────────────────────┐
│ 🔒 Launch site   7 members                 [📁 Files]             ✦   🔔   ⋯     │
└──────────────────────────────────────────────────────────────────────────────────┘
   tooltip on Files: "Open the Launch site project folder"

390
┌──────────────────────────────────────┐
│ ‹ 🔒 Launch site               📁 ✦ ⋯ │
│      7 members                        │
└──────────────────────────────────────┘
```

- It is the same button as the group Files button: the same component, place, size and testid family
  (`room-project-files`). It links to `/files?path=<folderPath>` and is pushed on history, so Back returns to the
  channel.
- A member who cannot open the project sees the header exactly as an unlinked channel looks today.
- **Removed / not added:** no project chip or badge next to the name, no second button. The project's name lives in
  the tooltip and the channel info.

### S2. Channel info (opened from the name; MembersDialog)

```
┌ Launch site ───────────────────────────────── ✕ ┐
│ Name   Launch site                         ✎     │
│ Project  📁 Launch site            Unlink         │   ← one row; the name opens the project page
│ ─────────────────────────────────────────────── │
│ + Add people                                      │
│ (members…)                                        │
└───────────────────────────────────────────────────┘

not linked, for a member who may link:
│ Project  Not linked                Link to a project │
```

- **Link to a project** opens a small picker: a search box and my team projects I may link. Projects that already
  have a channel are greyed, with "Has a channel". Picking one opens a confirm:
  - "Link #Launch site to the Launch site project?"
  - "People in this channel who can open the project's folder get a Files button and Save to project. Others see no
    change. The project's 8 members will see this channel's name on the project page."
  - Buttons: Link / Cancel.
- The channel's "⋯" menu gets one item, **Link to a project** or **Unlink project**. This is the one setting people
  look for in a menu, as Rename is.
- **Unlink** confirm: "Files saved to the project stay there. The channel's own files stay in the channel."

### S3. Project page (team project, side column under Instructions and Files)

```
1440 aside (320px)                         linked, I'm in it          linked, I'm not in it
┌────────────────────────────────┐   ┌───────────────────────────┐   ┌───────────────────────────┐
│ 📜 Instructions          Edit   │   │ # Channel                 │   │ # Channel                 │
│ ─────────────────────────────── │   │ 🔒 Launch site · 7   Open  │   │ 🔒 Launch site · 7         │
│ 📁 Files · 12 items      Open   │   └───────────────────────────┘   │ You're not in this channel│
│ ─────────────────────────────── │                                   └───────────────────────────┘
│ # Channel                       │   ← no channel, for someone who may link:
│   Talk about this project with  │
│   its people.                   │
│   [+ Create a channel]  Link a  │   ← one secondary button + one text link
│                         channel │
└────────────────────────────────┘
```

- The empty state uses the existing `EmptySideBox` (as empty Instructions/Files do). Filled, it is the one-line
  `DisclosureRow`, and its "⋯" has Unlink.
- Phone 390: the aside is last (after the chats), as today. The row is one line. Create opens the dialog as a bottom
  sheet.
- Shown to nobody for:
  - a personal project;
  - a project in the trash;
  - an owner or admin outside the project (`member: false`);
  - a guest: they see the linked row if they are in the channel, otherwise nothing.
- **Kept lean:** no channel preview, no message count, no members list here.

### S4. Create a channel (from S3)

```
┌ Create a channel for Launch site ────────────── ✕ ┐
│ Channel name                                       │
│ [ Launch site                              ]       │
│ People                                             │
│ [ Search people…                           ]       │
│ ☑ Mina Kim   ☑ Leo Park   ☑ Sales (group: 4)       │   ← the project's members, ticked
│ ☐ Ari (guest) · this becomes their one group chat  │
│ A private channel. Only the people you add can      │
│ read it. Its Files open this project's folder.      │
│                               Cancel  [Create]     │
└─────────────────────────────────────────────────────┘
```

- This is the existing "Create a channel" picker (`PeoplePicker`, required name) with two things pre-filled and one
  line of explanation. It is not a new dialog component.

### S5. New project dialog (only once people are picked)

```
┌ New project ─────────────────────────────────── ✕ ┐
│ Name  [ Launch site                       ]        │
│ People [ Mina Kim ✕  Leo Park ✕  + ]               │
│ ☐ Also create a channel for this project           │   ← appears only when someone is picked
│                               Cancel  [Create]     │
└─────────────────────────────────────────────────────┘
```

- Off by default (the owner said optional). Not shown:
  - with no people (a personal project);
  - in "Move to project › New project" (its Undo deletes only an untouched project);
  - for a guest;
  - for a member whose team lets only admins share projects (no people field there).
- The channel is named after the project and has the same people.

### S6. A file in a linked channel

```
computer (hover/focus)                         phone (long press sheet)
┌───────────────────────────────┐             ┌───────────────────────────┐
│ 📄 quote-v2.pdf  1.2 MB  ⤓  📁⁺ │             │ Save to Launch site       │
└───────────────────────────────┘             │ Save to another folder…   │
   📁⁺ tooltip: "Save to Launch site"           │ Download                  │
   after: 📁 link "In project · quote-v2.pdf"   │ …                         │
                                               └───────────────────────────┘
toast: "Saved to Launch site · Open"
```

- The icon keeps its 24 px slot, so the chip never changes width (the 11-17 rule).

## Edge cases

- **Member not in the project:** no button, no save, no info row, no AI default. The AI default for them falls back
  to today's order (D4, D7).
- **Hidden subfolders in the project:** the button opens the root. Files shows only what the rules allow. Save goes
  to the root only. The AI's default is the root. A subfolder the person cannot see is never named.
- **Guests:**
  - a guest in the channel whose one project is this project sees the Files button;
  - a guest never gets Save to project, never links, unlinks or creates (403), and is never ticked by default in S4;
  - `canList` already applies `guestProjects`, so no new guest code is needed.
- **Phone (390):** the header shows the folder icon only (as now). The info row and the project row fit one line, and
  the project name truncates. S4 and S5 are bottom sheets. All of these are checked in light and dark mode.
- **An existing per-project channel:** linked from its info or "⋯", or from the project page's **Link a channel**,
  which opens my private channels with no link. Nothing in the channel changes. Files sent before the link stay in
  the channel; each gets Save to project from then on.
- **Two channels for one project:** the second link is refused (`project_has_channel`):
  - the picker greys the project, with "Has a channel";
  - someone who can see the first channel is told its name and can unlink it there first;
  - the unique index makes a race safe: the second transaction fails.
- **A group DM:** offered "Turn into a private channel" first (existing), then it can link.
- **A team channel (`# leads`) or Everyone:** never offered.
- **Safe operations (1A) on:** linking and creating still work (they are room and project rules). The AI default
  still applies, and the wider-audience card asks as it does today under 1A.
- **An admin who reads the project by membership:** behaves as a member. An admin outside it: manages (can unlink
  from the project's "⋯") but never sees the channel's name. `Project.channel` is not sent with `member: false`.
- **Account removal:** `linked_by` set null; nothing shown.

## Steps

1. Server: migration 427 (number checked at build time); `rooms/project-link.ts`
   (link/unlink/create/projectFor); `roomOut` field; archive paths delete the link; endpoints and contract in
   `shared/src/api`; `Project.channel`; the access-change fan-out; the audit rows; `POST /api/projects` `channel`.
2. Server: `savePlaceFor` project step plus the prompt line.
3. Web: header button, channel info row and ⋯ item, link picker and confirm.
4. Web: project page row, Create dialog pre-fill, New project checkbox.
5. Web: Save to project on chip and menu, the toast, "In project".
6. i18n in six languages, `docs/site` user docs (channels page, projects page), `changes/channel-project-link.md`,
   and decision file `docs/decisions/20261119-channel-project-link.md`. The older decisions get a "See also" line in
   their own files only where they say otherwise (room save place, the save button).

Two PRs (server, then web), batched with the day's other reviewed PRs per the batch rule.

## Risks

- **Permissions:** the link grants nothing. Every read goes through `canSeeProject` + `canList`/`canWrite`, which is
  checked again on each request. The main risk is leaking the **project name** or the **channel name**:
  - `Room.project` is per viewer;
  - `Project.channel` goes only to project readers;
  - error bodies for an unseen project are the 404 of a missing one.

  The security tests below are needed for this.
- **AI widening:** the new default place can be wider than the room. The existing card and Always allow cover it,
  with no new bypass. `askedToSave` keeps its "no wider-audience card" condition, so a project wider than the room
  still asks.
- **Performance:** `projectFor` adds one indexed lookup per private channel in `roomOut`, and the rules are read once
  per list (`rulesOnce`).
- **Migration:** additive, reader 1. A rollback build ignores the table.

## Tests

- `bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run check:prepush`; server tests under Bun
  1.3.12.
- New `tests/unit/b-rooms-project-link.test.ts`:
  - link/unlink both sides and who may;
  - one-to-one, including a race;
  - kinds refused (DM, group DM, team, Everyone, personal project, trashed project);
  - the per-viewer field (member, non-member, admin outside, guest in/out of the project);
  - the live events (rule change, project membership change, leave, trash/restore, rename);
  - archive deletes the link, and a project deleted for good cascades;
  - create-from-project (pre-filled people, guest one-chat rule, rollback when the link fails);
  - `POST /api/projects` with `channel`.
- `tests/security/lib/rooms-cases.ts` and `access-request-cases.ts` style matrix rows for the three endpoints.
  Assert no project name in any refused body, and no `Project.channel` for `member: false`.
- `tests/unit/b-side-chat.test.ts`:
  - a linked channel saves to the project folder;
  - an asker who cannot write it falls back;
  - the wider card still asks when the project is wider;
  - trashed project → fallback.
- `tests/unit/b-rooms-save-to-team.test.ts`: saving into the project root through the existing path, a personal
  file → plan says sensitive.
- Web unit: `room-save-sheet.test.tsx` (one-click vs fallback), `rooms-lib.test.ts`, `project-form` (checkbox only
  with people).
- Web e2e: `web/test/e2e/channel-project-link.spec.ts` (link from channel, link from project, create from project,
  Files opens folder, Save to project, non-member sees nothing, live removal, 1440 and 390, light and dark).
- AI scenario: `SAVE-0x`, "summarise this thread to a file" in a linked channel's side chat → project folder, one
  card when wider.

### QA rows to add (QA tab, English, one case per row; status at start / PR / dev merge)

| Case | Expected |
| --- | --- |
| Link a private channel to a team project from channel info | Files button appears for members who can open the project; tooltip names the project |
| Link from the project page (Link a channel) | Channel row shows on the project page; header button appears in the channel |
| Create a channel for this project from the project page | Private channel made with the project's members pre-ticked; linked; opens |
| New project with people + "Also create a channel" | Project and linked channel both made; channel named after the project |
| Channel member not in the project | No Files button, no Save to project, no project row in info |
| Remove a person from the project while they have the channel open | Their Files button disappears without reload |
| Save to project on a file (computer) | One click, file in project root, toast with Open, chip shows "In project" |
| Save to project on a phone (long press) at 390 | Menu shows Save to {project} first; works; dark mode readable |
| Save a personal-looking file in a linked channel | Sheet opens instead (project pre-selected, Looks personal note) |
| Side chat: "save the summary as a file" in a linked channel | Saved in the project folder; wider-audience card when the project has people outside the channel |
| Second channel tries to link the same project | Refused; picker shows "Has a channel" |
| Project moved to the trash, then restored | Button and save disappear, then return |
| Last person leaves the linked channel | Project page offers Create / Link again |
| Guest in the channel and in the project | Sees Files, never Save to project, cannot link or create |
| Admin outside the project | Project page shows no channel name; can unlink from the project's menu |
| Unlink from channel info | Button goes; files already saved stay in the project |

## Open questions for the owner (short)

1. **Join from the project page?** A project member not in the linked channel sees "You're not in this channel".
   Should they get a **Join** button? That would make project membership a way into a private channel. Recommended
   for now: no; a channel member adds them.
2. **One click with no audience line?** Save to project skips the sheet's "N people outside this conversation can see
   this folder", because the link confirm already said who can open the project. Recommended: yes, one click as you
   asked. The alternative is a toast that also says "8 people can open it".

Everything else above is decided as recommended unless the owner says otherwise.

## Result

Filled in at the end.
