---
title: Host it on a Windows PC
description: Run your team's Trina AX server on a Windows 11 PC in your office, in four steps, with what you need and what to keep in mind.
---

Your team's Trina AX server can run on an ordinary Windows PC that stays on, such as the PC at the front desk or a spare one in the office. One setup script does the work. It is the same server as on a Linux machine, with the same updates, backups and safe space for the AI's work.

It suits a small office that has a PC that is always on. If you would rather not keep a PC on at all, [Trina hosting](https://ax.trina.app/#pricing) runs the server for you.

How hard is it?

- **Only on this PC: easy.** Paste a few commands, restart the PC once, and it is done in about 10 minutes.
- **For the whole team:** you need your own domain and a Cloudflare account. As with other open-source software, it takes someone who knows a little IT.

Korean: [윈도우 PC에 설치하기](../../INSTALL-WINDOWS.ko.md) (the full guide in Korean).

## What you need

| | |
|---|---|
| **The PC** | Windows 11 (Home, Pro or Enterprise), or Windows 10 version 22H2. Most PCs from the last few years work |
| **Memory** | 16 GB recommended, 8 GB at least. With 8 GB the PC feels slow for other work while the AI answers |
| **Disk** | 20 GB free on drive C:, plus room for the team's files |
| **Account** | A Windows account with administrator rights. The server belongs to this account |
| **Power and internet** | The PC stays plugged in, on and online during work hours |
| **About 10 minutes** | About 6 minutes, up to 40 on a slow PC or connection, plus one restart |

## The four steps

:::steps
#### Sign in to Windows with the account that will keep the server
Use an account with administrator rights. The server runs while this account is signed in.

#### Run the setup
Open the Start menu, type **PowerShell**, right-click **Windows PowerShell** and choose **Run as administrator**. Copy these four lines, paste them into the blue window and press Enter:

```powershell
cd $env:USERPROFILE\Downloads
$V = (Invoke-RestMethod https://api.github.com/repos/trina-app/trina-ax/releases/latest).tag_name
Invoke-WebRequest "https://raw.githubusercontent.com/trina-app/trina-ax/$V/scripts/windows/install-wsl-server.ps1" -OutFile install-wsl-server.ps1
powershell -ExecutionPolicy Bypass -File .\install-wsl-server.ps1
```

Answer its questions (Enter means yes) and leave the window open. The first time, Windows restarts once; sign in again and the setup goes on by itself in a new window. If a "Welcome to WSL" window opens, close it. If something is missing (for example virtualization is off), the script stops and says what to do.

#### Create your team
At the end the script offers to open the setup page on this PC and copies a one-time setup code for you. (If the window's last lines mention `ssh -L` or `sudo`, skip them: they are for a Linux server. Open `http://127.0.0.1:47820/setup` on this PC.) Paste the code into the page, then create your owner account and your team, and pick its language.

#### Use it on this PC, or give it your own address
**Only on this PC?** You are done: open `http://127.0.0.1:47820` in the browser or the desktop app on this PC. Nothing else to set up.

**For colleagues' computers and the phone apps**, the server needs a secure web address of your own that starts with `https://`, such as `https://team.yourcompany.com`, the way other self-hosted software does. The simplest way is a free Cloudflare Tunnel to a domain you own: follow [Connect your own domain with Cloudflare Tunnel](#connect-your-own-domain-with-cloudflare-tunnel) below. Then invite your team from the app.
:::

:::tip
The script is a plain text file. To see what it would change without changing anything, run it with `-WhatIf` at the end of the last line. Running it again is safe: finished steps are skipped.
:::

## Connect your own domain with Cloudflare Tunnel

A tunnel lets people reach the server at `https://team.yourcompany.com` without opening anything on the PC or the office router: a small Cloudflare program on the PC connects out to Cloudflare, and Cloudflare gives the address a certificate that computers and phones trust. You need a domain (for example `yourcompany.com`) and a free Cloudflare account.

:::steps
#### Put your domain on Cloudflare
No domain yet? Buy one first, from any domain seller or from Cloudflare itself (usually a few dollars a year). Then sign up at [cloudflare.com](https://www.cloudflare.com) and add your domain (the free plan is enough). Cloudflare tells you which two name servers to set where you bought the domain. Wait until Cloudflare shows the domain as active; this can take a few hours.

#### Create the tunnel
In the Cloudflare dashboard, open **Networking › Tunnels** and choose **Create a tunnel**. Give it a name such as `trina-office` and create it. On the next screen Cloudflare shows install commands for each system. You need only the long token in them: the text after `service install`. Copy it.

#### Install the Cloudflare program next to the server
On the PC, open **Windows PowerShell as administrator** again and paste this line, with your token in place of `YOUR_TOKEN`:

```powershell
wsl -d TrinaAX --cd / -u root -- bash -c "curl -fsSL -o /tmp/cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb && dpkg -i /tmp/cloudflared.deb && cloudflared service install YOUR_TOKEN"
```

It installs Cloudflare's program inside the server's Linux, where it starts with the server. (On a PC with an ARM processor, write `arm64` instead of `amd64`.) Back in the dashboard the tunnel turns **Healthy**; choose **Continue**.

#### Point your address at the server
On the tunnel's **Routes** tab choose **Add route › Published application**. Type a subdomain (for example `team`), pick your domain, and in **Service URL** enter `http://127.0.0.1:47820`. Choose **Add route**.

#### Tell Trina AX its address
In the same PowerShell window, with your address in place of `team.yourcompany.com`:

```powershell
wsl -d TrinaAX --cd / -u root -- bash -c "cd /root/trina-ax-kit && ./install-linux.sh repair --public-host team.yourcompany.com"
```

This runs the installer again and restarts the server, so for about 35 seconds nobody can use it. It ends with a line `installed mycel <version> (...)`; skip the hints after it about `ssh -L` and `sudo`, which are for a Linux server.

Open `https://team.yourcompany.com` on another computer or a phone and sign in. Your team uses this address in the browser and the apps; the invite links use it too.
:::

The address works only while the PC is on and signed in, like the server itself. Cloudflare's own guide: [Create a tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/).

## Keep it running

- **Stay signed in.** Locking the screen is fine. Signing out, or a restart before someone signs in again, stops the server for everyone.
- **Keep the PC awake.** The script offers to stop sleep while the PC is plugged in. On a laptop, also set closing the lid to **Do nothing** when plugged in.
- **After Windows updates**, Windows may restart at night and wait at the sign-in screen. Turn on **Settings › Accounts › Sign-in options › Use my sign-in info to automatically finish setting up after an update**, and check the next morning that the team can open Trina AX.
- **Updates to Trina AX** install by themselves in the team's update window (Admin › Team settings, 03:00 to 05:00 by default). If the PC is off at night, move the window to hours when it is on.
- While the PC is off or asleep, nothing runs: scheduled tasks and phone notifications wait until it is back.

## Where your team's files are

Everything (files, chats, backups) is in one hidden Linux disk file on drive C:, not in your Windows folders. Windows programs and the PC's own files stay separate from it. The backups Trina AX makes are on that same disk, so they do not help if the PC breaks: copy a backup to another disk from time to time, as the [full guide](../../INSTALL-WINDOWS.md#backups) shows. Do not let disk-cleanup tools or OneDrive touch the folder.

:::warning
Resetting or reinstalling Windows, or removing the Linux part (`wsl --unregister TrinaAX`), deletes all of the team's data at once. Make and check a copy elsewhere first.
:::

## Remove it

The [full guide](../../INSTALL-WINDOWS.md#uninstall-and-roll-back) has two ways: remove the server and keep the data, or remove everything and put the PC's settings back as they were.

## Full guide

[Self-host on a Windows PC](../../INSTALL-WINDOWS.md) ([한국어](../../INSTALL-WINDOWS.ko.md)) explains every step the script takes, the memory limit, what works differently on Windows and what to do when something goes wrong.
