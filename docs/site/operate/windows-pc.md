---
title: Host it on a Windows PC
description: Run your team's Trina AX server on a Windows 11 PC in your office, in four steps, with what you need and what to keep in mind.
---

Your team's Trina AX server can run on an ordinary Windows PC that stays on, such as the PC at the front desk or a spare one in the office. One setup script does the work. It is the same server as on a Linux machine, with the same updates, backups and safe space for the AI's work.

It suits a small office that has a PC that is always on and nobody who looks after servers. If you would rather not keep a PC on at all, [Trina hosting](https://ax.trina.app/#pricing) runs the server for you.

## What you need

| | |
|---|---|
| **The PC** | Windows 11 (Home, Pro or Enterprise), or Windows 10 version 22H2. Most PCs from the last few years work |
| **Memory** | 16 GB recommended, 8 GB at least. With 8 GB the PC feels slow for other work while the AI answers |
| **Disk** | 20 GB free on drive C:, plus room for the team's files |
| **Account** | A Windows account with administrator rights. The server belongs to this account |
| **Power and internet** | The PC stays plugged in, on and online during work hours |
| **About 10 minutes** | The test PC took 6 minutes, plus one restart. A slow PC or connection can take up to 40 |

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
At the end the script offers to open the setup page on this PC and copies a one-time setup code for you. Paste the code into the page, then create your owner account and your team, and pick its language.

#### Give the team an address
Right now only this PC can open Trina AX (at `http://127.0.0.1:47820`). Colleagues' computers and the phone apps need a secure web address that starts with `https://`. Two ways:

- **The Trina relay** gives you an address like `yourteam.trina.app`. Ask us for a claim code at contact@trina.app, then pick **Trina AX relay** in **Admin › System › Change connection** and enter your team name and the code. Nothing on the PC or the office router needs to be opened.
- **Your own address**, through a tunnel or a web server you already run. This needs someone technical; the [full guide](../../INSTALL-WINDOWS.md#reach-it-from-other-computers-and-phones) has the details.

Then invite your team from the app.
:::

:::tip
The script is a plain text file. To see what it would change without changing anything, run it with `-WhatIf` at the end of the last line. Running it again is safe: finished steps are skipped.
:::

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
