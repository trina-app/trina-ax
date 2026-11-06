// Local end-to-end tests only (MYCEL_MOBILE_TEST_CA=<a CA certificate, PEM>): this Android build also trusts that CA for
// https://localhost, so the app can reach a development team (adb reverse) with a throwaway certificate. Without the
// variable nothing changes. scripts/android-release.sh refuses to run while it is set.
const fs = require('node:fs')
const path = require('node:path')
const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins')

const XML = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <domain-config>
    <domain includeSubdomains="false">localhost</domain>
    <trust-anchors>
      <certificates src="@raw/mycel_test_ca" />
      <certificates src="system" />
    </trust-anchors>
  </domain-config>
</network-security-config>
`

module.exports = config => {
  const pem = process.env.MYCEL_MOBILE_TEST_CA
  if (!pem) return config
  const text = fs.readFileSync(pem, 'utf8')
  if (!/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/.test(text)) throw new Error('MYCEL_MOBILE_TEST_CA must be one PEM certificate')
  config = withAndroidManifest(config, c => {
    c.modResults.manifest.application[0].$['android:networkSecurityConfig'] = '@xml/mycel_test_network'
    return c
  })
  return withDangerousMod(config, ['android', async c => {
    const res = path.join(c.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res')
    fs.mkdirSync(path.join(res, 'xml'), { recursive: true }); fs.mkdirSync(path.join(res, 'raw'), { recursive: true })
    fs.writeFileSync(path.join(res, 'xml', 'mycel_test_network.xml'), XML)
    fs.writeFileSync(path.join(res, 'raw', 'mycel_test_ca.pem'), text)
    return c
  }])
}
