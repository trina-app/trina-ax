# Linux desktop app (2/3): the feed, the team server and the release

- Date (UTC): 2026-11-18 23:59
- Branch: `feat/linux-desktop-feed`
- Status: in progress
- Where: server/src/office, server/src/system, server/src/routes, scripts/release, desktop/src (updater),
  .github/workflows/release.yml. Why: the release and the update path live there (see docs/REPOSITORY-RULES.md)
- Version impact: minor, the signed office manifest gains an optional `linux` field and a new download

The decided plan is [docs/decisions/20261119-linux-desktop-app.md](../../decisions/20261119-linux-desktop-app.md),
sections "Updates" and "CI > Release". This file covers part 2 of its three pull requests. It goes into dev in batch
`batch/20261119-linux-desktop` with part 1 (the app and packages).

## Goal

A Linux AppImage updates itself from the team server, checked against the signed release, like Windows. A .deb shows
one line when a newer version is out, with a button to the download page. The release builds and publishes the four
Linux files without ever holding back the rest of the release.

## Scope

In:

- signed office manifest: optional flat `linux` field; `releaseFiles()`; `versionManifestAction` treats it like `mac`;
- `scripts/release/publish.ts --linux <dir>`; SHA256SUMS lists the four files;
- team server `offerLinux` (system/windows-app.ts and office/update.ts): the two AppImages and the two yml files;
- `routes/downloads.ts`: the yml files and the AppImages they name;
- desktop updater: `updateMode` for Linux, `verifyInstaller` for Linux, the .deb notice (`update.linux.*`, 6 languages);
- release.yml job `build-linux-desktop`, publish and github-release wiring; docs/RELEASE-CI.md rows;
- unit tests and a `changes/` note.

Out: the electron-builder Linux section, `dist:linux`, main.ts, local apps and desktop.yml (part 1); website and docs
(part 3).

## Steps

1. Manifest field, releaseFiles, versionManifestAction, publish --linux.
2. offerLinux in both copy paths, outcome kept as `linux`; downloads route.
3. Desktop updater: updateMode, verifyInstaller, .deb notice (pure check in desktop/src/common).
4. release.yml and RELEASE-CI.md.
5. Tests, changes note.

## Decisions

None new: [docs/decisions/20261119-linux-desktop-app.md](../../decisions/20261119-linux-desktop-app.md).

## Risks

Older team servers drop the unknown `linux` field (zod strips it). Disk use on the team server grows by about 250 MB.
A failed Linux build must not block the release. No migration.

## Tests

`bun run typecheck`, `bun run check:prepush`, `bun run check:i18n`, `bun run check:docs`, the touched unit tests
under Bun 1.3.12.

## Result

Filled in at the end.
