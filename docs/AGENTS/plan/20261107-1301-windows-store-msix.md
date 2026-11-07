# Windows desktop app in the Microsoft Store (MSIX)

- Date (UTC): 2026-11-07 13:01
- Branch: `feat/windows-store-msix`
- Status: done
- Where: `editions/trina/microsoft-store/` (store package settings, like `editions/trina/mac-app-store/`) and small
  shared changes in `desktop/` and `web/`. Why: the store listing is Trina's, but "a store build does not update
  itself" is the same rule the Mac App Store build already follows (see docs/REPOSITORY-RULES.md)
- Version impact: none. The normal Windows installer and the Mac apps do not change; only a new store build is added

## Goal

The Windows installer is not signed, so Windows shows the blue "Windows protected your PC" screen and people must
click "More info → Run anyway". Many company PCs block it. A Microsoft Store package (MSIX) is signed by Microsoft,
installs without that screen and is updated by the store. Company developer accounts are free since May 2026; Trina
Inc. registered on 2026-10-30 (employment check still in review on 2026-11-07).

## Scope

In:
- `editions/trina/microsoft-store/electron-builder.msix.config.ts`: the base desktop config with an `appx` target
  (MSIX file), the store identity from Partner Center, `publish: null`, the store version (4 parts, last one 0).
- Tile and logo images for the package, made from the Trina mark (`editions/trina/branding/mobile/icon.svg`).
- A store build turns the app's own update check off (`process.windowsStore`, like `process.mas`), and Settings ›
  Apps shows one line "updates come from the Microsoft Store" instead of installers.
- The page's file-input handling stays Mac-App-Store-only (only that build answers file inputs itself).
- `.github/workflows/msstore.yml`: builds the MSIX on a Windows runner (manual run, and on pull requests that touch
  the store files) and keeps it as a workflow artifact.
- Store listing text (ko, en) and the submission answers in the edition folder.

Out:
- Uploading to Partner Center from CI (the Store submission API needs an Entra app; done by hand for now).
- Signing the normal NSIS installer.
- Moving people's teams from the NSIS app to the store app (MSIX keeps its own app data; they add the team again).

## Steps

1. Plan (this file).
2. Desktop: `storeBuild()` in `desktop/src/common/update.ts`; updater and bridge use it; unit tests.
3. Web: `answersFileInputs()` for the Mac-only file-input path; Settings › Apps store line per platform; five
   languages.
4. Edition folder: config, images, README, listing text.
5. Workflow; check the MSIX builds on the runner.
6. After Microsoft finishes the account check: reserve the name "Trina AX", put the identity in the config, build,
   upload and submit.

## Risks

- `process.windowsStore` is true only inside an MSIX/AppX package, so the NSIS app is unchanged.
- The store needs each new package version to be higher; prerelease versions (`0.4.0-beta.10`) collapse to
  `0.4.0.0`, so the store build takes an explicit `MSSTORE_VERSION`.
- `runFullTrust` is a restricted capability: the submission must explain it (desktop app, Electron).
- The five app languages: one new message key.

## Tests

- `bun run typecheck`, `bun run test:unit` (updater mode and store flag, downloads list, i18n keys).
- The MSIX job on a Windows runner; install check of the package is done by the store certification.

## Result

- Steps 1–5 are in this branch: the store build turns its own update check off and shows the Microsoft Store line,
  the MSIX config with tile images and manifest (microphone), the `Microsoft Store package` workflow, the listing
  text. The workflow's pull-request run builds a test package with a placeholder identity.
- Step 6 waits for Microsoft: on 2026-11-07 the account's employment check was still "reviewing" (submitted
  2026-10-30). Then: reserve "Trina AX", copy the identity into `IDENTITY`, run the workflow, upload, submit.
