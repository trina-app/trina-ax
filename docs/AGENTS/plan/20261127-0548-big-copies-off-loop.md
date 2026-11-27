# Big file copies leave the event loop; the bootstrap watchdog restarts a hung server by default

- Date (UTC): 2026-11-27 05:48
- Branch: `fix/async-large-copies` (stacked on `fix/watchdog-kill-default`, #682)
- Status: in progress
- Where: server/src/team-files (place.ts, service.ts), server/src/files/copy-off-loop.ts, the other copy sites
  (uploads, chat files, tools, jobs), native/cmd/mycel-bootstrap/watchdog.go, docs.
  Why: #682 left the bootstrap (Linux, Docker, Mac installs) log-only because big copies ran as one
  `fs.copyFileSync` on the event loop; on ext4 a 10–20 GB file holds `/api/health` for more than 5 minutes.
- Version impact: minor, part of the unreleased 0.21.0 watchdog feature: the bootstrap's `watchdog.kill` default
  changes. The bootstrap is a root program, so the release with it is a root update.

## Goal

No copy of a file a person or the AI made runs on the server's event loop, with the same crash safety as before, so
the bootstrap's watchdog can restart a hung server by default.

## Scope

In:
- `copyOffLoop()` (fs.promises.copyFile with COPYFILE_FICLONE: a clone where the disk has them, else Bun's file
  threads; measured: a 1.2 GB copy on ext4 overlay and on HFS+ holds the loop under 40 ms, copyFileSync 1.3–4.4 s).
- `replacing()` and its three callers (replace upload, replace copy, version restore): the copies move before the
  synchronous step. The old version is copied under a temp name in `.system/history` and the new content is staged
  under a temp name next to the file, both awaited; then, in one synchronous step, the file must still be the one that
  was hashed (inode, size, mtime): version row, rename. A failed rename deletes the version row and blob again. A file
  that changed while it was copied is looked at again (5 tries, then conflict). A reader sees the old file or the new
  one, never a half file.
- The same order for plain uploads, copies, chat attachments, folder copies, `placeProduced` (make_file and the other
  tools), trash restore (a rename only).
- The rest of the class: chat files, outputs, save_url, thumbnails input, promo video, speech jobs, the office update
  EXDEV copies; whole-file synchronous hashes of copies without a size limit (share take-back, chat folder drop) move
  to an async hash; room-file adoption hashes only up to ROOM_FILE_MAX; xlsx recalculation and the old trash restore
  read whole files only up to their limits.
- A guard test: `copyFileSync`/`cpSync` only in a short list of small, fixed files; never in team-files, uploads,
  chat files or outputs; `sha256Regular` only where the size is bounded first. Behaviour tests for the replace order.
- Bootstrap: kill on unless `server.json` `watchdog.kill` is false (also `"false"`, `0`, `"0"`, `"off"`, `"no"`).
- Docs: CONFIGURATION.md, the install docs, the decision 20261127-restart.md, a changes fragment.

Out: thresholds, the office supervisor (on already), the engine session stash read.

## Steps

1. copy-off-loop.ts; place.ts staging API (stageInstall/commitStaged/abortStaged, stageTeamCopy, stageVersion/
   commitVersion/undoVersion, replaceKeeping, installRenamed, onTeamVolume).
2. service.ts replacing() and callers; make-file, attachments; the other copy sites and hashes.
3. Guard and behaviour tests; bootstrap default and Go tests; docs.

## Decisions

Updates docs/decisions/20261127-restart.md (the bootstrap kills by default now; why that is safe).

## Risks

A staged temp file in a team folder after a crash (as with the old synchronous copy). A wasted copy when a replace
turns out to be a conflict (the old version is copied only after the hash decided it is needed). Interleaving: every
check that a name is free or a file unchanged runs again after the awaited copies, in the synchronous step.

## Tests

`tests/unit/g-copy-off-loop.test.ts`, `c-files-replace-race`, the team-files, uploads, room-file-moves, make-file,
share and restore tests, the security tests, `go test ./cmd/mycel-bootstrap/`, `bun run typecheck`,
`bun run check:prepush`.
