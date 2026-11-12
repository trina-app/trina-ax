# Go back only where it can work; no false "held" after the server went forward again

- Date (UTC): 2026-11-12 03:36
- Branch: `fix/goback-and-false-hold`
- Status: done
- Where: core (`server/src/system`, `server/src/routes/system.ts`, `web/src/pages/admin`, `native/cmd/mycel-ctl`,
  `native/cmd/mycel-bootstrap`, `scripts/install-linux.sh`, docs). Why: update and roll-back are Team AX core
  (docs/REPOSITORY-RULES.md).
- Version impact: patch: honest update screens and status; the bootstrap and mycel-ctl are root files, so the release
  that carries this is a root update. No migration, one optional API field.

## Goal

QA TC-334: an update driven by 0.4.0's `mycel-ctl` reports `rolled_back` and writes a 20-hour hold
(`root/update-failed.json`) although the bootstrap went forward to 0.5.0 again and 0.5.0 runs fine. `mycel-ctl
status` then says "HELD: release 0.5.0 was rolled back". 0.4.0's code cannot change, so 0.5.0 must see that the held
release is the one that runs, healthy, with its root files in place, and drop the hold.

QA TC-336: after 0.4.0 -> 0.5.0, Admin › System offers "Go back" to 0.4.0 with no warning, though 0.4.0 cannot read
the database 0.5.0 migrated (reader level 4 against 6). Clicking it bounces back to 0.5.0 and the job says it went
back. Go back must not be offered (or run) for a version that cannot open the database, the screen must say how to
go back instead (restore the backup made before the update), and a Go back that bounced must say so.

## Scope

In:
1. mycel-ctl: a hold whose version runs here, answers `/api/health` with that version, is not pending or stopped in
   `state.json`, and whose root files are that version or newer, is over: status and update ignore it, remove the file
   (as root) and say so in one plain note line.
2. Server: `rootUpdateFailure` ignores such a hold too (Admin › Home / Diagnostics).
3. Server: `UpdateStatus.previousNeedsRestore` (the kept version's bundle reader level is below the level the
   database needs, `schema_migrations.min_compatible_reader`). The route and `rollBack()` refuse it in plain words.
4. Web: no Go back button then; the row says it cannot go back and points to the restore steps.
5. Honest job outcome: at start, the newest update job that finished as `done` but whose target is not the version
   that runs, and that started from this version, becomes `failed` ("Could not go back to 0.4.0; still on 0.5.0" plus
   the reason). The web waits for the server to come back after an update job and reads the job again before it
   says "finished".
6. Bootstrap: a pending version that exits 75 is rolled back at once with "cannot read the database" (not three tries
   and "exited 3 times"). Diagnostics says a bounced Go back in plain words.
7. Docker / installer "older kit" warning and docs/INSTALL-DOCKER.md: no advice to roll back into a version that
   cannot read the database; the restore steps go in docs/BACKUP-RESTORE.md.

Out: changing 0.4.0's mycel-ctl; restoring a backup automatically when going back.

## Steps

1. Go: `staleHold` in schedule.go, used by `collectUpdateSettings`, `gate`, `heldHere`; tests.
2. Bootstrap: exit 75 while pending -> roll back at once; test.
3. Server: `requiredReaderLevel(db)`, `UpdateManager` option, `previousNeedsRestore`, route/rollBack guard,
   `reconcileUpdateJobs`, `rootUpdateFailure` filter, Diagnostics line; unit tests.
4. Web: System.tsx row, jobs.tsx wait-for-restart; i18n (en first, then ko, id, ja, es); unit test.
5. Installer warning, docs, `changes/goback-honest.md`, DECISIONS entry.

## Risks

- No migration. `UpdateStatus` gains an optional field (older web ignores it; the server guard covers old clients).
- Writing `state.json` from root is avoided (owner and race with the bootstrap); the note goes to the command output.
- The web's wait after an update job polls `/api/health` for at most a few minutes; on a timeout it says the server is
  still restarting instead of "finished".
- Five languages for every new string.

## Result

Built as planned. mycel-ctl drops a hold of the version that runs and answers (root files in, nothing pending or
stopped) in status, update and the timer, with one note line; the server ignores it too. `UpdateStatus` has
`previousNeedsRestore`; Admin › System shows no Go back then and says why, the route and `admin.js rollback` refuse it.
`settleUpdateJob` marks an update job whose version did not stay as failed at the next start, and the web waits for
`/api/health` before it says "finished". The bootstrap rolls a pending version that exits 75 back at once with a plain
reason. The installer's older-kit warning and docs/INSTALL-DOCKER.md point to the new restore steps in
docs/BACKUP-RESTORE.md. Not run here: the real Ubuntu VM and Docker passes of TC-334 / TC-336 (QA).
