# A department's room puts its uploads in the department's folder

- Date: 2026-11-21
- Status: accepted
- Supersedes: the group-folder part of [Every conversation has a Files list](20261121-room-files-list.md) (the folder as
  the list's first row); the rule of who sees the folder ([20261116-room-group-folder-button.md](20261116-room-group-folder-button.md))
  stays
- Branch: feat/group-room-folder-files, feat/structure-polish-web (plan
  [20261121-0619-structure-polish.md](../AGENTS/plan/20261121-0619-structure-polish.md) B, #212; QA TC-6304..TC-6308)

- **Ask (the IA/UX review, owner-approved 2026-11-21):** a department's room kept its own files apart from the
  department's folder, so the same team's files were in two places.
- **Rule:**
  - A file sent from the computer in a department's team room (`kind = 'team'` with a group) is placed in
    `<group folder>/Chat attachments/` with a `room_file_refs` row, as a project room's files are
    (`chatAttachmentsPlace`, `teamPlaceFor`).
  - It stays in room storage instead, with nothing refused, when the group has no folder (or it is missing or in the
    trash), when **the folder rule is wider than the members** (someone who is not the owner or an admin, active and not
    in the room, reads it: everyone, a role, another group or a person, inherited rules included), when a room member
    cannot read Chat attachments, when the uploader cannot write there, for a private preview, an answer's attached copy,
    and under safe operations. Such a file is labelled "Only in this conversation".
  - **Wide inherited rules.** Group folders are not limited and inherit from the root and `groups/`. A team whose root
    gives everyone read therefore keeps every department upload in room storage. That is correct: everyone could read
    that folder. If the folder is widened after an upload, the file is a group-folder file and its new readers see it in
    Files.
  - **Admins outside the department** read the group folder, as they read every folder outside `users/`, so they can
    open the room's new uploads in Files, which they could not before. **Accepted by the owner on 2026-11-21**, said in
    the release notes and the admin notes. They do not become room members and get 404 for the room's file endpoint.
  - **Header.** A team room with a folder I can open (`Room.groupFolder`) shows the folder button with the group's name
    first ("Open the {name} folder"). Its Files list shows only while it holds files of its own (`Room.roomFiles`: older
    files and uploads that stayed) and lists only those. A file in the folder shows "{group} › Chat attachments" beside
    its name. Deleting a message deletes only the message, and the confirm adds "The file stays in {group} › Chat
    attachments." for a file in the folder; a room-stored file goes with the message as before.
  - **Later joiners.** People who join the department later can open every earlier upload in its Chat attachments
    folder, but not the messages from before they joined. This is the same as a project.
  - **Before it is sent.** An upload sits in Chat attachments, readable by the department and admins, from the moment
    it is added until it is sent, discarded (✕), or cleared after 24 hours.
  - **A department folder inside a project** keeps the room's uploads in room storage, not in the folder.
  - **A person turned back on.** If someone who can open the folder is disabled and later turned back on, they can open
    the uploads made in the meantime. This is the same as the folder being widened later.
  - Old files of department rooms stay in room storage (in that Files list, room search and ⌘K recent).
- **Why:** one place for a team's files, the same model as a project's room.
- **Left out:** moving the old room-stored files; the Everyone room (no folder) and the welcome steps' team group (no
  room), which stay as they are.
- **Tests:** tests/unit/b-group-room-folder-files.test.ts, tests/security/lib/rooms-cases.ts,
  web/test/unit/room-files-list.test.tsx, web/test/e2e/room-group-folder.spec.ts.
- **Version impact:** minor (where new uploads go, a visible header change).
