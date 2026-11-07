# Dev environment on srt: install

The srt runner of the dev environment (design: `docs/research/srt-dev-env.md`). The AI's `box_shell` commands run on
the team server as the server account, inside srt, in a `systemd-run --scope` unit. The podman box (`../install-trial.sh`)
stays the default until a later PR removes it. Do not install both on one server: `install-srt.sh` writes the same
drop-in file (`dev-env.conf`) and sets `MYCEL_DEV_ENV_RUNNER=srt`.

## Files

| File | Goes to | What |
|---|---|---|
| `install-srt.sh` | (run as root) | packages, node, srt, the files below, the server drop-in, a scope check |
| `uninstall-srt.sh` | (run as root) | removes all of it; `--purge` also deletes `<base>/devenv` |
| `package.json`, `package-lock.json` | `/opt/trina/srt/<version>/` | the pinned srt and its dependencies, with integrity hashes |
| `run-wrap` | `/opt/trina/devenv/run-wrap` | rlimits, `oom_score_adj`, the exit file |
| `srt-full.mjs` | `/opt/trina/srt/<version>/full.mjs` | srt's CLI for a person's Full internet: allows host names only, never an IP address or a local name |
| `devenv.rules.in` | `/etc/polkit-1/rules.d/60-<ID>-devenv.rules` | the server account may start, stop and reset-failed `trina-dev-<16>.scope` only |
| `devenv.slice.in` | `/etc/systemd/system/<ID>-devenv.slice` | the ceiling of all runs, from `<base>/root/dev-env.json` |

## Install

On a Debian 13 Trina server, as root:

```
scripts/dev-env/srt/install-srt.sh --id mycel
```

On a hosted team VM the plan file `<base>/root/dev-env.json` must be there (root-owned, format 1). Self-hosted servers
without the file get half of the memory and of the CPUs for all runs together. The first run restarts the team server.

Then, in the app, an owner or admin turns on the dev environment of a project and accepts the warning (version 2).

## Check

- `systemctl show -p Environment <ID>-server.service` names `MYCEL_DEV_ENV_RUNNER=srt`.
- The project page says the dev environment is available. If not, it says why (a missing file, polkit).
- `systemctl list-units 'trina-dev-*'` lists the runs while they run.

## A new srt version

1. Change the version in `package.json`, run `npm install --package-lock-only --ignore-scripts` in this folder.
2. Change the `srt` artifact in `scripts/system/packages.json` (version, url, sha256 and size of the npm tarball; the
   lockfile's `resolved`) and `SRT_VERSION` in `server/src/devenv/srt/config.ts`. `install-srt.sh` reads the version
   from the list; `tests/unit/system-packages.test.ts` compares the list, the server, `package.json` and the lockfile.
   Node is pinned in the same list (`node`: version, and url, sha256 and size per platform from `SHASUMS256.txt`).
3. Read srt's release notes: it is a "beta research preview".
4. Run `bun tests/linux/srt-run.ts` (the Docker attack suite).

A new version goes into a new folder. Running scopes keep the old one; the install removes an old folder only when no
process uses it.
