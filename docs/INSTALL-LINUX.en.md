# Self-host on Linux

[한국어](INSTALL-LINUX.md) · [IT checklist](for-admins.md)

Use a dedicated server or VM. **systemd must be PID 1 and cgroup v2 must be available. A plain Docker container is not supported by this production installer.** Do not bypass those checks. A local demo is a separate development environment.

## Requirements

| Item | Requirement |
|---|---|
| OS | Debian 13 recommended; Debian 12 or Ubuntu 24.04. Installer rejects Ubuntu 22.04 and RHEL-family systems |
| CPU | amd64 with SSE4.2 or arm64 |
| RAM / disk | 4 GB RAM recommended (2 GB: one concurrent run); at least 20 GB plus space for files, history and backups (the app itself takes about 1–1.5 GB: see [Kept versions](#kept-versions)) |
| Kernel | 6.12+ recommended; older kernels have isolation limitations reported by diagnostics |
| Tools / access | sudo, curl, tar, Python 3 for checksum check; internet for packages, updates and selected providers |
| Operations | A named operator, approved provider account, HTTPS access plan and off-host backup destination |

These are install requirements, not a capacity benchmark. One installation is one team.

Linux servers run no OCR. When the AI reads a photo or a scanned PDF page it sees the image itself (Admin > Team settings, "Send images, PDF pages and video frames to the AI", on by default), and scanned documents and photos are not text-searchable, as with Claude Code's own search. The installer no longer installs tesseract.

The AI reads video and audio files with the distribution's ffmpeg and ffprobe (the `ffmpeg` package, 5.1 or newer, installed by apt with the other packages; never part of the kit): frames and, when allowed in Team settings › Voice input, a transcript. Its decoders read files people upload, so keep Debian / Ubuntu security updates on (for example the `unattended-upgrades` package); they ship ffmpeg's security fixes. Without ffmpeg the AI says it cannot read video on this server.

The server learns its own public address from the release feed (`https://updates.trina.app/ip`, once over IPv4 and once over IPv6, at start and every 30 minutes) and refuses web addresses the AI opens that lead back to it (through the router or NAT in front of the server). While it does not know it (no internet, or that outbound connection blocked), every web address the AI opens needs a person and scheduled tasks open none. `MYCEL_EXIT_ADDRESS_CHECK=off` in `/etc/default/mycel` stops the check (the server then keeps asking).

HWP/HWPX text extraction is available. Visual previews are the optional HWP Preview plugin: installing it from the official list in Admin > Plugins makes the server download the pinned build over https from the release feed (the address updates come from), so that outbound connection must be open. Default release kits do not include the rhwp executable. Debian 12 does not support visual previews and Admin > Plugins says so (glibc 2.36; the pinned renderer needs 2.39). Original downloads and text extraction remain available. See [runtime limits](../resources/hwp/README.md).

Korean, Japanese and Chinese in PDFs: the PDFs the AI makes are drawn with the Noto Sans CJK fonts in the kit (`app/<version>/fonts/`, OFL-1.1, notice in `licenses/noto-sans-cjk/`). A Linux server has no font for these characters, so up to 0.2.15 they came out as empty boxes. Nothing to install on the server: an installed server gets the fonts with its normal update (no root step, no apt). PDFs made before that need to be made again. The fonts add about 32 MB to the kit (40 MB unpacked).

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
2. Owner → Admin → AI connections: connect an authorized Claude or Codex account/API key. On fresh teams one company connection can serve the whole team by default; saved choices persist. Personal connections take priority; connection consent is separate. This setting is not permission under provider terms. Use HTTPS for credential setup.
3. Configure an HTTPS address before inviting colleagues. A separately installed tunnel/reverse proxy must reach `127.0.0.1:47820`; register its hostname with `sudo ./install-linux.sh repair --public-host team.example.com`. Tunnel credentials are managed outside this installer. Official relay registration needs an issued connection code; it is not a free hostname signup.
4. Invite a small group, copy a [starter skill](../examples/README.md), and review its result against sources.
5. Make a backup and practice [restore](BACKUP-RESTORE.md) before real rollout.

Claude Code on other models (DeepSeek, Kimi, GLM and others through OpenRouter or a provider's Anthropic-compatible API): set `engine.anthropicGateway` in `/var/lib/mycel/config/server.json`, restart with `sudo systemctl restart mycel-server`, and add the gateway's key in Admin → AI connections. Conversations then go to the gateway provider and the model's vendor, and Claude subscription connections are off. [Anthropic-compatible gateway](CONFIGURATION.md#anthropic-compatible-gateway).

## Upgrade and rollback

Read the [latest release](https://github.com/trina-app/trina-ax/releases/latest) and admin actions, make a full backup plus an encrypted off-host archive, then review diagnostics. The signed Trina feed is `https://updates.trina.app/server/stable.json`. App-only updates can apply during the configured window when no answers are running; root changes require the update timer or `sudo mycel-ctl update`. Check `sudo mycel-ctl status` afterward and test login and a permitted file.

The update timer and `sudo mycel-ctl update` without `--version` install the feed's release only when it is newer than the app that runs, in the same version order as the app's own updater (a server on a pre-release such as 0.2.18-pre.1 skips a 0.2.17 feed and says so); to go back on purpose, give the version: `sudo mycel-ctl update --version <version>` (newer root files stay).

For manual updates, download and verify the new kit as above, then use `sudo ./install-linux.sh update --from .`. A startup failure can roll the app back; it does **not** undo database migrations or file changes. Do not assume an older binary can read every future database. Restore from a verified pre-update backup when needed, using a compatible release.

### Kept versions

Every update brings one version folder, `app/versions/<version>` (about 540 MB unpacked). Ten minutes after the server starts (when the bootstrap has confirmed the new version) and then every hour, the server account removes what roll-back cannot use; there is no root step.

- **Kept:** the current version (`app/current`); the previous one (`previous` in `app/state.json`: Admin › System › Update › Roll back, and where the bootstrap goes when the current version no longer verifies); the newest version downloaded but not applied yet; any version folder changed in the last 24 hours (one `mycel-ctl update` or the installer has just brought in and is switching to).
- **Removed:** every other version folder; `.staging-*` and `*.partial` left by an update that did not finish, once a day old; engine folders `app/engines/<name>/<sha12>` that `current` no longer points to, a day after the installer changed the engine. Links are never followed, and names that are not versions stay. A folder is first renamed to `.prune-<hex>` and then removed; one left by an interrupted removal goes a day later. One that changed meanwhile and cannot get its name back is kept as `.prune-hold-<hex>` and shown in Diagnostics until you rename or remove it. A folder owned by another account (for example root's, from an installer that was stopped) is reported in Diagnostics and left for root to remove. A folder that is or holds a mount point is never removed.
- A pending update (`pending` in `state.json`) skips that run.
- `app/` is therefore usually 1–1.5 GB (two or three versions and the engines). Admin › System › Diagnostics shows the kept versions and their size ("Kept versions").
- Now, by hand: `trina_admin prune-versions --dry-run` (lists what would go, JSON; also works as root) and `trina_admin prune-versions` (`trina_admin` as in [BACKUP-RESTORE.md](BACKUP-RESTORE.md); not as root).
- The first update to 0.2.16 removes the versions collected so far ten minutes after it: in a test (Debian 13 container) 9 versions, 4.5 GB and about 40,000 files took 5 seconds. A slow disk may take tens of seconds; the server keeps answering meanwhile.
- An older kit put in by the installer (`older`: the running version stays) is kept for one day only; switch to it within that day (`admin.js switch <version>`).

### Windows app

The Windows desktop app updates only from its own team server's `/downloads/latest.yml` (every 4 hours; installed when
the app quits). Fifteen minutes after the server starts (an update restarts it) and every 6 hours after that, a Linux
server puts the Windows installer and `latest.yml` of the release it runs into `data/downloads`; Settings › Apps shows
the installer too, and the "Windows app" line of Admin › System › Diagnostics shows the last result. A server whose
automatic updates are off (`--no-auto-update`, `update.auto: false`) asks the feed only when it starts, that is after
you updated it.

- Source: `office/<channel>.json` (signed) on the same feed as the server's. The signature, both files' size and
  SHA-256, and that `latest.yml` names exactly that installer are checked. An app newer than the server waits until
  the server has that release.
- One Windows installer is kept (about 110 MB; older ones are removed). Nothing is downloaded when the free space left
  afterwards would be under the team folder's write reserve (512 MB or 2% of the disk, whichever is larger). A newer
  installer put there by hand stays.
- Windows apps already installed need nothing: they pick up the new version at their next check.
- Now, by hand: `trina_admin desktop-refresh` (`trina_admin` as in [BACKUP-RESTORE.md](BACKUP-RESTORE.md); JSON; not as
  root). A version whose files did not match is tried again a day later; `--force` tries at once.
- A server without internet: on another computer download the server's channel file
  `https://updates.trina.app/office/stable.json` (`beta.json` on the beta channel) and the Windows installer and
  `latest.yml` it names (`office/<version>/`), put them in one folder the server account can read and run
  `trina_admin desktop-refresh --from /full/path` (not a relative path: `trina_admin` runs from `/`). The same checks
  apply. A release newer than the server is not offered (`ahead`): update the server first. The command exits non-zero
  unless the result is `offered`, `current` or `newer` (a newer installer put there by hand).
- When the channel has already moved on to a newer release, the server takes its own release's signed manifest
  instead (`office/<version>/<channel>.json`, kept on the feed for every release from 0.2.19 on).
- Office mode (Mac) does the same with its own update agent. A hosted tenant does only the run after each start (the
  hosted service's update restarts it), from its own feed; its owner sees the result in Diagnostics.

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

## Backup, restore, uninstall

See [BACKUP-RESTORE.md](BACKUP-RESTORE.md) for DB-only restore, team files, encrypted archives, ownership and new-machine limits. Local backups are on the same disk and are not disaster recovery by themselves.

```sh
sudo ./install-linux.sh uninstall
```

This removes services/app components while retaining data, and the `MYCEL_SAFE_OPS_1A` line of `/etc/default/<id>` (a reinstall starts with 1A off; the file's other lines stay). Only after verifying an off-host recovery copy, `uninstall --purge` also removes data/accounts. Confirm the installer identity and path before removal; never use demo cleanup on a production directory.

## Troubleshooting and FAQ

Use Admin → System → Diagnostics and `sudo mycel-ctl status`. Locally inspect `journalctl -u mycel-server -u mycel-launcher -n 100`; redact before sharing. If there is no systemd, use a suitable VM. Ubuntu sandbox/AppArmor problems should be repaired with the installer, not by disabling isolation. [Troubleshooting](TROUBLESHOOTING.md) · [FAQ](FAQ.md) · [Configuration](CONFIGURATION.md).

Source-built unsigned kits are an advanced development path: derive a unique `-dev` version from the source version, review the bundle and explicitly accept its unsigned status on a disposable host. They are not the normal update path. [Developer guide](DEVELOPMENT.md).
