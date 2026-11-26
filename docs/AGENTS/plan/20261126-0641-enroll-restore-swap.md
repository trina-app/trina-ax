# Enroll restore: build the restored files in a new folder, then swap them in

- Date (UTC): 2026-11-26
- Branch: `fix/enroll-restore-swap`
- Status: done (PR #627)
- Where: native/cmd/mycel-enroll/restore.go, native/cmd/mycel-enroll/enroll_test.go
- Version impact: patch (a bug fix in the team VM enroll; no API or file format change)

## Problem
An R2 restore on a team VM never worked. mycel-enroll gave `admin.js restore-artifacts --to BASE`. BASE always
exists, and restore-artifacts refuses a target that exists. Seen in prod on 2026-11-26 (free → paid move). The output
shape (`db/app.sqlite`, `team/`) is also not the server layout (`data/app.db`, teamRoot).

## Fix
- restore-artifacts writes to `<dataDir>/.restore-out` (a new folder). `.restore-out` and `.restore-out.partial-*`
  are removed before and after.
- Root swaps: old `app.db` and team folder kept as `*.before-restore-<time>`, restored ones put in place (0600, 0700),
  `data/sessions` moved aside. When the team folder cannot move, the database swap is undone.
- dataDir and teamRoot come from `config/server.json`; a broken server.json is an error. The swap refuses two file
  systems before anything moves.
- restore-artifacts and restore-verify do not change.

## Tests
- TestRestoreMode: the mock refuses a target that exists (as the real command); the swap, kept copies and cleanup.
- TestRestoreServerDirs, TestSwapInRestoredUndoesTheDatabase.
