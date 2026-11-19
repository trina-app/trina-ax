# A channel linked to a project: one folder, the project's

- Date (UTC): 2026-11-19 14:43 (revision 2: 2026-11-19, after an independent review; the coordinator's decisions)
- Branch: `plan/channel-project-link` (build branches: `feat/channel-project-link-server`, `feat/channel-project-link-web`)
- Status: draft (the owner approved the direction on 2026-11-19; this plan settles the details)
- Where: Team AX core (`server/src/rooms/`, `server/src/chat/projects.ts`, `server/src/chat/side-room.ts`,
  `server/src/chat/turn.ts`, `server/src/admin/folders.ts`, `server/src/team-files/service.ts`, `shared/src/api/rooms.ts`,
  `shared/src/api/entities.ts`, `web/src/pages/Room.tsx`, `web/src/components/rooms/*`, `web/src/pages/Projects.tsx`, the
  six `web/src/i18n/*.ts`, `docs/site`). Why: rooms, projects, files and permissions are core.
- Version impact: **minor** (one additive table, three endpoints, optional API fields, a new event line kind).

## Goal

Teams make one channel per project. Today a file posted there stays in conversation storage (`.system/rooms`) while
the project keeps its files in `projects/<name>`, and the two know nothing of each other; only a group channel's header
**Files** button opens a folder (the group's; [20261116-room-group-folder-button](../../decisions/20261116-room-group-folder-button.md)).

After this: one folder, the project's. A channel can be **linked to a project**. Its header Files button opens the
project folder; a document posted there gets **Save to project** in one click; the ✦ side chat saves new documents to
the project folder by default. A project's page shows its channel, or offers **Create a channel** (the main path) and
**Link a channel**.

## Scope

In: linking one private channel to one team project, from the channel's info or the project page; creating a channel
from the project page; the Files button, Save to project, the side chat's save place and its narrow no-card rule; a
neutral event line; live updates.

Out (the owner): copying channel files into the folder by itself; syncing channel members and project access, either
way, ever.

**Removed in revision 2** (coordinator, after review):
- the channel "⋯" menu item (Link to a project / Unlink project): linking lives in the channel info and the project page
  only;
- unlinking by an owner or admin outside the project (or by any project manager who is not in the channel);
- the new-project dialog's "Also create a channel" checkbox: making a project (folder, rules) and a channel in one step
  cannot be one transaction, so it brings a "project made, channel not" state. A project made with people lands on its
  page, where **Create a channel** is the first thing in the Channel box;
- a Join button on the project page for a project member outside the channel (decided: none; see S3).

Later, if asked: project activity posted into the channel (Linear/Asana style); the project's instructions or files as
the side chat's context (a side chat still never joins a project: `side_chat_no_project`).

## Reference check (the idea, not the wording)

- **Slack**: a channel has its own Files tab and one canvas: one place for the channel's files. We keep "one place" and
  point it at the project's folder.
- **Linear** ([Slack docs](https://linear.app/docs/slack), [changelog 2026-05-21](https://linear.app/changelog/2026-05-21-project-slack-channels)):
  a project can have its own Slack channel, made from the project with the project's members added; no sync afterwards.
  We keep create-from-the-project, the pre-filled people and no sync; not a team-wide automatic setting.
- **Asana** ([help](https://help.asana.com/s/article/slack-and-asana)): link from the project's settings or from the
  channel; only the project's editors link. We keep both sides and "only someone who may edit the project".
- **Notion teamspaces**: members are the teamspace's own list, not a chat's: supports keeping the two lists apart.

## Decisions

### D1. Cardinality: one project per channel (hard); one channel per project (an index, can be dropped)

```sql
-- min_compatible_reader: 1
CREATE TABLE room_project_links (
  room_id    TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,       -- one project per channel: the key
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  linked_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  linked_at  TEXT NOT NULL
);
-- one channel per project: a separate unique index, so a later "several channels per project" drops only this
CREATE UNIQUE INDEX room_project_links_project ON room_project_links(project_id);
```

- Why a channel has one project: its Files button and Save to project need one answer. Why a project has one channel
  for now: the project page shows one row, not a list; Slack and Linear show one primary channel. A second channel can
  still save into the folder with Save to another folder….
- Migration: next free B number; 426 is the highest on dev today, so **427**, checked again at build time against dev and
  open PRs (`check:prepush` warns). `PRAGMA foreign_keys = ON` (db.ts) makes the cascades real; the deleting paths also
  delete explicitly (D5), so nothing depends on the pragma alone.
- `linked_by` is named in `auth/account-removal.ts KEPT_WITH_ACCOUNT` ("set null by the key; never shown") so the
  account-removal coverage test passes.

**Active link.** A row is *active* only when: the room is not archived, is kind `group` with a name (a private channel);
the project has `trashed_with IS NULL`; and its `folder_path` is in the members-only zone (`inProjectZone`: exactly
`projects/<name>`, two segments). Every read (`projectFor`, `Project.channel`, the save place, the event line's name)
checks this; an inactive row behaves as no link. An inactive row never blocks a new link: the link write deletes the
inactive row on either side in the same transaction (D3).

### D2. What can be linked

- Channel: only a **private channel** (a named group room, [20261117-named-groups-private-channels](../../decisions/20261117-named-groups-private-channels.md)).
  Not a group DM (its "Turn into a private channel" comes first), a DM, Everyone, or a team channel (`# leads` keeps its
  group folder; one Files button per header).
- Project: only a team project whose folder is `projects/<name>` (`inProjectZone`), not in the trash. Personal projects,
  and older team projects outside `projects/` (made before 2026-11-09), are refused. A project repointed by an admin to
  a folder outside the zone makes its link inactive (D1); repointed back, active again.

### D3. Who may link, unlink, create, and the error order

**Link** (`PUT /api/rooms/:id/project`, also used by the project page's Link a channel): a non-guest member of the
channel who reads the project (`canSeeProject`) and can write its folder (`canWrite(folder_path)`). An owner or admin
outside the project cannot: they do not read its contents.

**Unlink** (`DELETE /api/rooms/:id/project`, from the channel info or the project page): the same person as Link (a
channel member who reads and writes the project). Nobody else, admins included. A link no channel member can see any
more is inactive for all of them and harmless; it goes when the channel or project goes.

**Create a channel** (`POST /api/projects/:id/channel`): a non-guest who reads and writes the project.

**Error order** (each checked before the next, so an answer reveals nothing the caller could not already see):

1. guest: 403 `forbidden` (the endpoints are not in `auth/guest-endpoints.ts`; the functions check again);
2. room: not a member, archived or missing: **404**, the body of `GET /api/rooms/:id`'s missing room;
3. room not a private channel: 409 `not_private_channel`;
4. project: missing, not readable by the caller, or in the trash: **404**, the body of `GET /api/projects/:id`'s missing
   project (one body for all three);
5. project not in the zone (personal or legacy): 409 `project_not_linkable`;
6. no write on the folder: 403 `project_write_needed`;
7. the channel has an active link to another project: 409 `channel_linked` (the same project again: 200, unchanged);
8. the project has an active channel: 409 `project_has_channel`. **One rule:** the error never names the channel, for
   anyone. The caller reads the project, so the project page already shows them its channel (S3) where they may see it.

Unlink: steps 1–2, then "no active link" answers 204 as a success (idempotent), then 4 (a project the caller cannot read:
404) and 6.

**Transactions.** Link: `db.transaction(...).immediate()`; inside it re-read the room (member, not archived, named
group) and the project (`trashed_with`, zone) and judge write with a fresh `RuleSet.load`; delete any inactive row with
this `room_id` or this `project_id`; insert; write the event line (D4); write the audit row. After commit, `roomEvent(id,
'updated')` to the channel's members (each built by `roomOut` for its recipient). The unique key settles a race: the
second transaction fails with 409 `project_has_channel`.

Create: the rate limit and send token are taken as `createGroup` takes them (before its transaction). `createGroup`
gets one optional hook, `inTx?: (roomId: string) => void`, run inside its existing transaction after the members and the
`created` line: it re-checks the project (as Link steps 4–6, a fresh RuleSet) and inserts the link and the `project_linked`
line. A throw rolls back the room, its members and a guest's claim (`claimGuestRoom` is in the same transaction).
`roomEvent(id, 'added')` runs after commit as today.

**Audit** (the project only, never the room's id: a private channel is a group room, and `roomAuditRef`
(`rooms/store.ts:510`) names a group room by its kind only, since the same room id on several people's rows would tell
admins who talks to whom):

```ts
const room = roomAuditRef(r)   // always { kind: 'group' } here: only private channels link
audit(db, { actor: userId, action: 'project.channel_link',   target: projectId, detail: { room, via: 'channel' | 'project' | 'create', replaced: boolean } })
audit(db, { actor: userId, action: 'project.channel_unlink', target: projectId, detail: { room, via: 'channel' | 'project', replaced: false } })
audit(db, { actor: null,   action: 'project.channel_unlink', target: projectId, detail: { room, via: 'room_archived' | 'project_deleted', replaced: false } })
```

`replaced`: an inactive row on either side was replaced (D1). The shape test asserts that no room id appears anywhere in
any of these rows (target, detail, nested values, as a string search of the serialised row).

Admin paths that cut project paths for admins outside a project (members-only zone) need nothing here: no path is in it.

### D4. Who sees what (no new permission path; what is really disclosed)

- `Room.project?: { id, name, folderPath, canSave }`, built per viewer in `roomOut` by `projectFor(db, room, userId,
  rules)` (`rooms/store.ts`, beside `groupFolderFor`): present only for an **active** link and a viewer for whom
  `canSeeProject` and `RuleSet.canList(folderPath)` hold. `canSave`: the viewer is not a guest and `canWrite(folderPath)`.
  Rules read once per list (`rulesOnce`).
- `Room.canLinkProject?: true`: a non-guest member, a private channel, and no active link (or an active link the viewer
  sees: then the info row offers Unlink instead).
- `Project.channel?: { roomId, name, memberCount, inIt }`: only an **active** link (an archived room is skipped), only for
  someone who reads the project (`canSeeProject`), never with `member: false`, and **never for a guest who is not in the
  channel** (withheld in the API, not only on screen). `Project.canLinkChannel?: true`: may link (D3) and no active
  channel.

**What is disclosed, plainly:**
- To every channel member: that the channel was linked to *a* project (the event line, below), and, when they cannot see
  it, no Link control (`canLinkProject` absent). Never the project's name, folder or people, unless they can open it.
- To the project's readers (not guests outside the channel): the linked channel's **name and member count**, also when
  they are not in it. A private channel's name is thereby visible to its project's members. The link confirm (S2) says so
  before linking.
- A refused link tells the caller only what they can see already (the error order above).

**Event line.** A new `RoomEventLine` kind, stored as `{ type: 'project_linked', projectId }` / `{ type:
'project_unlinked', projectId }` and written by `eventLine` in the link transaction. Sent per viewer: `{ type:
'project_linked', project: { id, name } | null }`, the project only for a viewer who can open it now (the D4 test).
Words: "{actor} linked this channel to a project" (no project: everyone else), "{actor} linked this channel to the project
{name}" (those who can open it, the name a link to the project page); "{actor} unlinked this channel from a project" /
"… from the project {name}". Like every event line: no badge, notice, push, menu, and never given to the AI. An older
app shows its neutral `unknown` line. Create a channel writes the `created` line and then `project_linked`.

**Live** (finding 9). `afterAccessChange` → `groupFoldersChanged` (`rooms/service.ts`) grows a second pass for linked
channels: before the change, the linked group rooms of the people whose access changed (`teamRoomSeats` widened to
`linkedRoomSeats`: `room_members` ⋈ `room_project_links` for those people); after the sync, for each person still in such
a room whose project folder is at, under or above a changed folder, compare **both** `canList` (→ `Room.project`) and
`canWrite` (→ `canSave`) before and after; send `room.updated` when either answer changed. Bounded like
[20261116-live-folder-button](../../decisions/20261116-live-folder-button.md): only changed people, only linked rooms
near a changed folder. Link, unlink, project rename, trash, restore and delete send `room.updated` to the channel's
members (D5).

**Client refetch** (finding 14): a linked channel's Files button, Save to project and the project row refetch the room
(`GET /api/rooms/:id`) on a 404 from the folder or save (then hide what is gone) and on window focus; the project page
refetches the project on focus, so `Project.channel` follows a rename or a leave without a socket event of its own.

### D5. Lifecycle (where each event happens in code)

| Event | Where | Link row | Who is told |
| --- | --- | --- | --- |
| Channel renamed | `rename` | kept | project page on next load / focus |
| Last person leaves, is removed, or their account goes (archive) | `dropMembers`'s `run()` (also its `inTx` use from `sync`) | deleted in the same `run()` when `archived`; audit `reason: room_archived` | nobody in the room is left |
| Project renamed | `PATCH /api/projects/:id` | kept | `room.updated` to the channel's members |
| Folder repointed (admin) | the same PATCH | kept; inactive when outside the zone | `room.updated` |
| Project folder (or a folder above) to the trash | `TeamFiles.remove` (sets `projects.trashed_with`) | kept, inactive | `room.updated` to the channels of the projects it marked (the ids the UPDATE touched, read before it) |
| Restored from the trash | `TeamFiles` restore (the `back` ids, also a restore to another path) | active again if the new `folder_path` is in the zone | `room.updated` for `back` |
| Purged from the trash | trash purge (`projects` row stays, `trashed_with` set) | kept, inactive | none (already inactive) |
| Deleted for good | `DELETE /api/projects/:id` (both branches, also `ifEmpty`) | deleted explicitly in its transaction (and by cascade); audit `reason: project_deleted` | `room.updated` after commit |
| Member loses read or write | `afterAccessChange` | kept | that person, live (D4) |
| Channel member leaves (not the last) | `dropMembers` | kept | normal |

A team project cannot go back to "only me", so that row is not needed.

### D6. Save to project (one click, documents and media only)

- Shown on a file in a linked channel to a viewer with `Room.project.canSave`, when the file is a **document or media
  type** by its name's extension, checked case-insensitively after NFKC, from one shared list
  `shared/src/files/plain-kinds.ts PROJECT_PLAIN_EXT` (also used by D7):
  `md, txt, csv, pdf, doc, docx, xls, xlsx, ppt, pptx, hwp, hwpx, png, jpg, jpeg, gif, webp, heic, mp4, mov, webm, mp3,
  m4a, wav`. (`svg` and `html` are not on it: they can hold script.)
- **Falls back to the existing sheet** (project folder pre-selected, Choose another folder… kept) for everything else:
  runnable or config names (`Makefile`, `conftest.py`, `package.json`, `.sh`, `.py`, `.js`, `.ts`, `.toml`, `.yml`, …: anything
  not on the list), a dotfile, an instruction name (`instructionLike`: `CLAUDE.md`, `AGENTS.md`), a file that looks
  personal (`files[].sensitive`), and a message whose files are not all one-click files.
- One click: the client calls `POST /api/rooms/:id/save-plan` with `folder` = the project folder (existing), then
  `save-to-team`, so every server check stays (member, message visible, not quarantined, ≤ 50 MB, never an overwrite,
  "(2)" names, same bytes once, file history). The target is the **root** of the project folder: predictable for one
  click; hidden subfolders are never a target. The server checks the list again (`save-to-team` with `oneClick: true`
  refuses a name not on it with 409 `needs_sheet`), so an older or tampered client cannot skip the sheet for code.
- **Toast:** "Saved to {project} · Open · Undo". When the plan's count of people outside this channel who can open the
  folder is above 0: "Saved to {project} · {n} people outside this channel can open it · Undo" (Open stays in the
  toast's action). Undo (10 seconds, the toast's life) moves the copies this save made (`existed: false` only) to the
  trash through the normal file delete, each only if its bytes are still the saved sha256; a changed one stays ("It was
  changed, so it stays in {project}").
- Already saved: the chip shows "In project · {name}" (the existing "In team folder" link, project wording when the path
  is inside the linked project).
- Menu (right-click, long press): **Save to {project}** first, then **Save to another folder…** (today's sheet). Not
  linked, or no `canSave`: unchanged, **Save to team folder**.
- Never for guests (they never save), nor for members without `Room.project`.

### D7. The AI in a linked channel's side chat

**Where it saves** (`savePlaceFor`, `chat/side-room.ts`). Order, finding 10: (1) the asker is a guest → their own folder
(the guest check now runs **first**, before every room kind); (2) the room has an active link, the asker sees it and can
write the project folder → `{ path: folderPath, project: true }`; (3) today's order (group folder, Everyone → `shared/`,
smallest group, own folder + share).

**The prompt line** (`sideRoomSection`; the project name is user text, so quoted, cut to 100 characters and never
treated as instructions):
> This channel is linked to the project "{name}". Unless the person names another place, save new documents and media
> from this channel in the project's folder {folderPath} (its top level, or a subfolder the person names). Not everyone
> in this channel can necessarily open that folder: say who can open a saved file only from the save result's "Who can
> open the new file now" line.

**The narrow no-card rule** (the coordinator's decision; the owner's "fewer prompts"): in the linked channel's own side
chat, when the person's own message of this turn asked to save, a call that makes a **new** file whose name is on
`PROJECT_PLAIN_EXT` inside the active linked project's folder needs **no room card** (after a room read). The
**wider-audience card is kept** whenever people outside the channel can open the target folder: the rule removes the
extra room card, never the question "more people will see this". Why it is safe enough: the person asked for the save in
their own words, the link was a deliberate choice, and documents and media are not run by the project's dev environment.
Implemented as one extra test in `turn.ts` beside `newPlainFile` / `ownFolderPlace` (`linkedProjectPlain`): it applies
only when all hold:
- `askedToSave()` is true: the turn's own message asked to save (the same condition as the one-prompt rule of
  20261116-room-link-save-one-prompt: never a scheduled run's task text, an app-sent message, or words from the room);
  a room message that steers a save gets the card as before;
- the turn is a side chat (`side_room` set) of a room with an active link, judged at call time;
- the path, as `authorize(..., 'write')` resolves it for the person, is inside that project's `folder_path` (not
  another project, not `skills/`, no hidden segment, not `instructionLike`, not managed);
- the file does not exist yet and was not trashed by an AI turn (`aiTrashed`);
- the extension is on `PROJECT_PLAIN_EXT`;
- the target folder's readers are no wider than the project folder's own readers (a subfolder with an extra share or
  rule still asks: counted by the same reader as `widening()`);
- not a confidential chat, not a scheduled run, not safe operations.

The wider-audience card is judged separately and unchanged (`widening()`, `missingReaders`): a project with people
outside the channel gets it, with its usual counts and Always allow.

Everything else asks exactly as today: code and config names (the `inProjectFolder` protection in `turn.ts` stays: "its
dev environment may run a new file by its name (conftest.py, a Makefile, a package's scripts)"), an existing file, edits,
moves, copies, `save_url` downloads, a file outside the project folder. This **supersedes**, for this case only, the "a
project or managed folder … still asks" line of [20261116-room-link-save-one-prompt](../../decisions/20261116-room-link-save-one-prompt.md)
(the room card only; the wider-audience card of
[20261117-ai-save-my-files-default](../../decisions/20261117-ai-save-my-files-default.md) is not changed); the decision
file says so.
The "Who can open the new file now" line stays on every save.

### D8. Creating a channel from a project: pre-fill people only

- The dialog pre-ticks the project's **people** (individuals, from `GET /api/projects/:id/people`, groups expanded into
  their people; no group entries, so the channel never follows a group). The creator is always in. Owners and admins who
  only manage it are not listed.
- **Guests** of the project are listed **unticked** with the existing line (a guest can be in one group chat); a guest
  already in another group chat is greyed out ("A guest can be in one group chat and one project.").
- **Over 100:** a channel holds `ROOM_GROUP_MAX` = 100 people with me. When the project has more than 99 other people,
  nothing is pre-ticked and one line says "This project has {n} people. A channel can hold up to 100: pick who to add."
- A copy at creation, never a sync. Recommended because the owner's case is "the project's people talk in its channel".

### D9. Naming

- Default name: the project's name as typed, editable (max `ROOM_NAME_MAX`). No forced lowercase or hyphens: Trina
  channel names are free text and Korean names have no case. Duplicate channel names are allowed, as today.
- Words (English first, Slack's terms): Channel, Create a channel, Link a channel, Link to a project, Unlink, Files, Save
  to project, Save to another folder…. ko 채널 / 채널 만들기 / 채널 연결 / 프로젝트에 연결 / 연결 해제 / 프로젝트에 저장; ja,
  zh, es, id follow 20261116-sidebar-channels-dms's channel words.

## API

- `Room.project?`, `Room.canLinkProject?`, `Project.channel?`, `Project.canLinkChannel?` (D4); `RoomEventLine` kinds
  `project_linked`, `project_unlinked` (D4).
- `PUT /api/rooms/:id/project` `{ projectId }` → `Room`; `DELETE /api/rooms/:id/project` → 204;
  `POST /api/projects/:id/channel` `{ name, userIds }` → 201 `Room` (D3, its errors and order).
- `POST /api/rooms/:id/save-to-team` gains optional `oneClick: true` (409 `needs_sheet`, D6). `save-plan` unchanged.
- Pickers reuse lists: `GET /api/rooms` (filter on the client: private channels with `canLinkProject`), `GET
  /api/projects` (filter: `canLinkChannel`). No new reads.
- `POST /api/projects` is unchanged (the checkbox was cut).

## Screens (per item; computer 1440, phone 390, light and dark)

### S1. Channel header (linked, viewer can open the project)

```
1440
┌──────────────────────────────────────────────────────────────────────────────────┐
│ 🔒 Launch site   7 members                 [📁 Files]             ✦   🔔   ⋯     │
└──────────────────────────────────────────────────────────────────────────────────┘
   tooltip: "Open the Launch site project folder"

390
┌──────────────────────────────────────┐
│ ‹ 🔒 Launch site               📁 ✦ ⋯ │
│      7 members                        │
└──────────────────────────────────────┘
```

The group Files button's component, place and size (testid `room-project-files`), linking `/files?path=<folderPath>`,
pushed on history. A member who cannot open the project sees today's header. Not added: a project chip by the name, a
second button, an item in "⋯".

### S2. Channel info (opened from the name; MembersDialog)

```
┌ Launch site ───────────────────────────────── ✕ ┐
│ Name     Launch site                       ✎     │
│ Project  📁 Launch site                 Unlink    │   ← the name opens the project page
│ ─────────────────────────────────────────────── │
│ + Add people                                      │
└───────────────────────────────────────────────────┘

not linked (canLinkProject):   │ Project  Not linked          Link to a project │
linked, I can't see it:        (no Project row)
```

- **Link to a project** picker: a search box and my team projects with `canLinkChannel`; projects that already have a
  channel are not listed (`canLinkChannel` absent). **Empty:** "No projects to link. You can link a team project you're a
  member of and can edit." with a link to Projects.
- Confirm: "Link this channel to Launch site?" · "People here who can open the project's folder get a Files button and
  Save to project; others see no change. Everyone here sees that the channel was linked to a project. The project's 8
  members will see this channel's name on the project page." · Link / Cancel.
- Unlink confirm: "Files saved to the project stay there. Files sent in the channel stay in the channel."

### S3. Project page (team project; side column under Instructions and Files)

```
no channel (canLinkChannel)          linked, I'm in it            linked, I'm not in it
┌────────────────────────────────┐   ┌───────────────────────────┐   ┌──────────────────────────────┐
│ # Channel                       │   │ # Channel                 │   │ # Channel                    │
│   Talk about this project with  │   │ 🔒 Launch site · 7   Open  │   │ 🔒 Launch site · 7            │
│   its people.                   │   └───────────────────────────┘   │ Ask someone in the channel   │
│   [+ Create a channel]          │     ⋯ › Unlink (if I may)         │ to add you.                  │
│   or Link a channel             │                                   └──────────────────────────────┘
└────────────────────────────────┘
```

- Empty: the existing `EmptySideBox`, **Create a channel** as its one button (the owner's main path), "or Link a channel"
  as a text link. Filled: one `DisclosureRow`.
- **Link a channel** picker: my private channels with `canLinkProject` and no link. **Empty:** "You have no private
  channels without a project." with **Create a channel**.
- Not shown: a personal or legacy project, a project in the trash, an owner or admin outside it (`member: false`), a
  guest who is not in the channel (the API withholds it). Phone 390: the aside comes after the chats, as today; the row is
  one line; dialogs are bottom sheets.
- No Join button (decided). No channel preview, message count or members list here.

### S4. Create a channel (from S3)

```
┌ Create a channel for Launch site ────────────── ✕ ┐
│ Channel name  [ Launch site                  ]     │
│ People        [ Search people…               ]     │
│ ☑ Mina Kim  ☑ Leo Park  ☑ Jun Lee  ☑ Sora Choi     │   ← the project's people, ticked (no group entries)
│ ☐ Ari (guest) · this becomes their one group chat  │
│ A private channel: only the people you add can     │
│ read it. Its Files open this project's folder.      │
│                               Cancel  [Create]     │
└─────────────────────────────────────────────────────┘
```

The existing Create a channel picker (`PeoplePicker`, required name) with name and people pre-filled and one line.

### S5. New project dialog: unchanged (the checkbox was cut).

### S6. A file in a linked channel

```
computer (hover/focus)                         phone (long press sheet)
┌───────────────────────────────┐             ┌───────────────────────────┐
│ 📄 quote-v2.pdf  1.2 MB  ⤓  📁⁺ │             │ Save to Launch site       │
└───────────────────────────────┘             │ Save to another folder…   │
   📁⁺ tooltip "Save to Launch site"            │ Download                  │
   saved: 📁 "In project · quote-v2.pdf"        └───────────────────────────┘
toast: "Saved to Launch site · 3 people outside this channel can open it · Undo"
deploy.sh, package.json: the icon opens the sheet ("Where should this go?", project pre-selected)
```

The icon keeps its 24 px slot (the 11-17 rule).

## Edge cases

- **Member not in the project:** no button, no save, no project row, no AI default (falls back to today's order); they
  see the neutral "linked this channel to a project" line.
- **Lost write only:** the button stays, Save to project goes (live, `canSave`), the AI default falls back.
- **Hidden subfolders:** the button opens the root; Files shows what the rules allow; one-click and the AI default use
  the root; the no-card rule refuses a subfolder wider than the root.
- **Guests:** a guest in the channel whose one project is this one sees Files (`canList` applies `guestProjects`); never
  Save to project, never links, unlinks or creates (403), never pre-ticked; `Project.channel` withheld when not in the
  channel; the side chat's guest check runs first.
- **Phone 390:** folder icon only in the header; one-line rows; sheets; checked light and dark.
- **An existing per-project channel:** linked from its info or the project page's Link a channel; older files get Save to
  project from then on; nothing in the channel changes.
- **Two channels for one project:** the picker does not list a project with a channel; a race gets 409
  `project_has_channel` (never naming the channel).
- **A channel linked to a project that went to the trash or out of the zone:** inactive; it can link another project (the
  inactive row is replaced in the same transaction).
- **A project whose linked channel was archived:** the row went with the archive; an old row is skipped when read and
  replaced on link.
- **A group DM:** "Turn into a private channel" first. **Team channel / Everyone:** never offered.
- **Safe operations (1A) on:** linking and creating work; the AI no-card rule does not apply (cards ask as today).
- **Account removal:** `linked_by` set null; event lines keep their author as any line does.

## Steps

1. Server: migration 427; `rooms/project-link.ts` (active check, link, unlink, `projectFor`); `createGroup`'s `inTx`
   hook; `dropMembers` deletes the link on archive; the trash, restore, repoint and delete hooks with their
   `room.updated`; the event line kinds; `Room` and `Project` fields; three endpoints and contracts; the audit rows;
   `KEPT_WITH_ACCOUNT`; the live pass in `groupFoldersChanged`.
2. Server: `PROJECT_PLAIN_EXT`; `save-to-team` `oneClick`; `savePlaceFor` (guest first, then the link); the prompt line;
   `turn.ts linkedProjectPlain`.
3. Web: header button; channel info row, pickers with empty states, confirms; event line words; refetch on 404 and
   focus.
4. Web: project page row, Create dialog pre-fill and the over-100 line.
5. Web: Save to project on chip and menu, the toast with the outside count and Undo, "In project".
6. i18n in six languages; `docs/site` (channels and projects pages); `changes/channel-project-link.md`;
   `docs/decisions/20261119-channel-project-link.md` (names what D7 supersedes).

Two PRs (server, then web), batched with the day's other reviewed PRs per the batch rule.

## Risks

- **Disclosure:** the project's name goes only to those who can open it; a channel's name goes to the project's readers
  (said in the confirm); the event line tells every channel member that a link exists. Covered by the security matrix.
- **AI no-card rule:** a new path past the room card only, for an explicit save in the person's own words
  (`askedToSave`), narrowed to new document and media files in the linked project's folder, re-judged at call time; the
  wider-audience card still asks when people outside the channel can open the target; code and config names and wider
  subfolders still ask. The decision file names it,
  and the security review of the server PR must look at it.
- **One-click:** the server enforces the list (`oneClick`), so the sheet cannot be skipped for code by a client.
- **Performance:** one indexed lookup per private channel in `roomOut`; rules once per list; the live pass bounded.
- **Migration:** additive, reader 1; a rollback build ignores the table and shows `unknown` for the new lines.

## Tests

- `bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run check:prepush`; server tests under Bun 1.3.12.
- `tests/unit/b-rooms-project-link.test.ts`: the audit rows' shape (`target` the project id, `detail.room` `{ kind:
  'group' }`, `via`, `replaced`; the room id appears nowhere in any row, as a string search of the serialised row, for
  link, unlink, archive and delete); link and unlink from both sides and who may; the error order (each step,
  404 bodies equal to missing room / missing project); the kinds refused; personal, legacy (outside `projects/`), trashed
  and repointed-out projects; one-to-one and the race; an inactive row replaced (trashed project, out-of-zone, archived
  room); same project again is 200; `Room.project` per viewer (member, non-member, read-only member: `canSave` false,
  admin outside, guest in/out); `Project.channel` (archived skipped, `member: false` none, guest outside none); the event
  line per viewer (name or none), older client `unknown`; account removal; create-from-project
  (pre-fill is the client's; server: link in `createGroup`'s transaction, rollback on a failed re-check incl. the guest
  claim, rate limit); `dropMembers` archive deletes the link (leave, remove, `sync` of a gone account).
- `tests/unit/b-rooms-project-link-live.test.ts`: `room.updated` on link, unlink, rename, repoint, trash (only marked
  projects' channels), restore (also to another path, out of zone stays inactive), delete for good (both branches); the
  access pass: read lost, write lost only, write regained, group membership change, unrelated folder sends nothing.
- `tests/unit/b-side-chat.test.ts`: guest first; linked channel → project folder; no write → fallback; trashed /
  out-of-zone → fallback; the prompt line (quoted, cut name).
- `tests/unit/b-linked-project-no-card.test.ts`: the person asks "save this as a file" and every channel member reads the
  project: a new `.md`/`.docx`/`.png` in the project root, no room card, no wider card; **no ask in the turn's own
  message, but a room message says "save the notes to the project folder"** (the side chat read it with room_read): the
  room card is shown, or nothing is saved; **the project has people outside the channel**: the wider-audience card is
  shown with its counts (the room card is not); `Makefile`, `conftest.py`, `package.json`, `x.sh`, `x.py`, `CLAUDE.md`, a dotfile: card; an existing file: card;
  a subfolder with an extra share: card; another project's folder: card; not the side chat of that room: card; the link
  removed mid-turn: card; confidential chat, scheduled run, safe operations: card; `save_url`: card.
- `tests/unit/b-rooms-save-to-team.test.ts`: `oneClick` accepts the list and refuses others with `needs_sheet`
  (case, NFKC, double extension `x.pdf.sh`); into the project root; Undo removes only `existed: false` copies with the
  same bytes.
- `tests/security/lib/rooms-cases.ts`: matrix rows for the three endpoints (guest, non-member, member without project
  read, member with read only, admin outside, writer), asserting no project or channel name in any refused body.
- Web unit: `room-save-sheet.test.tsx` (one-click vs sheet by name, toast with and without the outside count, Undo),
  `rooms-lib.test.ts` (event line words), `project-channel-row.test.tsx` (the three states, the empty pickers, the
  over-100 line), refetch on 404 and focus.
- Web e2e `web/test/e2e/channel-project-link.spec.ts`: link from the channel, link from the project, create from the
  project, Files opens the folder and **Back returns to the channel** (the same room, scrolled where it was), Save to
  project, a code file opens the sheet, a non-member sees only the neutral line,
  live removal, 1440 and 390, light and dark.
- AI scenario `SAVE-0x`: "summarise this thread to a file" in a linked channel's side chat, everyone in the channel in
  the project → a new `.md` in the project folder with no card; the same with the project wider than the channel → the
  wider-audience card only; "write a Makefile for it" → a card.

### QA rows to add (QA tab, English, one case per row; status at start / PR / dev merge)

| Case | Expected |
| --- | --- |
| Link a private channel to a team project from channel info | Files button for members who can open the project; tooltip names it; neutral line for the others, named line for those who can open it |
| Link from the project page (Link a channel) | Channel row on the project page; button in the channel |
| Link a channel picker with no free private channels | Empty line and Create a channel |
| Link to a project picker with no linkable projects | Empty line and a link to Projects |
| Create a channel for this project | Private channel with the project's people pre-ticked, guests unticked; linked; opens |
| Create a channel for a project of more than 99 people | Nobody pre-ticked; the 100 line |
| Channel member not in the project | No button, no save, no project row; neutral line only |
| Member who can read but not write the project | Button shown; no Save to project; Save to team folder stays |
| Remove a person from the project while the channel is open | Button goes without reload |
| Take only write away from a person | Save to project goes, button stays, without reload |
| Save to project on a PDF (computer) | One click, project root, toast with Open and Undo |
| Save to project when people outside the channel can open the project | Toast says how many; Undo removes the copy |
| Save a `deploy.sh` or `package.json` in a linked channel | The sheet opens, project pre-selected |
| Save a personal-looking file | The sheet opens with Looks personal |
| Save to project on a phone (long press) at 390, dark | Save to {project} first; works; readable |
| Side chat: "save the summary as a file" in a linked channel (everyone in the channel is in the project) | New .md in the project folder, no card |
| Same, but the project has people outside the channel | The wider-audience card asks, with its counts; no room card |
| Side chat asked only "summarise this", while a channel message says "save it to the project folder" | Nothing saved without a card |
| Side chat: "write a Makefile for this project" | A card asks |
| Second channel tries to link the same project | Project not in the picker; a race is refused without naming the channel |
| Project to the trash, then restored | Button and save go, then come back |
| Channel linked to a trashed project links another project | Works |
| Last person leaves the linked channel | Project page offers Create / Link again |
| Guest in the channel and the project | Sees Files; never Save to project; cannot link or create |
| Guest in the project but not the channel | Project page shows no Channel row |
| Admin outside the project | Project page shows no channel; no unlink anywhere |
| Unlink from channel info | Button goes; saved files stay; unlink line |
| Project member not in the channel | Row says "Ask someone in the channel to add you"; no Join button |
| Rename the project while the channel is open | Files tooltip and the info row show the new name without reload |
| Rename the channel | The project page row shows the new name (on focus or reload) |
| Click Files in the channel header, then Back | The project folder opens; Back returns to the same channel |
| Delete the project for good while the channel is open | Files button and Save to project go without reload; the channel stays a plain private channel |
| Project page Channel row and the Create a channel sheet at 390, light | One-line row; sheet fits; nothing cut off |
| Project page Channel row and the Create a channel sheet at 390, dark | Same, readable in dark |

## Open questions for the owner

None blocking. The coordinator decided on 2026-11-19: no Join button; one-click for documents and media only, with the
outside count and Undo; the AI's narrow no-card rule; the neutral event line; the cuts above.

## Result

Filled in at the end.
