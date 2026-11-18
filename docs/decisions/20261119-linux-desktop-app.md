# The desktop app ships for Linux: a .deb and an AppImage, x64 and arm64

- Date: 2026-11-19
- Status: proposed (the plan; not built yet)
- Supersedes: none
- Branch: docs/linux-desktop-plan (the owner, 2026-11-19)

- **Ask:** the owner, 2026-11-19: ship the desktop app for Linux too. "개발자들이 별을 주기 때문에 있긴해야해": developers
  give the GitHub stars, so a Linux app has to exist. That is decided. This file is the plan for building it.
  The owner added: the Linux app needs a pull request check in CI too, like the Mac dmg and Windows installer jobs.
- **Today:** the desktop app (`desktop/`: Electron 44, electron-builder 26.15.3, electron-updater 6.8.10) ships as
  the Mac dmg (and the office zip) and the Windows installer. Linux ships only as the server kit (`release.yml`
  build-linux). `desktop/electron-builder.config.ts` has no `linux` section, and `updateMode()`
  (`desktop/src/common/update.ts`) returns `off` for Linux.
- **Rule (MVP):**
  - One Linux build job makes four files: a `.deb` and an `.AppImage`, each for x64 and arm64.
  - The AppImage updates itself from the team server, like Windows and the Mac. An update installs only after the
    signed release names it.
  - The .deb tells the person when a new version is out.
  - No apt repository, no .rpm, no Flatpak and no GPG key in the first version.
  - The audience is developers, so Linux gets a small link on the download page and one line in the README, not a
    third big button.

## Packages

| File | For | How it updates |
|---|---|---|
| `Trina-AX-<v>-linux-amd64.deb`, `…-arm64.deb` | Ubuntu and Debian, where most people will be | one line, "a new version is out", with the download page; the person installs the new .deb |
| `Trina-AX-<v>-linux-x86_64.AppImage`, `…-arm64.AppImage` | every other distribution (Fedora, Arch, …) | by itself, like Windows: downloaded, checked, put in place when the app quits |

- **The .deb is the main download.** electron-builder 26.15.3 already does what Ubuntu 24.04 needs:
  - It writes the menu entry. The entry carries `MimeType=x-scheme-handler/trina-ax`, taken from the existing
    `protocols` setting.
  - Its default dependencies pull in the libraries the app uses (`libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6
    xdg-utils libatspi2.0-0 libuuid1 libsecret-1-0`). We set no `deb.depends`, because that would replace this list.
  - It installs an AppArmor profile, so Chromium's sandbox may use user namespaces on Ubuntu 24.04. The after-install
    script loads `/etc/apparmor.d/<executable>`, and after-remove unloads it. Set-uid `chrome-sandbox` is used only
    where user namespaces are missing altogether.
- **The AppImage is for other distributions, not Ubuntu 24.04.** It has two problems there:
  - **FUSE 2:** it needs FUSE 2 (`libfuse2t64`), which a fresh Ubuntu 24.04 does not have.
  - **No sandbox:** it cannot ship an AppArmor profile. Its AppRun probes `unshare -Ur true`, and when user namespaces
    are blocked it adds `--no-sandbox` by itself.

  We do not accept an unsandboxed app, because it loads team pages and the AI's browser pane. In a packaged AppImage,
  when `app.commandLine.hasSwitch('no-sandbox')` is set, the app shows one dialog and quits. The dialog says "On this
  system, install the .deb" and links to the download page. Fedora and Arch allow user namespaces, so the AppImage runs
  sandboxed there.

  electron-builder's static AppImage runtime (`toolsets.appimage`, still beta) drops the FUSE 2 need. We revisit it
  once it is stable; it is not part of this plan.
- **arm64** is built on the x64 runner. electron-builder builds for the other processor, and the app has no native
  modules on Linux: the only one, `meeting-audio`, is Mac only. The arm64 .deb is then checked on a real arm64 runner
  (see CI). The owner asked for arm64, so it stays in v1.
