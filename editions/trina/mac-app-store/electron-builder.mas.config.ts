// Mac App Store build of the desktop app (README.md here). It reuses desktop/electron-builder.config.ts and changes only
// what the store needs: the store's bundle id, the mas target (universal), App Sandbox entitlements, the provisioning
// profile and the build number. electron-builder runs in desktop/ (the base config's project folder):
//   MAS_BUILD_NUMBER=<n> MAS_PROVISIONING_PROFILE=<file> bunx electron-builder \
//     --config ../editions/trina/mac-app-store/electron-builder.mas.config.ts --mac mas --universal --publish never
// The base appId stays as it is: Windows identifies the installed app by it.
import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import base from '../../../desktop/electron-builder.config'
import { PRODUCT } from '../../../shared/src/product'

const TEAM_ID = 'YWW96288YY'
const BUNDLE_ID = 'app.trina.ax'

// this folder, for the entitlements files. electron-builder compiles this file into a cache folder first
// (config-file-ts), where __dirname is not this folder; it runs in desktop/, so the folder is also found from there.
const HERE = [__dirname, resolve(process.cwd(), '..', 'editions', 'trina', 'mac-app-store')].find((d) => existsSync(join(d, 'entitlements.mas.plist')))
if (!HERE) throw new Error('editions/trina/mac-app-store not found: run electron-builder in desktop/')

// every upload needs a higher build number than the last one in App Store Connect; the version people see stays
// desktop/package.json's version
const buildNumber = process.env.MAS_BUILD_NUMBER ?? ''
if (!/^[1-9]\d{0,8}$/.test(buildNumber)) throw new Error('MAS_BUILD_NUMBER: a whole number higher than the last uploaded build')
const profile = process.env.MAS_PROVISIONING_PROFILE ?? ''
if (!profile || !existsSync(profile)) throw new Error(`MAS_PROVISIONING_PROFILE: the Mac App Store provisioning profile file for ${BUNDLE_ID}`)
// the file is copied into the app with its mode; one only its owner can read is root-only in the .pkg (ITMS-90255)
if ((statSync(profile).mode & 0o044) !== 0o044) throw new Error('MAS_PROVISIONING_PROFILE: the file must be readable by everyone (chmod 644)')

export default {
  ...base,
  appId: BUNDLE_ID,
  buildVersion: buildNumber,
  // the store updates the app (desktop/src/common/update.ts turns the app's own update notice off in a store build)
  publish: null,
  mac: {
    ...base.mac,
    target: [{ target: 'mas', arch: ['universal'] }],
    extendInfo: { ...base.mac.extendInfo, ElectronTeamID: TEAM_ID, ITSAppUsesNonExemptEncryption: false },
  },
  mas: {
    // "Apple Distribution: <this>" signs the app, "3rd Party Mac Developer Installer: <this>" the .pkg
    identity: `Trina Inc. (${TEAM_ID})`,
    type: 'distribution',
    hardenedRuntime: false,
    entitlements: join(HERE, 'entitlements.mas.plist'),
    entitlementsInherit: join(HERE, 'entitlements.mas.inherit.plist'),
    entitlementsLoginHelper: join(HERE, 'entitlements.mas.loginhelper.plist'),
    provisioningProfile: resolve(profile),
    artifactName: `${PRODUCT.artifactBase}-\${version}-mas-\${arch}.\${ext}`,
  },
}
