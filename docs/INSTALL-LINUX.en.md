# Self-host on Linux

[한국어](INSTALL-LINUX.md) · [IT checklist](for-admins.md)

Use a dedicated server or VM. **systemd must be PID 1 and cgroup v2 must be available. A plain Docker container is not supported by this production installer.** Do not bypass those checks. A local demo is a separate development environment.

## Requirements

| Item | Requirement |
|---|---|
| OS | Debian 13 recommended; Debian 12 or Ubuntu 24.04. Installer rejects Ubuntu 22.04 and RHEL-family systems |
| CPU | amd64 with SSE4.2 or arm64 |
| RAM / disk | 4 GB RAM recommended (2 GB: one concurrent run); at least 20 GB plus space for files, history and backups |
| Kernel | 6.12+ recommended; older kernels have isolation limitations reported by diagnostics |
| Tools / access | sudo, curl, tar, Python 3 for checksum check; internet for packages, updates and selected providers |
| Operations | A named operator, approved provider account, HTTPS access plan and off-host backup destination |

These are install requirements, not a capacity benchmark. One installation is one team.

Linux servers run no OCR. When the AI reads a photo or a scanned PDF page it sees the image itself (Admin > Team settings, "Send images and PDF pages to the AI", on by default), and scanned documents and photos are not text-searchable, as with Claude Code's own search. The installer no longer installs tesseract.

The server learns its own public address from the release feed (`https://updates.trina.app/ip`, once over IPv4 and once over IPv6, at start and every 30 minutes) and refuses web addresses the AI opens that lead back to it (through the router or NAT in front of the server). While it does not know it (no internet, or that outbound connection blocked), every web address the AI opens needs a person and scheduled tasks open none. `MYCEL_EXIT_ADDRESS_CHECK=off` in `/etc/default/mycel` stops the check (the server then keeps asking).

HWP/HWPX text extraction is available. Visual previews are the optional HWP Preview plugin: installing it from the official list in Admin > Plugins makes the server download the pinned build over https from the release feed (the address updates come from), so that outbound connection must be open. Default release kits do not include the rhwp executable. Debian 12 does not support visual previews and Admin > Plugins says so (glibc 2.36; the pinned renderer needs 2.39). Original downloads and text extraction remain available. See [runtime limits](../resources/hwp/README.md).

## Download, verify, check

Use a new download directory. Resolve the latest release once and use the same version for all files:

```sh
V=$(curl -fsSL -o /dev/null -w '%{url_effective}' https://github.com/trina-app/trina-ax/releases/latest)
V=${V##*/v}
ARCH=amd64 # use arm64 for an ARM server
BASE="https://github.com/trina-app/trina-ax/releases/download/v$V"
KIT="TrinaAX-server-$V-linux-$ARCH.tar.gz"
curl -fLO "$BASE/$KIT"
curl -fLO "$BASE/SHA256SUMS"
python3 - "$KIT" <<'CHECK'
import hashlib, pathlib, sys
name = sys.argv[1]
entries = {parts[1].lstrip('*'): parts[0] for line in pathlib.Path('SHA256SUMS').read_text().splitlines() if len(parts := line.split()) == 2}
assert name in entries, 'Artifact missing from SHA256SUMS'
assert hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest() == entries[name], 'Checksum mismatch'
print('Checksum OK')
CHECK
tar xzf "$KIT"
cd "TrinaAX-server-$V-linux-$ARCH"
./app/$V/root/mycel-ctl verify-bundle "./app/$V"
sudo ./install-linux.sh check --from .
```

A checksum detects download corruption; it is not independent proof of authenticity. The bundle verifier checks the embedded release signature, and the installer checks again. Do not use `--allow-unsigned` for published releases. Inspect the release/source and trust path before running downloaded programs.

### Build a kit from source (development)

On a Linux machine of the server's architecture with git, curl, unzip, xz-utils, zstd, build-essential, cmake, Go
(`native/go.mod`) and Bun 1.3.12; Node.js is not needed:

```sh
git clone https://github.com/trina-app/trina-ax.git && cd trina-ax
bun install --frozen-lockfile --ignore-scripts   # the server kit needs no package install scripts
ARCHS=amd64 bash native/build.sh                  # ARCHS=arm64 on ARM
bash scripts/linux/build-whisper.sh --arch amd64 --out dist/whisper
bun run build:web
bun scripts/build-bundle.ts --os linux --arch amd64 --version 0.2.9-dev.1 --whisper-dir dist/whisper --out dist/linux
cd dist/linux && sudo ./install-linux.sh install --from . --allow-unsigned --engine claude
```

Without `--ignore-scripts`, `bun install` runs install scripts with bun's stand-in for `node`
(`/tmp/bun-node-*/node`); if that points to a bun that was deleted, it stops with `node: command not found`
(`electron-winstaller` exited with 127). Use `--ignore-scripts` or delete that folder. A self-built kit is unsigned,
hence `--allow-unsigned`.

## Install

```sh
sudo ./install-linux.sh install --from . --engine claude --engine codex
sudo mycel-ctl status
```

