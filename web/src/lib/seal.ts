// Seal a token / API key in the browser before it is sent (docs/DECISIONS.md "AI 연결" D12): the relay ends TLS and
// sees plain HTTP, so the secret travels encrypted to the team server's public key and nothing on the way (relay,
// logs, proxies) ever holds it. ECDH P-256 with a one-time key pair -> HKDF-SHA256 (no salt, info
// "mycel-seal-v1|<kid>") -> AES-256-GCM. The server side is server/src/credentials/seal.ts.
// Needs crypto.subtle, which browsers give only on secure pages (https or localhost): canSeal() says whether it is
// there, and the screen refuses to add a connection otherwise.
import type { SealedSecret, SealingKey, SealPurpose } from '@mycel/shared/api'

const b64u = (b: ArrayBuffer | Uint8Array): string => {
  const bytes = b instanceof Uint8Array ? b : new Uint8Array(b)
  let s = ''
  for (const x of bytes) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** crypto.subtle is only there on secure pages (https, localhost) */
export const canSeal = (): boolean => typeof globalThis.crypto !== 'undefined' && !!globalThis.crypto.subtle && (typeof window === 'undefined' || window.isSecureContext !== false)

export async function sealSecret(key: SealingKey, secret: string, purpose: SealPurpose): Promise<SealedSecret> {
  const subtle = globalThis.crypto.subtle
  const server = await subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: key.publicJwk.x, y: key.publicJwk.y, ext: true }, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const mine = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair
  const shared = await subtle.deriveBits({ name: 'ECDH', public: server }, mine.privateKey, 256)
  const hk = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  const aes = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(`mycel-seal-v1|${key.kid}`) }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt'])
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const nonce = b64u(globalThis.crypto.getRandomValues(new Uint8Array(16)))
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, aes, new TextEncoder().encode(JSON.stringify({ secret, nonce, purpose })))
  const epk = await subtle.exportKey('raw', mine.publicKey)
  return { kid: key.kid, epk: b64u(epk), iv: b64u(iv), ct: b64u(ct) }
}
