# After an update, check that the AI engine can start before keeping the version

- Date (UTC): 2026-11-16 03:24
- Branch: `fix/post-update-engine-check`
- Status: done
- Where: `native/` (bootstrap, launcher, mycel-ctl). Why: the post-switch health check and the roll-back live in the
  bootstrap, and only the launcher runs as the engine account (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a safety check on the update path; it takes effect with root files that carry the new
  bootstrap and launcher

## Goal

2026-11-16: a Linux server updated itself from 0.5.5 to 0.5.7. The new version folder came out 0750/0640, so the engine
account could not reach `native/mycel-bridge`, and every AI answer failed for about 7 hours
(`bwrap: Can't find source path …/native/mycel-bridge: Permission denied`). The update was kept because the bootstrap
only asks `/api/health`. QA TC-3523.

After this change a new version is kept only when the engine account can also start the engine's sandbox with it.
Otherwise the update is rolled back like a version that does not come up, and the reason is recorded in plain words.

## Scope

In:

- Launcher: a `{"op":"sandbox-check"}` request. It builds the engine's launch with the same code a turn uses
  (`turnEnv.command`, so `buildBwrapArgs` on Linux with bwrap) and runs the bridge of the version `app/current` points
  to now with `-h` (a no-op that exits 0 in every bridge version), as the engine account. Linux without bwrap runs the
  bridge directly. macOS answers "skipped".
- Bootstrap: when a pending update answers `/api/health`, it asks the launcher before it records `ok`. A failed check
  stops the version and rolls back with the reason. Not Linux, no launcher answer, or a launcher that does not know the
  request: the version stays and the log says the check was skipped.
- mycel-ctl update: it no longer reports `ok` while `state.json` still has the version pending (the bootstrap is
  still checking). A roll-back is then reported as `rolled_back` with the bootstrap's reason, as before.

Out: the version folder modes and a start-up repair (the release coordinator's 0.5.8 updater fix).

## Steps

1. Launcher: `enginecheck.go` (request, answer), the Linux and macOS parts, a reserved `sandbox-check` folder name.
2. Bootstrap: `--launcher-sock` (default `<base>/run-launcher/launcher.sock` on Linux), the check after the health
   answer, the roll-back.
3. mycel-ctl: wait until the bootstrap settled the pending version.
4. Tests, decision file, changes fragment.

## Decisions

- [docs/decisions/20261116-post-update-engine-check.md](../../decisions/20261116-post-update-engine-check.md)

## Risks

- A launcher that does not answer must not roll back good updates: such a check is skipped, never failed.
- The check runs while the bootstrap watches the new version: it is bounded (about 45 s) and a stop signal or the
  server exiting is still handled.
- No migration, no UI text, no permissions change.

## Tests

- Go: bootstrap (bad tree rolls back, good tree stays, not Linux is a no-op, no launcher is skipped), launcher (Linux:
  a 0750/0640 version fails, a good one passes; real bwrap where CI has it), mycel-ctl (pending until settled).
- `bun run typecheck`, `bun run check:docs`, guard tests, updater and system unit tests under Bun 1.3.12.

## Result

Built as planned. Also: `scripts/install-linux.sh`'s switch wait gets the same "still pending" wait as mycel-ctl, and
`docker/test.sh` gets a step with the real server and engine accounts. A missing launcher socket is skipped at once (a
socket that does not accept yet is tried for 30 s), so installs and tests without a launcher are not slowed down. The
check folder's own errors are reported as skipped, not as a failed version. PR: fix/post-update-engine-check into dev.
