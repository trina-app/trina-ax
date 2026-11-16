// electron-builder settings (the dist:* scripts pass --config electron-builder.config.ts). The app's name, the
// installer and dmg file names and the Windows shortcut come from shared/src/product.ts, the one place the product
// name is written. appId stays fixed: Windows identifies the installed app by it (the NSIS uninstall entry and its
// GUID come from it), so an update after a rename replaces the old app instead of installing a second one.
// The office server recognizes the installers by <artifactBase>-Setup-<v>-x64.exe / <artifactBase>-<v>-mac-*.dmg
// (server/src/office/desktop.ts), built from the same PRODUCT.
import { PRODUCT } from '../shared/src/product'
import { winSignOptions } from './scripts/win-sign'
import { DESKTOP_APP_ID } from './src/common/app-id'

const A = PRODUCT.artifactBase

export default {
  // the shortcuts carry it as their AppUserModelID; main.ts gives the running app the same one (src/common/app-id.ts),
  // or Windows drops its notifications
  appId: DESKTOP_APP_ID,
  productName: PRODUCT.displayName,
  // the packaged package.json carries the name too (Electron's app name before main.ts sets it)
  extraMetadata: { productName: PRODUCT.displayName, description: `${PRODUCT.displayName} desktop app` },
  copyright: 'Copyright © 2026 TreeSoop. AGPL-3.0-only.',
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
      NSMicrophoneUsageDescription: 'Voice input and meeting notes use the microphone.',
      // meeting notes hear the sound of the call apps (desktop/native/meeting-audio, a Core Audio process tap): macOS's
      // "System Audio Recording" question shows this
      NSAudioCaptureUsageDescription: 'Meeting notes listen to the sound of your calls to write down what is said. The sound is not kept.',
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
    // the meeting notes' sound helper (desktop/native/meeting-audio/build.sh, run by the dist:mac* scripts) next to the
    // app's own program in Contents/MacOS; electron-builder signs it with the app (the inherit entitlements: microphone)
    extraFiles: [{ from: 'native-build/meeting-audio', to: 'MacOS/meeting-audio' }],
    // it is universal already, so the arm64 and x64 apps hold the same file: @electron/universal takes it as it is
    x64ArchFiles: 'Contents/MacOS/meeting-audio',
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
    // Authenticode signing with Microsoft Artifact Signing, only when the release job sets MYCEL_WIN_SIGN_*
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
  publish: [{ provider: 'generic', url: 'https://localhost.invalid/downloads/', channel: 'latest' }],
}
