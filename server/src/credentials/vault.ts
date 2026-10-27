// Secret storage of the AI connections (docs/DECISIONS.md "AI 연결" D6). Every secret lives in the database only
// encrypted (engine_credentials.secret_enc: AES-256-GCM, nonce 12 bytes, tag 16 bytes, AAD "mycel-cred-v1|<id>|<kind>"),
// so a copy of the database (VACUUM INTO backups, an archive, a support dump) holds no plaintext, and a row's
// ciphertext moved onto another row does not decrypt. The key is a 32-byte random file <secrets>/credentials.key
// (server account, 0600, folder 0700), never in the database and left out of every backup with the other secrets.
// Key version N > 1 lives in credentials.key.N (credentials-rekey, system/cli.ts).
//
// The key file is created with O_EXCL | O_NOFOLLOW and refused when it is a link, not a regular file, readable by
// others, owned by another account or of the wrong size (security T16): a planted file is never used, and a
// failure never overwrites a key (all connections would be lost).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const KEY_FILE = 'credentials.key'
export const CURRENT_KEY_VERSION = 1
const AAD = (id: string, kind: string) => Buffer.from(`mycel-cred-v1|${id}|${kind}`)

export class VaultError extends Error {
  name = 'VaultError'
  constructor(readonly code: 'key_missing' | 'key_unsafe' | 'decrypt_failed', message: string) { super(message) }
}

export const keyFileName = (version: number) => (version <= 1 ? KEY_FILE : `${KEY_FILE}.${version}`)

/** the highest key version that has a file in the folder (1 when none) */
export function detectVersion(secretsDir: string): number {
  let v = CURRENT_KEY_VERSION
  try {
    for (const f of fs.readdirSync(secretsDir)) {
      const m = /^credentials\.key\.(\d{1,4})$/.exec(f)
      if (m) v = Math.max(v, Number(m[1]))
    }
  } catch {}
  return v
}

/** Read a key file the safe way; null when it does not exist. Throws VaultError('key_unsafe') for anything odd. */
export function readKeyFile(file: string): Buffer | null {
  let st: fs.Stats
  try { st = fs.lstatSync(file) } catch { return null }
  if (st.isSymbolicLink() || !st.isFile()) throw new VaultError('key_unsafe', `${path.basename(file)} is not a regular file`)
  if ((st.mode & 0o077) !== 0) throw new VaultError('key_unsafe', `${path.basename(file)} is readable by other accounts (mode ${(st.mode & 0o777).toString(8)})`)
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new VaultError('key_unsafe', `${path.basename(file)} belongs to another account`)
  if (st.size > 128) throw new VaultError('key_unsafe', `${path.basename(file)} has the wrong size`)
  let text: string
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try { text = fs.readFileSync(fd, 'utf8').trim() } finally { fs.closeSync(fd) }
  const key = Buffer.from(text, 'base64')
  if (key.length !== 32) throw new VaultError('key_unsafe', `${path.basename(file)} does not hold a 32-byte key`)
  return key
}

/** Create a new random key file (O_EXCL: never replaces one). */
export function createKeyFile(file: string): Buffer {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const key = crypto.randomBytes(32)
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
  try { fs.writeSync(fd, key.toString('base64') + '\n') } finally { fs.closeSync(fd) }
  return key
}

export function sealWithKey(key: Buffer, id: string, kind: string, value: unknown): string {
  const nonce = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce)
  c.setAAD(AAD(id, kind))
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(value), 'utf8')), c.final()])
  return Buffer.concat([nonce, ct, c.getAuthTag()]).toString('base64')
}

export function openWithKey(key: Buffer, id: string, kind: string, enc: string): unknown {
  const raw = Buffer.from(enc, 'base64')
  if (raw.length < 12 + 16 + 2) throw new VaultError('decrypt_failed', 'ciphertext too short')
  const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
  d.setAAD(AAD(id, kind))
  d.setAuthTag(raw.subarray(raw.length - 16))
  try {
    const pt = Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()])
    return JSON.parse(pt.toString('utf8'))
  } catch {
    throw new VaultError('decrypt_failed', 'the secret could not be decrypted (another key, or the row was changed)')
  }
}

/**
 * The key of one server, read once per version. `encrypt` creates the current key on first use; `decrypt` never
 * creates one (a missing key = the connection must be made again).
 */
export class Vault {
  private keys = new Map<number, Buffer>()
  /** the key version new secrets are encrypted with: the highest credentials.key(.N) there is (after a rekey, N) */
  readonly version: number
  constructor(readonly secretsDir: string, version?: number) {
    this.version = version ?? detectVersion(secretsDir)
  }

  keyPath(version = this.version) { return path.join(this.secretsDir, keyFileName(version)) }

  /** the key of a version; null = no key file. Throws VaultError('key_unsafe'). */
  key(version: number, create = false): Buffer | null {
    const have = this.keys.get(version)
    if (have) return have
    let k = readKeyFile(this.keyPath(version))
    if (!k && create) {
      try { k = createKeyFile(this.keyPath(version)) } catch (e) {
        // another process made it at the same moment: read theirs
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
        k = readKeyFile(this.keyPath(version))
      }
    }
    if (k) this.keys.set(version, k)
    return k
  }

  encrypt(id: string, kind: string, value: unknown): { enc: string; keyVersion: number } {
    const k = this.key(this.version, true)!
    return { enc: sealWithKey(k, id, kind, value), keyVersion: this.version }
  }

  decrypt(id: string, kind: string, enc: string, keyVersion: number): unknown {
    let k: Buffer | null
    try { k = this.key(keyVersion) } catch (e) { throw e instanceof VaultError ? new VaultError('decrypt_failed', e.message) : e }
    if (!k) throw new VaultError('decrypt_failed', `no key file for version ${keyVersion}`)
    return openWithKey(k, id, kind, enc)
  }

  /** forget the cached keys (tests, rekey) */
  reset() { this.keys.clear() }

  /** Diagnostics: is the key file there and safe? (never returns the key) */
  check(): { state: 'missing' | 'ok' | 'unsafe'; detail?: string } {
    try { return readKeyFile(this.keyPath()) ? { state: 'ok' } : { state: 'missing' } } catch (e) { return { state: 'unsafe', detail: (e as Error).message } }
  }
}
