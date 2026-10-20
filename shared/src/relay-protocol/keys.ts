// Ed25519 helpers for team keys. The team server keeps only its private key (a 0600 PEM file); the relay keeps only
// the public key (base64 SPKI DER). No bearer tokens anywhere (tab 6).
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto'

export interface TeamKeyPair { privatePem: string; publicKey: string }

export function generateTeamKey(): TeamKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  }
}

export function loadPrivateKey(pem: string): KeyObject {
  const k = createPrivateKey(pem)
  if (k.asymmetricKeyType !== 'ed25519') throw new Error('team key must be Ed25519')
  return k
}

export function publicKeyOf(priv: KeyObject): string {
  return createPublicKey(priv).export({ format: 'der', type: 'spki' }).toString('base64')
}

/** Parse a base64 SPKI Ed25519 public key; null when it is not one. */
export function parsePublicKey(b64: string): KeyObject | null {
  if (typeof b64 !== 'string' || b64.length > 200 || !/^[A-Za-z0-9+/]+=*$/.test(b64)) return null
  try {
    const k = createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' })
    return k.asymmetricKeyType === 'ed25519' ? k : null
  } catch {
    return null
  }
}

export function signB64(priv: KeyObject, message: string): string {
  return sign(null, Buffer.from(message, 'utf8'), priv).toString('base64')
}

export function verifyB64(pub: KeyObject | string, message: string, sigB64: string): boolean {
  const key = typeof pub === 'string' ? parsePublicKey(pub) : pub
  if (!key || typeof sigB64 !== 'string' || sigB64.length > 200) return false
  try {
    const sig = Buffer.from(sigB64, 'base64')
    if (sig.byteLength !== 64) return false
    return verify(null, Buffer.from(message, 'utf8'), key, sig)
  } catch {
    return false
  }
}
