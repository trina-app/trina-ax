// The cryptography of the mailbox (shared/src/cloud-protocol/mail-in.ts "Sealed item" and "Request"), behind one small
// interface: Cloudflare Workers use WebCrypto (X25519, Ed25519, HKDF, AES-GCM); Bun's WebCrypto has no X25519, so tests
// and the local dev server use node:crypto (node-crypto.ts, never imported by the Worker). Both make the same bytes.
import { MAIL_IN_SEAL_ALG, MAIL_IN_SEAL_INFO, type MailInSealed } from '../../shared/src/cloud-protocol/mail-in.ts'

export interface MailCrypto {
  sha256Hex(data: Uint8Array | string): Promise<string>
  /** Seal `plaintext` to the team's X25519 public key (raw 32 bytes, base64url) with `aad` (UTF-8). */
  seal(sealKey: string, plaintext: Uint8Array, aad: string): Promise<MailInSealed>
  /** Ed25519 over `message` by the key (base64 SPKI DER); false for any bad input. */
  verify(spkiB64: string, message: Uint8Array, sigB64: string): Promise<boolean>
  /** a random id for an item (MAIL_IN_ITEM_ID_RE) */
  randomId(): string
}

const utf8 = (s: string) => new TextEncoder().encode(s)

// ---------------- WebCrypto (Cloudflare Workers) ----------------
const b64uOf = (b: ArrayBuffer | Uint8Array) => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b)
  let s = ''
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000))
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const bytesOf = (s: string, url: boolean) => {
  const b = atob(url ? s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4) : s)
  const u = new Uint8Array(b.length)
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i)
  return u
}
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')

/** WebCrypto: the Worker's. The algorithm names are passed as plain objects (the TS DOM types do not all know them). */
export function webMailCrypto(subtle: SubtleCrypto = crypto.subtle, random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): MailCrypto {
  const S = subtle as unknown as { [k: string]: (...a: unknown[]) => Promise<any> }
  return {
    async sha256Hex(data) { return hex(await S.digest!('SHA-256', typeof data === 'string' ? utf8(data) : data)) },
    async seal(sealKey, plaintext, aad) {
      const teamRaw = bytesOf(sealKey, true)
      if (teamRaw.length !== 32) throw new Error('bad seal key')
      const teamPub = await S.importKey!('raw', teamRaw, { name: 'X25519' }, false, [])
      const pair = await S.generateKey!({ name: 'X25519' }, true, ['deriveBits'])
      const epk = new Uint8Array(await S.exportKey!('raw', pair.publicKey))
      const shared = await S.deriveBits!({ name: 'X25519', public: teamPub }, pair.privateKey, 256)
      const ikm = await S.importKey!('raw', shared, 'HKDF', false, ['deriveBits'])
      const salt = new Uint8Array(64); salt.set(epk, 0); salt.set(teamRaw, 32)
      const keyBits = await S.deriveBits!({ name: 'HKDF', hash: 'SHA-256', salt, info: utf8(MAIL_IN_SEAL_INFO) }, ikm, 256)
      const key = await S.importKey!('raw', keyBits, { name: 'AES-GCM' }, false, ['encrypt'])
      const iv = random(12)
      const ct = await S.encrypt!({ name: 'AES-GCM', iv, additionalData: utf8(aad), tagLength: 128 }, key, plaintext)
      return { alg: MAIL_IN_SEAL_ALG, epk: b64uOf(epk), iv: b64uOf(iv), ct: b64uOf(ct) }
    },
    async verify(spkiB64, message, sigB64) {
      try {
        const key = await S.importKey!('spki', bytesOf(spkiB64, false), { name: 'Ed25519' }, false, ['verify'])
        return await S.verify!({ name: 'Ed25519' }, key, bytesOf(sigB64, false), message)
      } catch { return false }
    },
    randomId() { return b64uOf(random(18)) },
  }
}
