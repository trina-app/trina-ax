# Pictures kept in the team folder show as pictures in rooms

- Date (UTC): 2026-11-22 08:40
- Branch: `fix/project-room-pictures`
- Status: in progress
- Where: server/src/rooms (file-refs.ts, files.ts), server/src/routes/rooms.ts, web/src/components/rooms. Why: the
  room file endpoint and its view of a team-folder file live there.
- Version impact: patch. A bug fix: pictures sent in a group channel or a project room show as pictures again; no API
  shape change (RoomFile.thumb is now true for them).

## Goal

A picture pasted in a department's group channel ("leads") or a project's room is placed in the team folder
("leads › Chat attachments", rooms/team-place.ts, since the department-room files batch #245 of 2026-11-21) and kept
as a room_file_refs row. Its RoomFile always said `thumb: false` (rooms/file-refs.ts view), and the web shows a picture
only for `kind === 'image' && thumb`, so every such picture, a fresh 36 KB PNG too, was a file chip. Pictures there
should look like pictures in any other room: alone, and in the equal-height gallery, opening the viewer on click.

## Scope

In:
- Every room file kept in the team folder (one path for all of them: a computer upload in a project room or a group
  channel, createInTeamFolder; a team file picked in a project room, teamRef; a conversation's files moved when it is
  made a project, file-moves.ts): `thumb` is true when the server can give a preview of it now.
- The thumbnail endpoint (`?thumb=1`) for such a file: a thumbnail made from the team file as it is now (640 px, the
  room thumbnails' size and look: a GIF's first frame, a transparent PNG as PNG), kept in
  `<data dir>/room-team-thumbs/<room file id>/<dev>-<ino>-<size>-<mtime>.<jpg|png>` and made again when the file
  changes; the original only when it is a small web image (≤ 2 MB, PNG/JPEG/GIF/WebP) and no thumbnail could be made.
  Never a large original. Every request checks access first, as today (in the room now, may see the message, reads
  the team file's path now; quarantined files are unavailable; download-only rows get no thumbnail).
- A picture renamed to a non-picture name stays a chip; a deleted or unavailable one keeps its gone state; HEIC gets a
  thumbnail when this server converts HEIC (as room photos do), else a chip; SVG and TIFF stay chips (rooms make no
  thumbnail of them either).
- The picture's tooltip names its place ("Open image.png · leads › Chat attachments").
- Cache cleanup when the room file row goes.

Out:
- The Trina chat's team-file references (uploads/team-refs.ts thumbnail) are a separate code path: they already show
  pictures up to 2 MB and fall back to a chip after a failed load; not changed here.

## Steps

1. Plan (this file).
2. Server: file-refs.ts `view()` sets `thumb` by `teamThumbPossible`; rooms/files.ts `openThumb()` (async) makes or
   reads the cached thumbnail through a descriptor checked against the access check's stat; the route uses it.
3. Web: the picture tooltip names the place for a team file.
4. Tests: unit (thumb flag, thumbnail access, cache key change, rename, gone, quarantine, large original never sent),
   e2e (a project room picture and a gallery; a group channel picture).
5. Screenshots 1440/390 light/dark.

## Decisions

none

## Risks

Serves team-file bytes (as a thumbnail): access checks run before every read; the thumbnail is made from a copy read
through a descriptor bound to the checked inode (no swap between check and read). No migration.

## Tests

`bun run typecheck`, `bun run check:prepush`, tests/unit for rooms, web e2e for rooms pictures.

## Result

