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

HWP/HWPX text extraction is available. Experimental visual previews are in this source but off by default, and their runtime is excluded from default release bundles. Debian 12 does not support visual previews (glibc 2.36; the pinned renderer needs 2.39). Original downloads and text extraction remain available. See [runtime limits and release gate](../resources/hwp/README.md).

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

## Install

```sh
sudo ./install-linux.sh install --from . --engine claude --engine codex
sudo mycel-ctl status
```

The installer creates `axserver` and `axagent`, installs into `/var/lib/mycel`, configures sandbox/firewall and systemd units (`mycel-server`, `mycel-launcher`, firewall and update timers). It downloads pinned engine binaries. Default app port: 47820, loopback. `--id`, `--port`, `--proxy-port` and `--no-auto-update` are advanced options; preserve the same install identity when maintaining it.

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

## Backup, restore, uninstall

See [BACKUP-RESTORE.md](BACKUP-RESTORE.md) for DB-only restore, team files, encrypted archives, ownership and new-machine limits. Local backups are on the same disk and are not disaster recovery by themselves.

```sh
sudo ./install-linux.sh uninstall
```

This removes services/app components while retaining data. Only after verifying an off-host recovery copy, `uninstall --purge` also removes data/accounts. Confirm the installer identity and path before removal; never use demo cleanup on a production directory.

## Troubleshooting and FAQ

Use Admin → System → Diagnostics and `sudo mycel-ctl status`. Locally inspect `journalctl -u mycel-server -u mycel-launcher -n 100`; redact before sharing. If there is no systemd, use a suitable VM. Ubuntu sandbox/AppArmor problems should be repaired with the installer, not by disabling isolation. [Troubleshooting](TROUBLESHOOTING.md) · [FAQ](FAQ.md) · [Configuration](CONFIGURATION.md).

Source-built unsigned kits are an advanced development path: derive a unique `-dev` version from the source version, review the bundle and explicitly accept its unsigned status on a disposable host. They are not the normal update path. [Developer guide](DEVELOPMENT.md).
