# Update roll-back: the old version cannot read the database (exit 75)

- Date (UTC): 2026-11-11
- Branch: `fix/update-rollback-schema-too-new`
- Status: in progress
- Where: `native/cmd/mycel-bootstrap` (Go), `native/cmd/mycel-ctl/status.go`, `shared/src/install.ts`. Why: the
  bootstrap is the only process that runs when no server version starts (macOS LaunchDaemon and Linux systemd unit both
  run it)
- Version impact: the bootstrap is a root file, so the next release is a root update

## Goal

A new version runs its migrations, then misses the health check or dies before it is healthy. The bootstrap rolls back
to the previous version. When a new migration raised `min_compatible_reader` above the old build's level, the old
build exits 75 (SchemaTooNewError) on every start. The bootstrap treats that as a crash and restarts it forever: no
version runs, and the owner has no screen to fix it from.

## Plan

- Old version exits 75 right after the bootstrap rolled back to it: go forward to the newer version again (it already
  migrated the database, so it is the only build that can read it). No database file is touched.
- The forwarded version gets the same health watch, but no roll-back: when it is healthy, history gets `ok` with a detail
  that says what happened. When it dies `--max-attempts` times first, the bootstrap stops trying.
- Exit 75 with nothing to go forward to, or a forwarded version that keeps dying: the bootstrap stops starting the server
  and records why in state.json (`blocked`) and in the history (`rolled_back`, detail "stopped: ..."). It waits for
  app/current to change, `blocked` to be removed, or SIGHUP, then tries again. `mycel-ctl status` shows the stop.
- Why not restore the pre-migrate copy: the bootstrap would have to pick the right file and swap SQLite files from
  outside the server; a wrong pick loses data. Restoring stays a step the owner chooses; the stop message names it.

## Tests

- Go: fake versions (shell scripts as `bin/bun`, a test health server): new version never healthy -> roll-back -> old
  exits 75 -> forward -> healthy, `ok` recorded; new version keeps dying -> roll-back -> 75 -> forward -> stop, no more
  starts; exit 75 with no roll-back before it -> stop at once.
- `go test ./...` in native/, server tests for the db / migrate / update prefixes.
