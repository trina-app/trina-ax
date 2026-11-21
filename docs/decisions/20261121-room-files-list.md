# Every conversation has a Files list; a group's folder is its first row

- Date: 2026-11-21
- Status: accepted (the Files list shipped; its group-folder part, the folder as the list's first row, is superseded by
  [A department's room puts its uploads in the department's folder](20261121-department-room-files.md))
- Supersedes: the header button of [20261116-room-group-folder-button.md](20261116-room-group-folder-button.md) (its
  rule of who sees the folder stays)
- Branch: feat/room-files-list (plan [20261120-1136-project-is-room.md](../AGENTS/plan/20261120-1136-project-is-room.md)
  D8, step 4)

- **Ask:** the plan's D8: every channel, 1:1 and group chat gets an in-room **Files** list, and ⌘K shows recent room
  files before anything is typed.
- **Rule:** the header's **Files** (a files icon alone on a phone) opens the room's Files list on its right, in the side
  chat's place (one of the two at a time; a sheet in a narrow window, the whole screen on a phone):
  `GET /api/rooms/:id/files`, newest first, in pages, each row checked as on read (a member now, a message they see:
  their start, never a private preview, an answer hidden from them or its thread, a project file only while they can
  read it, otherwise left out). A row opens the file viewer. A project's chat room has no list (404; its header has the
  project's button). ⌘K: `GET /api/room-files/recent`, the five newest of all their rooms with the same checks, a
  project room's file included only while readable (never as "unavailable").
- **The group's folder:** a team room's folder button (2026-11-16) sat in the same header place with the same word,
  **Files**. Two buttons both called Files would not make sense, so the folder is now the list's first row ("Open the
  leads folder"), one more click away. Who sees it is unchanged (`Room.groupFolder`). Status `proposed` until the
  owner agrees to that extra click; the other way is a second header button for the folder.
- **Speed:** a new partial index `room_files_by_room` (migration 431) reads one room's sent files newest first with no
  sort; the search across rooms keeps its walk by rowid (`+f.room_id`).
- **Tests:** `tests/unit/b-rooms-files-list.test.ts`, `tests/security/lib/rooms-cases.ts` (listRoomFiles,
  recentRoomFiles: a former member, a narrowed project folder, a guest), `web/test/unit/room-files-list.test.tsx`,
  `web/test/e2e/room-files-list.spec.ts` (1440 and 390).
- **Version impact:** minor (two endpoints, a migration and a visible header and ⌘K change).
