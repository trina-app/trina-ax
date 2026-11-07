// iPhone: the notification service extension that shows who and where in a room push (docs/DECISIONS.md "아이폰 알림의
// 이름"), added to the Xcode project at prebuild. Its Swift source is notification-service/NotificationService.swift. No
// new dependency and no CocoaPods: the extension uses Foundation, Security and UserNotifications only.
//
// Options (app.config.ts, src/labels.ts labelSetup): accessGroup (the keychain group the app and the extension share,
// "<team id>.<bundle id>.notifications"), extensionId ("<bundle id>.NotificationService"), teamId, version, build.
// - The app's entitlements list its own group first ("<team id>.<bundle id>", the group its keychain items have always
//   been in) and then the shared group, so only the item the app writes there on purpose is shared.
// - The extension's entitlements list the shared group only.
// - The extension is embedded in the app (PlugIns), built before it, signed like it (automatic signing at release,
//   scripts/ios-release.sh checks both), with the app's version and build number.
const fs = require('node:fs')
const path = require('node:path')

const TARGET = 'NotificationService'
const SWIFT = 'NotificationService.swift'
const PLIST = 'Info.plist'
const ENTITLEMENTS = 'NotificationService.entitlements'

const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const plist = body => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}</dict>
</plist>
`

/** The extension's Info.plist: the app's version and build number (App Store Connect refuses an extension whose
 * numbers differ from its app's), the extension point, and the shared keychain group it reads. */
function infoPlist(o) {
  return plist(`  <key>CFBundleDevelopmentRegion</key>
  <string>$(DEVELOPMENT_LANGUAGE)</string>
  <key>CFBundleDisplayName</key>
  <string>${TARGET}</string>
  <key>CFBundleExecutable</key>
  <string>$(EXECUTABLE_NAME)</string>
  <key>CFBundleIdentifier</key>
  <string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>$(PRODUCT_NAME)</string>
  <key>CFBundlePackageType</key>
  <string>XPC!</string>
  <key>CFBundleShortVersionString</key>
  <string>${xml(o.version)}</string>
  <key>CFBundleVersion</key>
  <string>${xml(o.build)}</string>
  <key>MycelLabelAccessGroup</key>
  <string>${xml(o.accessGroup)}</string>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionPointIdentifier</key>
    <string>com.apple.usernotifications.service</string>
    <key>NSExtensionPrincipalClass</key>
    <string>$(PRODUCT_MODULE_NAME).NotificationService</string>
  </dict>
`)
}
const entitlements = groups => plist(`  <key>keychain-access-groups</key>
  <array>
