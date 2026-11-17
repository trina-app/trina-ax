# The people who sent files in conversations clean them up; an admin can ask them all at once

- Date: 2026-11-16
- Status: accepted
- Supersedes: none (the parent plan's "a view of the existing search" became a page, see below)
- Branch: feat/room-files-cleanup (the owner: "go similar to Slack, go"; plan "Files sent in conversations, like
  Slack", decisions 5 and 6)

- **Ask:** files sent in conversations fill the team's small disk, and nobody could see their own to tidy them. Slack:
  any member or guest deletes the files they uploaded; admins see counts, never other people's files.
- **Rule 1, Files you sent** (`/sent-files`, `GET /api/room-files/mine`): everyone, guests too, sees their own files
  in the conversations they are in now, of their messages that are not deleted and that they still see, largest first,
  with the space they take together ("Your files in your conversations take 2.3 GB."). A row opens its message.
  Delete deletes the message it was sent with, the author's own right as in the conversation; the confirm says so and
  how many other files go with it, and every file of that message leaves the list. Index `room_files_by_sender`
  (migration 414).
- **Why a page, not a view inside Search** (the parent plan said a view): the clean-up notice must open it, and Search
  is a dialog with no address. It has no menu item, like the chat trash (`/trash`). Ways in: Search ("Files you sent",
  on the Files type and by its words), the clean-up notice, and a file refused for a full disk (members and guests).
- **Rule 2, Ask people to clean up** (`POST /api/admin/storage/ask-cleanup`, owner and admins; a button on the storage
  card under the lines, shown when there are files in conversations): an Activity notice (`storage.cleanup`) to each
  active person whose own files in conversations take more than 1 GB together (`ROOM_FILE_MAX`), or, when nobody does,
  more than 100 MB; counted only where they can still delete them (a member now, conversation not archived, message
  not deleted). "{name} asked the people whose files in conversations take the most space to delete what they no
  longer need. See the files you sent." ("An admin" once that account is gone.)
- **Never who or how many:** the answer is `{ askedAt }` only, the audit row (`storage.ask_cleanup`) has the actor and
  nothing else, the card says "Asked today", and the notices are recorded after the answer so its time tells nothing.
  The confirm says "You won't see who." In a tiny team an admin can still guess; Slack has the same.
- **Once a day for the team**, by the team's time zone: the notice's source is that day, so a second press or two
  admins at once send nothing more; the button reads "Asked today" for every admin until the team's next day.
- **Left out:** files nobody can delete are neither listed nor counted (a conversation the sender left, a DM closed
  because the other person left, a deactivated sender); archived conversations' files go by themselves after 30 days
  (20261116-archived-room-files-purge.md). The page's total is what the database records; the storage card's number is
  the folder on disk (with previews and unsent uploads) measured hourly, so the two are not meant to match.
- **Tests:** `tests/unit/b-rooms-sent-files.test.ts` (only mine; left, deleted and others' files out; largest first;
  pages; total; who is asked, 1 GB and the 100 MB fallback; once a day; the answer, audit and notice; member 403; the
  asker gone), the permission matrix cases, `web/test/unit/room-files-cleanup.test.tsx`,
  `web/test/e2e/storage-ask-cleanup.spec.ts`.
- **Version impact:** minor (migration 414, an index; two endpoints; the notice kind's table is migration 702's).
