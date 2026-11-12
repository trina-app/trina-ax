# Dev environment on a Mac team server (srt on macOS)

- Date (UTC): 2026-11-12 13:22
- Branch: `feat/devenv-srt-macos`
- Status: in progress
- Where: trina-ax `server/src/devenv/srt/`, `scripts/dev-env/srt/`, `scripts/install-macos.sh`. Why: the owner
  decided (2026-11-12) that the dev environment runs on srt only, also on a team's own Mac mini (self-host, one team).
- Version impact: minor (a new platform for an existing feature; nothing changes on Linux)

## Goal

The AI's `box_shell` commands run on a Mac team server (`scripts/install-macos.sh`, role accounts) in srt's macOS
sandbox (Seatbelt, `sandbox-exec`), with the same rules as on Linux where macOS allows it, and with the gaps written
down.

## Scope

- In: a macOS runner (`SrtSystem` for darwin), the Seatbelt additions (localhost), a pool of dev accounts (one uid per
  run), a RAM watchdog and process limits in place of cgroups, the install and uninstall in `install-macos.sh`, unit
  tests, attack checks on a real Mac, DECISIONS, INSTALL notes, a changelog fragment.
- Out: office mode (no sudo, so no separate account: the dev environment stays off there), the preview gateway (none
  exists on Linux either; this change only gives each run a port that the server can reach), Linux changes.

## Steps

1. A pool of dev accounts `_axdev1..N` (one uid per run at a time). The server switches to one with `sudo -n -u`
   (a sudoers rule that names only `run-wrap-mac` and only these accounts). Reasons: KERN_PROCARGS2 (a process reads
   the argv and environment of every process of its uid; a sandbox cannot block it), `ulimit -u` counts per uid, the
   server cannot signal another uid, and `kill -KILL -1` as the slot uid ends a run and everything it left.
2. `run-wrap-mac` (root-owned, runs as the slot account): limits (`ulimit -u -n -f -c`, nice), a RAM watchdog (sum of
   RSS of the uid, kill over the limit, mark `oom`), a time limit (mark `timeout`), the exit file, clean up at the end.
3. `srt-mac.mjs`: srt's CLI with `allowLocalBinding: false` and three rules added to srt's profile: bind, accept and
   connect on the run's own port only; no `kern.proc.all`. Fails closed when srt's profile has an unexpected shape.
4. `config.ts`: macOS read lists (system paths, `/etc` files, Command Line Tools), the run's port (`PORT`), the argv.
5. `system-mac.ts`: the macOS `SrtSystem` (slots, state files, ps for memory and CPU, sudo stop, self test).
6. File access: an inherited ACL on `team/` and `devenv/` for the dev group and the server account; the runner
   refreshes it on the run's writable folder before a run (a file moved in keeps no inherited ACL).
7. `install-macos.sh`: node (darwin entries in `packages.json`), srt, the accounts, sudoers (`visudo -cf`), the ACLs,
   pf rules (no dev account reaches the server's ports; nothing outside the Mac reaches a run's port), the server's
   environment. On by default, `--no-dev-env` opts out, a failure is a warning, `uninstall-macos.sh` removes it.
8. Unit tests, then the attack checks on this Mac (a test install), then docs and the PR.

## Risks

- srt's profile text changes in a new version: `srt-mac.mjs` refuses to run (fail closed) and a unit test pins it.
- RSS does not count compressed or swapped memory: written down as weaker than Linux.
- No CPU quota on macOS: nice only; written down.
