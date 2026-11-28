# AI file saves work when the data and team folders are two mounts of one disk

- Date (UTC): 2026-11-28 13:57
- Branch: `fix/exdev-rename-fallback`
- Status: done
- Where: `server/src/files/copy-off-loop.ts` (one helper), `server/src/team-files/place.ts` (`onTeamVolume`,
  `stageInstall`), `server/src/rooms/files.ts` (room upload). Why: these are the moves from the data folder into the
  team folder.
- Version impact: patch: a fix; no API, setting or file layout change. Hotfix candidate (every AI-made file fails on a
  standard Linux install since 0.20.2).

## Goal

Windows QA 2026-11-28 (WSL2 Debian 13, 0.20.4): every AI file save (Word report, Excel sheet, also on retry) failed with
`a tool call failed with an internal error`, `code EXDEV`. The server unit has `ProtectSystem=strict` and
`ReadWritePaths=… @BASE@/data @BASE@/team …`: systemd bind-mounts each path onto itself in the service's mount
namespace, so the data folder and the team folder are two mounts of one ext4 file system. `stat` gives both the same
`st_dev`, but Linux refuses a rename between two mounts (EXDEV). `onTeamVolume` (added in 7be277ed7, first released in
0.20.2) took the same `st_dev` for "one volume" and skipped the copy, so `installRenamed` failed. Reproduced on
qa.trina.app (native Debian 13 on Lightsail, dev build) inside the service's namespace: `os.rename` data → team gives
"Invalid cross-device link". Every systemd install (install-linux.sh: hosted teams, self-installed servers, WSL2) on
0.20.2 or later is hit; a Mac is not (one mount).

After this, the device number never decides rename against copy: the rename is tried and, on EXDEV, the file is copied
off the event loop, flushed to disk, and the source removed once the copy is placed.

## Scope

In:
- `renameOrCopy(src, dst)` in `files/copy-off-loop.ts`: refuses a source that is not a regular file (never follows a
  link), tries the rename, on EXDEV copies off the loop (`COPYFILE_EXCL`) and fsyncs the copy; returns which.
  `moveOffLoop` uses it.
- `onTeamVolume`: always stages the produced file under a temp name in the folder it goes into (or the team's
  `.system` when that folder is not there yet) with `renameOrCopy`. `finish(false)` puts a renamed file back at `src`
  or removes the copy; `finish(true)` removes the source of a copy. No `st_dev` comparison.
- `stageInstall`: its EXDEV branch through the same helper (adds the fsync).
- `rooms/files.ts` room upload: `moveOffLoop` instead of "any error → copy".
- Tests: EXDEV simulated by making `fs.renameSync` throw EXDEV for a move between two folders; a full `placeProduced`
  save with it on; a guard that no server file compares `.dev` to choose rename or copy in `place.ts`.

Out: `installRenamed` stays a rename only (synchronous step; the file is staged next to its place first). Trash
restore stays a rename (team folder to team folder).

## Steps

1. Helper + its unit test.
2. `onTeamVolume` and `stageInstall` through it; room upload.
3. EXDEV tests for `onTeamVolume`, `stageInstall`, a make_file save.
4. typecheck, check:prepush, affected unit tests.

## Decisions

none (a bug fix; the existing rule "a copy across volumes, off the event loop" is kept, only how "across" is found
changes).
