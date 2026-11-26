# Windows installer once a week; Mac, server and phone every release

- Date (UTC): 2026-11-26 03:32
- Branch: `ci/windows-weekly`
- Status: in progress
- Where: release CI (`.github/workflows/release.yml`, `scripts/release/`). Why: the owner's decision of 2026-11-26
  (at most one release a day; Windows signed with SSL.com eSigner tier 1 = 20 signings a month, 3–4 per release)
- Version impact: none. Release CI only; no app, server or feed format change.

## Goal

Each release signs the Windows app's exe, the uninstaller and the installer: daily releases would use 90–120 signings a
month against the plan's 20. The Windows installer ships about once a week; the Mac app, the office zip, the Linux
server and the phone keep shipping every release. Windows users always have a working update: on the days without a
Windows build the feed keeps naming the last one.

## Scope

In:
- `prepare` decides `windows=true|false` from the GitHub releases (no other state): yes when the last release on this
  channel that shipped the Windows installer is 7 days old or more, when there is none, or when signing is on and that
  installer is unsigned (the first signed build goes out at once). A tag message line `Windows: yes` forces it (a
  hotfix), `Windows: no` skips it; the line is taken out of the notes like `Rollout: all`. A manual run has a `windows`
  input (tag / yes / no). A run again of a tag whose GitHub Release says Windows was skipped keeps skipping.
- Guard: signing on, and the signed Windows releases of the last 30 days × 4 signings would pass the monthly limit
  (repository variable `WINDOWS_SIGNING_MONTHLY_LIMIT`, default 20): an automatic day skips Windows with a warning; a
  forced `Windows: yes` fails `prepare` before anything is built.
- Skip day: `build-windows` does not run. `publish.ts --keep-windows` publishes the office feed (zip, Mac, Linux app)
  with the `windows` entry of the channel's current head (the last Windows build's files under its own version
  folder), so the office Macs and the Linux servers keep offering that installer and the desks' Windows apps keep
  updating from it. The GitHub Release has no installer and says so in one line ("the Windows installer stays at vX");
  it is not listed as a missing download, and the "not in this release yet" line still goes away when the other
  downloads are there.
- Docs: RELEASE-CI.md section 3 (the job table), 1 (how to tag), 6 (failure table), 11 (why weekly, how to force or
  skip), a decision file, `changes/windows-weekly.md`.

Out:
- The website (separate repo) already offers "the newest release with a Windows installer"; its list reads 10
  releases. Reported, not changed here.
- Choosing the eSigner plan (the owner).

## Steps

1. `scripts/release/windows-cadence.ts`: pure `windowsLineOf` (the tag line), `decideWindows` (the rule),
   `peSigned` (Authenticode table in the PE header); a CLI that reads the releases JSON and fetches the first bytes of
   the installers it needs.
2. release.yml: prepare step + output, input, `build-windows` `if:`, publish / github-release conditions.
3. publish.ts `--keep-windows`.
4. Tests: `tests/unit/windows-cadence.test.ts`, publish.ts keep-windows, the workflow wiring.
5. Docs, decision, changes file.

## Decisions

`docs/decisions/20261126-windows-weekly.md`.

## Risks

- A carried `windows` entry points at an older version's folder: every reader (system/windows-app.ts, office
  update.ts offerWindows, desktop update-verify.ts) keys on `windows.version`, not the release's; checked.
- A re-run that would add a new Windows build to a version already published with a carried one is refused by
  `versionManifestAction` (another Windows app): fail-safe; docs say to tag a new version.

## Tests

`bun run typecheck`, the new and changed unit tests, `bun run check:prepush`, `bun run check:docs`.

## Result

(at the end)
