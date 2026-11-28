# Windows PC as a team server (WSL2), with an installer

- Date (UTC): 2026-11-28 00:43
- Branch: `feat/windows-wsl-server`
- Status: done
- Where: `scripts/windows/`, `scripts/install-linux.sh`, `scripts/system/packages.sh`, `docs/`. Why: the owner asked
  for a Windows server install after a QA run on a Windows 11 PC (see docs/REPOSITORY-RULES.md)
- Version impact: minor, a new supported install path (Windows via WSL2) and its installer script

## Goal

A company that has only Windows PCs can run its Trina AX team server on one of them. On 2026-11-27 the normal Linux
server (0.20.2) installed and ran inside WSL2 Debian 13 on a Windows 11 PC (bwrap + Landlock ABI 7, LibreOffice,
the headless browser, a real AI turn). What was missing: a false Landlock warning, a long silent package step, curl and
python3 on a fresh Debian, a server that stops when the last WSL window closes, and a guide.

## Scope

In:
1. `install-linux.sh`: decide the Landlock warning from `mycel-sandbox probe` (landlockAbi >= 1), not from
   `/sys/kernel/security/lsm` (WSL has no securityfs mounted; neither do some other hosts).
2. `packages.sh` / `install-linux.sh`: a "still installing packages … N min" line every minute while apt runs in an
   installer a person watches.
3. `scripts/windows/install-wsl-server.ps1`: checks (Windows build, virtualization, RAM), enables the two Windows
   features (reboot once, resumes by RunOnce), installs a named Debian distro, installs curl / python3 /
   ca-certificates for the download step, downloads and verifies the kit exactly as INSTALL-LINUX (checksum,
   `verify-bundle`, `install-linux.sh check`), installs, adds a logon task that keeps the distro running, asks before
   changing sleep on AC, writes or merges `.wslconfig` carefully, prints the local address. `-WhatIf` dry run,
   idempotent, plain-language messages.
4. `docs/INSTALL-WINDOWS.md` (English) and `docs/INSTALL-WINDOWS.ko.md`, linked where the Linux and Docker guides
   are listed. Requirements, RAM, reboot, keep awake, where data lives, backups, uninstall.
5. `mycel-ctl status` showing `engine.claude-code` as fail for a token at its usage limit: trace; fix if a bug.

Out: publishing the .ps1 as a signed release asset (release CI owner); Windows-native server (no WSL); reaching the
server from other PCs on the LAN (mirrored networking / portproxy), left to the guide as an advanced note.

## Steps

1. Plan (this file).
2. Installer fixes 1 and 2 with unit tests (bash parts run in tests, as `install-linux-space.test.ts` does).
3. Item 5: trace, then fix with a test or note.
4. PowerShell script; PSScriptAnalyzer if available; a unit test that checks its safety rules (verification never
   skipped, no `--allow-unsigned`, `-WhatIf` supported, only the bootstrap packages).
5. Guides, links, `changes/windows-wsl-server.md`, decision file.
6. `bun run typecheck`, `bun run check:prepush`, `bun run check:docs`, the full `tests/unit`. Open the PR into dev.

## Decisions

`docs/decisions/20261128-windows-wsl-server.md`: Windows runs the Linux server inside WSL2 (no Windows-native
server); the distro is kept running by a hidden logon task; the bootstrap packages are only what downloading and
checking the kit needs, as docker/Dockerfile's download stage.

## Risks

- No migration. No UI text (the five app languages are not touched).
- The PowerShell script cannot be run here (no Windows): owner QA on the Windows PC runs it before release notes say
  more than "new".
- Keep-alive depends on WSL behavior that changed between WSL versions; the script checks `wsl --version`.

## Tests

`bun run typecheck`, `bun run check:prepush`, `bun run check:docs`, `tests/unit/g-scripts.test.ts`,
`tests/unit/system-packages.test.ts`, a new `tests/unit/windows-wsl-install.test.ts`, the full `tests/unit`.

## Result

Built as planned in PR #716. Added after an owner addendum: a "What works differently on Windows" section from a code check (sign-in returns, desktop app, LAN direct connection as a known limit, updates, video memory, backups, free space), and 127.0.0.1 instead of localhost. Item 5 was a real bug (the diagnostics and Admin used different "limited" rules); fixed with one shared rule. The script was not run on Windows here: owner QA next.
