# Files › Shared with me lists what a grant gives you now; opening a shared file marks its notice read

- Date: 2026-11-16
- Status: accepted
- Supersedes: none
- Branch: feat/files-shared-with-me (file sharing P2, PR 1; QA TC-3093 "P2")

Plan: docs/AGENTS/plan/20261116-0947-files-shared-with-me.md (reviewed independently; the review's changes are in it).
Follows the archive's "A member shares their own files" (its P2 list) and
[Everyone on the team as a recipient](20261116-file-share-everyone.md) (its "Not done" list).

- **Ask:** someone who was given files finds them again without digging through Activity.
- **Where:** one row **Shared with me** under **Recent files** in Files' places (computer and phone), always there for
  members, owners and admins, also while empty. The page is `/files?view=shared` (a query, no new route). A row opens
  the file's link page (`/f/<id>`), which then shows **‹ Shared with me**; opened from anywhere else it does not.
- **What is listed (rule):** a file is listed when a grant reaches the caller now (by name, a group they are in, or the
  whole team for an active non-guest), the share is live, its owner (when known) can still edit the file, the caller
  is not its owner, and the file is at its path and not plainly another file. A file the folder rules already let the
  caller read is listed only for a grant **by name**: a group's or the whole team's share of such a file changes
  nothing for them, would fill every member's list for one Everyone share in `shared/`, and told them nothing in
  Activity either. A by-name share is always listed, even when Activity said nothing (it notifies only new openers).
  If an admin narrows a folder and keeps its links, a file shared with Everyone there appears for the people who lost
  folder read: that grant is now their only way in.
- **Who and when:** one helper, `sharerFor()`, for the list and the link page: the newest grant that qualifies (by
  name when the folder lets the caller read the file, else any grant that reaches them). A granter whose account is
  gone is "A former member" in both. The link page now also names the sharer when the file opens by the folder rules
  and a by-name grant exists. The list is ordered by the newest grant that reaches the caller; in the rare case of a
  folder-readable file with a newer group grant than its by-name grant, the row sits at the newer time and names the
  by-name grant.
- **No path, ever:** the row carries the link id, the file's own name, the sharer's name and the time; no path,
  folder, owner, size, type or picture version (a recorded size can be stale; the type comes from the name).
- **Cost:** no new table or index (`file_share_grants_subject` from 355 answers the three lookups, unioned). The list
  never writes, never hashes and never walks the accounts: `open()` was split into pure `pinState()` (same / dead /
  needs a hash) and `grantOpens()`, which both the list and `open()` use; `open()` keeps its side effects (hash, repin,
  mark dead). A file that only a hash could tell apart is listed under the name it already had, and a click answers
  "You need access". Per call: at most 2,000 grant rows, 100 files looked at on disk, 50 listed; `next` is the key of
  the last row read. A page may be empty while `next` is set; the client reads on (at most 10 calls per read) and shows
  the empty line only when nothing more is left.
- **Live:** one content-free notice `file_shares_changed` (no id, path, count or person) to every connected active
  non-guest member, at most once a second per team, sent after the change is saved. The DB steps inside other areas'
  transactions (move, trash, restore, purge, a folder save's link removal, a row going dead) only flag the team in
  memory; the file-share service sends the notice from a timer once the step has returned. The service also raises it
  for its own changes (add, remove, Remove all, account removal) and after every access change (a folder save, a
  group's people, someone's groups or role). Why a broadcast: a precise recipient list would need group and account
  reads inside folder moves and folder saves, and the notice says nothing, so every member learning "some share
  changed at T" is negligible (lists already reload on `files.changed`). Guests never get it. The page also reads again
  when the window comes back after 30 s.
- **Mark read on open:** opening a file on its link page (GET `/api/files/shared/:id` answering open) marks the caller's
  own "shared with you" notice of that file read, and the notice of every press that holds it (one file of "Mina
  shared 5 files with you" opened: the press is read; the list shows the rest). Only there, never in `open()`, which
  every Activity row, a press's list and push run (marking there would mark the whole Activity list read as it is
  shown). The badge follows (`notifications.changed`), and a push still retrying stops (it is wanted only while unread).
- **Guests:** the endpoint is not in the guest endpoints, so 403 at the route; the service refuses too. A guest has no
  Files tab. File links stay closed to guests both ways (the plan's open question 2: no).
- **Account removal:** nothing new to clean (the list is computed). The shares of every file the deleted person owned
  go with their account, team files they added included, so such a row disappears for its recipients; a row shared by
  someone who did not own the file (an admin sharing a teammate's file) stays and says "A former member".
- **Not done (later PRs):** "Share a file" and this section in the other five doc languages; a greyed guest row in the
  Share dialog; phone push for access requests with a "File sharing" switch (migration 358); the iPhone extension's
  sharer name and `/f/` app links. Not planned: search over files shared by name, "Remove from Shared with me", a
  "Shared by me" list, counts or filters.
- Tests: `tests/unit/c-file-shared-with-me.test.ts`, `tests/security/file-shares-p2.test.ts` (soundness: every listed
  file opens; completeness: every qualifying share is listed), the permission matrix case `sharedWithMe`; web e2e
  `files-shared-with-me.spec.ts` (owner, admin, member; 1440 and 390; light and dark; en and ko pictures with
  `FILES_SHARED_SHOTS`).
- Version impact: **minor** (a list, one endpoint, one notice code; no migration).
