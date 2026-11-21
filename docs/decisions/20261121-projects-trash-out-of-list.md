# A project in the trash leaves the Projects list; one quiet Trash row at its bottom holds it

- Date: 2026-11-21
- Status: accepted
- Supersedes: the list part of [A team project in the trash: its members keep its card](../DECISIONS.md#a-team-project-in-the-trash-its-members-keep-its-card--휴지통의-팀-프로젝트-멤버에게는-카드가-남아요-fixproject-trash-ux-2026-11-13-the-owner-qa-tc-10601064-tc-1066)
- Branch: fix/projects-trash-out-of-list (the owner, qa screenshot 2026-11-21)

- **Ask:** "Team projects" on qa mixed live projects with many trashed ones, each a trash icon and "in the trash". The
  owner: "지운 게 저렇게 보여야해?"
- **Rule:** a team project in the trash is no row of any group in the Projects list (the panel beside the rail, the
  phone's Projects tab) and no card on the Projects page. At the bottom of the list there is one quiet "Trash" row with
  a count, shown only to someone who can restore at least one trashed project (`Project.canRestore`: the owner and
  admins, a creator who is one of its members) and only while there is one. It opens a dialog (a bottom sheet on a
  phone) with the trashed projects the list already gives that person (`GET /api/projects?manage=1`: `inTrash` with
  `trashed`, and `wasMember` or `canRestore`), newest first: the name (a link to its page), who moved it there and when
  (the in-the-trash note's words), and Restore where `canRestore` (the page's own restore, at once). A member who can
  restore none sees no row; a link to a trashed project still opens the in-the-trash note ("An admin or … can restore
  it").
- **Why:** as Drive and Notion: deleted things are out of the way, in one place, for whoever can bring them back.
- **Permissions:** unchanged. No new read: every row of the dialog is one the person already had (as an "in the trash"
  row, or in Files › Trash for an admin who is not a member). Files › Trash keeps its project rows; Delete for good
  stays on the project's page and in Files › Trash.
- **Tests:** `web/test/unit/projects-trash-row.test.ts`, `web/test/e2e/projects-panel.spec.ts` (hidden rows and cards,
  the row per role, restore from it, 390 and 1440).
- **Version impact:** patch.