- **Names:**
  - The Linux `artifactName` uses `PRODUCT.artifactBase`, like the Mac and Windows files.
  - `executableName: 'trina-ax'` names the program, the AppArmor profile and the menu entry.
  - `extraMetadata.desktopName: 'trina-ax.desktop'` and `linux.syncDesktopName: true` are also needed. Without them,
    Electron registers the link handler as "Trina AX.desktop". `main.ts` calls `setAsDefaultProtocolClient` on every
    packaged start, so it would point `mimeapps.list` at a file that does not exist and break `trina-ax://` links. The
    window would also not match its menu entry.
- **Not in the first version:**
  - **.rpm:** cheap to build, but it adds one more file to test on every release, and Fedora users can run the
    AppImage. Add it when someone asks.
  - **Flatpak:** "Apps on your computer" starts programs on the computer, which a Flatpak sandbox allows only through
    `flatpak-spawn --host`. Flathub review is slow too. Not planned.
  - **Snap:** not planned, for the same sandbox reason.

## Updates

Use **electron-updater for the AppImage, fed by the team server and checked against the release we already sign**.
This is the path Windows and the Mac use. It needs no new feed, no new key and no new trust rule.

1. **Release:** `scripts/release/publish.ts` gets `--linux <dir>`, like `--mac`.
   - The signed office manifest (`server/src/office/release.ts` OfficeRelease) gets an optional flat field:
     `linux: { version, appImageX64, appImageArm64, debX64, debArm64, latestYml, latestYmlArm64 }`. Each value is a
     ReleaseFile.
   - The field is flat because `publish.ts` `app()` and `adds()` read each object value as one file.
   - `releaseFiles()` lists the new files, so `verifyRelease` checks that their URLs are on the feed.
   - The field is `nullish`. Team servers that do not know it drop it (zod strips unknown keys), as they did with
     `mac` before 0.5.5.
   - The files go to `<feed>/office/<version>/` next to the Windows and Mac files.
2. **Team server:** two places already copy the Windows installer and the Mac update zip into `data/downloads/` from
   the verified manifest: `server/src/system/windows-app.ts` (Linux servers and hosted tenants) and the office updater
   (`server/src/office/update.ts`).
   - Both get an `offerLinux` next to `offerMac`, in the same run and with the same rules:
     - only a release that is not newer than the server itself;
     - size and SHA-256 must match the manifest;
     - older files are removed, and the `.yml` is written last;
     - nothing is copied when the disk would drop under the write reserve.
   - It copies the two AppImages, `latest-linux.yml` and `latest-linux-arm64.yml`, about 250 MB on the team server.
     It does not copy the .deb files.
   - **The yml check:** electron-builder merges the AppImage and the .deb of one arch into one `latest-linux.yml`, in
     no fixed order. So `offerLinux` checks that the yml's `files:` list holds the AppImage the manifest names, not
     that `path:` does. The .deb entry in that list is never requested, because AppImageUpdater picks the AppImage.
   - The outcome is kept and logged as `linux`, next to `mac` (`desktop-windows.json`, `dropUnnamedMac` and its
     twin). Diagnostics stays Windows-only, as it is for the Mac app.
   - `server/src/routes/downloads.ts` adds the two `.yml` files to `META_FILES` and serves the AppImage they name
     (`linuxOfferedIn`, like `macOfferedIn`).
3. **App:** `updateMode` gets the AppImage path as one more parameter. On Linux it returns `auto-install` when
   `APPIMAGE` is set (electron-updater falls back to AppImageUpdater when there is no `resources/package-type` file,
   and only deb, rpm and pacman have one). Otherwise it returns `notice`.
   - **AppImage:** `DesktopUpdater.checkWindows` runs unchanged: generic provider, `<team>/downloads/`, the session as
     a Bearer token.
     - `verifyDownload` passes `platform: 'linux'` and the arch to `verifyInstaller`
       (`desktop/src/common/update-verify.ts`), which reads `linux.appImageX64` or `linux.appImageArm64`.
     - `installOnQuit` and `installsVerified` work as on Windows. AppImageUpdater replaces `$APPIMAGE`, and renames it
       when the name holds the version.
     - A file the signed release does not name is deleted and never installed. Updates stay quiet
       (`docs/decisions/20261116-quiet-desktop-updates.md`).
   - **.deb:** no electron-updater. DebUpdater would run `pkexec dpkg -i` and ask for an admin password after the
     window closes.
     - Instead, `check()` gets a Linux branch. It reads the team's signed `/downloads/<channel>.json`, which the
       server already copies as signed text. It opens it with `openSignedManifest` and compares `linux.version` with
       its own version.
     - A newer one shows one new line, once per version, with a button for the download page. That is a new key,
       `update.linux.*`, in the six languages of `desktop/src/common/i18n.ts`. `offerDownload`'s text ("couldn't
       update to …") is for something else.
     - The Mac notice (`checkMac`, `index.json`) is not used, because it reads only Mac items.
