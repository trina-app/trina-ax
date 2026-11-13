# Dev environment on srt: runs as template units (route A), Ubuntu 24.04 on

- Date (UTC): 2026-11-13 04:44
- Branch: `feat/srt-ubuntu-route-a-3e556a`
- Status: in progress
- Where: `server/src/devenv/srt`, `scripts/dev-env/srt`, `scripts/linux/install-linux.sh`, `native/cmd/mycel-sandbox`.
  Why: the dev environment runner and its root install (see docs/REPOSITORY-RULES.md).
- Version impact: minor. Ubuntu 24.04 servers get the dev environment, and the root install changes (a new unit file
  and polkit rule).

## Goal

Ubuntu 24.04 is the most common customer server OS. Today the dev environment stays off there: on systemd 255,
`systemd-run --scope` (StartTransientUnit) gives polkit no unit name and no verb, so the polkit rule cannot limit the
server account to its run scopes (PR #622). Route A: each run is an instance of a root-installed template unit
`trina-dev@.service`, started with StartUnit. systemd 255 sends the unit name and the verb for StartUnit, so a narrow
rule works. Debian 13 uses the same path. Limits and security stay the same.

## Scope

In:
- `scripts/dev-env/srt/devenv-run.service.in`: the template (`User=` the server account, `Slice=<ID>-devenv.slice`,
  the server unit's sandbox lines, `OOMPolicy=kill`, a root-set `RuntimeMaxSec` backstop). `install-srt.sh` writes it
  to `/etc/systemd/system/trina-dev@.service`.
- `run-wrap` gets a unit mode: it reads the run's arguments, environment, folder and output files from a file in the
  hidden `<base>/devenv/run/` folder. The instance name gives no arguments.
- Per-run limits (memory, CPU, tasks) with `systemctl set-property --runtime` before the start. The template's
  `ExecStopPost=+` removes the run's runtime drop-ins.
- The polkit rule allows the server account only `trina-dev@<16>.service`, verbs start, stop, reset-failed and
  set-property.
- `system.ts`: the template path when the template is installed; the old scope path stays only for a server whose
  root files are older (until `install-srt.sh` runs again), and `install-srt.sh` stops old run scopes when it changes
  the rule.
- `mycel-sandbox port-forward` accepts the run's service cgroup.
- `install-srt.sh` accepts Ubuntu 24.04; it checks the template start and the refusals before it writes the server
  drop-in. `install-linux.sh` turns the dev environment on for Ubuntu 24.04.
- Docs: DECISIONS, INSTALL-LINUX, research notes, a changelog fragment.

Out: macOS (unchanged), route B (user manager with linger).

## Steps

1. VM spike on Ubuntu 24.04: polkit details of set-property and StartUnit, `RuntimeMaxSec` at runtime, OOM result.
2. Template, rule, run-wrap unit mode, install and uninstall scripts.
3. `system.ts` / `config.ts` / `runner.ts` / routes: unit names of both kinds, end of a run from the unit state.
4. port-forward cgroup check.
5. Unit tests: argv and args file, template lines equal to the server unit's sandbox lines, the polkit rule run with a
   fake polkit.
6. VM checks (`spike-vm.sh` with an Ubuntu option): S1, A21-A23, A25, A26 on Ubuntu 24.04; the same once on Debian 13;
   install, update and uninstall --purge with a kit built on the VM.

## Risks

- Security: a service does not inherit the server unit's sandbox as a scope did. The template must copy it; a unit
  test compares the lines.
- The server must never write a unit file or drop-in (it could set `User=root`); set-property accepts only cgroup
  properties on a unit that is not transient.
- Version skew: a new server bundle before the new root files. The old scope path covers that window.
- No migration.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun test tests/unit/dev-env-*.test.ts`,
`go test ./cmd/mycel-sandbox/...`, the VM runs above.

## Result

(at the end)