The installer creates `axserver` and `axagent`, installs into `/var/lib/mycel`, configures sandbox/firewall and systemd units (`mycel-server`, `mycel-launcher`, firewall and update timers). It downloads pinned engine binaries. Default app port: 47820, loopback. `--id`, `--port`, `--proxy-port` and `--no-auto-update` are advanced options; preserve the same install identity when maintaining it. `--id` cannot be `system`, `user`, `machine` or `capsule` (systemd's own slices).

## First run

On your workstation open a local SSH tunnel: `ssh -L 47820:127.0.0.1:47820 <server>`. Read the setup code locally on the server from `/var/lib/mycel/setup/code` with administrative access; keep it private. Open the loopback setup page and enter the code. Create the owner, team name and language; verify the team timezone.

Then follow **permissions → AI connection → invite the team → first skill → first backup**:

1. Admin → Groups/Folders: assign sources and verify access with two pilot accounts.
2. Owner → Admin → AI connections: connect an authorized Claude or Codex account/API key. Fresh teams allow shared subscriptions by default; saved choices persist. Personal connections take priority; connection consent is separate. This setting is not permission under provider terms. Use HTTPS for credential setup.
3. Configure an HTTPS address before inviting colleagues. A separately installed tunnel/reverse proxy must reach `127.0.0.1:47820`; register its hostname with `sudo ./install-linux.sh repair --public-host team.example.com`. Tunnel credentials are managed outside this installer. Official relay registration needs an issued connection code; it is not a free hostname signup.
4. Invite a small group, copy a [starter skill](../examples/README.md), and review its result against sources.
5. Make a backup and practice [restore](BACKUP-RESTORE.md) before real rollout.

## Upgrade and rollback

Read the [latest release](https://github.com/trina-app/trina-ax/releases/latest) and admin actions, make a full backup plus an encrypted off-host archive, then review diagnostics. The signed Trina feed is `https://updates.trina.app/server/stable.json`. App-only updates can apply during the configured window when no answers are running; root changes require the update timer or `sudo mycel-ctl update`. Check `sudo mycel-ctl status` afterward and test login and a permitted file.

For manual updates, download and verify the new kit as above, then use `sudo ./install-linux.sh update --from .`. A startup failure can roll the app back; it does **not** undo database migrations or file changes. Do not assume an older binary can read every future database. Restore from a verified pre-update backup when needed, using a compatible release.

## Safe PowerPoint (safe operations 1A, optional)

Confidential-document PowerPoint ([SAFE-OPS-1A](SAFE-OPS-1A.md)) is off by default:

```sh
sudo mycel-ctl safe-ops on       # checks, root-owned programs, MYCEL_SAFE_OPS_1A=1, group limits, restart
sudo mycel-ctl safe-ops status   # ready, or what is missing
sudo mycel-ctl safe-ops off
```

The server and the AI engines always run in one group, `mycel.slice`. Only while 1A is on does it get limits: memory
`min(4 GiB, server memory − 512 MiB)`, no swap, 512 tasks, at most 4 CPUs; the whole team runs inside them while 1A is
on, even on a larger server. Servers with less than 2304 MiB of memory are refused. 1A jobs run only root-owned
programs: the installer and `mycel-ctl update` keep root-owned copies of `mycel-safeops` and `pandoc` in
`/var/lib/mycel/root/safe-ops/`, from verified kits and bundles only (an `--allow-unsigned` install without them needs
`sudo ./install-linux.sh update --from <kit>`). Turning 1A on or off restarts the server and the launcher. Chats that
ran a 1A job keep web, connectors and the browser off afterwards; other chats get them back when 1A is off. Admin ›
System › Diagnostics shows "Safe PowerPoint (1A)": ready, or what is missing and the command to fix it.

## Code sandbox (optional)

The code sandbox lets the AI run bash and Python 3 programs (docs/DECISIONS.md "Code sandbox"). It is off by default.
An owner or admin turns it on in Admin › Team settings › Code sandbox for chosen people or groups, after accepting a
warning. Each run gets its own bubblewrap sandbox with no network at all, only the chat's work folder, and limits for
time, memory, processes, disk and output. It needs `--sandbox bwrap` and the delegated cgroups (the normal install).

The sandbox uses the programs of the distro in `/usr/bin` and installs nothing. bash is always there; for Python and
the common tools, install them on the host:

```sh
sudo apt install python3 jq unzip
```

The card shows the programs the launcher found. A plan file (below) without `"codeSandbox": true` keeps it off.

## Backup, restore, uninstall

See [BACKUP-RESTORE.md](BACKUP-RESTORE.md) for DB-only restore, team files, encrypted archives, ownership and new-machine limits. Local backups are on the same disk and are not disaster recovery by themselves.

```sh
sudo ./install-linux.sh uninstall
```

This removes services/app components while retaining data, and the `MYCEL_SAFE_OPS_1A` line of `/etc/default/<id>` (a reinstall starts with 1A off; the file's other lines stay). Only after verifying an off-host recovery copy, `uninstall --purge` also removes data/accounts. Confirm the installer identity and path before removal; never use demo cleanup on a production directory.

## Troubleshooting and FAQ

Use Admin → System → Diagnostics and `sudo mycel-ctl status`. Locally inspect `journalctl -u mycel-server -u mycel-launcher -n 100`; redact before sharing. If there is no systemd, use a suitable VM. Ubuntu sandbox/AppArmor problems should be repaired with the installer, not by disabling isolation. [Troubleshooting](TROUBLESHOOTING.md) · [FAQ](FAQ.md) · [Configuration](CONFIGURATION.md).

Source-built unsigned kits are an advanced development path: derive a unique `-dev` version from the source version, review the bundle and explicitly accept its unsigned status on a disposable host. They are not the normal update path. [Developer guide](DEVELOPMENT.md).
