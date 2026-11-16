# A team room's Files button follows folder rule and group changes live

- Date: 2026-11-16
- Status: accepted
- Supersedes: the "Left out" line of [A group's room links to the group's folder](20261116-room-group-folder-button.md)
- Branch: fix/live-folder-button-and-thread-updating (QA TC-3848)

- **Ask:** when an admin changes who may open a group's folder, the Files button in that group's room should appear or
  disappear for the people concerned without a reload.
- **Rule:** every change that can move folder access goes through `afterAccessChange` (`server/src/admin/folders.ts`:
  folder rules, group membership, roles, accounts). Before the room sync it reads the team rooms of the people whose
  access changed (`teamRoomSeats`); after the sync it calls `groupFoldersChanged` (`server/src/rooms/service.ts`), which
  sends `room.updated` (change `updated`) to those of them still in the room whose answer to
  `RuleSet.canList(<group folder>)` differs between the state before and after. Each event is built for its recipient
  with `roomOut`, as every other `room.updated`, so it carries `groupFolder` only for someone who may open it.
- **Bounded:** only the people whose access changed (never a room's other members: a change at the team root costs a
  check per changed person and room), and only team rooms whose group folder is at, under or above a folder whose access
  changed (a folder below it matters: a readable subfolder makes the group folder listable). A rule on an unrelated
  folder sends no team room event.
- **Joiners and leavers:** someone not in the room before the change (they joined with it, or their account was switched
  on again) gets only the sync's `added`, which already carries the room as they see it; someone the sync took out, or
  whose account was switched off, gets only `removed`.
- **Resume:** the event is published after the person's replay buffer was emptied for the access change, so it is kept:
  a window from before the change resumes with the `access_changed` notice and this event, not a resync.
- **Never throws:** the change is saved; a failure is logged and the button follows on the next list load.
- **Tests:** `tests/unit/b-rooms-group-folder.test.ts` (a member loses and regains the field through the live event, by
  a rule change and by a group membership change; a role change both ways; an account switched off and on; a new group
  member gets `added` only; the others are not told; an unrelated folder sends nothing);
  `tests/unit/b-rooms-group-folder-resume.test.ts` (real sockets: resume from before the change, resume after the
  event, the event live and replayed); web e2e `web/test/e2e/room-group-folder.spec.ts` (the button goes and comes back
  on a live `room.updated`, no reload).
- **Version impact:** patch (no API change; more `room.updated` events of an existing kind).
