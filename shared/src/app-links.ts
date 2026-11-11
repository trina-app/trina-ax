// The phone app's identity for universal links (iOS) and app links (Android) (docs/DECISIONS.md "First run, phase 2"):
// every team server serves these two files under /.well-known/, so a tapped invite or team link on a hosted team
// address (`https://<name>.<teamDomain>/invite/…`, `/join#t=…`) opens the phone app (its screen ④ asks first). The
// values are the edition's (editions/<name>/branding/mobile.json: appleTeamId, bundleId); a test keeps them equal.
// Self-hosted servers serve the files too (harmless); the app declares only the hosted domain, so their links open
// the app through "앱에서 열기" (`<linkScheme>://open?url=…`) instead.

export const APP_LINKS = {
  /** <Apple developer team>.<bundle id> */
  iosAppIds: ['YWW96288YY.app.trina.ax'] as readonly string[],
  androidPackage: 'app.trina.ax',
  /** SHA-256 of the certificates the app is signed with, "AA:BB:…". Now: the edition's upload key, which signs the APK
   * published on the release channel's update feed. The app is not public on Google Play yet; once
   * Play signs it, installs from Play carry Play's app signing key instead, so add that key's fingerprint here too
   * (Play Console › Test and release › App integrity › App signing). An empty list makes /.well-known/assetlinks.json
   * answer 404. */
  androidCertSha256: [
    '6F:9C:90:4B:59:83:9C:1C:F4:9C:95:95:77:EE:01:FE:78:02:63:35:CC:32:F8:FB:79:CA:F3:BA:08:C9:CA:7A',
    // Google Play's app signing key: installs from Play are signed with it (Play Console › App integrity › App signing)
    '8E:15:1D:64:3C:87:6B:8D:B4:B1:C5:A6:5A:47:00:E2:32:85:66:16:DB:90:79:45:0F:F6:6B:0B:BB:49:9C:81',
  ] as readonly string[],
}

/** The pages that open the app: an invite link and the team link (its token is in the fragment, `#t=`). */
export const APP_LINK_PATHS = { invite: '/invite/*', join: '/join' } as const

/** /.well-known/apple-app-site-association (iOS 13+ `components`; JSON, served without a redirect). */
export function appleAppSiteAssociation(ids = APP_LINKS) {
  return {
    applinks: {
      details: [
        {
          appIDs: [...ids.iosAppIds],
          components: [
            { '/': APP_LINK_PATHS.invite, comment: 'an invite link' },
            { '/': APP_LINK_PATHS.join, '#': 't=*', comment: 'the team link' },
          ],
        },
      ],
    },
  }
}

/** /.well-known/assetlinks.json, or null while no valid certificate fingerprint is set. */
export function assetLinks(ids = APP_LINKS) {
  const prints = ids.androidCertSha256.filter((p) => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(p))
  if (!prints.length) return null
  return [{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: ids.androidPackage, sha256_cert_fingerprints: prints } }]
}