4. **Signature:** the update check needs only the existing Ed25519 release key (`RELEASE_SIGNING_KEY`; the public
   keys are in `RELEASE_CHANNEL.keys`). Linux has no signature check of its own. A file downloaded by hand is covered by
   `SHA256SUMS` and `SHA256SUMS.sig` on the GitHub Release, which will list the four Linux files too.
   - **No GPG key and no AppImage embedded signature** for now. Nothing on Linux would check them.
   - **No apt repository for now.** It would need a GPG key (apt only checks OpenPGP signatures), signed `Release`
     and `Packages` files on every release, and an install guide with a key line. It becomes the next step when Linux
     users ask for updates with the rest of their system. Until then, the .deb download and the in-app line are enough.

## CI

### Release (`.github/workflows/release.yml`)

- **New job `build-linux-desktop`** ("Linux desktop app"):
  - `needs: prepare`, `runs-on: ubuntu-24.04`, no secrets, about 15 minutes.
  - It runs `bun run --cwd desktop dist:linux -- "-c.extraMetadata.version=$VERSION"`. `dist:linux` is a new script:
    `--linux deb AppImage --x64 --arm64 --publish never`.
  - It then runs `bun scripts/plugins/release-check.ts desktop/dist` and checks that both yml files name `$VERSION`.
  - The artifact is `release-linux-desktop`: the four files and the two `.yml`.
  - It also runs on `office_only`, like build-windows: it is a desktop download.
- **`publish`:** the new job goes into `needs`, with `LINUX_DESKTOP_OK: needs.build-linux-desktop.result ==
  'success'`. The Linux app rides along as the Mac app does:
  - "Which desktop builds are here" warns `build-linux-desktop did not pass: no Linux desktop app in this release`.
  - The office feed step passes `--linux in/release-linux-desktop` only when the job passed.
  - The office feed still depends only on build-office and build-windows. A failed Linux build never holds back the
    server release or the other downloads.
  - A later re-run that passes adds `linux` to the same version's manifest. `versionManifestAction` treats `linux`
    like `mac`, so the result is `upload`, not a refusal.
  - SHA256SUMS lists the four files when they are there.
- **`github-release`:** "Linux (desktop app)" joins the "Downloads not in this release yet" line, and the check on a
  re-run that removes that line once every download is there.
- `docs/RELEASE-CI.md` sections 2 and 6 get one row each.

### Pull requests (`.github/workflows/desktop.yml`)

Linux joins "Mac dmg" and "Windows installer":

- **Paths:** the same filter as today, plus `scripts/ci/linux-install-check.sh`.
- **Advisory, not required:** like the existing desktop jobs, these are not required checks and not in the merge
  queue. They are read before a pull request is enqueued (`docs/decisions/20261116-desktop-checks.md`).
- **Cost:** hosted Linux runners are free for this public repository.
- **Docs:** the workflow's top comment and `docs/RELEASE-CI.md` section 12 get the new jobs.

| Job | Runner | What it does | Time |
|---|---|---|---|
| **Linux packages (install, update over, uninstall)** | ubuntu-24.04 | Builds and runs the install, update-over and uninstall check below | ~15 min |
| **Linux package (arm64: install and start)** | ubuntu-24.04-arm | Installs the arm64 .deb from the job above, starts it under xvfb, waits for the first window, then removes it. It builds nothing, so it stays short and runs on every desktop pull request | ~5 min |
| **Desktop e2e (Linux, subset)** | ubuntu-24.04 | A chosen set of the existing desktop specs under xvfb (details below) | ~10 min |

