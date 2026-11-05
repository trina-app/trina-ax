// WebCrypto helpers (the same code runs in the Worker and in Bun): base64, PEM, sha256, Ed25519 team keys, and the
// two JWTs the providers want (APNs ES256, Google OAuth RS256).

const enc = new TextEncoder()

/** bytes WebCrypto accepts (an ArrayBuffer, not a SharedArrayBuffer) */
export type Bytes = Uint8Array<ArrayBuffer>

/** what the gateway calls providers with: a string URL, the standard init */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export function b64ToBytes(b64: string): Bytes | null {
  try {
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

export function bytesToB64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!)
  return btoa(bin)
}

export function b64url(data: Uint8Array | string): string {
  return bytesToB64(typeof data === 'string' ? enc.encode(data) : data).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function sha256Hex(data: Bytes | string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data))
  let hex = ''
  for (const b of d) hex += b.toString(16).padStart(2, '0')
  return hex
}

/** DER bytes of a PEM block (PKCS#8 private key). Accepts "\n" written as two characters (a secret pasted on one line). */
export function pemToDer(pem: string): Bytes | null {
  const m = /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/.exec(pem.replace(/\\n/g, '\n'))
  if (!m) return null
  return b64ToBytes(m[2]!.replace(/\s+/g, ''))
}

/** SPKI DER prefix of every Ed25519 public key (RFC 8410): 12 bytes, then the 32-byte key. */
const ED25519_SPKI_PREFIX = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]

/** The team key from the Authorization header: its key id (sha256 hex of the SPKI DER) and the imported key, or null. */
export async function importTeamKey(b64: string): Promise<{ keyId: string; key: CryptoKey } | null> {
  const der = b64ToBytes(b64)
  if (!der || der.length !== 44 || ED25519_SPKI_PREFIX.some((b, i) => der[i] !== b)) return null
  try {
    const key = await crypto.subtle.importKey('spki', der, { name: 'Ed25519' }, false, ['verify'])
    return { keyId: await sha256Hex(der), key }
  } catch {
    return null
  }
}

export async function verifyEd25519(key: CryptoKey, sigB64: string, message: string): Promise<boolean> {
  const sig = b64ToBytes(sigB64)
  if (!sig || sig.length !== 64) return false
  try {
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, sig, enc.encode(message))
  } catch {
    return false
  }
}

export async function importEs256(pem: string): Promise<CryptoKey | null> {
  const der = pemToDer(pem)
  if (!der) return null
  try {
    return await crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  } catch {
    return null
  }
}

export async function importRs256(pem: string): Promise<CryptoKey | null> {
  const der = pemToDer(pem)
  if (!der) return null
  try {
    return await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  } catch {
    return null
  }
}

/** A compact JWS. ES256: WebCrypto ECDSA already gives the raw r||s (IEEE P1363) that JWS wants. */
export async function signJwt(key: CryptoKey, header: Record<string, unknown>, claims: Record<string, unknown>): Promise<string> {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`
  const alg = header.alg === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' }
  const sig = new Uint8Array(await crypto.subtle.sign(alg, key, enc.encode(input)))
  return `${input}.${b64url(sig)}`
}
