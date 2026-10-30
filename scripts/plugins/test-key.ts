// The developer's plugin TEST signing key (docs/PLUGINS.md "시험 키"). It lives outside the repository, separate from
// the release key and from any production plugin key:
//   ~/.config/trina-ax-plugin-test/test-key.pem   (MYCEL_PLUGIN_TEST_KEY_FILE overrides; refused inside the repo)
// A server trusts it only when told so explicitly, and only in development or on a test server the operator marked:
//   MYCEL_PLUGINS_TEST_KEYS=$(bun scripts/plugins/test-key.ts --public)
// Unit tests never use this file: they make a fresh key per run. No test private key is committed anywhere.
//
//   bun scripts/plugins/test-key.ts            create it if missing; print the public key and key id
//   bun scripts/plugins/test-key.ts --public   print only the public key (for the environment variable)
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { keyIdOf, publicKeyOfPem } from '../../server/src/plugins/trust'

const REPO = path.resolve(import.meta.dir, '../..')

export function testKeyFile(): string {
  const f = path.resolve(process.env.MYCEL_PLUGIN_TEST_KEY_FILE ?? path.join(os.homedir(), '.config', 'trina-ax-plugin-test', 'test-key.pem'))
  if ((f + path.sep).startsWith(REPO + path.sep)) throw new Error('the plugin test key must live outside the repository')
  return f
}

/** The test key (PKCS#8 PEM), created on first use with owner-only permissions. */
export function ensureTestKey(): string {
  const file = testKeyFile()
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const { privateKey } = crypto.generateKeyPairSync('ed25519')
    fs.writeFileSync(file, privateKey.export({ format: 'pem', type: 'pkcs8' }) as string, { mode: 0o600, flag: 'wx' })
  }
  if ((fs.statSync(file).mode & 0o077) !== 0) throw new Error(`${file} must be readable only by you (chmod 600)`)
  return fs.readFileSync(file, 'utf8')
}

if (import.meta.main) {
  const pub = publicKeyOfPem(ensureTestKey())
  if (process.argv.includes('--public')) console.log(pub)
  else console.log(`plugin TEST key: ${testKeyFile()}\npublic key ${pub}\nkey id     ${keyIdOf(pub)}\nTrusted only with MYCEL_PLUGINS_TEST_KEYS in development (never on hosted or office servers).`)
}
