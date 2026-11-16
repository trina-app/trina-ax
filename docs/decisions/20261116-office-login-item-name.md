# An office Mac's background items are named after the product, through a small starter file

- Date: 2026-11-16
- Status: accepted
- Supersedes: none
- Branch: fix/office-login-item-name (the owner, QA TC-3451)

- **Ask:** on an office Mac the "Background Items Added" notice and System Settings > General > Login Items &
  Extensions showed the team server as 'Software from "Jarred Sumner"'. The owner did not know what it was. Switched
  off, the server stopped and `teamax status` said only "installed, stopped".
- **Why it showed that name:** for a LaunchAgent plist in `~/Library/LaunchAgents` macOS shows the organization of the
  signing certificate of the program in `ProgramArguments`, and the program's file name when it has no certificate
  (Apple, "Updating helper executables from earlier versions of macOS"). The agents ran `app/bin/bun`, which Bun's
  developer signs.
- **Rule:** the office agent and the update agent run `<home>/bin/<PRODUCT.displayName>` (a file literally named after
  the product, so an edition's branding names it). It is three lines of shell that `exec` `../app/bin/bun` with the
  same arguments, so launchd's process is still bun (same pid, signals, log and exit code). The file has no signature,
  so the Mac shows its name. `office.js install` writes it (`server/src/office/login-item.ts`); nothing is added to
  the zip and the release pipeline needs no signing secret.
- **Outside `app/` on purpose:** an update or a rollback swaps `app/`. A rollback's old `office.js install` can return
  before it rewrites the update agent's plist; a plist that named a file inside `app/` would then point at nothing.
  `<home>/bin/…` stays, and starts whichever `app/bin/bun` is there. `office-uninstall.sh` removes it.
- **Without the bundle** (a checkout, no `app/bin/bun`): the agents run bun itself, as before.
- **Switched off:** `teamax status` and `teamax start` ask macOS as the user
  (`SMAppService.statusForLegacyPlist`, through `osascript`, 3 s limit). Only the answer "needs approval", and only
  while the agent is not loaded, gives the sentence "… is switched off in this Mac's settings …" with the way back
  (switch the entries on, `teamax start`; `start` now also loads the update agent when it is not loaded). No answer, an
  error, or any other value claims nothing and the old text stays. The sentence names the product and adds that an
  older installation shows the entry as "Jarred Sumner" or bun. When the starter file cannot be written, install goes
  on and the agents run bun itself.
- **Not chosen:** signing the bundled bun again with the Trina Developer ID (the office zip job has no signing
  secrets, it changes a pinned third-party program and its JIT entitlements, and unsigned builds keep the wrong name);
  an app bundle with `AssociatedBundleIdentifiers` (Apple requires the program and the app to share a Team ID, so it
  fails for unsigned builds); a compiled starter in the zip (more to build for two processors; a file inside `app/`
  has the rollback problem above).
- **Left out:** the internet-address agent runs Cloudflare's own signed `cloudflared` and shows as Cloudflare. The
  server's web pages do not report a switched-off update agent. If the zip's programs are ever Developer ID signed,
  the starter stays a plain file and the name stays the product name.
- **Checked on a Mac (macOS 26, arm64):** with the real plists and starter file and a stand-in server,
  `backgroundtaskmanagementd` registered both items as `name=Trina AX` (the installed office's items are `name=bun`);
  changing a plist's program makes macOS treat it as an updated item and notify again. The switched-off answer could
  not be produced without the System Settings switch; it follows Apple's documentation.
- **Tests:** `tests/unit/office.test.ts` "LaunchAgent and restore" (the starter file, both plists with and without
  it, the state reader, the status and start wording).
- **Version impact:** an existing office gets the "Background Items Added" notice again at its next update (once
  per agent, with the new name). A rollback
  to an older version writes the old plist again.
