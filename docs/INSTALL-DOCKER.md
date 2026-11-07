# Self-host with Docker

[Linux server install](INSTALL-LINUX.en.md) · [IT checklist](for-admins.md) · [Backup and restore](BACKUP-RESTORE.md)

Run the team server with `docker compose up` on a Linux server or on a Mac with Docker (Docker Desktop, OrbStack, Colima). The image holds a signed release kit. At each start the container runs the same Linux installer (`install-linux.sh`) into a named volume, and then `mycel-ctl supervise` starts the engine firewall, the launcher and the server. There is no systemd in the container. The image carries the system packages every server needs (the always groups of the one list, `scripts/system/packages.json`, read from the kit), and the installer runs with `--minimal --skip-apt`: no CJK fonts, dev environment tools or headless browser for HTML to PDF in the image.

**Status: new and less tested than the Linux install.** Tested on 2026-11-04 with release 0.3.0 and 0.4.0-beta.2 on OrbStack (Docker 29.4, Linux 7.0, arm64). Not tested yet: an Ubuntu 24.04 or Debian host, amd64. For a production team, the [Linux install](INSTALL-LINUX.en.md) on a dedicated VM is still the reference: it has per-turn cgroup limits and root updates that this setup does not have (see [Differences](#differences-from-the-linux-install)).

## Requirements

| Item | Requirement |
|---|---|
| Docker | Docker Engine with Compose v2 (`docker compose`), or Docker Desktop / OrbStack on a Mac. Tested with Docker 29.4 |
| Host kernel | Landlock, cgroup v2, nftables, unprivileged user namespaces. 6.12+ recommended, as for the Linux install. Debian 13 and Ubuntu 24.04 kernels have Landlock. Checked on OrbStack only; Docker Desktop and Colima are not checked |
| CPU | amd64 with SSE4.2, or arm64 |
| RAM / disk | 4 GB for the container (2 GB: one concurrent run); 20 GB for the volume plus space for files, history and backups |
| Network | Outbound https for the image build (GitHub releases), the first start (the AI engine download) and AI providers |
| Host setting | `kernel.yama.ptrace_scope = 1` on the host (a container cannot set it) |

## Install

You need only the `docker/` folder of this repository: `Dockerfile`, `docker-compose.yml`, `entrypoint.sh`, `setup-link.sh`, `seccomp.json`, `env.example`.

```sh
git clone https://github.com/trina-app/trina-ax.git && cd trina-ax/docker
cp env.example .env           # set TRINA_AX_VERSION to the release you want
docker compose up -d --build
docker compose logs -f trina-ax
```

The build downloads `TrinaAX-server-<version>-linux-<arch>.tar.gz` and `SHA256SUMS` from GitHub Releases, checks the checksum, and checks the release signature (`mycel-ctl verify-bundle`). The build stops if a check fails. The checksum file, the signature and the `mycel-ctl` that checks it all come from the same download: these checks find a damaged download, not a replaced release (the same as the [Linux install](INSTALL-LINUX.en.md#download-verify-check)).

The first start takes a few minutes. The installer downloads the pinned AI engine (Claude Code, about 300 MB) and checks its SHA-256. The log shows `mycel-ctl supervise: started server` when the server runs. `docker compose ps` shows `healthy` when `/api/health` answers.

Settings in `.env`:

| Variable | Default | Meaning |
|---|---|---|
| `TRINA_AX_VERSION` | (required) | Release to run. Change it to update |
| `TRINA_AX_ENGINES` | `claude` | `claude`, `codex` or `claude codex` |
| `TRINA_AX_BIND` / `TRINA_AX_PORT` | `127.0.0.1` / `47820` | Host address and port of the web app |
| `TRINA_AX_TIMEZONE` | browser zone at setup, else UTC | Team time zone for the first run (IANA name). The container does not use the host's zone |
| `TRINA_AX_MEMORY` / `TRINA_AX_CPUS` | `4g` / `2` | Limits for the whole container |
| `TRINA_AX_PUBLIC_HOST` | none | Public https name, for the Cloudflare Tunnel sidecar |

Keep `TRINA_AX_BIND=127.0.0.1`. The web app has no TLS on this port. Do not publish it on a public address.

## First run

The setup link holds a one-time code. Keep it private. It works until the owner account exists.

```sh
docker compose exec trina-ax trina-ax-setup-link
```

- Docker on your own computer: open the link in your browser.
- Docker on a server: on your computer, run `ssh -L 47820:127.0.0.1:47820 <server>` first, then open the link.

Create the owner, the team name and the language. Then continue as in the Linux guide: **permissions → AI connection → invite the team → first skill → first backup** ([Linux first run](INSTALL-LINUX.en.md#first-run)). Connect the AI account in Admin › AI providers. Command line alternatives:

```sh
docker compose exec -T trina-ax /var/lib/mycel/root/set-claude-token < token.txt   # from `claude setup-token`
docker compose exec trina-ax mycel-ctl codex-login                               # not tested in Docker yet
docker compose exec trina-ax /var/lib/mycel/root/mycel-account reset-link         # owner password recovery
```

## Access for the team

Colleagues need https. Use one of these:

1. **Official relay.** Admin › System. The server connects out; nothing to open on the host. Needs an issued connection code.
2. **Cloudflare Tunnel sidecar.** Set `TRINA_AX_PUBLIC_HOST` and `CLOUDFLARE_TUNNEL_TOKEN` in `.env`, point the tunnel's public hostname at `http://localhost:47820`, then run `docker compose --profile tunnel up -d`. The sidecar shares the server's network, so its requests come from 127.0.0.1. The server needs that to treat them as the public address (Secure cookie, https origin, CF-Connecting-IP).

A reverse proxy on the host (nginx, Caddy) that connects to the published port does **not** work for the public address yet. Its requests come from the Docker network, not from 127.0.0.1, so the server does not handle them as the public https address. The office-network TLS port (`--tls-port`) is not set up in the Docker image either.

## Security settings

`docker-compose.yml` sets the minimum that keeps the engine lockdown of the Linux install working. Do not replace it with `privileged: true`.

What runs as which account inside the container:

| Process | Account | Started by |
|---|---|---|
| `trina-ax-entrypoint`, `install-linux.sh` (at start only), `mycel-ctl supervise` (PID 1) | root | Docker |
| Engine firewall (`nft` table `inet mycel`, applied again every 2 minutes) | root | supervise |
| `mycel-launcher` | `axagent` (uid 981) | supervise |
| AI engines (Claude Code, Codex) in bubblewrap + Landlock + seccomp, no network except the model proxy | `axagent` (uid 981) | launcher |
| `mycel-bootstrap` → team server, model proxy (127.0.0.1:47821), converters in bubblewrap | `axserver` (uid 980) | supervise |

The uids are fixed in the image (980 and 981, the same as the hosted image). The files in the volume belong to these numbers, so do not change them.

Capabilities: `cap_drop: ALL`, then only these. Each one was removed in a test; the result is in the right column.

| Capability | Why | Without it |
|---|---|---|
| `CHOWN` | The installer gives folders to `axserver` and `axagent` | Installer stops |
| `DAC_OVERRIDE` | Root reads and writes the role accounts' folders (mode 700) | Installer stops |
| `FOWNER` | The installer sets modes on folders root does not own | Installer stops |
| `FSETID` | The setgid bit on `run/tools` and `run-launcher`, so the sockets get the right group | Starts, but the engine cannot reach the tools socket. The entrypoint now stops with a message |
| `KILL` | supervise stops the server and the launcher (other uids) | `docker stop` waits until Docker kills everything |
| `SETUID`, `SETGID` | supervise and `runuser` start processes as the two accounts | bubblewrap check fails |
| `NET_ADMIN` | The nftables rule in the container's own network namespace: `axagent` may connect only to 127.0.0.1:47821 | Entrypoint stops |

Security options (`security_opt`):

| Option | Why | Trade-off |
|---|---|---|
| `no-new-privileges:true` | Nothing in the container gains privileges through setuid files | None. supervise sets the same flag itself |
| `seccomp=./seccomp.json` | Docker's default filter refuses the namespace calls bubblewrap makes as `axagent`. The file is Docker's default profile plus one rule: `clone`, `unshare`, `setns`, `mount`, `umount2`, `pivot_root` without `CAP_SYS_ADMIN` ([seccomp.NOTICE](../docker/seccomp.NOTICE)) | Root and `axserver` processes may call these. Each AI turn also gets the product's own seccomp filter inside bubblewrap |
| `apparmor=unconfined` | Docker's AppArmor profile refuses `mount` | No AppArmor confinement of the container. Hosts without AppArmor ignore it |
| `systempaths=unconfined` | bubblewrap mounts a new `/proc` in each turn's PID namespace. The kernel refuses that while Docker hides parts of `/proc` | **Main risk.** `/proc/sys` and `/proc/sysrq-trigger` are writable for root in the container, and `/proc/kcore` and similar files are readable by root. Without user namespace remapping, root in the container is root on the host: a process that runs as root in the container can take over the host (for example through `kernel.core_pattern`). The engine (`axagent`) and the server (`axserver`) cannot write these files. Only the entrypoint, the installer and supervise run as root, all from the signed kit. With rootless Docker or `userns-remap`, container root is not host root, and this risk goes away (not tested yet) |

Not changed from the Linux install: engine turns run as `axagent` in bubblewrap (user, PID, network, IPC and UTS namespaces), Landlock (`--landlock required`) and the product's seccomp filter; the nftables egress rule; the model proxy as the only network path; signed kits only (`--require-signed`).

### Ubuntu 24.04 hosts

Ubuntu 24.04 sets `kernel.apparmor_restrict_unprivileged_userns=1`. This probably also applies to unconfined containers: then bubblewrap cannot create a user namespace and the container stops at the first check. A container cannot load the AppArmor profile that the Linux installer uses. Options, on the host: load an AppArmor profile for the container that allows `userns`, or set `kernel.apparmor_restrict_unprivileged_userns=0`. **Not tested yet.** Use Debian 13 hosts until this is tested.

## Limits

The container has no writable cgroup tree, so `mycel-ctl supervise` cannot delegate cgroups:

- No per-turn limits (memory, tasks, CPU) and no shared converter limit. The log says `no turn cgroups` and `converters run without a cgroup limit`.
- The compose limits (`mem_limit`, `memswap_limit`, `pids_limit`, `cpus`) hold the whole team. One run-away turn or converter can slow or stop the others, but not the host.
- Safe PowerPoint (safe operations 1A) is not supported in Docker: it needs the cgroup limits.

## Updates

The image does not update itself. The installer runs with `--no-auto-update`: there is no update timer, and the server does not apply releases by itself (`server.json` `update.auto: false`).

To update:

1. Make a backup ([Backups](#backups)).
2. Set the new `TRINA_AX_VERSION` in `.env`.
3. `docker compose up -d --build`

At start the entrypoint sees the new kit version and runs `install-linux.sh update`. The installer switches `app/current`, keeps the previous version for roll-back, and installs the pinned engine of the new release. The bootstrap goes back to the previous version by itself if the new one does not start. Database changes are not undone.

Do not use these in the container:

- `mycel-ctl update` and `mycel-ctl auto-update on` (`mycel-ctl status` suggests them). The image tag is the version.
- Admin › Home › "Install now". It puts a newer app into the volume. The next start keeps it ("this kit is older"), but the root files stay at the image's version until you build a newer image.

Going back to an older image tag does not downgrade the volume: the installer keeps the newer version running and warns. To go back, use Admin › System › Update › Roll back, or restore a backup of the volume with the older tag.

## Backups

The whole install is in one named volume (`trina-ax_data` on `/var/lib/mycel`): the app versions, the root files, `data/` (database, backups), `team/` (the team folder), `config/`, `secrets/` and the engine account's folder.

Keep the data in the named volume. Do not replace it with a bind mount of a host folder: on a Mac the file sharing may not keep owners and the setgid bits, and the engine then cannot reach the server.

The entrypoint writes `/etc/default/mycel` again at each start, in the container, not in the volume. Changes that `mycel-ctl` makes to that file are lost at the next start.

Inside the app (the server stays up):

```sh
trina_admin() { docker compose exec -T -w / -u axserver -e MYCEL_CONFIG=/var/lib/mycel/config/server.json trina-ax \
  /var/lib/mycel/app/current/bin/bun /var/lib/mycel/app/current/server/src/admin.js "$@"; }
trina_admin backup --scope full
trina_admin list-backups
trina_admin archive --out /var/lib/mycel/data/off-host.tar.zst.age --password-stdin < password-file
docker compose cp trina-ax:/var/lib/mycel/data/off-host.tar.zst.age ./
```

See [BACKUP-RESTORE.md](BACKUP-RESTORE.md) for restore. The whole volume, with the server stopped:

```sh
docker compose stop
docker run --rm -v trina-ax_data:/v:ro -v "$PWD":/out debian:trixie-slim tar -C /v -czpf /out/trina-ax-volume.tar.gz .
docker compose start
```

A volume copy holds secrets (AI connections, keys): keep it encrypted and off the host. Local backups in the volume are not disaster recovery.

## Differences from the Linux install

| | Linux install (VM) | Docker |
|---|---|---|
| Service manager | systemd units | `mycel-ctl supervise` as PID 1 |
| Per-turn cgroup limits, converter limit | Yes | No (container limits only) |
| Safe PowerPoint (1A) | Yes | No |
| Updates | Update timer, `mycel-ctl update`, in-app | New image tag |
| `ptrace_scope` | Set by the installer | Set on the host by you |
| AppArmor profile for bubblewrap (Ubuntu) | Loaded by the installer | Host task, not tested |
| Kernel isolation from other workloads | Own kernel (VM) | Shared host kernel |
| Public address | Tunnel or reverse proxy to 127.0.0.1 | Relay or tunnel sidecar |

## Test

`docker/test.sh` builds the image, starts it with a separate project name and port, and checks: health, the setup page, the setup link, first-run setup through the published port, the engine firewall (`axagent` reaches only the model proxy), bubblewrap + Landlock + seccomp as `axagent`, the launcher's own status (bwrap, Landlock required, firewall loaded), and a new container on the same volume. It does not run a real AI turn (that needs an AI account). Then it removes the container, the volume and the network.

```sh
TRINA_AX_VERSION=0.3.0 bash docker/test.sh
TRINA_AX_KIT=local bash docker/test.sh      # an unpacked kit in docker/kit-local/ (unsigned is accepted)
```

## Uninstall

```sh
docker compose down        # stops and removes the container; the volume stays
docker compose down -v     # also deletes the volume: all team data. Only after an off-host backup
```

## Troubleshooting

| Message | Fix |
|---|---|
| `nftables does not work here` | `cap_add: NET_ADMIN` is missing |
| `the engine sandbox (bubblewrap) cannot start here` | A `security_opt` line is missing, or an Ubuntu 24.04 host ([Ubuntu hosts](#ubuntu-2404-hosts)) |
| `... has no setgid bit` | `cap_add: FSETID` is missing. Add it, start once with `TRINA_AX_REINSTALL=1` |
| `downloading https://downloads.claude.ai/... failed` | No outbound https at first start. The container tries again (restart policy) |
| Installer warning `this kernel has no Landlock in its LSM list` | The container cannot read `/sys/kernel/security`. Check Landlock with `docker compose exec trina-ax runuser -u axagent -- /var/lib/mycel/root/mycel-sandbox probe`: `landlockAbi` must be 1 or more |
| `opening seccomp profile (./seccomp.json) failed` | Run `docker compose` inside the `docker/` folder: the profile path is read from the current folder |
| `kernel.yama.ptrace_scope is 0` | On the host: `sysctl -w kernel.yama.ptrace_scope=1` and add it to `/etc/sysctl.d/` |

Logs: `docker compose logs trina-ax`. Status: `docker compose exec trina-ax mycel-ctl status`.
