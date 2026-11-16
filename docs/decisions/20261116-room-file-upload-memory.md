# Uploads are written to disk as they arrive; a room takes files of up to 10 GB through upload sessions

- Date: 2026-11-16
- Status: accepted
- Supersedes: none
- Branch: fix/room-file-upload-memory (the owner; a production team server killed by a ~100 MB room upload on 0.5.9)
- Limit changed: a room now takes files of up to 1 GB, and a guest at most 1 GB; the 10 GB in this file no longer
  holds ([A file sent in a room is at most 1 GB, for everyone](20261116-room-file-limit-1gb.md)).

- **What broke:** `POST /api/rooms/:id/files` (and every other multipart route: `/api/files/upload`, `/api/uploads`,
  `/api/transcribe`, `/api/admin/plugins/inspect`) read its body with `Request.formData()` in `http/route.ts`. That
  reads the whole body into memory before any size check can run. The only guards were the `Content-Length` header and
  `Bun.serve`'s `maxRequestBodySize` (51 MB), and Bun 1.3.12 (the Bun that server builds ship) does not apply that
  limit to a body without `Content-Length` (`Transfer-Encoding: chunked`, which a proxy in front may choose). Such a
  body of any size was buffered whole, answered 413 only afterwards, and the memory was not given back. Measured on
  Bun 1.3.12: each 100 MB attempt added 100 to 130 MB of resident memory for good (264 MB to 2.15 GB after twelve
  attempts). On a 3.8 GB server a few attempts ended in the kernel's out-of-memory kill.
- **Rule 1 (no upload in memory):** a multipart body is read as a stream (`server/src/http/multipart.ts`). The file part
  goes straight to a private temp file in `<data>/uploads/tmp` (0600, a server-made name) and is hashed on the way; text
  fields, part headers and delimiters together may take 64 KiB. The limit is counted while the bytes arrive, so a
  missing or false `Content-Length` changes nothing; past the limit the server stops reading, answers 413 and ends the
  connection (`Connection: close`). The temp file is removed on every refusal, on a dropped connection and after the
  handler unless the handler moved it into place. Handlers get `{ path, size, name, sha256 }` instead of a `File`.
- **Rule 2 (10 GB in a room):** the owner's limit for a file sent in a room is 10 GB (`ROOM_FILE_MAX`). One request
  still carries at most 50 MB: a proxy in front of a team server refuses a larger request (Cloudflare's 100 MB), and
  hosted teams go through the relay. So a larger file uses the upload sessions the Files page already uses
  (`uploads/sessions.ts`: 8 MB chunks written straight into one sparse part file, sha256 computed on the way,
  resumable for 24 h after the last chunk), with a new target `{ kind: 'room', roomId, name }`. Being in the room, the
  name and the 10 GB limit are checked when the session is made, before any byte is sent ("This file is too big to
  send in a chat. The limit is 10 GB.", 413 with `params.reason: room_file_too_large`), and again when it
  completes; a session refused for good then (the room left or closed) is dropped with its part file. Cancelling a
  session whose file is already in place removes that unsent file. The finished part file is moved (renamed) into the room's folder; on another disk it is copied without
  holding the server up. The free-disk and plan-storage checks are the upload sessions' own.
- **What touches a big room file afterwards:** hashing is streamed. A picture is read whole only up to 50 MB (its
  place and camera data are cut out, a thumbnail is made); a larger file named like a picture is kept as a plain file
  with no preview. The AI's room file tool reads at most its own limit (32 MB); its "save to team files" tool read up to 1 GiB into
  memory, which was harmless while a room file was at most 50 MB, and now refuses a file over 50 MB (the person
  downloads it and uploads it in Files);
  the Hangul preview has its own input limit; the in-app viewer already shows only the first part of a file or offers
  the download. Downloads are streamed with Range (sendfile on Linux). Room files are part of every team-folder
  backup, so large room files make backups larger: the plan's storage limit counts them.
- **Left as it is:** the 50 MB limits of the single-request routes, of a team file copied into a room and of a chat
  shared with people; the Files page limit (20 GB). Still read whole, each at most 50 MB: a picture sent in a room, and a plugin file an admin uploads to be checked.
  macOS direct downloads still use the pull stream described in `team-files/download.ts` (no backpressure in
  Bun 1.3.12), which is a development and office-Mac matter, not a hosted one.
- **Tests:** `tests/unit/http-multipart-stream.test.ts` (any chunk split, a body without a length that never ends is
  refused once the limit is passed and no more is read, a declared length over the limit is refused before a byte is
  read, no temp file after a refusal or a dropped connection, the room route, the room target of an upload session,
  the 10 GB refusal, a room left meanwhile, a large "picture" kept as a plain file).
- **Version impact:** none for stored data. Older web clients keep working (the single-request route is unchanged up
  to 50 MB); a newer web client needs a server with the room target for files over 8 MB, which ship together.
