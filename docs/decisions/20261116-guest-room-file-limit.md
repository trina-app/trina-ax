# A guest uploads files of up to 100 MB; the owner or an admin can raise it

- Date: 2026-11-16
- Status: accepted
- Supersedes: none
- Branch: fix/room-upload-followups (the owner, after rooms began to take files of up to 10 GB)
- Limit changed: a room now takes files of up to 1 GB, and a guest at most 1 GB; the 10 GB in this file no longer
  holds ([A file sent in a room is at most 1 GB, for everyone](20261116-room-file-limit-1gb.md)).

- **Ask:** rooms now take files of up to 10 GB ([Uploads are written to disk as they arrive](20261116-room-file-upload-memory.md)).
  A guest is someone from outside the team; should they be able to fill the team's storage with 10 GB files?
- **Rule:** the largest file a guest may upload is 100 MB by default. The owner or an admin can raise it for all guests
  to 1 GB or 10 GB (`TeamSettings.guestFileMax`). It covers every upload a guest makes: a file sent in a room, a file
  put in their project's folder and a file attached to an AI chat. A recording to transcribe is not for a guest at all
  (403). Members, admins and the owner are not held to it (10 GB in a room, 20 GB elsewhere).
- **Where it is checked:** on the server, from the person's role and the setting at the time of the upload
  (`uploads/guest-limit.ts`): when an upload session is made, for every target, before any byte is sent or any disk
  room is reserved; again when the session completes (a limit lowered meanwhile holds: nothing of the file is kept and
  the session ends); and in the single-request routes (`/api/rooms/:id/files`, `/api/files/upload`, `/api/uploads`),
  which carry at most 50 MB each, under the smallest guest limit. The answer is 413 with `params.maxBytes` and the
  guest's own limit in words: in a room "This file is too big to send in a chat. The limit is 100 MB."
  (`room_file_too_large`), elsewhere "This file is too big. As a guest you can upload files up to 100 MB."
  (`guest_file_too_large`). The web app reads the guest's limit from `Me.team.uploadMaxBytes` and refuses a larger
  file before it reads it (the room box, the AI chat box, a folder upload); guests' open pages are told when the
  setting changes and read it again.
- **Where it is set:** Admin > Members & invites, one line over the Guests list ("Largest file a guest can upload":
  100 MB, 1 GB, 10 GB), saved as it is picked. Choices, not a free number: three sizes a person can tell apart. The
  Guests section shows once the team has a guest (a team with none has no such section), so the default holds until
  then.
- **Left out:** a limit per guest, a limit on how much a guest may upload in total (the plan's storage limit and the
  free disk check still apply to every upload), files the AI makes for a guest.
- **Tests:** `tests/unit/a-guests-room-file-limit.test.ts`, `web/test/unit/guest-file-limit.test.tsx`.
- **Version impact:** a new team setting with a default; no migration. Teams whose guests sent files of up to 50 MB
  before see no change below 100 MB.
