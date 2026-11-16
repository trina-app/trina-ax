# Files: "Everyone on the team" as a recipient, and one notice for several files shared at once

- Date: 2026-11-16
- Status: accepted
- Supersedes: none
- Branch: feat/file-share-everyone (the owner, decisions 3-1 B and 3-2 A; QA TC-3509, TC-3510)

Plan: docs/AGENTS/plan/20261116-0255-file-share-everyone.md. Follows
[Find work files: share some of the added files with the team](20261116-find-files-share-step.md), whose open
questions these answer, and the archive's "A member shares their own files" (#979).

- **Ask (3-1 B):** a whole-team recipient for file shares, covering members now and later, never guests. **(3-2 A):**
  one press that shares several files tells each person once, "<name> shared 5 files with you", with one push, and
  opens a list of those files; a single file reads as before.
- **Everyone on the team is a group grant with the reserved id `*`** (`FILE_SHARE_EVERYONE`) in `file_share_grants`,
  not a new subject type. Why: the table's `subject_type` CHECK allows only user and group, migrations are additive
  (no table rebuild), and as a group row every way a grant goes already takes it: ✕ in the dialog, a move or a folder
  save that narrows (`sharesNarrowedByMove`, `removeLinksIn`), Remove all, a file that dies, the trash, a purge. No
  real group has that id (group ids are uuids; the server checks it before the groups table). An older build reads it
  as a group nobody is in: no access (it only narrows).
- **Who it reaches:** every active, not deleted, non-guest account when the file is opened (`REACHES` in
  files/shares.ts: the link page, the download, `sharedBy`, the notice's sharer, `grantees` for Remove all's count and
  the "who was newly added" notices, `linkPeopleIn` for the folder dialog's count). Someone who joins later opens it;
  a guest, a switched-off or deleted account never does. Guests are refused before any grant check anyway (`open`).
- **Who may add it: the existing rules, exactly.** Whoever may share the file now (`shareRight`): its owner with edit
  access, members only while "Members can share files they own" is on; the team owner and admins for any team file,
  as they may share it with any person or group today. A member may add only their own groups, but the whole team is
  not someone else's group: they are in it, so a member may add it to their own file. It counts as one of the 50.
- **Audit:** `file.share` with `everyone: true` (its people are not counted as a group).
- **Where it is offered:** the first option of the people-and-groups search in the file Share dialog and in Find work
  files' share step ("Everyone on the team", "Everyone in your team, also people who join later"). Before the press,
  one line: "Everyone on the team will be able to open this file, also people who join later." (the step: "… the 2
  files you ticked …"). The row afterwards: "Everyone on the team · Can view · ✕". The projects and chats pickers do
  not offer it; their endpoints refuse `*` as an unknown group.
- **One notice per press (3-2 A): a batch endpoint**, `POST /api/files/shares/batch` {paths ≤ 100, add}, rather than
  a batch id on the PUT: the notices are written after every file of the press is done, which needs one call. Each
  file is `change()`'s add with its own rules; a file refused is listed with the server's words and the rest go on.
  Each person newly given access: one file → that file's notice as before; several → one notice whose source is
  `b:<batch id>` (`file_share_batches`, `file_share_batch_items`, migration 356). The notice and
  `GET /api/files/shared-batch/:id` (the list page `/f/batch/:id`) show only the files of the press the viewer can
  open now, and answer only someone the press told (404 otherwise; the id is 16 random bytes like a link's).
- **The rate budget is by the press's size: one token per 10 files.** The room send budget exists so a share is no
  free probe of who exists. A press names the same people for every file, so it probes once; a token per file would
  cut a 25-file press in half (20 at once, then one a second). But a file costs work (a hash of up to 32 MB on its
  first share, a walk over the accounts when someone is added), so one token per 10 files (20 files: 2; 100: 10).
  Taken before anything is checked.
- **No free probe (security review of #1038, Low):** the people are checked only after the caller may share the file
  (the PUT) or at least one file of the press, and the token is taken before that check, so a refused name costs the
  same as a real one and a run of tries ends in 429. The "who may open it" walks run only when someone is added.
- **Browser push:** the service worker (web/pwa/sw.js) knows `file.shared`: the generic line, and a click opens the file
  or the press's list, the id from the signed-in notice.
- **Push (new for file shares):** `file_share_push_deliveries`, pushed only for a share by name (`named=1`), like a
  chat shared by name: a group's or the whole team's people get the Activity row alone (sharing with everyone does not
  ring every phone). Wanted while unread, outside quiet hours, while a file of it still opens. Code `file.shared`;
  the lock screen says "Someone shared files with you." (never who or which; the gateway has the same line, a gateway
  from before it says "You have a new notification"). A tap opens `/f/<id>` or `/f/batch/<id>`.
- **Retention:** a press's row goes with its last notice (the 30-day notice clean-up) or with its sharer's account
  (account removal, `file_share_batches.by_user`).
- **Not done:** the iPhone extension's name in the push title (needs an app build: the generic line shows), a setting
  "Files shared with me" for the push (push follows the person's push switch and quiet hours), "Shared with me",
  removing the whole team from many files at once, the AI tool's `share_with_person` naming the whole team.
- Tests: `tests/unit/c-file-share-everyone.test.ts` (Bun 1.4 and 1.3.12), `push-locale.test.ts`; web unit
  `share-found.test.ts`; e2e `file-share-everyone.spec.ts` (owner, admin, member; the press's notice and list),
  `find-work-files.spec.ts` (the step with the whole team); screenshots with `FILE_SHARE_EVERYONE_SHOTS` and
  `FIND_SHARE_SHOTS`.
- Version impact: **minor** (a recipient, two endpoints, a page, a push code, an additive migration).
