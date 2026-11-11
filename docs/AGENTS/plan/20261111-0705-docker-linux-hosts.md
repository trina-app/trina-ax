# Docker install: tested on Linux hosts, minimum kit version, Ubuntu 24.04 host setting

- Date (UTC): 2026-11-11 07:05
- Branch: `fix/docker-linux-hosts`
- Status: done
- Where: `docker/`, `docs/INSTALL-DOCKER.md`, `.github/workflows/docker.yml`. Why: the Docker install files and their
  docs are in this repository (see docs/REPOSITORY-RULES.md)
- Version impact: none. Docs, the Docker test script and a manual CI workflow change; no app or kit file changes

## Goal

The Docker install was tested only on a Mac with OrbStack. A first test on Linux hosts (GitHub Ubuntu 24.04 runners,
amd64 and arm64) found three problems:

1. `docker/Dockerfile` reads the package list `root/packages.json` from the kit. Kits before 0.5.0-beta.1 do not have
   it, so the build stops. The docs and `env.example` still use 0.3.0 as the example, so a person who follows the docs
   gets a failed build.
2. On Ubuntu 24.04, `kernel.apparmor_restrict_unprivileged_userns=1` stops bubblewrap. The container restarts and is
   never healthy. With the setting at 0 on the host, all checks pass.
3. `docker/test.sh` starts its own sandbox check without `/lib64`. On amd64 the program loader is
   `/lib64/ld-linux-x86-64.so.2`, so the check fails (`exec /usr/bin/bash: no such file or directory`). The product
   launcher mounts `/lib64` (native/cmd/mycel-launcher/sandbox_linux.go); only the test is wrong.

With fixes 2 and 3, `docker/test.sh` passed all checks on amd64 and arm64 with release 0.5.0-beta.1 and with a kit
built from the dev commit that the dev test server runs.

## Scope

In:
- `docker/test.sh`: the sandbox check links `/lib64`.
- `.github/workflows/docker.yml`: set `kernel.apparmor_restrict_unprivileged_userns=0` on the runner, as the docs tell
  a host owner.
- `docker/Dockerfile`: the error for an old kit names the minimum version.
- `docker/env.example`, `docs/INSTALL-DOCKER.md`: minimum kit version 0.5.0-beta.1, the Ubuntu 24.04 host setting as
  the tested fix, the new test status.

Out:
- A test on a Debian 13 host and a real AI turn in Docker (needs a VM and an AI account).
- An AppArmor profile for the container instead of the host setting.

## Steps

1. Plan (this file).
2. Fix `docker/test.sh` and `.github/workflows/docker.yml`.
3. Dockerfile error message, `env.example`, `docs/INSTALL-DOCKER.md`.
4. Run the Docker image workflow on this branch with 0.5.0-beta.1.

## Risks

- The host setting allows unprivileged user namespaces for every program on the host. The docs say so.
- No migration, no app code, no UI text.

## Tests

`bun run check:docs`; the Docker image workflow (`docker.yml`) on this branch, amd64 and arm64.

## Result

Built as planned. The Docker image workflow on this branch with 0.5.0-beta.1 passed all checks of `docker/test.sh` on
amd64 and arm64 (Ubuntu 24.04 runners, kernel 7.0): health, setup page, engine firewall, bubblewrap + Landlock +
seccomp as `axagent`, launcher ready, first-run setup, a new container on the same volume. Still open: a Debian 13 host
and a real AI turn in Docker.
