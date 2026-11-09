---
title: CLI reference
description: The commands operators use: mycel-ctl and the installer on Linux, teamax on an office Mac, and the admin tool.
---

## mycel-ctl (Linux)

Run with `sudo`. The base folder defaults to `/var/lib/mycel`.

| Command | What it does |
|---|---|
| `preflight [--json]` | Check this machine: kernel, Landlock, cgroup v2, user namespaces, nftables, Yama |
| `status [--json]` | Versions, units, firewall, disk, health and update history |
| `update [--version V \| --bundle FILE]` | Update the root files and the app now |
| `auto-update on\|off\|status` | Turn automatic updates on or off |
| `allow-unsigned on\|off\|status` | Accept unsigned development builds, or signed releases only |
| `verify-bundle DIR\|FILE` | Check a release's manifest and signature |
| `firewall apply\|status\|remove` | Load, check or remove the engine firewall |
| `safe-ops on\|off\|status` | Safe operations 1A |
| `codex-login` | Sign the engine account in to Codex with a device code |

The installer also uses `apply-plan` and `render-units`. `supervise` runs without systemd for tests only.

## install-linux.sh

Run from an unpacked kit with `sudo`.

| Command | What it does |
|---|---|
| `check --from .` | Check the machine and the kit without installing |
| `install --from . --engine claude --engine codex` | Install |
| `update --from .` | Update by hand from a verified kit |
| `repair --public-host HOST` | Register the HTTPS host name. Add `--app-connectors` to turn on the [MCP connector](../agents/mcp-connector.md). |

Advanced options: `--id`, `--port`, `--proxy-port`, `--no-auto-update` / `--auto-update`, `--require-signed`, `--minimal` / `--no-minimal` (only the system packages every install needs, without the fonts, the dev environment's tools and the headless browser). Never use `--allow-unsigned` for published releases.

## teamax (office Mac)

Call it as `~/TeamAX/teamax <command>`.

| Command | What it does |
|---|---|
| `status` | Whether the server runs, and update state |
| `start`, `stop`, `restart` | Control the server |
| `logs [n]` | Show the latest log lines |
| `info`, `card` | Addresses, and the office certificate fingerprint |
| `setup-link`, `reset-link [--username U]` | A setup link, or a password reset link |
| `backup` | Back up now |
| `archive FILE` | Write an encrypted archive (asks for a password) |
| `restore-archive FILE [--replace]` | Restore from an encrypted archive |
| `update status\|check\|now\|pause\|resume` | Manage updates |
| `update channel stable\|beta`, `update time HH:MM` | Pick the channel and the update time |
| `public-address set HOST TOKEN-FILE\|off\|status` | The optional internet address |
| `desktop list\|add\|remove` | Desktop installers offered under Settings › Apps |
| `check-ports`, `claude-mcp check` | Diagnostics |

## Admin tool (Linux)

Backups on Linux run the server's `admin.js` as the service account. The [backup guide](../../BACKUP-RESTORE.md) defines a `trina_admin` shell function for it.

| Command | What it does |
|---|---|
| `backup --scope full` | A full backup |
| `list-backups` | List backups |
| `archive --out FILE --password-stdin` | An encrypted archive of database and files |
| `restore-archive --in FILE --to NEWDIR --password-stdin` | Extract an archive into a new folder |
| `stage-restore --backup ID` | Restore the database at the next start |
| `restore-team --backup ID --to NEWDIR` | Rebuild team files into a new folder |

## Development scripts

`bun run demo`, `bun run dev`, `bun run demo:seed`, `bun run typecheck`, `bun run test:unit`, `bun run check:i18n`, `bun run check:docs`, `bun run docs:build`. [See local development](../develop/local-development.md).
