# Linux desktop app (1/3): the app, its packages and the pull request checks

- Date (UTC): 2026-11-19 00:00
- Branch: `feat/linux-desktop-app`
- Status: done
- Where: trina-ax `desktop/`, `web/src/components/integrations/`, `.github/workflows/desktop.yml`, `scripts/ci/`. Why: the
  desktop app and its PR checks live here (see docs/REPOSITORY-RULES.md)
- Version impact: minor, a new download (the decision file's "Version impact")

## Goal

Part 1 of the three pull requests in [docs/decisions/20261119-linux-desktop-app.md](../../decisions/20261119-linux-desktop-app.md):
the app builds as a .deb and an AppImage for x64 and arm64, and every desktop pull request proves that they install,
start, update over, uninstall and pass a Linux e2e subset.

## Scope

In:
- `electron-builder.config.ts`: the `linux` section (deb + AppImage, `category: Office`, `executableName: 'trina-ax'`,
  `artifactName`, `syncDesktopName`, `synopsis`, `maintainer`, the icon) and `extraMetadata.desktopName`; `dist:linux`.
- The app: a packaged AppImage started with `--no-sandbox` shows one dialog pointing to the .deb and quits; the AppImage
  registers no link handler; "Apps on your computer" refuses to seal settings with Electron's `basic_text` fallback
  (the page adds a GNOME Keyring / KWallet hint on Linux); `envFor` drops the AppImage's own variables and mount
  entries; the search path adds `/snap/bin`.
- `desktop.yml`: "Linux packages (install, update over, uninstall)", "Linux package (arm64: install and start)",
  "Desktop e2e (Linux, subset)"; `scripts/ci/linux-install-check.sh`; `docs/RELEASE-CI.md` section 12.

Out (parts 2 and 3): the signed manifest's `linux` field, `publish.ts --linux`, `offerLinux`, the downloads route, the
updater's Linux modes and .deb notice, the release job; the website, README and install guide.

## Steps

1. Builder config and script; AppImage sandbox dialog; keyring check; `envFor` and search path; i18n (desktop and web).
2. Unit tests for the pure parts (builder config, the sandbox rule, the environment).
3. CI jobs and the install check script; iterate until green on this pull request.

## Decisions

All in the decision file; none new.

## Result

Built as planned, plus: `deb.packageName: trina-ax` (the default would be "Trina AX") and `appImage.executableArgs: []`
(electron-builder's default menu entry starts `AppRun --no-sandbox`). The Linux e2e job needs a keyring with a password
(an empty one makes no login collection) and `MYCEL_DESKTOP_TEST_PASSWORD_STORE` (a development-only switch), because
Playwright's Electron loader adds `--password-store=basic`. The new jobs were green on run 44436027105: packages (install, start
sandboxed, update over, remove, the AppImage refusal), arm64 install and start, and the e2e subset (47 passed).
