# A private channel linked to a team project: one folder, the project's

- Date: 2026-11-19
- Status: accepted
- Supersedes: for one case only, the "a project or managed folder … still asks" line of
  [20261116-room-link-save-one-prompt](20261116-room-link-save-one-prompt.md): in a linked channel's own side chat, a
  new document or media file in the linked project's folder that the person's own message asked to save needs no room
  card. The wider-audience card of [20261117-ai-save-my-files-default](20261117-ai-save-my-files-default.md) is not
  changed.
- Branch: feat/channel-project-link (plan: docs/AGENTS/plan/20261119-channel-project-link.md; the owner approved it)

- **Ask (the owner, 2026-11-19):** teams make one channel per project, but a file posted there stays in conversation
  storage while the project keeps its files in `projects/<name>`. One folder, the project's.
- **Rule:**
  - A **private channel** (a named group room) can be linked to **one team project** in `projects/<name>`, and a project
    to one channel (`room_project_links`, migration 427: the room id is the key, a unique index on the project). A row
    counts only while it is active (the room not archived, the project not in the trash and in the zone); an inactive
    row is replaced by the next link of either side.
  - Linking, unlinking and **Create a channel** (from the project page, with the project's people pre-ticked, never a
    sync) are for a non-guest member of the channel who reads and writes the project; nobody else, admins included.
    Errors in a fixed order (guest, room, kind, project, zone, write, channel linked, project has a channel), each
    revealing nothing the caller could not see; the project's channel is never named in a refusal.
  - `Room.project` (the header's **Files** button, **Save to project**) only for a viewer who can open the project now;
    `Project.channel` (name, member count) only for someone who reads the project, never for a guest outside the
    channel. Event lines name the project only to a viewer who can open it. Audit rows (`project.channel_link`,
    `project.channel_unlink`) name the project only: a group room by its kind, never its id.
  - **Save to project** is one click for documents and media by name (`shared/src/files/plain-kinds.ts`), into the top of
    the project folder; anything else, and personal-looking files, go through the save sheet. The server checks the
    list for a one-click save (`oneClick`, 409 `needs_sheet`): a guard on the one-click path only: the same person may still save any file there through the sheet (the ordinary save, with their own write access), which is the person's own choice, not a bypass.
  - **Undo** takes back only a copy that one-click save made (`existed: false`): the save returns a token kept on the
    server for about 30 seconds, for that person, that place and that copy on disk (`statKey`); `save-undo` takes only
    the token, checks the same person, the same file on disk and the room file's own sha256, moves it to the trash and
    spends the token. Every other case is one 404 and nothing changes.
  - The channel's side chat saves new documents in the project folder by default (the guest check first). In that side
    chat, when the person's own message asked to save (`askedToSave`), a new document or media file in the project's
    folder needs no room card (`chat/turn.ts linkedProjectPlain`); the wider-audience card still asks when people
    outside the channel can open it. Code and config names, an existing file, a subfolder with an extra reader, another
    project, a scheduled run, a confidential chat and safe operations ask as before.
  - Lifecycle: the link goes when the channel is archived or the project is deleted for good (audited by the system),
    and is inactive while the project is in the trash or outside the zone. Link, unlink, rename, trash, restore and
    delete send `room.updated` to the channel's members; an access change sends it to whoever's open or save answer
    changed (rooms/service.ts groupFoldersChanged, second pass).
- **Why:** one place for a project's files without moving people between two member lists (Slack's one Files place,
  Linear's project channel made from the project, Asana's "only editors link").
- **Left out:** copying channel files by itself; syncing members either way; a Join button; several channels per project;
  project activity posted into the channel.
- **Tests:** tests/unit/b-rooms-project-link.test.ts, b-rooms-project-link-live.test.ts, b-linked-project-no-card.test.ts,
  b-side-chat.test.ts, b-rooms-save-to-team.test.ts (oneClick), tests/security/lib/rooms-cases.ts; web unit and
  web/test/e2e/channel-project-link.spec.ts.
- **Version impact:** minor (one additive table, three endpoints, optional fields, two event line kinds).
