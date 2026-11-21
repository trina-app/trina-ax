# Structure polish, four P3 fixes from the qa.trina.app walk (TC-6730 to TC-6733)

- Date (UTC): 2026-11-21 15:03
- Branch: `fix/p3-structure-polish`
- Status: in progress
- Where: `server/src/rooms/`, `shared/src/api/rooms.ts`, `web/src/components/{rooms,panels}/`, `web/src/lib/rooms.ts`, the six
  `web/src/i18n/*.ts`, one additive migration. Why: batch #245 left four visible rough edges (rooms, files are core).
- Version impact: **patch**: no new feature; one optional API field (`Room.listed`) and one optional query
  (`?listed=1`) that only fix list behaviour, one additive migration (reader 1).

## Goal

1. **TC-6730** The room header keeps "Moving files…" after the move finishes, until a reload. The mover now sends
   `room.updated` to every member when a room's moves settle (also when no closing line is written).
2. **TC-6731** Two people convert one conversation at the same time: the loser read "can't become a project". The
   server answers 409 `already_project` (with `projectId` when the caller can read it); the dialog says "This
   conversation just became a project." with a link to it.
3. **TC-6732** In a department room the file chip's folder link read "QA-Team3 › Cha…". The last folder
   ("Chat attachments") stays whole; the group's name is the part that is cut.
4. **TC-6733** A project room made by "Make it a project" or "New project with" vanished from the list on reload
   (listed only after its first message) and was counted as a hidden conversation. New `room_project_links.listed`
   (migration 434): set by a conversion and by `POST /api/projects/:id/room?listed=1` (the DM dialog); the room
   comes back as `Room.listed`, and the list shows it. A room the project page opens by itself stays unlisted until
   its first message. The "Hidden conversations" count was `all - shown`, so it counted those unlisted rooms; it now
   counts only rooms I hid, as the Chats page does.

## Scope

In: the four fixes, their unit and web tests, six languages (Korean says 대화방), a `changes/` note.
Out: the mock/e2e server beyond what the unit tests need; listing rooms the project page made before a message.

## Steps

1. Plan and `changes/` note (first commit).
2. Server: mover emits `room.updated` on settle; `already_project`; migration 434 + `listed`; schema.
3. Web: dialog line and link, `listedRoom`, hidden count, chip split, `?listed=1`; six languages.
4. Tests: `b-make-project`, `b-room-file-moves`, `structure-polish.test.tsx`; typecheck, prepush, i18n.
5. One independent review; one PR to `dev` (not queued: batched for 0.6.1); QA rows set to "Fixed in #<pr>".

## Decisions

- Rooms made before this update by a conversion are marked listed by the migration (from their `project_made` line).
  A "New project with" room made before it cannot be told from a project page's room, so it stays unlisted until its
  first message.