**Linux packages job.** It builds two unsigned versions of this commit, `<v>-ci.1` and `<v>-ci.2`, the way the
Windows job does. For the .deb, a `-` in the version becomes `~` (`0.5.17~ci.2`), and the checks compare against
that form. Each build has an x64 .deb and AppImage; ci.2 also has the arm64 .deb for the next job.
`linux-install-check.sh` then:

1. **Installs ci.1** with `apt-get install ./…deb`. It checks the files, the menu entry and the loaded AppArmor
   profile.
2. **Starts it:** under `xvfb-run`, with a throwaway `MYCEL_DESKTOP_USER_DATA`. It waits up to 60 s for the first
   window (`xdotool search --sync --name`). It checks that the app runs sandboxed, with no `--no-sandbox` in its
   command line. Then it checks that `xdg-mime query default x-scheme-handler/trina-ax` names `trina-ax.desktop`
   (after the first start, because `setAsDefaultProtocolClient` runs then).
3. **Installs ci.2 over it:** checks the version (`dpkg-query`), the link handler and that the data folder is still
   there, then starts the app again.
4. **Removes the package:** checks that the files, the menu entry, the profile and the handler are gone and that the
   data folder stays.
5. **Starts the ci.2 AppImage** with `libfuse2t64` installed. On this stock Ubuntu image the AppImage's AppRun adds
   `--no-sandbox`, so the check expects the app's ".deb" dialog and a quit, not a window.

The update-over uses two builds of the same commit, like the Windows job. The AppImage's self-update (download, check,
replace on quit) is covered by unit tests of the updater configuration and `verifyInstaller`, as Windows' update is,
and by QA rows. A live update test in CI would need a signed fake feed, so it is left out.

**Desktop e2e subset.** The specs are `smoke`, `desktop`, `quit`, `settings`, `language`, `offline`, `update` and
`local-apps`. The job is set up like the Mac e2e job: fake team names in `/etc/hosts`, the web build and rhwp.
- It runs inside `dbus-run-session` with `gnome-keyring-daemon --unlock`, because `local-apps.spec` saves a sealed
  setting.
- Electron runs from `node_modules`, without the .deb's AppArmor profile. So the job sets
  `kernel.apparmor_restrict_unprivileged_userns=0` for the test run, and never passes `--no-sandbox`.
- It runs on pull requests and on the push to dev, like the Mac e2e.
- The whole suite stays on the Mac. Find work files, work consent, the folder window and meeting notes are off on
  Linux, so their specs would only skip. A spec moves into the Linux list when it covers something Linux has.

## What changes in the app

- **`electron-builder.config.ts`:** a `linux` section with:
  - targets `deb` and `AppImage`, `category: Office`;
  - `executableName`, `artifactName`, `syncDesktopName`, `synopsis` and `maintainer`;
  - the icon from `build-resources/icon.png`.

  It also gets `desktopName` in `extraMetadata`. There is no `deb` section: the defaults are right.
- **Links (`trina-ax://`):** `main.ts` already handles Linux. A link starts a second instance, whose argument goes to
  the first (`second-instance`, `linkFromArgv`), and `setAsDefaultProtocolClient` runs in a packaged app. With
  `desktopName` set, the .deb's menu entry and the registered handler are the same file.
  - The AppImage gets no menu entry and no link handler in v1. A person who wants links installs the .deb.
- **The AppImage refuses to run without the sandbox:** the dialog and quit described under Packages.
- **Tray:** none. The only tray is the meeting-notes timer (`meeting-control.ts`), and meeting notes need the
  Mac-only `meeting-audio` helper.
- **Notifications:** Electron's `Notification` uses libnotify on Linux.
  - `platformNotifyDeps` already treats every platform other than the Mac the same way.
  - Settings already has the Linux wording (`desktopNotify.where.linux`).
  - A click opens the chat on GNOME and KDE. There are no action buttons; "mark read" is already Mac-only.
