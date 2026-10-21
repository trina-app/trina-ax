// One-time: make the office release signing key on the owner's Mac (docs/OFFICE.md "자동 업데이트").
//
//   bun scripts/release/keygen.ts            -> ~/.config/teamax-release/release-key.pem (600, folder 700)
//
// Prints only the public key (to bake into server/src/office/release.ts OFFICE_RELEASE_KEYS). Never overwrites an
// existing key: every installed office trusts it, and a lost key means shipping a build with a new one by hand.
// The private key never goes into the repository, a zip, a log or the terminal.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { publicKeyOf } from '../../server/src/office/release'
import { keyId } from '../../server/src/system/update'

export const KEY_DIR = path.join(os.homedir(), '.config', 'teamax-release')
export const KEY_FILE = process.env.TEAMAX_RELEASE_KEY ?? path.join(KEY_DIR, 'release-key.pem')

export function readReleaseKey(file = KEY_FILE): string {
  const st = fs.statSync(file)
  if ((st.mode & 0o077) !== 0) throw new Error(`${file} must be readable only by you (chmod 600 ${file})`)
  return fs.readFileSync(file, 'utf8')
}

if (import.meta.main) {
  if (fs.existsSync(KEY_FILE)) {
    const pub = publicKeyOf(readReleaseKey())
    console.log(`release key already exists: ${KEY_FILE}\npublic key ${pub}\nkey id     ${keyId(Buffer.from(pub, 'base64'))}`)
    process.exit(0)
  }
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true, mode: 0o700 })
  fs.chmodSync(path.dirname(KEY_FILE), 0o700)
  const { privateKey } = crypto.generateKeyPairSync('ed25519')
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string
  fs.writeFileSync(KEY_FILE, pem, { mode: 0o600, flag: 'wx' })
  const pub = publicKeyOf(pem)
  console.log(`release key written: ${KEY_FILE} (600)\npublic key ${pub}\nkey id     ${keyId(Buffer.from(pub, 'base64'))}`)
}
