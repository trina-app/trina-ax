// electron-builder settings (the dist:* scripts pass --config electron-builder.config.ts). The app's name, the
// installer and dmg file names and the Windows shortcut come from shared/src/product.ts, the one place the product
// name is written. appId stays fixed: Windows identifies the installed app by it (the NSIS uninstall entry and its
// GUID come from it), so an update after a rename replaces the old app instead of installing a second one.
// The office server recognizes the installers by <artifactBase>-Setup-<v>-x64.exe / <artifactBase>-<v>-mac-*.dmg
// (server/src/office/desktop.ts), built from the same PRODUCT.
import { PRODUCT } from '../shared/src/product'

const A = PRODUCT.artifactBase

export default {
  appId: 'com.treesoop.mycel',
  productName: PRODUCT.displayName,
  // the packaged package.json carries the name too (Electron's app name before main.ts sets it)
  extraMetadata: { productName: PRODUCT.displayName, description: `${PRODUCT.displayName} desktop app` },
  copyright: 'Copyright © 2026 TreeSoop. AGPL-3.0-only.',
  directories: { output: 'release', buildResources: 'build-resources' },
  files: ['dist/**/*', '!dist/**/*.map', 'package.json'],
  asar: true,
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
    extendInfo: {
      NSMicrophoneUsageDescription: 'Voice input in chats uses the microphone. / 채팅 음성 입력에 마이크를 사용합니다.',
      LSApplicationCategoryType: 'public.app-category.productivity',
      NSLocalNetworkUsageDescription: 'Connects straight to your team server inside the office. / 사무실 안에서 팀 서버에 직접 연결합니다.',
    },
  },
  dmg: { sign: false, title: `${PRODUCT.displayName} \${version}`, artifactName: `${A}-\${version}-mac-\${arch}.\${ext}` },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    signAndEditExecutable: true,
    artifactName: `${A}-\${version}-win-\${arch}.\${ext}`,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    multiLanguageInstaller: true,
    installerLanguages: ['en_US', 'ko_KR', 'id_ID', 'ja_JP', 'es_ES'],
    shortcutName: PRODUCT.displayName,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    runAfterFinish: true,
    deleteAppDataOnUninstall: false,
    artifactName: `${A}-Setup-\${version}-win-\${arch}.\${ext}`,
  },
  publish: [{ provider: 'generic', url: 'https://localhost.invalid/downloads/', channel: 'latest' }],
}
