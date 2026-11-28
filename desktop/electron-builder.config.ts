// electron-builder settings (the dist:* scripts pass --config electron-builder.config.ts). The app's name, the
// installer and dmg file names and the Windows shortcut come from shared/src/product.ts, the one place the product
// name is written. appId stays fixed: Windows identifies the installed app by it (the NSIS uninstall entry and its
// GUID come from it), so an update after a rename replaces the old app instead of installing a second one.
// The office server recognizes the installers by <artifactBase>-Setup-<v>-x64.exe / <artifactBase>-<v>-mac-*.dmg
// (server/src/office/desktop.ts), built from the same PRODUCT.
import path from 'node:path'
import { PRODUCT } from '../shared/src/product'
import { winSignOptions } from './scripts/win-sign'
import { DESKTOP_APP_ID } from './src/common/app-id'

const A = PRODUCT.artifactBase
/** Linux: the program's name, its AppArmor profile (/etc/apparmor.d/<it>) and its menu entry (<it>.desktop) */
export const LINUX_EXECUTABLE = A.toLowerCase()

export default {
  // the shortcuts carry it as their AppUserModelID; main.ts gives the running app the same one (src/common/app-id.ts),
  // or Windows drops its notifications
  appId: DESKTOP_APP_ID,
  productName: PRODUCT.displayName,
  // the packaged package.json carries the name too (Electron's app name before main.ts sets it)
  // desktopName: on Linux Electron registers the link handler (setAsDefaultProtocolClient, every packaged start) under
  // this menu entry's name, and the window's WM_CLASS matches it; without it the handler would point at
  // "<productName>.desktop", a file the .deb does not install (docs/decisions/20261119-linux-desktop-app.md "Names")
  extraMetadata: { productName: PRODUCT.displayName, description: `${PRODUCT.displayName} desktop app`, desktopName: `${LINUX_EXECUTABLE}.desktop` },
  copyright: 'Copyright © 2026 Trina Inc. AGPL-3.0-only.',
  directories: { output: 'release', buildResources: 'build-resources' },
  files: ['dist/**/*', '!dist/**/*.map', 'package.json'],
  asar: true,
  // links from outside, `<linkScheme>://open?url=<team link>` (the web's "앱에서 열기"; docs/DECISIONS.md "First run, phase
  // 2"): the dmg's and the Mac App Store build's Info.plist (CFBundleURLTypes) and the Microsoft Store package's
  // manifest (a windows.protocol extension, its template's ${extensions}) declare the scheme from here
  protocols: [{ name: PRODUCT.displayName, schemes: [PRODUCT.linkScheme] }],
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: false,
    resetAdHocDarwinSignature: true,
  },
  mac: {
    target: [{ target: 'dmg', arch: ['universal'] }],
    category: 'public.app-category.productivity',
    identity: null,
    hardenedRuntime: false,
    artifactName: `${A}-\${version}-mac-\${arch}.\${ext}`,
    // permission prompts: English here (the Info.plist base), each language's InfoPlist.strings in
    // build-resources/mac-infoplist/ copied into Contents/Resources/<folder>.lproj. Electron already ships zh_CN.lproj
    // and es_419.lproj, so Simplified Chinese and Spanish go there too, whichever folder macOS picks.
    extendInfo: {
      NSMicrophoneUsageDescription: 'Voice input in chats uses the microphone.',
      LSApplicationCategoryType: 'public.app-category.productivity',
      NSLocalNetworkUsageDescription: 'Connects straight to your team server inside the office.',
      // what macOS shows under its own question for each folder: "Find work files on this computer" reads Documents,
      // Desktop and Downloads after the app's own dialog (docs/DECISIONS.md "Find work files on this computer"), and the
      // team page's folder window reads a folder picked there (W6). Only names, types and dates are read until the person
      // adds files; file names may go to the team's AI, so the text promises nothing about names
      NSDesktopFolderUsageDescription: 'Looks for work files here. File contents stay on this Mac until you choose to add them.',
      NSDocumentsFolderUsageDescription: 'Looks for work files here. File contents stay on this Mac until you choose to add them.',
      NSDownloadsFolderUsageDescription: 'Looks for work files here. File contents stay on this Mac until you choose to add them.',
      CFBundleLocalizations: ['en', 'ko', 'zh-Hans', 'ja', 'es', 'id'],
    },
    // voice input's on-device helper (desktop/native/dictation/build.sh, run by the dist:mac* scripts) next to the app's
    // own program in Contents/MacOS; electron-builder signs it with the app (hardened runtime, the inherit
    // entitlements). It reads sound from the app, never the microphone, so it needs no permission of its own.
    // The <app> in Chrome extension's native messaging helper (desktop/native/chrome-host/build.sh): Chrome starts it
    // for our extension ids and it relays to the running app's socket (desktop/src/common/chrome-pair.ts)
    extraFiles: [{ from: 'native-build/dictation', to: 'MacOS/dictation' }, { from: 'native-build/chrome-host', to: 'MacOS/chrome-host' }],
    // they are universal already, so the arm64 and x64 apps hold the same files: @electron/universal takes them as they are
    x64ArchFiles: 'Contents/MacOS/{dictation,chrome-host}',
    extraResources: Object.entries({ en: 'en', ko: 'ko', 'zh-Hans': 'zh-Hans', zh_CN: 'zh-Hans', ja: 'ja', es: 'es', es_419: 'es', id: 'id' })
      .map(([folder, lang]) => ({ from: `build-resources/mac-infoplist/${lang}.strings`, to: `${folder}.lproj/InfoPlist.strings` })),
  },
  dmg: {
    sign: false,
    title: `${PRODUCT.displayName} \${version}`,
    artifactName: `${A}-\${version}-mac-\${arch}.\${ext}`,
    // the window it opens on: scripts/dmg-background.svg rendered at 660×452 and 1320×904 (background@2x.png, which
    // electron-builder joins with this file into one retina TIFF). electron-builder makes the window the picture's size,
    // title bar included, so no `window` here; the art's spots are the icon centres below (points from its top left).
    background: 'build-resources/background.png',
    iconSize: 144,
    iconTextSize: 13,
    contents: [
      { x: 170, y: 210, type: 'file' },
      { x: 490, y: 210, type: 'link', path: '/Applications' },
    ],
  },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    signAndEditExecutable: true,
    artifactName: `${A}-\${version}-win-\${arch}.\${ext}`,
    // Authenticode signing with SSL.com eSigner, only when the release job sets MYCEL_WIN_SIGN_PROVIDER
    // (scripts/win-sign.ts, docs/RELEASE-CI.md 11장); otherwise unsigned as before. No publisherName: electron-updater
    // keeps asking for no Windows signature (updates are checked against the Ed25519-signed release instead).
    ...winSignOptions(),
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    multiLanguageInstaller: true,
    installerLanguages: ['en_US', 'ko_KR', 'id_ID', 'ja_JP', 'es_ES', 'zh_CN'],
    shortcutName: PRODUCT.displayName,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    runAfterFinish: true,
    deleteAppDataOnUninstall: false,
    // build-resources/installer.nsh: the uninstaller removes the trina-ax:// link handler the app wrote (QA TC-383).
    // Named here so a missing file fails the build instead of shipping an uninstaller that leaves it behind.
    include: 'installer.nsh',
    artifactName: `${A}-Setup-\${version}-win-\${arch}.\${ext}`,
  },
  // Linux (docs/decisions/20261119-linux-desktop-app.md): the .deb for Ubuntu and Debian, the AppImage for every other
  // distribution, x64 and arm64 (dist:linux). The .deb keeps electron-builder's default dependencies (the libraries the
  // app needs; `deb` below sets only the package name), and its after-install script loads the AppArmor profile that lets
  // Chromium's sandbox use user namespaces on Ubuntu 24.04. The menu entry carries MimeType=x-scheme-handler/<scheme>
  // from `protocols` above. File names: <A>-<v>-linux-amd64.deb, -arm64.deb, -x86_64.AppImage, -arm64.AppImage
  // (electron-builder's arch names per format).
  linux: {
    target: [{ target: 'deb', arch: ['x64', 'arm64'] }, { target: 'AppImage', arch: ['x64', 'arm64'] }],
    category: 'Office',
    executableName: LINUX_EXECUTABLE,
    // the menu entry's file name (and its StartupWMClass) follows extraMetadata.desktopName, as Electron's app_id does
    syncDesktopName: true,
    artifactName: `${A}-\${version}-linux-\${arch}.\${ext}`,
    // the icon at every size the hicolor theme looks up (16…512, build-resources/linux-icons/<n>x<n>.png, written by
    // editions/trina/branding/logo/make.py from scripts/trina-icon.svg): GNOME's lookup stops at 512, so the one 1024 px
    // picture this used to be showed a generic gear in the app grid and the dock (QA TC-5353)
    icon: 'build-resources/linux-icons',
    synopsis: `${PRODUCT.displayName} desktop app`,
    maintainer: 'Trina Inc. <contact@trina.app>',
  },
  // only the package's name (apt install/remove <it>, dpkg-query): the default would be the product name, which has a
  // space and capitals. No `depends`: it would replace the default list of libraries. `fpm` adds the scalable icon
  // (hicolor/scalable/apps/<executable>.svg, any size) next to the sized PNGs electron-builder installs from linux.icon.
  deb: { packageName: LINUX_EXECUTABLE, fpm: [`${path.join(__dirname, 'scripts', 'trina-icon.svg')}=/usr/share/icons/hicolor/scalable/apps/${LINUX_EXECUTABLE}.svg`] },
  // electron-builder's default for the AppImage's own menu entry is `AppRun --no-sandbox %U` (used by AppImageLauncher,
  // Gear Lever, appimaged): the app refuses that start, so the entry passes nothing (AppRun still adds the flag by itself
  // only where the sandbox cannot run, and then the app says to install the .deb)
  appImage: { executableArgs: [] },
  // The AppImage's runtime (the small program at the start of the file that mounts it): AppImage's own static type2
  // runtime (electron-builder-binaries appimage@1.0.3, runtime 20251108, pinned by checksum in app-builder-lib). The
  // default legacy toolset (appimage-12.0.1) ships an arm64 runtime linked against the unversioned `libz.so`, which only
  // zlib's -devel package provides, so the arm64 AppImage did not start on a stock Fedora (QA TC-5356; its x64 runtime
  // names libz.so.1). The static runtime needs no shared library at all and no libfuse2: only a fusermount or
  // fusermount3 program, which GNOME and KDE desktops already have (docs/decisions/20261119-linux-desktop-app.md
  // "Packages"). CI checks the runtime of both AppImages (scripts/ci/appimage-runtime-check.sh).
  toolsets: { appimage: '1.0.3' },
  publish: [{ provider: 'generic', url: 'https://localhost.invalid/downloads/', channel: 'latest' }],
}
