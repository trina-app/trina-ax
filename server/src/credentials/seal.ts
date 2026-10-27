// Sealed secrets (docs/DECISIONS.md "AI 연결" D12): a token / key pasted in the browser is encrypted there with this
// server's public key before it is sent, so the relay (which ends TLS and sees plain HTTP), request logs and memory
// copies along the way never hold it. ECDH P-256 (a one-time browser key pair) -> HKDF-SHA256 (no salt, info
// "mycel-seal-v1|<kid>") -> AES-256-GCM (iv 12 bytes). The plaintext is JSON {secret, nonce, purpose}: the purpose
// must match the endpoint (a sealed value cannot be replayed on another request) and a nonce is accepted once within
// 10 minutes. The browser side is web/src/lib/seal.ts (same algorithm, WebCrypto on both ends).
//
// The private key is <secrets>/credential-sealing.jwk (P-256, server account 0600, created on first use with O_EXCL);
// kid = SHA-256 of the uncompressed public point, first 16 hex characters. Limit (security T7): a relay that
// actively rewrites the web app's JavaScript could still read a value before it is sealed.
import fs from 'node:fs'
import path from 'node:path'
import { SEAL_ALG, type SealedSecret, type SealingKey, type SealPurpose } from '@mycel/shared/api'

export const SEALING_KEY_FILE = 'credential-sealing.jwk'
const NONCE_TTL_MS = 10 * 60_000
const subtle = globalThis.crypto.subtle

export class SealError extends Error {
  name = 'SealError'
  constructor(readonly reason: 'kid' | 'format' | 'decrypt' | 'purpose' | 'replay', message: string) { super(message) }
}

const fromB64u = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'))

interface Loaded { privateKey: CryptoKey; publicJwk: SealingKey['publicJwk']; kid: string }

async function kidOf(publicKey: CryptoKey): Promise<string> {
  const raw = await subtle.exportKey('raw', publicKey)
  return Buffer.from(await subtle.digest('SHA-256', raw)).toString('hex').slice(0, 16)
}

export class Sealer {
  private loaded: Promise<Loaded> | null = null
  private nonces = new Map<string, number>()
  constructor(readonly secretsDir: string, private now: () => number = Date.now) {}

  get file() { return path.join(this.secretsDir, SEALING_KEY_FILE) }

  private readJwk(): JsonWebKey | null {
    let st: fs.Stats
    try { st = fs.lstatSync(this.file) } catch { return null }
    if (st.isSymbolicLink() || !st.isFile() || (st.mode & 0o077) !== 0 || st.size > 4096) throw new Error(`${SEALING_KEY_FILE} is not a private regular file`)
    const fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try { return JSON.parse(fs.readFileSync(fd, 'utf8')) as JsonWebKey } finally { fs.closeSync(fd) }
  }

  private async load(): Promise<Loaded> {
    let jwk = this.readJwk()
    if (!jwk) {
      const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair
      const made = await subtle.exportKey('jwk', pair.privateKey)
      fs.mkdirSync(this.secretsDir, { recursive: true, mode: 0o700 })
      try {
        const fd = fs.openSync(this.file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
        try { fs.writeSync(fd, JSON.stringify({ kty: made.kty, crv: made.crv, x: made.x, y: made.y, d: made.d })) } finally { fs.closeSync(fd) }
        jwk = made
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
        jwk = this.readJwk()
      }
    }
    if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d || !jwk.x || !jwk.y) throw new Error(`${SEALING_KEY_FILE} is not a P-256 private key`)
    const privateKey = await subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d, ext: false }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
    const publicKey = await subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true }, { name: 'ECDH', namedCurve: 'P-256' }, true, [])
    return { privateKey, publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, kid: await kidOf(publicKey) }
  }

  private keys(): Promise<Loaded> {
    if (!this.loaded) {
      this.loaded = this.load()
      this.loaded.catch(() => { this.loaded = null })
    }
    return this.loaded
  }

  /** GET /api/credentials/sealing-key (never the private part) */
  async publicKey(): Promise<SealingKey> {
    const k = await this.keys()
    return { kid: k.kid, alg: SEAL_ALG, publicJwk: k.publicJwk }
  }

  /** The secret inside a sealed value for this purpose; throws SealError (never says what the value was). */
  async unseal(s: SealedSecret, purpose: SealPurpose): Promise<string> {
    const k = await this.keys()
    if (s.kid !== k.kid) throw new SealError('kid', 'sealed with another key (reload the page)')
    let plain: Uint8Array
    try {
      const epk = await subtle.importKey('raw', fromB64u(s.epk), { name: 'ECDH', namedCurve: 'P-256' }, false, [])
      const shared = await subtle.deriveBits({ name: 'ECDH', public: epk }, k.privateKey, 256)
      const hk = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
      const aes = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(`mycel-seal-v1|${k.kid}`) }, hk, { name: 'AES-GCM', length: 256 }, false, ['decrypt'])
      plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: fromB64u(s.iv) }, aes, fromB64u(s.ct)))
    } catch {
      throw new SealError('decrypt', 'the sealed value could not be opened')
    }
    let j: { secret?: unknown; nonce?: unknown; purpose?: unknown }
    try { j = JSON.parse(new TextDecoder().decode(plain)) } catch { throw new SealError('format', 'the sealed value is not JSON') }
    if (typeof j.secret !== 'string' || typeof j.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(j.nonce)) throw new SealError('format', 'the sealed value is incomplete')
    if (j.purpose !== purpose) throw new SealError('purpose', 'sealed for another request')
    const now = this.now()
    for (const [n, until] of this.nonces) if (until <= now) this.nonces.delete(n)
    if (this.nonces.has(j.nonce)) throw new SealError('replay', 'this sealed value was already used')
    this.nonces.set(j.nonce, now + NONCE_TTL_MS)
    return j.secret
  }
}
