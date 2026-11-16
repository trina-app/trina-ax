# Downloads send the file that was checked

- Date (UTC): 2026-11-16 12:16
- Branch: `fix/download-checked-descriptor`
- Status: done
- Where: trina-ax core: `server/src/team-files/download.ts`, `server/src/team-files/place.ts` and the routes that send a
  team file. Why: file permissions and downloads are core (docs/REPOSITORY-RULES.md).
- Version impact: patch (a fix, no API or migration)

## Goal

A download checks a file (the path walk of `policy/resolve.ts`, a regular file with one link) and then sends it. The
sending step opened the file again by its path. The comment said that only the server writes inside the team folder,
which is not true for a personal folder when the dev environment is on: a run writes there. So the file that is sent
must be the file that was checked, and a link placed under a personal folder must never be followed, also not in a
folder on the way.

## Scope

In:

- `openChecked(abs, seen)`: with the `lstat` the check took, the opened file must be that very file (same device and
  inode), and the system's own path of the open file must be the path that was checked (so a folder on the way that
  became a link is not followed either). Without `seen` it is as before (server-owned folders).
- `streamFile`, `fileBody`, `rangeStream`: one open; the body is read from that descriptor (no second open by path).
  Range requests, content type, headers and sizes stay the same.
- Every caller that sends a team file passes what its check saw: file download, shared-file link, file version, the
  attachment thumbnail of a team file, a team file copied into a room.
- The comment at the top of `download.ts`.
- Tests first: they show what today's code does for each case.

Out: reads of a file's content by the AI tools and the file panel (`files/store.ts readRegular`): they refuse a link
in the last name, and are not a download. Reported separately.

## Steps

1. Tests that describe each case; run them on the code as it is and note the result.
2. `openChecked` with `seen`; the body from the descriptor.
3. Callers, the comment, a changelog fragment.
4. Checks on macOS and on Linux with Bun 1.3.12.

## Decisions

None. No rule changes: links and hard links were refused already; the download now keeps to it at every step.

## Risks

- Bun 1.3.12 has no way to say when a response body has gone out. A body sent with sendfile (Linux) must be a file
  Bun opens itself, so it is given the path of our open descriptor and the descriptor is closed a little later. Checked
  by hand on Bun 1.3.12 (Linux and macOS): Bun opens its own descriptor when the response starts, and the download goes
  on after ours is closed.
- A file replaced by a normal save between the check and the open is refused once (the next request works).
- macOS has no /proc: the path of an open file comes from Bun's `realpath` of `/dev/fd/N`, as `devenv/snapshot.ts` and
  `team-files/connected.ts` already do.

## Tests

`bun run typecheck`, `bun run check:docs`, the unit tests of downloads and team files, on this Mac and in the
`oven/bun:1.3.12` image.

## Result

Built as planned.

- What the code did before, per case (the new tests, run on the code as it was): a link as the last name, a folder on
  the way that is a link, and a hard-linked file were refused already. A change of the name after the check was not
  always kept out: the body of a whole-file download on Linux, and of any download through the team address, was
  opened by name a second time, and no open compared the file with the one that was checked.
- `openChecked(abs, seen)` compares device and inode with the check's `lstat` and the open file's own path with the
  checked path. `streamFile`, `fileBody` and `rangeStream` read from that one descriptor.
- Callers that pass what their check saw: file download, shared-file link, file version, attachment thumbnail of a team
  file, HEIC preview, a team file copied into a room, the hash and thumbnail of a team file attached to a chat.
  Server-owned folders (chat and room uploads, their thumbnails, installers, decks, videos) keep the plain open, and
  are sent from that one open too.
- Differs from the plan: a body through the team address is now our pull stream (it was a Bun.file read lazily); read
  as lazily, and the range path used it already. A reader that leaves while a read is on the thread pool no longer
  closes the descriptor under that read.
- Not in this change: `files/store.ts readRegular` (content reads by the AI tools and the file panel) opens without
  following a link in the last name, but does not compare the file with its check. Reported for a follow-up.
- Checks: typecheck, check:docs; the download and team-file unit tests on macOS (Bun 1.4.4 and 1.3.12) and in the
  `oven/bun:1.3.12` Linux image.
