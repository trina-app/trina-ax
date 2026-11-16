# A room upload goes on when the person leaves the room; large uploads take turns; an empty upload session lives an hour

- Date: 2026-11-16
- Status: accepted
- Supersedes: none
- Branch: fix/room-upload-followups (review of #1104, QA TC-3932)

Follows [Uploads are written to disk as they arrive](20261116-room-file-upload-memory.md), which let a room take files
of up to 10 GB.

- **Leaving the room (Rule):** a room box's files live above the room page (`web/src/store/roomUploads.ts`, by place,
  like its draft). An upload goes on while the person is in another room or on another page. They can see it in Chats:
  the room's row in both lists shows a small "Uploading a file" mark, and the chip, with what is happening to it, is in
  that room's box when they come back. A file is sent only when they press send in that box; nothing is sent for them.
  **Why not "abort and resume later":** a paused upload with no chip is invisible, and coming back would not start it
  again by itself (the page cannot keep the file across a reload, only across rooms).
- **The other exits:** closing or reloading the tab while a file is going up asks first (the browser's own prompt, as a
  folder upload does), and the page does not reload by itself then. After a reload the chip is gone like any file not
  sent; the pieces stay on the server for 24 hours and picking the same file again in that room continues from them.
  Signing out stops every upload, drops the sessions the server holds (one still being made goes with its first hour)
  and leaves no chip for the next person on that computer; a sign-in that ends another way (expired, ended, another
  person signing in) stops and forgets them too. A room the person is no longer in loses its uploads.
- **Many files at once (Rule):** at most three upload sessions are open from a page at a time
  (`lib/upload.ts SESSIONS_AT_ONCE`); the others wait ("Waiting for its turn") before anything of them is read. The
  server's limit of ten unfinished sessions a person stays. **Why not one request up to 50 MB again:** a single large
  request has no resume and holds a whole copy of the file in the browser's memory (the reason for the 8 MB line), and
  the Files page had the same failure for large files, which a queue fixes in one place.
- **Sessions left behind (Rule):** an upload session that has not received a chunk lives one hour
  (`SESSION_EMPTY_TTL_MS`); its first chunk gives it the usual 24 hours, so resuming a started upload is unchanged
  (Files too). A file taken out while its session is being made: the page waits for the answer and drops that session.
  **Why not reserve disk as chunks arrive:** the part file is sparse and the up-front reservation is what stops several
  large uploads from passing the storage limit together.
- **What a large upload says:** waiting for its turn, "Checking the file" (its checksum, before any byte goes out), its
  percent, waiting for the connection, "Finishing". No percent while it is checked: it would fall back to 0 when the
  bytes start.
- **Not changed:** what guests may send; the limits (10 GB in a room, 50 MB in one request, ten sessions a person).
- **Tests:** `web/test/unit/upload-turns.test.ts`, `web/test/unit/file-drop.test.tsx` (the room page),
  `tests/unit/c-uploads-empty-session.test.ts`.
