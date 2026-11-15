# Find work files on this computer (slice 1)

- Date (UTC): 2026-11-15 03:30
- Branch: `feat/find-work-files` (bridge + scan), then `feat/find-work-files-ui` (screens), then `docs/find-work-files-guide` (Mac guide)
- Status: in progress
- Where: Team AX core (`desktop/`, `shared/src/desktop-bridge.ts`, `web/`, `server/src/onboarding/`). Why: files, permissions and the desktop app are core (docs/REPOSITORY-RULES.md).
- Version impact: minor (a new desktop bridge call, a new API route for members, new screens)

## Goal

People rarely know which of their own files a team tool should have. The desktop app (Windows, and the Mac direct-download
build) offers "Find work files on this computer": after the person agrees in a dialog of the app itself, it looks through
Documents, Desktop and Downloads, lists what looks like work, and adds only what the person ticks. Nothing is ticked at
the start; no file content leaves the computer before the person adds it.

## Scope

In:
- **Bridge and scan (main process).** One `workFiles.scan()` call shows a native consent dialog and then walks the three
  folders in the main process, one after the other (macOS asks for each folder in turn). It returns metadata only (name,
  folder inside the root, type, size, date) with opaque ids. The page never passes a path. `read(id)` returns the bytes of
  one file of that scan session only: time-limited, at most 100 files and 1 GB per session. The walk uses lstat and never
  follows links or junctions; a read checks the real path is still inside the root, opens without following links, and
  checks the size and date again. A `version` on the bridge object, so older apps hide the entry. The Mac App Store build
  does not get it.
- **Info.plist strings** for Desktop, Documents and Downloads say what is true, in 6 languages.
- **Web.** The walk keeps no `File`: contents load at upload time only. Personal-looking names in all 6 app languages, with
  multi-word phrases. A list with two groups ("Looks like work"; "May be personal", folded, "Not sent to AI") and a search
  box, nothing ticked, "Select all" that skips personal files and keeps to 100. Files land in My files › "From this
  computer" (a localized folder label). Undo moves only the files this run created to the trash, worded with the team's
  trash period.
- **Entries.** A quiet line on My files (everyone but guests). In the setup's 팀 파일 step on the desktop app, the owner
  gets the same scan; the owner's files still go to the team home, as today.
- **AI picks for members.** A new route with its own prompt ("work files for my own folder"), as the person's own turn and
  budget; ids and reasons checked against fixed lists; names quoted as data.
- **Mac guide** in the docs with real screenshots, linked from "Allow in Settings".

Out (later slices): the "share to team" card, "Choose one folder instead", the "Other documents" group, cloud folders
(~/Library/CloudStorage), the Mac App Store build, a personal-details check of contents.

## Steps

1. Bridge + scan: `desktop/src/common/work-files.ts` (pure rules, sessions, read guard), main wiring, consent dialog,
   Info.plist strings, desktop i18n, unit tests, desktop e2e (made-up home: symlink escape, foreign ids). PR 1.
2. Screens: lazy file loading, personal matcher, the list, My files line, setup button, member rank route, Undo, i18n,
   web unit + e2e with a mock bridge, screenshots 1440/390 light/dark, walk report. PR 2.
3. The Mac guide with screenshots from a real run. PR 3.

## Risks

- Security: a page script on the team origin must not start a scan silently (native dialog), read outside the scan (session
  ids only), or escape through links (lstat, realpath, O_NOFOLLOW, size/date re-check).
- macOS TCC prompts depend on code signing; an unsigned build may ask again after an update. Signing is another branch.
- No migration. The new route is closed to guests by the guest allow-list.
- Six app languages; the desktop dialog's strings in six too.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `tests/unit/e-desktop-*`, `tests/unit/b-onboarding-file-rank.test.ts`,
`bun run test:web`, the desktop e2e by hand (`-c e2e/rtc-native.config.ts`), the full web e2e for the screens, unit tests
under Bun 1.3.12.

## Result

Filled in at the end.
