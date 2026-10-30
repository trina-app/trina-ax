// This product's plugin trust root: the Ed25519 public keys that may sign plugin packages and the plugin catalog
// (docs/PLUGINS.md "서명 키"). It is separate from RELEASE_CHANNEL.keys on purpose: a plugin key can never sign a
// server/office update, and a release key never makes a plugin trusted. Each key is limited to the publishers and
// plugin ids it may sign for.
//
// Written by scripts/plugins/trust.ts from editions/<name>/branding/plugin-trust.json (never by hand). The
// owner/operator creates the production key outside this repository; until then the list is empty and every plugin
// package and the bundled catalog are refused in production (development may trust test keys explicitly with
// MYCEL_PLUGINS_TEST_KEYS, never on hosted servers).
export interface PluginTrustKey {
  /** raw 32-byte Ed25519 public key, base64 */
  publicKey: string
  /** publisher ids this key may sign for */
  publishers: readonly string[]
  /** plugin id prefixes this key may sign for, e.g. "app.trina." */
  idPrefixes: readonly string[]
  /** may also sign the official catalog */
  catalog: boolean
}

export const PLUGIN_TRUST: { keys: readonly PluginTrustKey[] } = {
  keys: [],
}
