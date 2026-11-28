# Self-host on a Windows PC (WSL2)

[한국어](INSTALL-WINDOWS.ko.md) · [Linux server](INSTALL-LINUX.en.md) · [IT checklist](for-admins.md)

> **Not technical?** The short version is the docs page [Host it on a Windows PC](site/operate/windows-pc.md): what you
> need, four steps and what to keep in mind. This page has every detail behind it.

Your team server can run on a Windows PC that stays on. Windows runs a small Debian Linux inside it (WSL2, the
Windows Subsystem for Linux), and the normal [Linux server](INSTALL-LINUX.en.md) runs in that Linux. One script sets
it all up. It is the same server as on a Linux machine, with the same updates, backups and AI sandbox. The script
also cuts Linux off from Windows: Windows programs cannot be started from Linux, and the PC's drives are not visible
in it (see [What the script changes in Linux](#what-the-script-changes-in-linux)).

This way is new. The Linux server (0.20.2) was installed by hand on a Windows 11 PC with 8 GB of memory and worked
(2026-11-27: install, the AI's sandbox, documents, a real AI answer). The script then ran through all its
steps on a Windows 11 Home PC (Korean Windows, WSL 3.0.5) on 2026-11-28, and a second run found nothing to do. A dedicated Linux server or VM is still the first choice for
a team that has one.

## Steps at a glance

1. Check the [Requirements](#requirements).
2. Sign in to Windows with the account that will keep the server, an administrator account.
3. [Run the setup script](#run-the-setup-script). The first time, Windows restarts once and the script goes on by itself.
4. Open the setup page on this PC, create the owner and the team ([First run](#first-run)).
5. Only this PC uses it? You are done. For colleagues' computers and phones, give the server an https address on a
   domain of your own, for example with a Cloudflare Tunnel ([Reach it from other computers](#reach-it-from-other-computers-and-phones)).

## Requirements

| Item | Requirement |
|---|---|
| Windows | Windows 11 (recommended), or Windows 10 version 22H2 (build 19045) with its updates. Home, Pro and Enterprise all work |
| Processor | 64-bit (x64 or ARM64), with virtualization turned on in the BIOS/UEFI (Intel VT-x, AMD-V / SVM). Most PCs have it on |
| Memory | **16 GB recommended, 8 GB minimum.** In the test, Linux used up to 2.4 GB during one AI answer with documents. On 8 GB the PC is slow for other work |
| Disk | At least 20 GB free on drive C:, plus room for the team's files and backups |
| Account | A Windows administrator account. The server belongs to that account: it runs while that account is signed in |
| Network | Internet for the download, updates and the AI provider |
| Power | The PC stays on and plugged in. The script asks before it turns off sleep on power |

WSL2 with systemd needs the current WSL from Microsoft (version 2.4.4 or newer); the script installs or updates it.
Windows 10 no longer gets regular updates from Microsoft, so prefer Windows 11.

## Run the setup script

1. Open **Windows PowerShell as administrator**: Start menu, type `PowerShell`, right-click **Windows PowerShell**,
   **Run as administrator**.
2. Download the script of the latest release and run it:

   ```powershell
   cd $env:USERPROFILE\Downloads
   $V = (Invoke-RestMethod https://api.github.com/repos/trina-app/trina-ax/releases/latest).tag_name
   Invoke-WebRequest "https://raw.githubusercontent.com/trina-app/trina-ax/$V/scripts/windows/install-wsl-server.ps1" -OutFile install-wsl-server.ps1
   powershell -ExecutionPolicy Bypass -File .\install-wsl-server.ps1
   ```

   It is a plain text file: open it in Notepad first if you want to see what it does. `-WhatIf` shows every change
   it would make and changes nothing:
   `powershell -ExecutionPolicy Bypass -File .\install-wsl-server.ps1 -WhatIf`

3. Answer its questions (Enter means yes). On the test PC (2026-11-28) it took about 6 minutes plus the restart; a
   slower PC or connection can take up to 40 minutes, most of it the server's packages. Leave the window open.

What the script does, in order. Run it again at any time: finished steps are skipped.

1. **Checks this PC**: Windows version, 64-bit, memory, virtualization, free disk, and that the window runs as the
   account signed in to Windows. It stops with a plain message when something is missing.
2. **Turns on two Windows features**: Virtual Machine Platform and Windows Subsystem for Linux. The first time this
   needs **one restart**. The script asks, restarts, and after you sign in again it goes on by itself in a new window
   (a one-time task, "Continue the Trina AX setup after the restart"). If no window opens, run the same command again.
3. **Installs or updates WSL**, and sets how much memory Linux may use in `%UserProfile%\.wslconfig` (see
   [Memory](#memory)). A `.wslconfig` you already have is kept: it only gets a memory line when it has none, after a
   copy (`.wslconfig.trina-backup-<date>`).
4. **Installs Debian as a WSL distro named `TrinaAX`** (`-Distro <name>` for another name) and sets its
   `/etc/wsl.conf` ([below](#what-the-script-changes-in-linux)). Your other WSL distros are not touched. The first
   time, Windows may also open a "Welcome to WSL" window; close it.
5. **Installs curl and Python 3** in it: a new Debian has neither, and the download and its check need them.
6. **Downloads the server kit and checks it exactly as the Linux guide does** ([Download, verify,
   check](INSTALL-LINUX.en.md#download-verify-check)): the checksum from the release's `SHA256SUMS`, the kit's
   signature (`mycel-ctl verify-bundle`) and the installer's own check. It never skips a check and never installs an
   unsigned kit. Then it runs the normal installer (`install-linux.sh install`, with Claude Code and Codex). The
   unpacked kit stays in `/root/trina-ax-kit` inside Linux for later repairs. On a run after an install that stopped
   half-way (installed, but the server does not answer), it repairs (`install-linux.sh repair`) instead.
7. **Keeps the server running**: a task "Keep the Trina AX server running" (Task Scheduler, folder TrinaAX) starts at
   your sign-in and keeps Linux on (see [Keeping it running](#keeping-it-running)). It asks whether this PC should
   stop sleeping while it is plugged in.
8. **Checks the server** at `http://127.0.0.1:47820` and offers to open the setup page.

Options: `-Version 0.21.0` (a given release instead of the latest), `-Engine claude` (only Claude Code), `-MemoryGB 6`
(the memory limit), `-KeepAwake Yes|No` and `-OpenSetup Yes|No` (answer those questions ahead).
`-KitPath <TrinaAX-server-...-linux-amd64.tar.gz> -SumsPath <SHA256SUMS>` installs a kit from this PC instead of
downloading one (for example a signed pre-release to test): it is checked exactly like a download, and an unsigned
kit is refused.

The script itself comes from the release's source. What it downloads and installs (the kit) is checked against the
release signature, as on Linux.

## First run

The script offers to open `http://127.0.0.1:47820/setup` and puts the one-time setup code on the clipboard: paste it
into the page's setup code field. (Not in the address: an address is on the browser's command line, which other
programs on the PC can read.) To see the code yourself (keep it private):

```powershell
wsl -d TrinaAX --cd / -u root -- cat /var/lib/mycel/setup/code
```

Create the owner, the team name and the language; check the team's time zone. Then follow the Linux guide's
[First run](INSTALL-LINUX.en.md#first-run) list: permissions, AI connection, invite the team, first skill, first backup.

## Reach it from other computers and phones

The server answers only on this PC (`127.0.0.1`). Colleagues and the phone apps need an **https address** (a web
address that starts with `https://`, with a certificate phones trust) on a domain of your own, as with any
self-hosted software. Using it only on this PC needs none of this.

The simplest way is a free Cloudflare Tunnel: step by step, in plain words, in
[Connect your own domain with Cloudflare Tunnel](site/operate/windows-pc.md#connect-your-own-domain-with-cloudflare-tunnel).
Any other tunnel or reverse proxy that reaches `127.0.0.1:47820` works too (see the Linux guide's
[First run](INSTALL-LINUX.en.md#first-run), step 3). Either way, register the host name from inside Linux:

```powershell
wsl -d TrinaAX --cd / -u root -- bash -c "cd /root/trina-ax-kit && ./install-linux.sh repair --public-host team.example.com"
```

A tunnel program can run inside Linux (`wsl -d TrinaAX --cd / -u root`) or on Windows (it reaches the server at
`127.0.0.1:47820`). Opening the PC's port to the office network (WSL's mirrored networking, `netsh portproxy`) is not
needed and not covered here: it gives no https.

## What the script changes in Linux

`/etc/wsl.conf` of the `TrinaAX` distro (the earlier file is kept as `/etc/wsl.conf.trina-backup`):

| Setting | Why |
|---|---|
| `[boot] systemd=true` | The server's services run under systemd |
| `[interop] enabled=false`, `appendWindowsPath=false` | Linux programs, the AI's commands included, cannot start Windows programs (`cmd.exe`, `powershell.exe`): they would run as your Windows account, outside the AI's sandbox |
| `[automount] enabled=false`, `mountFsTab=false` | Drive C: and the other drives are not mounted in Linux (`/mnt/c`): nothing in Linux can read or change the PC's files. So the commands here start with `--cd /`: without it WSL warns that it cannot translate the current Windows folder |
| `[user] default=root` | The commands here and File Explorer's `\\wsl.localhost\TrinaAX` use root; the distro has no other user |

Windows still reaches Linux (`wsl.exe`, File Explorer, `127.0.0.1:47820`); only the way back is closed. The script
copies its own steps and a `-KitPath` kit into Linux through `wsl.exe`, not through drive C:.

## What works differently on Windows

The server runs in WSL's default network mode (NAT). The script does not turn on WSL's mirrored networking: what it
adds (the office network reaching WSL) only the desktop app's LAN direct connection would use, and that needs more
(below). Use `127.0.0.1`, not `localhost`, on this PC: WSL forwards IPv4, and a browser may try `localhost` over IPv6
first.

| Feature | On Windows (WSL) |
|---|---|
| Browser on this PC | `http://127.0.0.1:47820`: Windows forwards it to the server inside WSL |
| Desktop app on this PC | Paste `http://127.0.0.1:47820` on the app's first screen (it takes `http://` for this PC's own address only). An invite link or **Open in the app** does not carry a `127.0.0.1` address: paste it |
| Colleagues' computers, phone apps | Need the https address ([above](#reach-it-from-other-computers-and-phones)): your own domain through a tunnel to `127.0.0.1:47820`. The phone apps need https with a public certificate |
| Sign-in to Canva, Intercom, Square (and Microsoft from the desktop app) | On this PC at `http://127.0.0.1:47820` the browser signs in by itself: the return to `127.0.0.1` reaches the server (Windows QA 2026-11-28). On the https address, from any computer, the web says to use the desktop app, as on Linux: the app catches the return on `127.0.0.1` of the PC where the browser is |
| Other MCP connectors' sign-in | The browser returns to the server's own address; on this PC through `127.0.0.1`, for others through the https address. Connectors that want client metadata (CIMD) need the https address |
| Google Drive, Sign in with Google, Slack | Need the https address (Google and Slack accept only `https://` return addresses), as on Linux |
| GitHub | The shared GitHub app returns only to team addresses of Trina's domains; a server on an address of its own needs its own GitHub app |
| Claude and ChatGPT sign-in | Work: Claude's code is pasted back, ChatGPT signs in with a device code (no return to this PC) |
| Desktop app's LAN direct connection (`--tls-port`) | **Not on WSL.** Its certificate names WSL's internal address, not the PC's LAN address, and the office network cannot reach WSL in NAT mode. Use the https address instead |
| Updates | The server updates itself in the team's update window (Admin › Team settings, 03:00–05:00 by default). A PC that is off or signed out at night never updates: set the window to hours the PC is on, or run `wsl -d TrinaAX --cd / -u root -- mycel-ctl update`. An update restarts the server's services, never Windows or WSL |
| Videos (HyperFrames) | Offered when Linux has at least 3.5 GB (the script's limit is 5 GB or more); one render takes about 1 GB. The server sizes its own limits from the memory Linux sees, which is the `.wslconfig` limit |
| Backups | Inside the Linux disk on drive C:, like everything else ([Backups](#backups)) |
| Free disk space | The server's free-space checks see the Linux disk (up to 1 TB), not drive C:. Watch C: yourself: when it is full, Linux cannot write either. The Linux disk does not shrink when files are deleted |

## Keeping it running

- **Signed in**: WSL stops Linux about 15 seconds after the last window that uses it closes; the server's own services
  do not count. The task "Keep the Trina AX server running" keeps one hidden connection open while your account is
  signed in. **Locking the screen is fine. Signing out stops the server**, and so does a restart until you sign in
  again.
- **After Windows updates**: Windows restarts for updates and waits at the sign-in screen. Turn on Settings ›
  Accounts › Sign-in options › **Use my sign-in info to automatically finish setting up after an update**, and check
  the server after update nights. Set the PC's active hours so restarts happen outside work time.
- **Sleep**: the server cannot answer while the PC sleeps. The script can set "never sleep while plugged in" (the
  screen still turns off). On a laptop, also set what closing the lid does (Control Panel › Power Options › Choose
  what closing the lid does › Do nothing, when plugged in).
- **While it is stopped** nothing of the server runs: scheduled tasks, phone notifications and the relay wait, and the
  daily backup catches up when Linux runs again.
- **Check**: `wsl -l -v` lists `TrinaAX` as `Running`; `wsl -d TrinaAX --cd / -u root -- mycel-ctl status` shows the server.
- **Stop it for a while**: disable the task in Task Scheduler (folder TrinaAX), then `wsl --terminate TrinaAX`.
  Enable the task again (or sign out and in) to start it.

## Memory

WSL gives Linux at most half of the PC's memory unless `.wslconfig` says otherwise. The script writes a limit when
the file has none: 5 GB on an 8 GB PC, 6 GB on 12 GB, 8 GB on 16 GB, 12 GB on 24 GB, 16 GB on 32 GB or more. To change
it, edit the `memory=` line under `[wsl2]` in `%UserProfile%\.wslconfig` and run `wsl --shutdown` (the server comes
back within a minute through the task). If answers fail or LibreOffice pages time out, give Linux more memory or use
a PC with 16 GB.

## Where the data is

Everything of the server (team files, chat history, the database, backups, AI connections) is inside the Linux
distro's virtual disk, a file `ext4.vhdx` in a folder under `%LocalAppData%\wsl\`. It grows as the team adds files.

- **`wsl --unregister TrinaAX` deletes that disk and with it all of the team's data, at once and for good.** Never
  run it on a server in use without a copy elsewhere.
- Do not delete the folder with disk-cleanup tools, and keep it out of folders that sync to the cloud (OneDrive):
  a synced copy of an open disk file is not a backup.
- Resetting or reinstalling Windows deletes it too.

## Backups

The in-app backups (Admin › System › Backups) are inside the same virtual disk: they protect against mistakes, not
against a broken PC. Copy an encrypted archive off the PC regularly, as in [Backup and restore](BACKUP-RESTORE.md#make-a-backup-now):

```powershell
wsl -d TrinaAX --cd / -u root
```

Then, inside Linux, the Linux commands of that page (`trina_admin backup --scope full`, `trina_admin archive --out
/var/lib/mycel/data/off-host.tar.zst.age --password-stdin`). Linux does not see drive C:, so copy the archive from
Windows: in File Explorer open `\\wsl.localhost\TrinaAX\var\lib\mycel\data\` (or **Linux › TrinaAX** in the
navigation pane), copy `off-host.tar.zst.age` to another disk or storage, compare its SHA-256 at both ends
(`Get-FileHash` on Windows), then delete it in Linux. `\\wsl.localhost` works in the Windows desktop session of the
signed-in account, not over SSH or remote PowerShell:

```sh
rm /var/lib/mycel/data/off-host.tar.zst.age
```

File Explorer opens the Linux files as root (the distro's default user): it can read and change everything there,
the secrets included. Copy only this file, and do not leave that window open.

A copy of the whole Linux disk is possible too, with the server stopped: disable the task, `wsl --terminate TrinaAX`,
then `wsl --export TrinaAX D:\TrinaAX-backup.tar` (it holds the secrets: keep it as safe as the PC). `wsl --import`
makes a distro from it again.

## Updates

The server updates itself from the release feed, as on Linux ([Upgrade and rollback](INSTALL-LINUX.en.md#upgrade-and-rollback)).
WSL updates with Windows Update (or `wsl --update`). Keep Debian's security updates on as the Linux guide says
([Requirements](INSTALL-LINUX.en.md#requirements)): for example
`wsl -d TrinaAX --cd / -u root -- apt-get install -y unattended-upgrades`.

## Uninstall and roll back

A setup that stopped half-way: run the script again. Finished steps are skipped. An install that stopped before the
installer ran starts again from a new download; one that stopped after it is repaired from the kept kit.

Remove the server and **keep the data** (the Linux installer's uninstall; a later install finds the data again):

```powershell
wsl -d TrinaAX --cd / -u root -- bash -c "cd /root/trina-ax-kit && ./install-linux.sh uninstall"
```

Remove **everything**, after you made and checked an off-PC backup:

```powershell
# first, the sleep settings the PC had before the script changed them (only if it did)
$f = "$env:ProgramData\TrinaAX\power-before.json"
if (Test-Path $f) {
  $p = Get-Content $f -Raw | ConvertFrom-Json
  # a value saved as "unknown" (powercfg did not show it) is left as it is
  if ("$($p.standbyAcSeconds)" -match '^\d+$') { powercfg /setacvalueindex $p.scheme SUB_SLEEP STANDBYIDLE $p.standbyAcSeconds }
  if ("$($p.hibernateAcSeconds)" -match '^\d+$') { powercfg /setacvalueindex $p.scheme SUB_SLEEP HIBERNATEIDLE $p.hibernateAcSeconds }
  powercfg /setactive $p.scheme
}
Unregister-ScheduledTask -TaskPath '\TrinaAX\' -TaskName 'Keep the Trina AX server running' -Confirm:$false
wsl --unregister TrinaAX            # deletes the Linux disk with all of the team's data
Remove-Item -Recurse "$env:ProgramData\TrinaAX"
```

Then, if you want them back as they were:

- `.wslconfig`: put back the copy `%UserProfile%\.wslconfig.trina-backup-<date>`, or delete the two lines the script
  added under `[wsl2]` (or the whole file, if the script made it).
- Sleep: the first lines above put back what the PC had before the script changed it (`power-before.json`; nothing
  when it was already "never" or you answered No). Otherwise Settings › System › Power › Screen and sleep.
- The Windows features: leave them on (other programs use WSL), or turn off "Virtual Machine Platform" and "Windows
  Subsystem for Linux" in Windows Features and restart.

## Troubleshooting

| What you see | What to do |
|---|---|
| `Virtualization is off in this PC's firmware` | Restart into the BIOS/UEFI setup and turn on Intel VT-x or AMD-V / SVM |
| `0x80370102` or `0x8007019e` from WSL | Virtualization or the WSL feature is off: run the script again, restart when it asks |
| `This window runs as ..., but ... is signed in` | Sign in to Windows with the administrator account that keeps the server; do not elevate with another account's password |
| The install stops at a download | The PC needs internet to github.com, deb.debian.org, downloads.claude.ai, updates.trina.app. A company proxy: see [Behind an HTTP proxy](INSTALL-LINUX.en.md#behind-an-http-proxy) |
| `wsl -d TrinaAX --cd ~` asks for a user name | Debian's first start. Close it, or create a user; the server does not need one. Use `-u root` for the commands here |
| The server stops after a while | Is the task running (Task Scheduler › TrinaAX)? Are you still signed in? Did the PC sleep? |
| The installer warned `this kernel offers no Landlock` | Update WSL (`wsl --update`) and run the script again. (Up to 0.20 the installer read a file WSL does not have and warned even though Landlock worked) |
| `mycel-ctl status` shows the Claude connection as a warning | The subscription waits for its usage limit to end; it comes back by itself |

More: `wsl -d TrinaAX --cd / -u root -- mycel-ctl status`, Admin › System › Diagnostics, the Linux guide's
[Troubleshooting](INSTALL-LINUX.en.md#troubleshooting-and-faq) and [Troubleshooting](TROUBLESHOOTING.md).
