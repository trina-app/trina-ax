# Windows app installs an update only when it matches Trina's signed release

- Date (UTC): 2026-11-11 07:16
- Branch: `fix/windows-update-verify-signature`
- Status: in progress
- Where: desktop/ (updater), shared/ (manifest signature check), server/ (puts the signed manifest next to the installer).
  Why: the Windows app trusted whatever installer its team server offered; the signed release info is the only proof
  that an installer is ours (see docs/REPOSITORY-RULES.md: core first).
- Version impact: patch, a security fix with no new screens.

## Goal

The Windows desktop app (unsigned NSIS, electron-updater, team server /downloads/) installed any installer whose
sha512 matched latest.yml, and both came from the same server. Someone who controls a team server (or its disk) could
push any program to every desk. Owner decision 2026-11-11: install an update only when it matches the signed release
info, checked with the existing Ed25519 release keys. No code-signing certificate yet (SmartScreen stays). Offline
offices still update through their team server.

## Scope

In:
- shared/src/release-manifest.ts: open the signed manifest envelope (Ed25519 over the payload with a baked key); the
  server's verifyRelease uses it too (one copy of the check).
- desktop/src/common/update-verify.ts (pure): signed manifest + installer SHA-256 + product/channel/version/current
  version → ok or a reason.
- desktop updater: no install on quit until verified; manifest from <team>/downloads/<channel>.json, else the release
  feed (<feed>/office/<version>/<channel>.json, <feed>/office/<channel>.json); a mismatch deletes the download, logs,
  and shows "This update couldn't be checked, so it wasn't installed." (five languages).
- server offerWindows (office Mac and Linux): also writes the signed manifest as /downloads/<channel>.json; served.
- Development builds may skip the check (MYCEL_DESKTOP_UPDATE_UNVERIFIED=1, not packaged only).

Out: Authenticode signing / SmartScreen; macOS (notice only, unchanged); store builds (unchanged).

## Steps

1. Shared envelope check; server verifyRelease uses it.
2. Desktop verify function + tests (good, wrong key, tampered payload, hash mismatch, wrong channel/version, downgrade).
3. Server places <channel>.json (and the route serves it) + tests.
4. Updater wiring + i18n; docs/DECISIONS.md, update.ts header; changes/ fragment.

## Risks

- Existing offices/servers that already offer the current installer must get the manifest too (offerWindows 'current'
  path writes it), else desks fall back to the internet feed; an offline office would block until its next update run.
- Cannot run a real Windows install here; QA note in the PR (TC-166).
- No migrations.
