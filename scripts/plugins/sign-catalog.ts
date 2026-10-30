// Sign the official plugin list (resources/plugins/catalog.json) with a plugin key: an owner/operator step once the
// production plugin key exists (docs/PLUGINS.md "서명 키"). Until then the list ships unsigned inside the signed core
// release and the server shows it as information only (no installs from it).
//
//   bun scripts/plugins/sign-catalog.ts --key ~/.config/trina-ax-plugins/plugin-key.pem      writes catalog.sig
//   bun scripts/plugins/sign-catalog.ts --test --catalog <dir>                               test key, another folder
//
// The test key never signs the list in resources/plugins: a test signature there would make every production server
// treat the list as tampered.
import fs from 'node:fs'
import path from 'node:path'
import { PLUGIN_CATALOG_DOMAIN, PluginCatalog } from '../../shared/src/plugins'
import { canonicalJson, parseStrictJson } from '../../server/src/plugins/json'
import { publicKeyOfPem, signDetached } from '../../server/src/plugins/trust'
import { ensureTestKey } from './test-key'

const REPO = path.resolve(import.meta.dir, '../..')
const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined }

/** catalog.sig for the catalog.json in `dir`. */
export function signCatalog(dir: string, keyPem: string): void {
  const raw = parseStrictJson(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8'))
  PluginCatalog.parse(raw)
  fs.writeFileSync(path.join(dir, 'catalog.sig'), signDetached(keyPem, PLUGIN_CATALOG_DOMAIN, canonicalJson(raw)))
}

if (import.meta.main) {
  const dir = path.resolve(arg('--catalog') ?? path.join(REPO, 'resources/plugins'))
  const test = process.argv.includes('--test')
  const keyFile = arg('--key')
  if (!test && !keyFile) { console.error('give --key <plugin key pem> (or --test with --catalog <another folder>)'); process.exit(2) }
  const pem = test ? ensureTestKey() : fs.readFileSync(keyFile!, 'utf8')
  const official = path.join(REPO, 'resources/plugins')
  if ((test || publicKeyOfPem(pem) === publicKeyOfPem(ensureTestKey())) && dir === official) { console.error('the test key never signs resources/plugins/catalog.json'); process.exit(1) }
  signCatalog(dir, pem)
  console.log(`signed ${path.join(dir, 'catalog.json')}`)
}
