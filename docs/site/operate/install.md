---
title: Install
description: Choose between Trina hosting, a Linux server and an office Mac, and get each one running.
---

There are four ways to run Trina AX. Pick the one that fits who will look after it.

| | Trina hosting | Linux server | Office Mac | Local demo |
|---|---|---|---|---|
| **Best for** | Teams without IT | Teams with an IT owner | A small office with a dedicated Mac | Looking around |
| **Who runs it** | Trina, in AWS Seoul | Your IT | Your office operator | You |
| **AI** | Your authorized Claude or OpenAI connection | Same | Claude (no Codex) | Off |
| **OS isolation** | Yes | Yes | Runs as the signed-in user | No |
| **Start** | [See the plans](https://ax.trina.app/#pricing) | [Below](#linux-server) | [Below](#office-mac) | [Quickstart](../get-started/quickstart.md) |

One installation is one team.

## Linux server

### Requirements

| Item | Requirement |
|---|---|
| OS | Debian 13 recommended; Debian 12 or Ubuntu 24.04 |
| CPU | amd64 with SSE4.2, or arm64 |
| Memory and disk | 4 GB RAM recommended; at least 20 GB disk plus your files, history and backups |
| System | systemd with cgroup v2. A plain Docker container is not supported. |
| Access | sudo, curl, tar and Python 3 for the checksum check |

### Install

:::steps
#### Download and verify the kit
Download `TrinaAX-server-<version>-linux-<arch>.tar.gz` and `SHA256SUMS` from the [latest release](https://github.com/trina-app/trina-ax/releases/latest), compare the checksum, and unpack it. The [Linux guide](../../INSTALL-LINUX.en.md) has a copy-paste script.

#### Check the bundle and the machine
```sh
./app/$V/root/mycel-ctl verify-bundle "./app/$V"
sudo ./install-linux.sh check --from .
```

#### Install
```sh
sudo ./install-linux.sh install --from . --engine claude --engine codex
sudo mycel-ctl status
```
The installer creates the service accounts, installs into `/var/lib/mycel` and sets up the sandbox, firewall and systemd units. The app listens on `127.0.0.1:47820`.

#### Create the owner
Open an SSH tunnel (`ssh -L 47820:127.0.0.1:47820 <server>`), read the setup code from `/var/lib/mycel/setup/code` on the server, and open the setup page.

#### Give it an HTTPS address
Put a tunnel or reverse proxy in front of `127.0.0.1:47820`, then register its hostname with `sudo ./install-linux.sh repair --public-host team.example.com`.
:::

:::warning
Do not use `--allow-unsigned` for published releases. It is only for kits you built yourself.
:::

## Office Mac

An office Mac runs Trina AX as a dedicated, signed-in macOS user. It stops when that user logs out.

| Item | Requirement |
|---|---|
| macOS | 13 or newer, Apple Silicon or Intel |
| Account | A dedicated signed-in user, with FileVault on |
| AI | Claude Code, installed and signed in separately |

:::steps
#### Download and verify the ZIP
Download `TrinaAX-office-<version>-mac.zip` and `SHA256SUMS` from the latest release, and compare the checksum.

#### Check, then install
```sh
bash "$OFFICE_DIR/office-install.sh" --check-only
bash "$OFFICE_DIR/office-install.sh"
```
No sudo is needed. It installs into `~/TeamAX`.

#### Create the owner
Use the local setup link the installer prints. Office computers then use `https://<Mac-IP>:8443` after trusting the office certificate (`~/TeamAX/teamax card` shows its fingerprint).
:::

Full guide: [Office Mac](../../OFFICE.en.md).

## After installing

Follow the first-week order: **permissions → AI connection → invite the team → first skill → first backup**. [Read the admin guide](../use/admin.md).
