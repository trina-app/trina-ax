// Check (and with --apply, write) an edition's plugin trust root (docs/PLUGINS.md "서명 키"):
//
//   bun scripts/plugins/trust.ts editions/trina/branding/plugin-trust.json            check only
//   bun scripts/plugins/trust.ts editions/trina/branding/plugin-trust.json --apply    write shared/src/plugin-trust.ts
//
// Refused: a key that is not a raw 32-byte Ed25519 public key, a product release key (RELEASE_CHANNEL.keys: a release
// key must never sign plugins and the other way round), the developer's local test key, duplicates, more than 4 keys,
// or a key without publishers / plugin id prefixes. The production key pair itself is made by the owner/operator
// outside this repository; only public keys come here.
import fs from 'node:fs'
import path from 'node:path'
import { RELEASE_CHANNEL } from '../../shared/src/release-channel'
import type { PluginTrustKey } from '../../shared/src/plugin-trust'
import { keyIdOf, publicKeyOfPem, validPublicKey } from '../../server/src/plugins/trust'
import { testKeyFile } from './test-key'

const REPO = path.resolve(import.meta.dir, '../..')
export const TRUST_FILE = path.join(REPO, 'shared/src/plugin-trust.ts')

export function checkTrust(input: unknown, testPublicKey: string | null): PluginTrustKey[] {
  const o = input as { keys?: unknown }
  if (!o || typeof o !== 'object' || !Array.isArray(o.keys)) throw new Error('keys: a list')
  if (o.keys.length > 4) throw new Error('keys: at most 4 (a main key and spares)')
  const seen = new Set<string>()
  return o.keys.map((k: Partial<PluginTrustKey>, i: number) => {
    if (!k || typeof k.publicKey !== 'string' || !validPublicKey(k.publicKey)) throw new Error(`keys[${i}].publicKey: a raw 32-byte Ed25519 public key in base64`)
    if (RELEASE_CHANNEL.keys.includes(k.publicKey)) throw new Error(`keys[${i}]: this is a product release key; plugins need their own key`)
    if (testPublicKey && k.publicKey === testPublicKey) throw new Error(`keys[${i}]: this is the local plugin TEST key`)
    if (seen.has(k.publicKey)) throw new Error(`keys[${i}]: listed twice`)
    seen.add(k.publicKey)
    const list = (v: unknown, name: string, re: RegExp) => {
      if (!Array.isArray(v) || !v.length || v.some((x) => typeof x !== 'string' || !re.test(x))) throw new Error(`keys[${i}].${name}: a non-empty list`)
      return v as string[]
    }
    return { publicKey: k.publicKey, publishers: list(k.publishers, 'publishers', /^[a-z][a-z0-9-]{1,39}$/), idPrefixes: list(k.idPrefixes, 'idPrefixes', /^[a-z][a-z0-9.-]{1,60}\.$/), catalog: k.catalog === true }
  })
}

export function trustSource(keys: PluginTrustKey[]): string {
  const old = fs.readFileSync(TRUST_FILE, 'utf8')
  const head = old.slice(0, old.indexOf('export const PLUGIN_TRUST'))
  const body = keys.map((k) => `    { publicKey: ${JSON.stringify(k.publicKey)}, publishers: ${JSON.stringify(k.publishers)}, idPrefixes: ${JSON.stringify(k.idPrefixes)}, catalog: ${k.catalog} }, // key id ${keyIdOf(k.publicKey)}\n`).join('')
  return `${head}export const PLUGIN_TRUST: { keys: readonly PluginTrustKey[] } = {\n  keys: [${keys.length ? `\n${body}  ` : ''}],\n}\n`
}

if (import.meta.main) {
  const file = process.argv[2]
  if (!file) { console.error('usage: bun scripts/plugins/trust.ts <plugin-trust.json> [--apply]'); process.exit(2) }
  let test: string | null = null
  try { if (fs.existsSync(testKeyFile())) test = publicKeyOfPem(fs.readFileSync(testKeyFile(), 'utf8')) } catch { /* no local test key */ }
  const keys = checkTrust(JSON.parse(fs.readFileSync(file, 'utf8')), test)
  console.log(`${keys.length} plugin key(s): ${keys.map((k) => keyIdOf(k.publicKey)).join(', ') || '(none: every plugin package is refused in production)'}`)
  if (process.argv.includes('--apply')) { fs.writeFileSync(TRUST_FILE, trustSource(keys)); console.log(`wrote ${path.relative(REPO, TRUST_FILE)}`) }
}
