# Team projects: restore, concurrent edits, trash wording, delete

넣을 곳: Team AX core (`server/src/chat/`, `server/src/team-files/service.ts`, `server/src/routes/chats.ts`, `web/src/components/`), 이유: projects and their trash are core.

QA rows TC-1012 to TC-1016.

## Plan
- TC-1014: a team project restored from the trash (the project page's Restore or the folder on Files › Trash, both
  `restoreTrash`) resumes, for each person who sees it again, the scheduled tasks a due run paused because it was gone
  (`schedules.resumeForProject`, only tasks whose last change is that pause and made after the folder went to the trash;
  never a task the person turned off). New `chat/project-restore.ts`.
- TC-1015: confirmed: nothing told members' open lists that the shared chats were back (the trash sent
  `chat.updated` 'deleted'). The same follow-up publishes `chat.updated` 'restored' for each shared chat.
- TC-1013: `PATCH /api/projects/:id` takes an optional `base` (name and instructions as the form loaded them). A base
  that differs from the project now: 409 `project_changed` with the current name and instructions, nothing saved. The
  edit form sends it; on 409 it keeps the person's text in the boxes, shows the other person's version under it and a
  plain message; a second Save keeps theirs. Older clients (no base) save as before.
- TC-1012: a project in the trash shows "in the trash" alone (no "No members left"): `whoSeesProject` says nothing for
  it; the Projects panel row (phone list) says "in the trash" with a trash icon.
- TC-1016: confirmed by the code: a member's older project on an admin's folder (folder_made 0) showed Delete to its
  creator, and the server answered 409 project_folder_stays. `Project.canDelete` says it before the click; the card
  and page menus hide Delete then.

## Tests
- `tests/unit/b-project-restore.test.ts`: tasks resume after a restore (not the one turned off), members hear
  `chat.updated` 'restored', 409 on a stale base and a save without base, canDelete for the old member project.
- Web unit test for the form's 409.
