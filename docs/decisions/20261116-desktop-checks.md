# Desktop checks run on pull requests (Mac e2e, dmg, Windows install / update)

- Date: 2026-11-16
- Status: accepted
- Supersedes: none
- Branch: ci/desktop-checks (the owner approved adding desktop checks to CI)

- **Ask:** the owner, 2026-11-16: add desktop checks to CI. The repository is public, so GitHub's hosted macOS and
  Windows runners cost nothing.
- **Why:** pull request CI (`ci.yml`) is Linux only. The desktop e2e specs never ran there, so the find-work-files
  specs broke unnoticed (#994). Windows install-over had no test at all, and one was tried on a real PC. The dmg settings
  are changing (#1036 electron-builder 26.15.3, HFS+; #985 the window background), and a broken dmg showed up only at
  release.
- **Rule:** `.github/workflows/desktop.yml` runs three jobs on a pull request that changes `desktop/**`, `shared/**`,
  `editions/trina/branding/**`, `scripts/release-notices.ts`, the two check scripts, `package.json`, `bun.lock` or the
  workflow itself:
  - **Desktop e2e (macOS):** the whole desktop Playwright suite (`desktop/e2e/ci.config.ts`), including desktop.spec,
    work-files, work-files-wide, work-consent and the folder window. Only made-up homes and data folders
    (`FOLDER_TEST_HOME`, `MYCEL_DESKTOP_USER_DATA`). The standalone fixtures go through `desktop/e2e/fixture-run.ts`:
    the fixture is killed once it prints its result line (the #1015 pattern), so an Electron that will not exit cannot
    stall the job. The run has a 25-minute ceiling and one retry. The results folder (report, fixture logs) is uploaded
    when the job fails.
  - **Mac dmg:** an unsigned universal `dist:mac`, then `scripts/ci/dmg-check.ts`. It mounts the dmg read-only and
    checks the image format, the volume name, the file system, the app (Info.plist version, executable, app.asar), the
    Applications link, the background picture in `.background/`, and `.DS_Store` (each icon's position, picture
    background, icon and label size). **Every expected value comes from `desktop/electron-builder.config.ts` and the
    installed electron-builder**: the file system is `dmg.filesystem`, else APFS before electron-builder 26.13.0 and
    HFS+ from it. #1036 and #985 move the check with them; nothing is written into the check. The dmg is uploaded for
    3 days.
  - **Windows installer (windows-2025, the release's image):** two unsigned NSIS installers of the commit
    (`<version>-ci.1`, `-ci.2`), then `scripts/ci/windows-install-check.ps1`. It checks a silent install (`/S`): the
    uninstall entry, files and shortcuts, and the signature status (NotSigned or Valid; a broken signature fails). It
    starts the app with a throw-away data folder and checks the `trina-ax://` handler. It installs over the app the way
    the updater does (`--updated /S --force-run`): the new version, the handler kept, the app started again. Then it
    uninstalls silently and checks the cleanup (installer.nsh removes the handler). The logs are uploaded.
- **Not required checks.** The required check stays `ci.yml`'s. A desktop job that fails is red on the PR; the reviewer
  reads it before merging.
- **Cost:** path filter, `cancel-in-progress` per PR, caches for bun's store and the Electron / electron-builder
  downloads. Not on push to dev (the PR run covers it).
- **Left out:** signing and notarization (secrets; release-only, mac-app.yml / release.yml), the Mac App Store and
  Microsoft Store packages (msstore.yml), a true end-to-end self-update (needs a release signed with the release key,
  TC-2704). Also left out: a second Windows user profile; the fresh runner is the fresh profile.
- **Tests:** `tests/unit/ci-dmg-check.test.ts` (the expectations follow the settings and the electron-builder
  version; `.DS_Store` positions). The jobs were proven on the PR: green runs, and one deliberately broken dmg (no
  background) that the check failed.
- **Version impact:** none (CI and tests only).
