# A file sent in a room is at most 1 GB, for everyone

- Date: 2026-11-16
- Status: accepted
- Supersedes: the limit parts of [Uploads are written to disk as they arrive](20261116-room-file-upload-memory.md) (Rule 2: 10 GB in a room) and of [A guest uploads files of up to 100 MB](20261116-guest-room-file-limit.md) (the 10 GB choice)
- Branch: fix/room-file-limit-1gb (the owner: "1기가")

- **Ask:** rooms took files of up to 10 GB, and an admin could let guests send 10 GB too. How large may a file sent in
  a chat be?
- **Rule:** a member, an admin or the owner sends files of up to 1 GB in a room (a DM, a group chat, a team room):
  `ROOM_FILE_MAX`, one fixed limit like Slack's, with no setting to raise it. A guest sends up to 100 MB by default; the
  owner or an admin may raise that to 1 GB, never above the member limit, so the guest choices are 100 MB and 1 GB
  (`TeamSettings.guestFileMax`: `'100mb' | '1gb'`; a PATCH with `'10gb'` is refused, 400).
- **A team that picked 10 GB before:** the stored `'10gb'` is read as `'1gb'` (`admin/settings.ts` `getTeamSettings`),
  not dropped to the 100 MB default: the admin page shows 1 GB, and the guest's limit everywhere is 1 GB. Nothing is
  rewritten; the next save stores a valid choice.
- **Where it is checked:** unchanged, now with 1 GB: when an upload session with a room target is made, before any byte
  is sent, and again where the file is kept (`RoomFiles.create`: a finished session, one request, a team file's copy),
  413 `room_file_too_large` with "This file is too big to send in a chat. The limit is 1 GB." The room box refuses a
  larger file before it reads it ("… is larger than 1 GB and can't be sent.", from `rooms.tooBig` in every language).
- **Left as it is:** the Files page and folder uploads (20 GB a file, `UPLOAD_SESSION_MAX`); a guest's other uploads
  (their project's folder, an AI chat) keep the guest limit; the 50 MB single-request routes.
- **Tests:** `tests/unit/a-guests-room-file-limit.test.ts` (1 GB fits and one byte more is refused for a member at the
  start and where it is kept; the guest default, raised to 1 GB, a stored 10 GB read as 1 GB, 10 GB refused as a new
  choice), `tests/unit/http-multipart-stream.test.ts` (the refusal's words), `web/test/unit/guest-file-limit.test.tsx`
  (the two Admin choices, the room box's pre-check for a guest and a member).
- **Version impact:** no migration. A member's upload over 1 GB that started before the update is refused when it
  completes.
