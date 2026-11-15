// The Mac dmg people download (docs/RELEASE-CI.md "Mac app"): signed with the Developer ID Application certificate and
// notarized by Apple, so it opens with no "unidentified developer" warning. It reuses electron-builder.config.ts and
// changes only what that needs: hardened runtime with build-resources/entitlements.mac*.plist (no App Sandbox), the
// signing identity, notarization of the app (electron-builder staples it before the dmg and the zip are made), a
// signed dmg, and a zip next to it: electron-updater's Mac updater (Squirrel.Mac) installs from the zip, which
// latest-mac.yml names (desktop/src/main/updater.ts). scripts/release/mac-app.ts then notarizes and staples the dmg
// itself and checks everything with Gatekeeper.
//   CSC_LINK=<.p12 file or base64> CSC_KEY_PASSWORD=… APPLE_API_KEY=<AuthKey .p8 file> APPLE_API_KEY_ID=… \
//   APPLE_API_ISSUER=… bun run --cwd desktop dist:mac:release -- "-c.extraMetadata.version=<version>"
// The appId stays the base one (com.treesoop.mycel): the dmgs before this were that app, so an install from one is
// replaced in place, and it is not the Mac App Store build (app.trina.ax, editions/trina/mac-app-store), whose data
// lives in its sandbox. Without CSC_LINK electron-builder looks in the keychains for the identity below.
import base from './electron-builder.config'

const TEAM_ID = 'YWW96288YY'

for (const k of ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']) {
  if (!process.env[k]) throw new Error(`${k} is not set: notarization needs the App Store Connect API key (docs/RELEASE-CI.md "Mac app")`)
}

export default {
  ...base,
  mac: {
    ...base.mac,
    target: [{ target: 'dmg', arch: ['universal'] }, { target: 'zip', arch: ['universal'] }],
    // "Developer ID Application: Trina Inc. (YWW96288YY)"; electron-builder adds the certificate type itself
    identity: `Trina Inc. (${TEAM_ID})`,
    type: 'distribution',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build-resources/entitlements.mac.plist',
    entitlementsInherit: 'build-resources/entitlements.mac.inherit.plist',
    // notarytool with the API key of the environment (APPLE_API_KEY / _ID / _ISSUER)
    notarize: true,
  },
  dmg: { ...base.dmg, sign: true },
}
