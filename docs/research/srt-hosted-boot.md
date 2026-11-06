# srt on hosted team servers: install at boot from the plan

Status: on branch `image/srt-in-ami`, not in an AMI yet. For Dion. 2026-11-05.

## What

Every hosted EC2 team server made from this image installs the dev environment on srt by itself. No customer step and
no operator step.

- The image already has the packages, node 22, srt and run-wrap (`install-srt.sh --image-mode`, commit 3f58a168).
- New: `mycel-devenv-boot.service` runs before `mycel-server` at each server start. It:
  1. reads `<base>/root/plan.json` (the control plane writes it with `mycel-ctl apply-plan`, at enrollment and at each
     plan change);
  2. writes `<base>/root/dev-env.json` (root, 0644) from the plan;
  3. runs `install-srt.sh --boot`: the polkit rule, the devenv slice and the server drop-in.
- `mycel-devenv-plan.path` runs the same unit again when `plan.json` changes.
- Files: `scripts/image/files/mycel-devenv-boot` (script), `mycel-devenv-boot.service`, `mycel-devenv-plan.path`,
  `20-devenv-boot.conf` (server drop-in: `Wants=` and `After=`). `customize.sh` installs them only when the image has srt.

## Why this way

The owner chose not to add a new `dev-env.json` writer in the control plane. The plan file is already on every
server, so the image derives the limits from it. A plan change in the control plane changes the limits with no new
code there.

## Mapping (plan.json to dev-env.json)

Reference: Starter (4096 MiB, 2 vCPU). u = plan `memoryMiB` / 4096.

| Field | Rule | Starter | Team (8 GiB, 2 vCPU) | Business (16 GiB, 4 vCPU) |
|---|---|---|---|---|
| memoryMiB | 1536 × u, max 8192 | 1536 | 3072 | 6144 |
| cpus | 0.75 × cpuCores, max 4 | 1.5 | 1.5 | 3 |
| pids | 512 × u, max 4096 | 512 | 1024 | 2048 |
| diskGiB | 8 × u, max 32 (srt does not use it) | 8 | 16 | 32 |
| maxRunning | 1 + log2(u), max 4 | 1 | 2 | 3 |
| network | always `open` | open | open | open |

A plan under 4096 MiB (Free, the old trial) gets no dev environment: no `dev-env.json`, no server drop-in. A move down
to such a plan removes both. The node, srt and package files stay (they are part of the image).

The machine caps the plan. The script uses min(plan `memoryMiB`, machine memory) for u, and min(plan `cpuCores`,
`nproc`) for cpus. Machine memory is the cgroup `memory.max` or `MemTotal` (as `MachineMemoryMiB` in
`native/internal/plan`), rounded up to whole GiB: a 4 GiB EC2 VM has a `MemTotal` of about 3.8 GiB, and a t3a.small
(2 GiB) has 1942 MiB. Reason: on a move up, the control plane writes the new `plan.json` at once, but the VM gets the
new size only at its next idle reboot. Thus:

- A move up from Free (2 GiB VM) keeps the dev environment off until that reboot. At the reboot the unit turns it on
  before the server starts, so there is no restart during the day.
- A move up from Starter to Team keeps the Starter numbers until the reboot.

## It stays off until an admin turns it on

The drop-in sets `MYCEL_DEV_ENV=1`. That only makes the "Dev environment" section show in Admin › Team settings for
every hosted admin. The feature itself stays off: `server/src/devenv/setting.ts` runs nothing until an owner or admin
turns it on and accepts the warning (beta.5).

## It never stops the server

- The server only `Wants=` the unit. The script always exits 0. A failure is a line in the journal
  (`journalctl -u mycel-devenv-boot`).
- `--boot` downloads nothing. A missing package, node or srt is a logged stop. No `apt-get update` at boot, so no
  network and no dpkg lock are needed.
- The server restarts only when the drop-in changed and the server already runs, with `systemctl restart --no-block`.
  At boot the server waits for the unit, so a blocking restart there could hang.
- The drop-in has `ReadWritePaths=-<base>/devenv` and `ExecStartPre=+/usr/bin/install -d -o axserver -g axserver -m
  700 <base>/devenv`. A new data disk (restore, reattach) without the folder never stops `mycel-server`.

## Risks

- Not yet tested on a real EC2 boot (systemd, polkit, the path unit). The Docker test runs the script parts with stub
  `systemctl`, `runuser` and `systemd-run`.
- An open network goes out from the team server's public address. The allowlist of srt's proxy applies (the default
  domains plus the team's domains).
- Memory: on Starter the slice can use 1536 MiB of 4096 MiB. Section 13 of `srt-dev-env.md` measured this size with a
  Remotion render; Team and Business are proportional, not measured.
- Every server start runs the unit (an estimate of 1 to 2 s, not measured: the srt version check and a scope probe).
- A move down to Free removes the drop-in, so the server restarts once (`--no-block`) and the running answers end. A
  move up from Free does not restart the server (see the machine cap above).
- Order in the control plane (trina-cloud `src/teams/lifecycle.ts`): a move up is `resize(idle)`, then `apply-plan`.
  With `applyMemory: 'idle'` the new memory can come only at the next idle reboot. Fixed by the machine cap: until the
  reboot the old machine size counts, so a team that moved up from Free never gets Starter limits on a 2 GiB VM.
- On Starter the ceilings add up to more than the RAM (launcher 3328 + server 1792 + slice 1536 MiB on 4096 MiB).
  `run-wrap` sets `oom_score_adj` 800 for every run, so in a machine-wide shortage the kernel kills a run before the
  server.

## Roll back

On one server (as root):

```
systemctl mask mycel-devenv-boot.service mycel-devenv-plan.path
rm -f /etc/systemd/system/mycel-server.service.d/dev-env.conf /var/lib/mycel/root/dev-env.json
systemctl daemon-reload && systemctl restart mycel-server
```

For all new servers: build the AMI from the commit before this change, or give `customize.sh` no `--srt` folder.
`uninstall-srt.sh` also works, but it removes node and srt from `/opt/trina`. After it the next server start logs a
stop (`--boot` downloads nothing) and adds no drop-in; mask the units to keep the journal clean.
