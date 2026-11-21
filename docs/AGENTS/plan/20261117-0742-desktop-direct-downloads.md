# Desktop app: a download goes straight into the Downloads folder

- Date (UTC): 2026-11-17
- Branch: `feat/desktop-direct-downloads`
- Status: in progress
- Where: `desktop/` (the save), `shared/src/desktop-bridge.ts` (the bridge), `web/` (the notice). Why: saving a file is
  the desktop shell's job and belongs to the core, not to an edition (see docs/REPOSITORY-RULES.md)
- Version impact: patch. An existing action (Download) loses a step; nothing new to learn.

## Goal

In the desktop app, Download on a file (a room's file, a chat's attachment, Files, a preview, an export) opened the
system's "Save As" window: name, tags, place. People expect what Slack and a browser do: the file is in Downloads and
a small notice says so. QA TC-4638.

## Scope

In:
- The team page's downloads in the desktop app (Mac dmg build and Windows) are saved to the computer's Downloads folder
  with no window. A name that exists is not replaced: `name (1).ext`, `name (2).ext`.
- The file name from the server or the page is cleaned: no folder parts, no leading dots, no characters Windows
  refuses; the final path is checked to be inside Downloads.
- The page's existing toast says "Saved to Downloads" with one action, "Show in folder". A download that fails says so.

Out:
- The browser (no desktop app): unchanged.
- The Mac App Store build: it has no right to write to Downloads without the save window, so it keeps the window.
- The in-app browser pane (other websites, driven by the AI): unchanged.
- A setting for another folder, a list of downloads, progress.

## Steps

1. `desktop/src/common/downloads.ts`: `safeDownloadName`, `pickDownloadPath` (pure) + unit tests.
2. `desktop/src/main/app-window.ts`: `will-download` on the team's app session; `bridge:download` to the page when it
   ends; `bridge:download-show` opens the folder for a download the app itself saved (the page names an id, no path).
3. `shared/src/desktop-bridge.ts`, `desktop/src/preload/app.ts`: `downloads.onDone`, `downloads.show`.
4. `web/src/lib/desktopDownloads.ts`: the toast; strings in every language file.
5. Decision file, changelog fragment, user docs line.
6. Check by hand in the desktop app in dev against a throwaway server: the same file twice, both names, the notice in
   light and dark.

## Decisions

See `docs/decisions/20261117-desktop-direct-downloads.md`.

## Result

(filled in at the end)
