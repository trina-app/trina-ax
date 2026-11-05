/// <reference types="node" />
import fs from 'node:fs'
import path from 'node:path'
import type { ConfigContext, ExpoConfig } from 'expo/config'
import { mobileProduct } from './src/product.ts'
import { IOS_USAGE } from './src/strings.ts'

/** Store version (CFBundleShortVersionString / versionName). The build number must grow with every upload. */
const VERSION = '1.0.0'

/** `MYCEL_MOBILE_EDITION=<name>` reads editions/<name>/branding/mobile.json (only the fields src/product.ts accepts) and
 * the fixed asset names in editions/<name>/branding/mobile/. Without it the neutral Team AX defaults apply. */
function edition(projectRoot: string): { values: unknown; assets: Record<'icon' | 'adaptive' | 'splash', string> | null } {
  const name = process.env.MYCEL_MOBILE_EDITION
  if (!name) return { values: undefined, assets: null }
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(name)) throw new Error('MYCEL_MOBILE_EDITION must be an edition folder name')
  // Relative to the project: the resolved config is embedded in the app, so no build machine path ends up there.
  const dir = path.join('..', 'editions', name, 'branding')
  const values = JSON.parse(fs.readFileSync(path.join(projectRoot, dir, 'mobile.json'), 'utf8')) as unknown
  const file = (n: string) => path.join(dir, 'mobile', n)
  const assets = { icon: file('icon.png'), adaptive: file('adaptive-icon.png'), splash: file('splash-icon.png') }
  return { values, assets: Object.values(assets).every(f => fs.existsSync(path.join(projectRoot, f))) ? assets : null }
}

function buildNumber(): string {
  const n = process.env.MYCEL_MOBILE_BUILD_NUMBER ?? '1'
  if (!/^[1-9][0-9]{0,8}$/.test(n)) throw new Error('MYCEL_MOBILE_BUILD_NUMBER must be a positive integer')
  return n
}

export default ({ config, projectRoot }: ConfigContext): ExpoConfig => {
  const chosen = edition(projectRoot)
  const product = mobileProduct(chosen.values ?? config.extra?.teamAxEdition)
  const background = product.background ?? '#fcfbf8', build = buildNumber()
  // Android push needs the FCM project file (owner-provided, not in the repository). Without it Android builds skip push.
  const googleServices = process.env.MYCEL_MOBILE_GOOGLE_SERVICES
  if (googleServices && !(path.basename(googleServices) === 'google-services.json' && fs.existsSync(googleServices))) throw new Error('MYCEL_MOBILE_GOOGLE_SERVICES must name an existing google-services.json')
  return {
    name: product.name, slug: 'team-ax-mobile', version: VERSION, scheme: product.scheme,
    orientation: 'portrait', userInterfaceStyle: 'automatic',
    ...(chosen.assets ? { icon: chosen.assets.icon } : {}),
    ios: {
      supportsTablet: false, bundleIdentifier: product.bundleId, buildNumber: build,
      ...(product.appleTeamId ? { appleTeamId: product.appleTeamId } : {}),
      // HTTPS only; the app adds no encryption of its own (export compliance questionnaire skipped).
      infoPlist: { ITSAppUsesNonExemptEncryption: false, CFBundleAllowMixedLocalizations: true, ...IOS_USAGE.en },
      // React Native's required-reason APIs (its template's manifest); Expo modules ship their own. No tracking.
      privacyManifests: {
        NSPrivacyTracking: false,
        NSPrivacyAccessedAPITypes: [
          { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp', NSPrivacyAccessedAPITypeReasons: ['C617.1'] },
          { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults', NSPrivacyAccessedAPITypeReasons: ['CA92.1'] },
          { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategorySystemBootTime', NSPrivacyAccessedAPITypeReasons: ['35F9.1'] },
        ],
      },
    },
    android: {
      package: product.bundleId, versionCode: Number(build),
      ...(chosen.assets ? { adaptiveIcon: { foregroundImage: chosen.assets.adaptive, backgroundColor: background } } : {}),
      ...(googleServices ? { googleServicesFile: googleServices } : {}),
      // Not shipping yet: the web app's camera/microphone stay blocked on Android until it is tested there.
      permissions: [], blockedPermissions: ['android.permission.RECORD_AUDIO', 'android.permission.CAMERA'],
    },
    locales: { en: { ios: { CFBundleDisplayName: product.name, ...IOS_USAGE.en } }, ko: { ios: { CFBundleDisplayName: product.name, ...IOS_USAGE.ko } } },
    plugins: [
      'expo-secure-store',
      'expo-localization',
      // aps-environment entitlement; Xcode's App Store export switches it to production.
      ['expo-notifications', { defaultChannel: 'default' }],
      ['expo-splash-screen', { backgroundColor: background, ...(chosen.assets ? { image: chosen.assets.splash, imageWidth: 112 } : {}) }],
      ['expo-build-properties', { android: { targetSdkVersion: 36 } }],
    ],
    extra: { teamAxEdition: product, pushEnabled: { ios: true, android: !!googleServices } },
  }
}