${groups.map(g => `    <string>${xml(g)}</string>\n`).join('')}  </array>
`)

/** The extension reads the item the app writes with expo-secure-store: service "<keychainService>:no-auth", account the
 * key's bytes. If a later expo-secure-store names its items differently, stop here rather than ship an extension that
 * finds nothing. */
function checkSecureStoreNaming(projectRoot) {
  const dir = path.dirname(require.resolve('expo-secure-store/package.json', { paths: [projectRoot] }))
  const swift = fs.readFileSync(path.join(dir, 'ios', 'SecureStoreModule.swift'), 'utf8')
  if (!swift.includes('service.append(":\\(requireAuthentication ? "auth" : "no-auth")")') || !swift.includes('kSecAttrAccount as String: encodedKey')
    || !swift.includes('let encodedKey = Data(key.utf8)') || !swift.includes('query[kSecAttrAccessGroup as String] = accessGroup')) {
    throw new Error('notification-service: expo-secure-store stores keychain items differently now; update NotificationService.swift (Label.service / Label.item)')
  }
}

/** Adds the extension target once: its files in a group, its sources, an embed phase in the app right after the app's
 * resources (before the script phases, which keeps Xcode's build graph free of cycles) and its build settings. */
function addExtension(project, o) {
  if (project.pbxTargetByName(TARGET)) return
  const objects = project.hash.project.objects
  // addTarget links the app to the extension only when these sections exist (a fresh project has none)
  objects.PBXTargetDependency = objects.PBXTargetDependency || {}
  objects.PBXContainerItemProxy = objects.PBXContainerItemProxy || {}
  const app = project.getFirstTarget()
  const group = project.addPbxGroup([SWIFT, PLIST, ENTITLEMENTS], TARGET, TARGET)
  project.addToPbxGroup(group.uuid, project.getFirstProject().firstProject.mainGroup)
  const target = project.addTarget(TARGET, 'app_extension', TARGET, o.extensionId)
  project.addBuildPhase([SWIFT], 'PBXSourcesBuildPhase', 'Sources', target.uuid)
  project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', target.uuid)
  project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid)

  // the embed phase addTarget appended to the app: named as Xcode names it, and moved right after Resources
  const phases = app.firstTarget.buildPhases
  const embed = phases.findIndex(p => p.comment === 'Copy Files')
  if (embed < 0) throw new Error('notification-service: no embed phase was added to the app')
  const [phase] = phases.splice(embed, 1)
  const copy = objects.PBXCopyFilesBuildPhase
  copy[phase.value].name = '"Embed Foundation Extensions"'
  copy[`${phase.value}_comment`] = 'Embed Foundation Extensions'
  phase.comment = 'Embed Foundation Extensions'
  const resources = phases.findIndex(p => p.comment === 'Resources')
  phases.splice(resources < 0 ? phases.length : resources + 1, 0, phase)
  // as Xcode's own template embeds an extension
  for (const f of copy[phase.value].files) {
    const file = objects.PBXBuildFile[f.value]
    if (file) file.settings = { ATTRIBUTES: ['RemoveHeadersOnCopy'] }
  }

  // the app's own settings that the extension must match
  const configs = project.pbxXCBuildConfigurationSection()
  const appList = project.pbxXCConfigurationList()[app.firstTarget.buildConfigurationList]
  const appSetting = (name, key) => {
    const ref = appList.buildConfigurations.find(c => c.comment === name)
    return ref ? configs[ref.value].buildSettings[key] : undefined
  }
  const list = project.pbxXCConfigurationList()[target.pbxNativeTarget.buildConfigurationList]
  for (const ref of list.buildConfigurations) {
    const name = ref.comment
    Object.assign(configs[ref.value].buildSettings, {
      PRODUCT_NAME: `"${TARGET}"`,
      PRODUCT_BUNDLE_IDENTIFIER: `"${o.extensionId}"`,
      INFOPLIST_FILE: `"${TARGET}/${PLIST}"`,
      CODE_SIGN_ENTITLEMENTS: `"${TARGET}/${ENTITLEMENTS}"`,
      CODE_SIGN_STYLE: 'Automatic',
      DEVELOPMENT_TEAM: o.teamId,
      IPHONEOS_DEPLOYMENT_TARGET: appSetting(name, 'IPHONEOS_DEPLOYMENT_TARGET') || '16.4',
      TARGETED_DEVICE_FAMILY: '"1"',
      SWIFT_VERSION: '5.0',
      SWIFT_OPTIMIZATION_LEVEL: name === 'Debug' ? '"-Onone"' : '"-O"',
      CLANG_ENABLE_MODULES: 'YES',
      APPLICATION_EXTENSION_API_ONLY: 'YES',
      GENERATE_INFOPLIST_FILE: 'NO',
      MARKETING_VERSION: o.version,
      CURRENT_PROJECT_VERSION: o.build,
      SKIP_INSTALL: 'YES',
    })
  }
  project.addTargetAttribute('DevelopmentTeam', o.teamId, target)
}

function check(o) {
  const ok = o && /^[A-Z0-9]{10}$/.test(o.teamId) && /^[A-Z0-9]{10}\.[a-z0-9.]+\.notifications$/.test(o.accessGroup) && o.accessGroup.startsWith(o.teamId + '.')
    && /^[a-z][a-z0-9.]+\.NotificationService$/.test(o.extensionId) && /^\d+\.\d+\.\d+$/.test(o.version) && /^[1-9][0-9]{0,8}$/.test(o.build)
  if (!ok) throw new Error('notification-service: invalid options')
}

module.exports = (config, o) => {
  check(o)
  const appId = config.ios && config.ios.bundleIdentifier
  if (!appId || o.extensionId !== `${appId}.NotificationService` || o.accessGroup !== `${o.teamId}.${appId}.notifications`) throw new Error('notification-service: the extension must belong to the app')
  // loaded here, not at the top: the repository's tests load this file without the app's own node_modules
  const { withDangerousMod, withEntitlementsPlist, withXcodeProject } = require('expo/config-plugins')
  config = withEntitlementsPlist(config, c => {
    c.modResults['keychain-access-groups'] = [`${o.teamId}.${appId}`, o.accessGroup]
    return c
  })
  config = withDangerousMod(config, ['ios', async c => {
    checkSecureStoreNaming(c.modRequest.projectRoot)
    const dir = path.join(c.modRequest.platformProjectRoot, TARGET)
    fs.mkdirSync(dir, { recursive: true })
    fs.copyFileSync(path.join(__dirname, 'notification-service', SWIFT), path.join(dir, SWIFT))
    fs.writeFileSync(path.join(dir, PLIST), infoPlist(o))
    fs.writeFileSync(path.join(dir, ENTITLEMENTS), entitlements([o.accessGroup]))
    return c
  }])
  return withXcodeProject(config, c => { addExtension(c.modResults, o); return c })
}
module.exports.infoPlist = infoPlist
module.exports.entitlements = entitlements
