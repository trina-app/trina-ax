# The trash confirm for a team project names where it goes; same-named trashed projects show their path

- Date: 2026-11-18
- Status: accepted
- Supersedes: none
- Branch: fix/project-trash-wording (QA TC-4971)

Follows [A team project in the trash: its members keep its card](../DECISIONS.md#a-team-project-in-the-trash-its-members-keep-its-card--휴지통의-팀-프로젝트-멤버에게는-카드가-남아요-fixproject-trash-ux-2026-11-13-the-owner-qa-tc-10601064-tc-1066).

- **Ask:** the "Move to trash" confirm said members can't open the project until an admin or its creator restores it, but not
  where it goes or for how long. Two trashed projects with one name looked the same in Files › Trash.
- **Rule 1, the confirm:** "Members can't open its files or shared chats. It stays in Files › Trash for {days} days, where
  an admin or its creator can restore it." The days are the team's file-trash retention (Admin › Team settings
  `trashRetentionDays`), sent to the web as `Me.team.trashRetentionDays` (like `chatTrashRetentionDays`) and refreshed when an
  owner saves it. No number is written in the web. An older server does not send it: the confirm keeps the old sentence
  (no number named). The guest line stays under it.
- **Rule 2, the trash list:** when two or more trashed project rows share a name (letter case and Unicode form ignored),
  each shows its whole folder path in the Files sidebar's words ("Projects › Launch", "My projects › Launch") instead of only
  the folder it sits in. A project with a name of its own keeps the short place.
- **Tests:** `web/test/unit/trash-list.test.ts` (same-named rows), `web/test/unit/project-list-menu.test.tsx` (the confirm names
  the team's days, never 30 by default).
