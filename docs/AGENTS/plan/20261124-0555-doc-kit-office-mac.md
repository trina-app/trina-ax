# Documents on an office Mac: the per-user kit, srt build and LibreOffice render

- Date (UTC): 2026-11-24 05:55
- Branch: `feat/doc-kit-mac` (on `feat/doc-skills`, PR #499; rebased onto `feat/doc-kit-everywhere` once it is pushed)
- Status: in progress
- Where: `scripts/office/`, `scripts/system/packages.json`, `server/src/devenv/`, `server/src/files/office-view.ts`,
  `server/src/office/`. Why: document output on the office install is core server and installer work
  (see docs/REPOSITORY-RULES.md)
- Builds on: `20261124-0314-doc-quality-all-situations.md` ("Docker and office Mac", owner decisions 2 and 4: yes)
- Version impact: minor. A new capability on office installs (documents built in a run, pages looked at); the package
  list gains a Mac-only group, which is not a root change for Linux servers

## Goal

An office Mac team (ZIP install, no sudo, no developer on site) gets the same documents as a hosted team: the AI builds
Word, PowerPoint, Excel and PDF files with the document skills and looks at the pages before it answers, Korean included.
The owner runs one install step as before and does nothing for updates.

## Scope

In:
- `office-install.sh` fetches the kit per user into `<prefix>/kit`, like the browser: LibreOffice (the DMG of The
  Document Foundation, pinned version and sha256, Developer ID signature and notarisation checked), CPython with the
  document libraries (wheels pinned by sha256), node with srt and the Node libraries (lock files), and the kit fonts
  (Noto Sans KR, Noto Serif KR, Carlito, Caladea; pinned). Downloaded and verified before the server stops, switched
  in one link after, the version before kept. A failed download only warns; the next run (every automatic update runs
  the installer) tries again. The package list pins all of it, so a LibreOffice security fix reaches every office Mac
  with the next update, with nothing for the user to do.
- Builds: `box_shell` in the documents profile, run by srt (Seatbelt) as the signed-in user: no network, the home
  folder and the team folder unreadable, only the chat's work folder writable, the kit read-only. No dev slot accounts,
  no sudo. Commands only (no background jobs or dev servers).
- Look: `read` with `as_images` for Word, Excel and PowerPoint through the kit's LibreOffice in its own `sandbox-exec`
  profile (no IP network, no reads under `/Users` but the kit and its empty work folder, exec only inside the app),
  with the kit fonts in its throwaway profile's `user/fonts` so Korean draws.
- The documents profile is on for office installs (owner decision 2).
- Proof on this Mac in a throwaway install: a real install from the ZIP flow, the held-out requests through the real
  AI, Korean files built and rendered, and escape checks (home, keychain, network, Unix sockets, launchd, other
  processes).

Out: Intel Macs are not tested here (no Intel Mac); the Mac team server (install-macos.sh, slot accounts) keeps its own
dev environment; jobs and dev servers in the documents profile; a Lima VM (rejected in the plan above).

## Steps

1. Package list: a `doc-kit-mac` group (LibreOffice, node, srt, CPython, the fonts) and a `doc-kit-mac` Python program
   (macOS wheels with hashes).
2. `scripts/office/doc-kit.sh`: prepare (download, verify, test) and switch (one link), used by `office-install.sh`.
3. Server: kit paths and checks (`devenv/kit.ts`); a same-user srt system for the office (`srt/system-office.ts`);
   the documents profile in the runner (offline, work folder only, commands only); run environment with the kit's
   Python, node libraries and document skills.
4. Look: `office-view.ts` on macOS with the kit's LibreOffice and fonts; pptx joins Word and Excel.
5. Supervisor: names the kit to the server; `teamax status` says whether documents are ready.
6. Docs: docs/OFFICE.md (what the owner sees, size, time), decision file, changes file.
7. Proof run on this Mac, then the throwaway install is removed.

## Decisions

- `docs/decisions/20261124-office-mac-doc-kit.md`: same-user srt (Seatbelt) for document builds on an office Mac, with
  the kit fetched per user; why not slot accounts (sudo) or a VM.

## Risks

- Seatbelt is weaker than a VM, and the run has the server's uid: another process of that uid is reachable only
  through what Seatbelt allows (checked: no `ps` of others, no signals, no keychain, no launchd submit, no Apple
  events). The security review decides.
- The render profile still allows its OSL pipe in `/private/tmp` (LibreOffice's single-instance socket).
- Disk: about 1.2 GB more; first install downloads about 450 MB.
- No migration.

## Tests

`bun run typecheck`, `bun run check:docs`, `bun run check:prepush` (Bun 1.3.12); unit tests for `system-packages`, the
dev environment's settings, the office render profile and the kit checks.

## Result

Filled in when the work is done.
