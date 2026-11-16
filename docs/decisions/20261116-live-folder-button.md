# A team room's Files button follows folder rule and group changes live

- Date: 2026-11-16
- Status: accepted
- Supersedes: the "Left out" line of [A group's room links to the group's folder](20261116-room-group-folder-button.md)
- Branch: fix/live-folder-button-and-thread-updating (QA TC-3848)

- **Ask:** when an admin changes who may open a group's folder, the Files button in that group's room should appear or
  disappear for the people concerned without a reload.
- **Rule:** every change that can move folder access goes through `afterAccessChange` (`server/src/admin/folders.ts`:
  folder rules, group membership, roles, accounts). After the room sync it calls `groupFoldersChanged`
  (`server/src/rooms/service.ts`), which sends `room.updated` (change `updated`) to the members of a team room whose
  answer to `RuleSet.canList(<group folder>)` differs between the state before and after. Each event is built for its
  recipient with `roomOut`, as every other `room.updated`, so it carries `groupFolder` only for someone who may open it.
- **Bounded:** only team rooms whose group folder is at, under or above a folder whose access changed for someone (a
  folder below it matters: a readable subfolder makes the group folder listable), and in those rooms only the members
  whose answer changed. Nobody else is told. A rule on an unrelated folder sends no team room event.
- **Left to the room sync:** someone who joins or leaves the room in the same change already gets `added` or `removed`
  with the room as they see it; people new to the team or gone from it are skipped here.
- **Never throws:** the change is saved; a failure is logged and the button follows on the next list load.
- **Tests:** `tests/unit/b-rooms-group-folder.test.ts` (a member loses and regains the field through the live event, by
  a rule change and by a group membership change; the others are not told; an unrelated folder sends nothing); web e2e
  `web/test/e2e/room-group-folder.spec.ts` (the button goes and comes back on a live `room.updated`, no reload).
- **Version impact:** patch (no API change; more `room.updated` events of an existing kind).
