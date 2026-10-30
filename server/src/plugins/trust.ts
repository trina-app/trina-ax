// Who may sign plugins and the plugin catalog on this server.
//
// Production: PLUGIN_TRUST (shared/src/plugin-trust.ts, set per edition by scripts/plugins/trust.ts) — separate from
// the release keys (a release key listed there is dropped), each key limited to publishers and plugin id prefixes.
// Test trust, clearly labelled, through environment variables only (on Linux the root-owned /etc/default/<id>; never
// server.json, which the app itself can rewrite):
//   MYCEL_PLUGINS_TEST_KEYS=<base64>[,<base64>]   also trust these test public keys ("Test build")
//   MYCEL_PLUGINS_ALLOW_UNSIGNED=1               accept packages without a valid signature ("Unverified")
// They count only in development mode, or on a production-mode test server whose operator also set
// MYCEL_PLUGINS_TEST_SERVER=1. Office and hosted servers ignore all three. While any is in effect the admin Plugins
// page shows a warning band. No test private key is in this repository: tests make one per run, and
// scripts/plugins/test-key.ts keeps the developer's key outside the repository.
// The file inventory (every byte listed with its SHA-256) is checked for every package whatever the trust: a test
// setting never lets a package's files differ from its own manifest.
import crypto from 'node:crypto'
import { PLUGIN_TRUST, RELEASE_CHANNEL, type PluginTrustKey } from '@mycel/shared'
import { PluginSignature } from '@mycel/shared/plugins'
import type { PluginTrust } from '@mycel/shared/api'

export interface TrustKey extends PluginTrustKey { kind: 'official' | 'test' }
export interface TrustRoot {
  keys: readonly TrustKey[]
  allowUnsigned: boolean
  hosted: boolean
  /** test settings in effect (shown as an admin warning) */
  warnings: ('test_keys' | 'unsigned' | 'test_server')[]
  /** test settings that were present but ignored here, for the log */
  ignored: string[]
}

export const keyIdOf = (publicKeyB64: string) => crypto.createHash('sha256').update(Buffer.from(publicKeyB64, 'base64')).digest('hex').slice(0, 16)

export function validPublicKey(b64: string): boolean {
  return /^[A-Za-z0-9+/]{43}=$/.test(b64) && Buffer.from(b64, 'base64').length === 32
}

function publicKeyObject(b64: string): crypto.KeyObject {
  return crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(b64, 'base64')]), format: 'der', type: 'spki' })
}

/** The trust root for this process. `runKind` is system/deployment.ts runKindOf(config). */
export function trustRoot(o: { runKind: 'hosted' | 'selfhost' | 'office' | 'dev'; env?: Record<string, string | undefined>; productionKeys?: readonly PluginTrustKey[] }): TrustRoot {
  const env = o.env ?? process.env
  const release = new Set(RELEASE_CHANNEL.keys)
  // a release key is never a plugin key, even if someone listed it
  const official: TrustKey[] = (o.productionKeys ?? PLUGIN_TRUST.keys).filter((k) => validPublicKey(k.publicKey) && !release.has(k.publicKey)).map((k) => ({ ...k, kind: 'official' as const }))
  const testKeys = (env.MYCEL_PLUGINS_TEST_KEYS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const unsigned = env.MYCEL_PLUGINS_ALLOW_UNSIGNED === '1'
  const testServer = env.MYCEL_PLUGINS_TEST_SERVER === '1'
  const asked = [...(testKeys.length ? ['MYCEL_PLUGINS_TEST_KEYS'] : []), ...(unsigned ? ['MYCEL_PLUGINS_ALLOW_UNSIGNED'] : []), ...(testServer ? ['MYCEL_PLUGINS_TEST_SERVER'] : [])]
  const allowed = o.runKind === 'dev' || (o.runKind === 'selfhost' && testServer)
  if (!allowed) return { keys: official, allowUnsigned: false, hosted: o.runKind === 'hosted', warnings: [], ignored: asked }
  const officialIds = new Set(official.map((k) => k.publicKey))
  const test: TrustKey[] = testKeys.filter((k) => validPublicKey(k) && !release.has(k) && !officialIds.has(k))
    .map((publicKey) => ({ publicKey, publishers: ['*'], idPrefixes: [''], catalog: true, kind: 'test' as const }))
  const warnings: TrustRoot['warnings'] = [...(test.length ? ['test_keys' as const] : []), ...(unsigned ? ['unsigned' as const] : []), ...(o.runKind === 'selfhost' && (test.length || unsigned) ? ['test_server' as const] : [])]
  return { keys: [...official, ...test], allowUnsigned: unsigned, hosted: false, warnings, ignored: [] }
}

export type SignatureCheck =
  | { ok: true; trust: PluginTrust; keyId: string | null }
  | { ok: false; reason: 'signature' | 'untrusted' }

/**
 * Verify a detached signature over `domain + canonical` for something published by `publisher` with id `id`
 * (catalogs: publisher/id null). Unsigned or unverifiable input is accepted only when the root allows unsigned
 * packages (never for the catalog).
 */
export function checkSignature(root: TrustRoot, domain: string, canonical: string, sigText: string | null,
  subject: { publisher: string; id: string } | 'catalog'): SignatureCheck {
  const fallback = (reason: 'signature' | 'untrusted'): SignatureCheck =>
    subject !== 'catalog' && root.allowUnsigned ? { ok: true, trust: 'unverified', keyId: null } : { ok: false, reason }
  if (sigText === null) return fallback('signature')
  let sig: { keyId: string; sig: string }
  try { sig = PluginSignature.parse(JSON.parse(sigText)) } catch { return fallback('signature') }
  const key = root.keys.find((k) => keyIdOf(k.publicKey) === sig.keyId)
  if (!key) return fallback('untrusted')
  const allowed = subject === 'catalog' ? key.catalog
    : (key.publishers.includes('*') || key.publishers.includes(subject.publisher)) && key.idPrefixes.some((p) => subject.id.startsWith(p))
  if (!allowed) return fallback('untrusted')
  let good = false
  try { good = crypto.verify(null, Buffer.from(domain + canonical, 'utf8'), publicKeyObject(key.publicKey), Buffer.from(sig.sig, 'base64')) } catch { good = false }
  if (!good) return fallback('signature')
  return { ok: true, trust: key.kind, keyId: sig.keyId }
}

/** Sign `domain + canonical` with an Ed25519 private key (PKCS#8 PEM). Build scripts and tests only. */
export function signDetached(privateKeyPem: string, domain: string, canonical: string): string {
  const key = crypto.createPrivateKey(privateKeyPem)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('the plugin signing key must be Ed25519')
  const pub = (crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64')
  const sig = crypto.sign(null, Buffer.from(domain + canonical, 'utf8'), key).toString('base64')
  return JSON.stringify({ keyId: keyIdOf(pub), sig }) + '\n'
}

export function publicKeyOfPem(privateKeyPem: string): string {
  return (crypto.createPublicKey(crypto.createPrivateKey(privateKeyPem)).export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64')
}
