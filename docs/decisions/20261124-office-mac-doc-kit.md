# Documents on an office Mac: a per-user kit, srt as the signed-in user, LibreOffice in its own profile

- Date: 2026-11-24
- Status: accepted (security review pending)
- Supersedes: none (builds on docs/decisions/20261124-doc-skills.md; plan docs/AGENTS/plan/20261124-0555-doc-kit-office-mac.md)
- Branch: feat/doc-kit-mac

- **Ask.** Owner: office Macs get the same documents as hosted teams (decisions 2 and 4 of
  docs/AGENTS/plan/20261124-0314-doc-quality-all-situations.md: the documents profile on; about 1.2 GB more disk, measured 1.4 GB).
  The install stays one step with no sudo, and updates keep it current with nothing for the user to do.
- **Kit.** `office-install.sh` fetches the group `doc-kit-mac` of scripts/system/packages.json into `<prefix>/kit/<key>`
  (scripts/office/doc-kit.sh): LibreOffice from The Document Foundation's DMG (pinned version and sha256, Developer ID
  signature of team 7P5S3ZLCN7 and Apple's notarisation checked), CPython with the document libraries (wheels by
  sha256), node with srt and the Node libraries (npm ci of the bundle's locks), and the Noto CJK fonts. Made and tested
  while the server runs, switched in one link after it stops, the kit before kept until the next switch, the same way as
  the browser. A failure warns; the next run (every automatic update) tries again. A LibreOffice security release is a
  new pin, so it reaches every office Mac with its next update.
- **Build.** The documents profile (devenv/setting.ts): `box_shell` runs srt (Seatbelt) as the signed-in user, in a
  process group of its own (srt/system-office.ts), with no network, no team or personal folder, the home folder
  unreadable, only the chat's work folder writable and the kit read-only; foreground commands only, never in a project
  chat. It is on for every active member; the team's dev environment switch does not apply, and Settings shows none.
- **Look.** The kit's LibreOffice draws Word and Excel pages in the converters' `sandbox-exec` profile, with only its own
  single-instance pipe added (listen, never connect; tools/isolate.ts officePipeRules) and no app, URL or Apple event.
  Fonts follow the one rule of files/office-profile.ts: the supervisor names the kit's fonts in MYCEL_KIT_FONTS_DIR.
- **Why not slot accounts.** They need sudo, which an office install does not have. **Why not a Linux VM.** About
  2.7 GiB of disk and 2 GiB of memory while it runs, a second OS to update, 10-13 s to start, untested on Intel.
- **What Seatbelt does not do that a VM would.** The run has the server's uid. Checked on a real install that a run
  cannot read the home folder, the keychain item of the Claude login, other processes (ps, signals), cannot submit a
  launchd job, open an app or reach the network or a Unix socket (QA TC-8713). A kernel or Seatbelt bug is not covered.
  There is no per-uid process limit (the uid is the server's): a run that leaves its process group is not ended by the
  watchdog until the server stops.
- **Reopen when.** The security review finds Seatbelt too weak for AI-written code as the server's user, or office
  installs get a privileged helper (then slot accounts, as on a Mac team server).
