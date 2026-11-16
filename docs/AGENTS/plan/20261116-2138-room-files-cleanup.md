# Files you sent, and "Ask people to clean up"

- Date (UTC): 2026-11-16 21:38
- Branch: `feat/room-files-cleanup` (on top of `feat/storage-full-notices`: it uses that branch's notice table and
  refused-file words)
- Status: done
- Where: Team AX core (`server/src/rooms/`, `server/src/routes/`, `server/src/notifications/`, `server/src/system/`,
  `shared/src/api/`, `web/src/pages/`, `web/src/components/`, `web/src/i18n/*`). Why: conversations, storage and admin
  are core (docs/REPOSITORY-RULES.md).
- Version impact: minor. One migration (an index), two endpoints, one notice kind (its table exists from migration 702).
- Parent plan: "Files sent in conversations, like Slack" (reviewed 2026-11-16), phase P3, first part. The archived
  conversations' files are a separate small PR.

## Goal

Like Slack, the people who sent the files are the ones who clean them up. Today nobody can see the files they sent in
conversations, so nobody can tidy. After this:
- everyone (members, guests, admins, the owner) can open **Files you sent**: their own files in conversations, largest
  first, with the space they take in total, and delete each one (the message it was sent with goes too, as today);
- owners and admins get one button under "Files in conversations" on the storage card: **Ask people to clean up**. It
  sends a notice to each person whose files in conversations take more than 1 GB. The admin is never told who or how
  many.

## Scope

In:
1. **Server, the list.** `GET /api/room-files/mine` (new endpoint, `listMyRoomFiles`; guests may call it): my files of
   sent messages that are not deleted and not event lines, in conversations I am a member of now and that are not
   archived; largest first (size DESC, then newest), a cursor of (size, rowid), at most 50 a page; each row the same
   `RoomFileSearchHit` the search gives (file, message, conversation, sender, time) and the conversations' names as
   the search gives them (`RoomSearchRoom`); `totalBytes`: the sum over all of them (not only the page). Built on the
   search's own checks (`myRooms`, `canSee`, `fileOut`), so it never lists what the person could not see by opening
   the conversation. A new endpoint rather than `mine`/`sort` on `GET /api/room-files`: the search's query needs a text,
   and its order is newest first by design.
2. **Index:** migration `414_b_room_files_by_sender.sql`: `room_files(user_id, size DESC) WHERE message_id IS NOT NULL` (413 is taken by an open branch).
3. **Server, ask.** `POST /api/admin/storage/ask-cleanup` (owner and admins): picks the active people whose files in
   conversations (the rule of 1) take more than 1 GB in total, and records `storage.cleanup` (table `storage_notices`,
   `by_user` = the asker) for each; at most once per 24 h for the team (settings key `system.storageCleanupAskedAt`; a
   second press in that time sends nothing and answers the same). Answers `{ askedAt }` and nothing about recipients;
   audit row `storage.ask_cleanup` with the actor only (`detail: {}`). `GET /api/admin/storage` gains
   `cleanupAskedAt` (optional), so the button reads "Asked today" for every admin for 24 h.
4. **Notice** `storage.cleanup`: "{name} asked everyone with large files in conversations to delete what they no longer
   need. See the files you sent." ("An admin asked …" when the asker's account is gone); it opens Files you sent. Shown
   always, Activity only, no push. Plumbing as `storage.filling` (enum, `tableOf`, `out`, `eventEnabled`, a new link
   `sent_files`). The asking admin gets it too when they are over 1 GB.
5. **Web, the page** `/sent-files` ("Files you sent"), no menu item: the shared `PageHeader`, one line "Your files in
   conversations take 2.3 GB. Largest first.", then shared `ListRow`s (icon; name; second line conversation · date ·
   size; at the end a Delete icon button). A row opens the message in its conversation (as a search hit does). Delete
   asks first (shared `confirmDialog`): "Delete report.mp4? The message it was sent with is deleted too, for everyone
   in the conversation." Then `DELETE /api/rooms/:id/messages/:messageId` (author only, today's rule); the row goes and
   the total drops. States: loading (Skeleton), error ("Couldn't load your files." + Try again), empty ("You haven't sent
   any files in conversations."), a failed delete (toast "Couldn't delete. Try again.", the row stays), more pages
   ("Show more"). Phone: the same page full width with the app's back.
6. **Ways in** (no new menu item): Search, an action "Files you sent" (listed on the Files type with no text, found by
   its words elsewhere); the `storage.cleanup` notice; a refused file in a conversation for a member or guest gets "See
   the files you sent" (the phase-2 chip, beside "Ask an admin…"); owners and admins keep "See what uses the space".
7. **Web, the button** on the storage card under the breakdown (owner and admins): "Ask people to clean up" → confirm
   "Everyone whose files in conversations take more than 1 GB gets a notice asking them to delete what they no longer
   need. You won't see who." [Ask] → "Asked today" (disabled) until 24 h after; failure: toast "Couldn't send. Try
   again." Only when the breakdown is there and `rooms` > 0. Phone: full width under the lines.

Out: any list of other people's files or who was asked; bulk delete; removing a file but keeping its message; a files
list per conversation; push.

Added on screen: one page (no menu item), one Search action, one link on a refused chip (members, guests), one button
on the storage card (owner, admins), one notice kind. Removed: nothing.

## Decisions

`docs/decisions/20261116-room-files-cleanup.md`: the people who sent files clean up; the page is a page (a notice must
open it, and Search is a dialog with no address); "Ask people to clean up" picks people over 1 GB and never shows them;
once a day for the team; counted only where the person can still delete (a member now, conversation not archived).

## Risks

- Privacy: the admin's answer, the audit row and the notice name no recipient; a test checks the answer and the audit.
  In a tiny team an admin can still guess; Slack has the same.
- A guest's own files: they see only conversations they are in now.
- Deleting the message deletes its text and every file in it; the confirm says the message goes.
- The total is the person's own; nothing shows other people's.
- Migration number 413 (B's next); `check:migrations`, other open PRs.

## Tests

Server (Bun 1.3.12): the list (only mine; largest first; cursor; a message deleted, a conversation left, an archived
one, someone else's file: not listed; totalBytes), guests; ask-cleanup (who gets it: over 1 GB yes, under no, a
member's files in a conversation they left do not count; once a day; the answer and audit name nobody; member 403);
the notice's words and link; account removal; route coverage and the permission matrix. Web unit: the page's states
and the delete confirm; the notice text/link; the chip's link by role. e2e (mock): the page at 1440 and 390, Delete,
empty; the button and "Asked today". Real: a copy of the QA team, owner/admin/member/guest, 1440 and 390, light and
dark.

## Result

Built, with the spec review's changes (a fresh subagent, against current code):
- Delete takes the whole message: every file of it leaves the list and the total; the confirm says how many others go.
- The notice carries `cleanup: { by }` (a name while the asker's account is active, else "An admin").
- Migration 414, a partial index (413 is used by an open branch).
- Once a day by the team's time zone; the day is the notice's source, in one transaction with the setting (two admins
  at once send once).
- The list calls `syncFor` first, as the search does; the count for others is its own SQL rule (member now, not
  archived, not deleted).
- The notices are recorded after the answer (no timing hint).
- When nobody is over 1 GB, those over 100 MB are asked; the words say "the people whose files take the most space".
- The Search action is outside the guests' guard (typed, and listed on the Files type).
- Wording: "Your files in your conversations take …"; the confirm "People whose files … take the most space …".
- A page modelled on `/trash` (shared PageHeader, ListRow, confirmDialog, EmptyState, ErrorNote, Skeleton).
