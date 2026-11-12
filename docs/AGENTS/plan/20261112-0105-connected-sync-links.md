# Connected folders: a sync never follows a link out of the source

- Date (UTC): 2026-11-12 01:05
- Branch: `fix/connected-sync-links`
- Status: done (PR open)
- Where: trina-ax core (`server/src/team-files/connected.ts`, `server/src/auth/messages.ts`, `tests/unit/connected.test.ts`).
  Why: connected folders are a core team-files feature.
- Version impact: patch; no schema change, no new endpoint, one new error message.

## Goal

The source of a connected folder was checked only when the owner connected it. Someone who can write to the shared
folder (a NAS user, for example) could later turn the source, or a file or folder inside it, into a link to the
server's own data. Later syncs followed the link and copied server files into `connected/<name>`, where every member
and their AI can read them. After this change a sync only ever copies files that really are inside the checked source.

## Scope

In:
- Every sync checks the source again: it must still be a real folder (not a link), resolve to the same path that was
  checked when it was connected, and still pass the rules of `checkSource` (outside the team folder, data and install).
  Otherwise the sync stops with a plain error for the owner ("moved") and copies nothing.
- The listing checks each folder before it reads it: a folder that is now a link, or resolves elsewhere, is skipped.
- Each file is opened without following a link in its last name (`O_NOFOLLOW`, `O_NONBLOCK` so a planted pipe cannot
  hang the sync). The path of the opened file is then read from the open file itself (Linux `/proc/self/fd`, macOS
  `/dev/fd` resolved by Bun with `F_GETPATH`) and must be inside the source; if it cannot be read, the file is skipped
  (fail closed). This closes the race where a folder on the way is swapped for a link between listing and copying.
Out: hard links (the server account cannot hard-link files it does not own on Linux with protected hard links).

## Steps

1. Re-check the source at the start of `doSync`; new error code `moved` with messages in five languages.
2. Folder check in `listSource`.
3. `copyNoFollow`: open with `O_NOFOLLOW|O_NONBLOCK`, check regular file and the opened path, copy through the handle.
4. Unit tests: source replaced by a link to a server folder; a file and a folder replaced by links (also between
   listing and copying); normal files still sync.

## Risks

Security fix. macOS office Mac and Linux both covered (no `/proc` on macOS). Names in NFD on a NAS: paths compared
after NFC.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun test tests/unit/connected.test.ts` and the other
team-files unit tests.

## Result

Built as planned. A read error during the re-check (macOS privacy, for example) is still reported as before
("permission" / "not_found"), only a failed rule becomes "moved". Unit tests simulate the race by putting the links in
right after the listing; they fail on the old code (a link-replaced source synced, three files copied through links).
Linux's `/proc/self/fd` path is exercised by CI on Linux; macOS was run here.