- **safeStorage (keyring):** "Apps on your computer" seals setting values with `safeStorage`
  (`desktop/src/main/local-apps.ts`). On Linux that needs a Secret Service (GNOME Keyring or KWallet) in the session.
  - With no keyring, Electron falls back to `basic_text`, a fixed key. `setSettings` must treat
    `safeStorage.getSelectedStorageBackend() === 'basic_text'` as `unavailable`, never as sealed.
  - We never call `setUsePlainTextEncryption`.
  - The page already shows "This computer could not keep the settings safely, so they were not saved." On Linux
    (`bridge.platform`) it shows a variant that adds "it needs GNOME Keyring or KWallet". That is one new key in the
    six languages of `web/src/i18n/`.
  - The connection itself still works without stored settings.
  - The team sessions' cookies fall back the same way, as Chrome's do on Linux.
- **Start at login:** nothing. The app has no start-at-login on the Mac or Windows either.
- **Apps on your computer** (`desktop/src/common/local-apps.ts`) is already on outside the Mac App Store
  (`localApps: process.mas ? 0 : …`). Programs start from an argument list, Stop kills the whole process group
  (`detached` everywhere except Windows), and a run as root is refused. All of that holds on Linux. Two changes:
  1. `envFor` also leaves out `APPIMAGE`, `APPDIR`, `ARGV0`, `OWD`, and any `LD_LIBRARY_PATH` or `PATH` entry inside
     the AppImage's mount. Otherwise `npx` or `python`, started from the AppImage, would load the app's own libraries.
  2. The search path adds `/snap/bin` (Ubuntu's snap programs).

  The known tools (Aside, ego lite) are shown as they are on the Mac, with no platform switch. A tool that is not
  installed fails with its usual "program not found". Step 4 of the decision file
  `20261118-local-app-connectors.md` ("Later: Windows and Linux") gets a line pointing here.
- **Off on Linux, as in the Mac App Store build:** Find work files (`workFilesVersion` returns 0) and meeting notes
  (`meetingHelperPath` returns null). Settings already hides what the bridge reports as 0.
- **Downloads** (`markDownloaded`): already does nothing on Linux, where there is nothing to mark.
- **Tests that pin today's behaviour change with it:**
  - `tests/unit/office-update.test.ts` expects `updateMode('linux', true)` to be `off`.
  - The exact download-folder listings in `tests/unit/g-windows-app.test.ts` and `g-mac-app.test.ts` gain the Linux
    files.

## Website and README

- **Website:** the website lives in its own repository; this repo holds only its link, `APP_DOWNLOADS.page`.
  - `ax.trina.app/download` gets a small "Linux" line under the Mac and Windows buttons: ".deb (Ubuntu, Debian)",
    "AppImage (other Linux)" and "arm64". The links go to the feed files, the way the Windows installer is linked.
  - One short note sits under it: "On Ubuntu, install the .deb."
  - This audience is developers, so the words can be technical.
  - Mac and Windows stay the two big buttons. Nothing else on the page changes. Check the page at 390 px, in dark and
    in light.
- **README**, in all six languages:
  - "Apps:" becomes "Mac, Windows, Linux, iPhone, Android".
  - "Every device" gets Linux.
  - One line under the download buttons: `Linux: .deb and AppImage (x64, arm64) on the download page`.
  - No new badge picture.
- **Docs:** a short "Desktop app on Linux" part in `docs/INSTALL-LINUX.en.md` and `.md`, the page developers open.
  It says which file to pick, gives the FUSE, sandbox and keyring notes, and shows how to check `SHA256SUMS.sig`.

## QA rows to add

Add these rows to the QA tab when the build starts: in English, one case per row, with the status at the start, at
the pull request and at the dev merge.

- **Distros:** Ubuntu 24.04 (GNOME) for the .deb and Fedora 42 (GNOME) for the AppImage.
- **Machines:** VMs or a spare PC, never a customer's machine.
- **Team:** the shared QA-Acme team.

| Area | Case | Expected | Assignee |
|---|---|---|---|
| Linux desktop | Ubuntu 24.04 x64: install the .deb from the download page (App Center double-click, and `sudo apt install ./…deb`) | the app is in the app grid with its icon and opens to the first screen | dion |
| Linux desktop | Ubuntu 24.04: sign in to the team (password, then Google sign-in that returns through the browser) | signed in; the browser hands back to the app | dion |
| Linux desktop | Ubuntu 24.04: "Open in the app" from the web, with the app closed and with it open | the app opens on that team or page (screen ④) | dion |
| Linux desktop | Ubuntu 24.04: one chat with the AI; a reply arrives while the window is in the background | the answer streams; one system notification; clicking it opens the chat | dion |
| Linux desktop | Ubuntu 24.04: attach a file with the file chooser, then download a file from a chat and open it | the upload works; the download lands in Downloads and opens in its app | dion |
| Linux desktop | Ubuntu 24.04: .deb update. Install version N-1 while the team server is on N | one line says a new version is out; Download opens the page; the new .deb installs over the old one; still signed in | dion |
| Linux desktop | Ubuntu 24.04: `sudo apt remove` | gone from the grid; the `trina-ax://` handler and the AppArmor profile are gone; the data folder stays (documented) | dion |
| Linux desktop | Ubuntu 24.04: start the AppImage | one dialog points to the .deb, then the app quits; it never runs without the sandbox | dion |
| Linux desktop | Fedora 42 x64: download the AppImage, make it runnable, start it, sign in, one chat | it runs sandboxed and works as on Ubuntu | dion |
| Linux desktop | Fedora 42: AppImage auto-update. Start N-1 while the team server is on N, then quit | the next start is N, without asking; a changed file on the team server is refused and deleted | dion |
| Linux desktop | Ubuntu 24.04 arm64 (VM): install the arm64 .deb, start, sign in, one chat | works as on x64 | dion |
| Linux desktop | A session without a keyring (e.g. Xfce without gnome-keyring): save settings for an app on this computer | the "could not keep the settings safely" toast with the keyring hint; nothing saved; the connection still runs | raka |
| Linux desktop | Apps on your computer on Linux: add an "Other" program (an MCP server in `~/.local/bin`), from the .deb and from the AppImage | the confirm shows the command; it runs; Stop ends it and its children; it does not load the AppImage's libraries | raka |
| Team server | After a server update: `data/downloads/` holds both AppImages, `latest-linux.yml` and `latest-linux-arm64.yml`; older files are removed | the server log shows the Linux app offered; the files match the signed release | pras |
| Linux desktop | Ubuntu 24.04 with the system in dark mode | the app, its menus and its dialogs are dark and readable; switching the system theme follows live | dion |
| Website | `/download` at 390 px, in dark and in light | the Linux line fits without sideways scroll; the links reach the four files | dion |

The 390 px check does not apply to the app window itself: its smallest width is 900 (`app-window.ts` minWidth).

## Size

About **6.5 working days** for one person, plus the first release:

| Part | Days |
|---|---|
| electron-builder Linux config and `dist:linux`, `desktopName`, the AppImage sandbox dialog, the keyring check, `envFor`, i18n | 1 |
| Updater: Linux modes, `verifyInstaller` for Linux, the .deb notice from the signed manifest, unit tests | 1 |
| Manifest `linux` field, `publish.ts --linux`, `offerLinux` on Linux servers and offices, the downloads route, tests | 1.5 |
| CI: the release job and the publish and github-release changes; desktop.yml's three jobs, `linux-install-check.sh`, the e2e subset green | 1.5 |
| Website line, READMEs, docs | 0.5 |
| QA rows above on two distros and arm64 | 1 |

The work is two or three pull requests:

1. the app and packages, with the pull request checks;
2. the feed, the team server and the release;
3. the website and docs.

Each starts with its plan in `docs/AGENTS/plan/` (REPOSITORY-RULES).

## Open questions for the owner

None blocks the build. One choice comes later, and only if Linux users ask for it: an apt repository (and its GPG
key), so the .deb updates with the rest of the system.

- **Version impact:** minor (a new download; the signed manifest gains an optional field that older servers drop).
