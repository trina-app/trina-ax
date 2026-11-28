# A Windows PC runs the Linux server inside WSL2, kept up by a sign-in task

- Date: 2026-11-28
- Status: accepted
- Supersedes: none
- Branch: feat/windows-wsl-server (the owner, after QA on a Windows 11 PC on 2026-11-27)

- **Ask:** the owner: make a Windows PC usable as the team server, fix what the QA run found, write a guide, and build
  the setup into an installer where possible.
- **Rule:** Windows runs the normal Linux server (the release kit and `install-linux.sh`, nothing Windows-specific in
  the server) inside a WSL2 Debian distro of its own (`TrinaAX`). `scripts/windows/install-wsl-server.ps1` does the
  Windows part only: checks, the two Windows features, WSL, `.wslconfig`, the distro with systemd, and the Linux guide's
  download and checks unchanged, then the installer. There is no Windows-native server.
- **Keep-alive:** a Task Scheduler task at the sign-in of the account that installed it runs a hidden
  `wsl.exe -d TrinaAX -u root --exec /usr/bin/sleep infinity` in a loop (again 10 s after it ends). WSL stops a distro
  about 15 s after its last client ends and systemd's services do not count (Microsoft's systemd page). Not
  `.wslconfig` `[general] instanceIdleTimeout=-1` (WSL 2.5.4 and later): it changes every distro of that user, and the
  distro still has to be started after a restart, which the task does anyway. Not a task "whether the user is signed in
  or not": WSL from Session 0 / S4U fails in reports (microsoft/WSL#8835, discussion #14261). So the server runs while
  that account is signed in (a locked screen is fine); the guide says so and names Windows' "finish setting up after an
  update" sign-in option.
- **Bootstrap packages:** the script installs only `ca-certificates`, `curl` and `python3` before the kit exists (what
  the Linux guide's download and checksum need, its "Requirements" line), like `docker/Dockerfile`'s download stage.
  Everything else comes from the kit's list (`scripts/system/packages.json`).
- **`.wslconfig`:** written when absent; an existing file only gets a `memory=` line in `[wsl2]` when it has none, after
  a copy. 5 GB on an 8 GB PC (WSL's default is half), 8 GB on 16 GB. Never `wsl --shutdown` without asking when other
  distros run.
- **Network:** WSL's default NAT mode; the script never sets `networkingMode=mirrored`. Checked in the code: the browser
  on the PC reaches the server through localhost forwarding (`127.0.0.1`, IPv4); the loopback sign-in returns
  (Canva, Intercom, Square) land in the desktop app on the person's own PC, not in the server; Google, Slack and phones
  need the https address in any mode; ChatGPT (device code) and Claude (pasted code) return nothing to the PC; the relay
  is outbound. Mirrored mode would only serve the desktop app's LAN direct connection (`--tls-port`), whose certificate
  names WSL's own address and which also needs Hyper-V and Windows firewall rules, and it is Windows 11 22H2+ only and
  changes every distro of the user. That connection is a known limit on Windows.
- **Sleep:** changed only after a yes (`-KeepAwake`), AC only (`standby-timeout-ac 0`, `hibernate-timeout-ac 0`).
- **Left out:** publishing the script as a signed release asset (the release owner; the kit it downloads is checked
  against the release signature); reaching the server from the LAN by mirrored networking or `netsh portproxy` (no
  https; the guide sends people to the same https address setup as Linux).
- **Also:** `install-linux.sh` takes Landlock from `mycel-sandbox probe` (landlockAbi ≥ 1) instead of
  `/sys/kernel/security/lsm`, which WSL2 does not mount; the diagnostics' "limited" rule for AI connections is the one of
  Admin › Providers (`onlyWaitingForLimit`, `server/src/credentials/resolve.ts`).
- **Tests:** `tests/unit/windows-wsl-install.test.ts`, `tests/unit/system-packages.test.ts` (heartbeat),
  `tests/unit/engine-limited-status.test.ts`.
- **Version impact:** minor (a new supported install path).
