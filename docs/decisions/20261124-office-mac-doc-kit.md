# Documents on an office Mac: a per-user kit, srt as the signed-in user, LibreOffice in its own profile

- Date: 2026-11-24
- Status: accepted (security review pending)
- Supersedes: [20261124-doc-skills.md](20261124-doc-skills.md) where it says a Mac's run has no document libraries and a Mac cannot
  draw Word or Excel pages (office Macs now can); builds on [20261124-documents-mode.md](20261124-documents-mode.md). Plan:
  docs/AGENTS/plan/20261124-0555-doc-kit-office-mac.md
- Branch: feat/doc-kit-mac

- **Ask.** Owner: office Macs get the same documents as hosted teams (decisions 2 and 4 of
  docs/AGENTS/plan/20261124-0314-doc-quality-all-situations.md: documents mode on; about 1.2 GB more disk, measured 1.4 GB).
  The install stays one step with no sudo, and updates keep it current with nothing for the user to do.
- **Kit.** `office-install.sh` fetches the group `doc-kit-mac` of scripts/system/packages.json into `<prefix>/kit/<key>`
  (scripts/office/doc-kit.sh): LibreOffice from The Document Foundation's DMG (pinned version and sha256, Developer ID
  signature of team 7P5S3ZLCN7 and Apple's notarisation checked), CPython with the document libraries (wheels by
  sha256), node with srt and the Node libraries (npm ci of the bundle's locks), and the Noto CJK fonts. Made and tested
  while the server runs, switched in one link after it stops, the kit before kept until the next switch, the same way as
  the browser. A failure warns; the next run (every automatic update) tries again. A LibreOffice security release is a
  new pin, so it reaches every office Mac with its next update.
- **Build.** Documents mode (docs/decisions/20261124-documents-mode.md, `devenv/setting.ts commandMode`): the office
  supervisor sets `MYCEL_DEV_ENV_DOCUMENTS_ONLY=1` when the kit is there. An office Mac has no full dev environment (no
  slot accounts) and no admin setting for one, so documents mode counts as never chosen there: on for every active
  member who is not a guest; `TEAMAX_DOCUMENTS_MODE=0` in config/office.env (the server gets `MYCEL_DOCUMENTS_MODE=0`) turns it off. Settings says in one line whether it is on; each
  command is in the Activity log. `box_shell` runs srt (Seatbelt) as the signed-in user (srt/system-office.ts) with no
  network, no team or personal folder, the home folder unreadable, only the chat's work folder writable and the kit
  read-only; foreground commands only, in project chats too (in the chat's work folder).
- **Look.** The kit's LibreOffice draws Word and Excel pages in the converters' `sandbox-exec` profile, with only its own
  single-instance pipe added (listen, never connect; tools/isolate.ts officePipeRules): no fork, no exec but soffice, no
  Mach service but the user database and LaunchServices' read side (no pasteboard, keychain or window server), no app,
  URL or Apple event.
  Fonts follow the one rule of files/office-profile.ts: the supervisor names the kit's fonts in MYCEL_KIT_FONTS_DIR.
- **Why not slot accounts.** They need sudo, which an office install does not have. **Why not a Linux VM.** About
  2.7 GiB of disk and 2 GiB of memory while it runs, a second OS to update, 10-13 s to start, untested on Intel.
- **What Seatbelt does not do that a VM would.** The run has the server's uid. Checked on a real install that a run
  cannot read the home folder, the keychain item of the Claude login, other processes (ps, signals), cannot submit a
  launchd job, open an app or reach the network or a Unix socket (QA TC-8713). A kernel or Seatbelt bug is not covered.
  A run shares the server's uid, so a process that leaves its process group (setsid) is not reached by a group kill.
  Bounds (security review and re-check of #509): rlimits inherited by every process of the run, escapees too (processes
  of this uid at most what runs now plus the run's pids limit, so a fork bomb stops there; CPU seconds per process at
  most the run's time limit). The shell that runs the command inside the sandbox reaps when the command ends, and on
  the server's stop (SIGTERM first, then the kill): `kill -KILL -1`, which Seatbelt lets reach every process of that
  run's sandbox and nothing outside it, so a survivor that setsids, double-forks and leaves `devenv/` ends with the run
  (a perl survivor that held 1.6 GB past the run's end and a server restart before this fix now ends with it). After
  the run, and at every server start, this uid's processes that carry the run's tag (`TRINA_RUN_ID`, visible for
  programs that are not part of macOS), that a quarter-second watchdog saw descend from the run (by parent and by
  process group), or that work in `devenv/` are ended too. **What is left:** a process that kills the reaping shell
  before the command ends. It keeps the rlimits and the sandbox (no network, only the work folder) and lives until it
  ends or the Mac restarts.
- **Reopen when.** The security review finds Seatbelt too weak for AI-written code as the server's user, or office
  installs get a privileged helper (then slot accounts, as on a Mac team server).
