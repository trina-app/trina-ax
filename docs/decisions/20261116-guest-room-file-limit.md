# A guest sends files of up to 100 MB in a chat; the owner or an admin can raise it

- Date: 2026-11-16
- Status: accepted
- Supersedes: none
- Branch: fix/room-upload-followups (the owner, after rooms began to take files of up to 10 GB)

- **Ask:** rooms now take files of up to 10 GB ([Uploads are written to disk as they arrive](20261116-room-file-upload-memory.md)).
  A guest is someone from outside the team; should they be able to fill the team's storage with 10 GB files?
- **Rule:** a guest's largest file in a room is 100 MB by default. The owner or an admin can raise it for all guests to
  1 GB or 10 GB (`TeamSettings.guestRoomFileMax`), never above a member's limit. Members, admins and the owner send up
  to 10 GB whatever the setting says.
- **Where it is checked:** on the server, from the sender's role at the time of the upload (`rooms/files.ts maxFor`):
  when an upload session with a room target is made (before any byte is sent) and again where any room upload is kept
  (a finished session; a single request and a team file's copy pass the same check, though each carries at most 50 MB,
  under the smallest guest limit), so a limit lowered while a file was on its way holds. The
  answer is 413 with `params.reason: room_file_too_large`, `params.maxBytes`, and the words "This file is too big to
  send in a chat. The limit is 100 MB." with the guest's own limit. The web app reads the guest's limit from
  `Me.team.roomFileMaxBytes` and refuses a larger file before it reads it; guests' open pages are told when the
  setting changes and read it again.
- **Where it is set:** Admin > Members & invites, one line over the Guests list ("Largest file a guest can send in a
  chat": 100 MB, 1 GB, 10 GB), saved as it is picked. The Guests section shows once the team has a guest (a team with
  none has no such section), so the default holds until then. Choices, not a free number: three sizes a person can tell apart.
- **Left out:** a limit per guest, a limit on how much a guest may send in total (the plan's storage limit and the free
  disk check still apply to every upload), limits for files a guest uploads to a project's folder.
- **Tests:** `tests/unit/a-guests-room-file-limit.test.ts`, `web/test/unit/guest-file-limit.test.tsx`.
- **Version impact:** a new team setting with a default; no migration. Teams whose guests sent files of up to 50 MB
  before see no change below 100 MB.
