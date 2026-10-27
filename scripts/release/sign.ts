// Release signing and hashing helpers shared by the release scripts (release-ci.ts, publish-server.ts, publish.ts).
// Light on purpose: node built-ins and the release channel only, so the release workflow's first job can check the
// tag and the key without installing the repository's packages.
//
// A detached signature file is the format of a bundle's manifest.sig and the server feed's .sig: {"keyId", "sig"},
// Ed25519 over the exact bytes, keyId = the first 16 hex digits of sha256(raw public key) (server/src/system/update.ts
// verifySignature reads it).
import crypto from 'node:crypto'
import fs from 'node:fs'
import { RELEASE_CHANNEL } from '../../shared/src/release-channel'

/** sha256(raw 32-byte public key), first 16 hex digits (server/src/system/update.ts keyId) */
export const keyIdOfRaw = (raw: Uint8Array) => crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16)

export class KeyError extends Error { name = 'KeyError' }

/** The private key of a PEM text, refusing anything that is not an Ed25519 private key. The message never carries the
 * text (it may be a secret pasted into the wrong place). */
function privateKey(pem: string): crypto.KeyObject {
  let k: crypto.KeyObject
  try { k = crypto.createPrivateKey(pem) } catch { throw new KeyError('the release key is not a private key in PEM form') }
  if (k.asymmetricKeyType !== 'ed25519') throw new KeyError(`the release key is ${k.asymmetricKeyType ?? 'unknown'}, not Ed25519`)
  return k
}

/** raw base64 Ed25519 public key of a PEM private key (what RELEASE_CHANNEL.keys lists) */
export function publicKeyOfPem(pem: string): string {
  const der = crypto.createPublicKey(privateKey(pem)).export({ format: 'der', type: 'spki' }) as Buffer
  return der.subarray(der.length - 32).toString('base64')
}

/**
 * The signing key must be one this product's builds trust (RELEASE_CHANNEL.keys): a key of another product (a fork's
 * secret pasted into this repository, or the other way round) would sign releases no installation accepts, or worse,
 * releases another product's installations accept. Returns the key id (public, safe to print).
 */
export function checkSigningKey(pem: string, keys: readonly string[] = RELEASE_CHANNEL.keys): string {
  const pub = publicKeyOfPem(pem)
  const id = keyIdOfRaw(Buffer.from(pub, 'base64'))
  if (!keys.includes(pub)) {
    const known = keys.map((k) => keyIdOfRaw(Buffer.from(k, 'base64'))).join(', ')
    throw new KeyError(`the release key (key id ${id}) is not one of this product's release keys (${known}; shared/src/release-channel.ts)`)
  }
  return id
}

/** Detached signature file ({keyId, sig} JSON + newline) over `data`. Ed25519 is deterministic: the same key and bytes
 * always give the same file. */
export function signDetached(data: Uint8Array, pem: string): string {
  const k = privateKey(pem)
  const id = keyIdOfRaw(Buffer.from(publicKeyOfPem(pem), 'base64'))
  return JSON.stringify({ keyId: id, sig: crypto.sign(null, data, k).toString('base64') }) + '\n'
}

/** Check a detached signature file against `keys` (the same rule as update.ts verifySignature). */
export function verifyDetached(data: Uint8Array, sigText: string, keys: readonly string[]): boolean {
  let s: { keyId?: unknown; sig?: unknown }
  try { s = JSON.parse(sigText) } catch { return false }
  if (typeof s.keyId !== 'string' || typeof s.sig !== 'string') return false
  for (const k of keys) {
    const raw = Buffer.from(k, 'base64')
    if (raw.length !== 32 || keyIdOfRaw(raw) !== s.keyId) continue
    const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' })
    return crypto.verify(null, data, pub, Buffer.from(s.sig, 'base64'))
  }
  return false
}

/** Read a PEM file that must be readable only by its owner (the workflow writes it with umask 077). */
export function readKeyFile(file: string): string {
  const st = fs.statSync(file)
  if (!st.isFile() || (st.mode & 0o077) !== 0) throw new KeyError(`${file} must be a file readable only by you (chmod 600)`)
  return fs.readFileSync(file, 'utf8')
}

/** sha256 (or another digest) of a file, read in pieces */
export function hashFile(file: string, algo = 'sha256', enc: 'hex' | 'base64' = 'hex'): string {
  const h = crypto.createHash(algo)
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.allocUnsafe(4 << 20)
  try { for (let pos = 0; ;) { const n = fs.readSync(fd, buf, 0, buf.length, pos); if (!n) break; h.update(buf.subarray(0, n)); pos += n } } finally { fs.closeSync(fd) }
  return h.digest(enc)
}

/** sha256 and size of what a URL answers; null on 404, anything else but 200 throws. Streams (release files are large). */
export async function remoteHash(url: string, f: typeof fetch = fetch): Promise<{ sha256: string; size: number } | null> {
  const r = await f(url, { signal: AbortSignal.timeout(30 * 60_000) })
  if (r.status === 404) { await r.body?.cancel(); return null }
  if (!r.ok || !r.body) throw new Error(`${url}: HTTP ${r.status}`)
  const h = crypto.createHash('sha256')
  let size = 0
  for await (const c of r.body as unknown as AsyncIterable<Uint8Array>) { h.update(c); size += c.byteLength }
  return { sha256: h.digest('hex'), size }
}
