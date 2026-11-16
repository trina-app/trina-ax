# An update is kept only when the AI engine can start with it

- Date: 2026-11-16
- Status: accepted
- Supersedes: none
- Branch: fix/post-update-engine-check (QA TC-3523)

Plan: [docs/AGENTS/plan/20261116-0324-post-update-engine-check.md](../AGENTS/plan/20261116-0324-post-update-engine-check.md).

- **Ask:** 2026-11-16, a Linux self-installed server updated itself from 0.5.5 to 0.5.7. The server's own app-only
  update unpacked the new version as the server account with umask 027, so `app/versions/0.5.7` came out 0750/0640.
  The engine account could not reach `native/mycel-bridge`, and every AI answer failed for about 7 hours with
  `bwrap: Can't find source path …/app/current/native/mycel-bridge: Permission denied`. The bootstrap kept the version
  because its only test was `/api/health`.
- **Rule:** on Linux, a pending update that answers `/api/health` is kept only after the engine account has started the
  engine's sandbox with it once. The bootstrap (`native/cmd/mycel-bootstrap/enginecheck.go`) asks the launcher
  `{"op":"sandbox-check"}` on `<base>/run-launcher/launcher.sock` (`--launcher-sock` to change it). The launcher
  (`native/cmd/mycel-launcher/enginecheck.go`) builds the launch with the code a turn uses (`turnEnv.command`: the
  bubblewrap argv of `buildBwrapArgs` and `mycel-sandbox exec` with `--sandbox bwrap`, the plain start without it) and
  runs the bridge of the version `app/current` points to now with `-h`. Every bridge version prints its usage and exits
  0 on `-h`, so a switch back to an older version is checked the same way. The working folder is
  `<agent root>/sandbox-check`, a reserved name that is never a chat, made and removed by each check.
- **Only the version's own files roll back.** The launcher answers `ok:false` only when the failure is about the
  version: `app/current`'s bridge does not resolve for the engine account (a folder it cannot enter), or the message of
  bwrap, mycel-sandbox or the ELF check names the version's folder (`app/current/…` or `app/versions/<v>/…`, where the
  bridge resolves). Anything else is this machine's fault and breaks the version before too: bwrap broken by an OS
  upgrade or AppArmor, a broken `root/mycel-sandbox` or `sandbox-etc`, Landlock required but gone, the agent root.
  Rolling back would not help, and the update would be tried again and again. So the launcher answers `ok:true` with
  `hostProblem`; the bootstrap keeps the version and writes the reason into the history's `ok` entry ("kept, but the AI
  engine could not start on this server: …"), and Admin › System's update line shows it as a warning (the server is the
  cause, not the update; AI answers may fail until it is fixed). A launch that does not end within 15 s (a loaded
  server) is skipped too ("the engine sandbox did not end within 15s"), with no warning.
- **A failed check is a failed update.** The bootstrap stops the version and rolls back to the one before, exactly like
  a version that does not come up. The history entry is `rolled_back` with the reason in plain words: "the AI engine
  cannot start with this version, so every AI answer would fail: <bwrap's, mycel-sandbox's or the bridge's own
  message>". It then reaches people the way any roll-back does: Admin › System's update line, the update job that turns
  `failed` with "Reason: …" (`settleUpdateJob`), the hold that stops the app's own updater from taking the same release
  again for a while, and `mycel-ctl update`'s `rolled_back` result (exit 10) with root's `update-failed.json` hold.
- **Only a clear "no" rolls back.** Not Linux (an office Mac, Windows, development): nothing is asked. No launcher
  socket, a socket that does not accept within 30 s (a launcher restarting after root files changed), no answer in 30 s, or a launcher older than
  the bootstrap (it answers `bad request`): the version is kept as before and the bootstrap's log says the check was
  skipped and why. A launcher missing is not the new version's fault, and a roll-back for it would also hit the
  version before.
- **No turn checks in it.** The check takes no turn slot, cgroup or firewall check: what an update can break is the
  version's files, and every turn still runs those checks itself. A forwarded version (started again after the one
  before could not read the database) is not checked again: it cannot be rolled back (info only).
- **mycel-ctl waits for the bootstrap.** `mycel-ctl update` reported `ok` as soon as the new version answered health.
  It now waits while `app/state.json` still has the version pending (up to 90 s more once it is healthy), so a version
  the bootstrap then rolls back is reported `rolled_back` with the bootstrap's reason.
- **Left out:** the version folder modes themselves and a repair at start-up (the updater fix, #1042, done elsewhere).
  This check is the net under that fix: whatever leaves the version's files unusable for the engine, the version does
  not stay. The start-up repair of 0.5.9 is synchronous and runs at the top of the server's `start()` (server/src/main.ts),
  before the server answers `/api/health`, so the check after health sees the repaired folder: a version the repair
  heals is kept, not rolled back.
- **Messages at the deadline.** When the version answers health but the bootstrap's check has not finished by the
  deadline, `mycel-ctl update` and the installer's switch say that the AI engine check did not finish (not "did not
  answer /api/health"); the bootstrap still keeps or rolls back the version when it does.
- **Takes effect** with root files that carry this bootstrap and launcher. An app-only update keeps the bootstrap and
  launcher already installed, so a server gets the check from the first release whose root files include them.
- **Tests:** `native/cmd/mycel-bootstrap/enginecheck_test.go` (a version left 0750/0640 rolls back with the reason, a
  good one stays, an older launcher is skipped, not Linux and no launcher are no-ops, a host fault and a timeout keep the
  version, the host fault with its note),
  `native/cmd/mycel-launcher/enginecheck_linux_test.go` (Linux: the plain start and the real bubblewrap launch fail on
  a bridge the engine cannot run and pass on a good one; `TestEngineCheckHostFaultIsNotTheVersions` and
  `TestEngineCheckTimeoutIsSkipped` for what is not the version's), `native/cmd/mycel-ctl`
  `TestUpdateWaitsForTheEngineCheck` and `TestUpdateEngineCheckNotFinished`, `tests/unit/g-update-history-text.test.ts`
  (the warning, and that the bootstrap writes the same words),
  and a step in `docker/test.sh` with the real server and engine accounts.
- **Version impact:** patch.
