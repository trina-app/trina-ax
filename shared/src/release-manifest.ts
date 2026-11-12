// The signed release manifest envelope (docs/EDITION-RELEASE.md, server/src/office/release.ts):
// {format: 1, payload: "<JSON text>", keyId, sig}, an Ed25519 signature over the exact payload bytes with one of this
// product's release keys (RELEASE_CHANNEL.keys, ./release-channel.ts). One copy of the signature check for the team
// server (office/release.ts verifyRelease) and the Windows desktop app (desktop/src/common/update-verify.ts), which
// installs an update only when this signed release names the downloaded installer. node:crypto only.
import { createHash, createPublicKey, verify } from 'node:crypto'

/** the key id of a raw 32-byte Ed25519 public key: the first 16 hex digits of its SHA-256 */
export const releaseKeyId = (raw: Uint8Array): string => createHash('sha256').update(raw).digest('hex').slice(0, 16)

export type OpenedManifest = { ok: true; payload: string; keyId: string } | { ok: false; reason: string }

const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex')

/** Check the envelope's signature against `keys` (raw base64): the payload text when it verifies, else why not. */
export function openSignedManifest(text: string, keys: readonly string[]): OpenedManifest {
  if (!keys.length) return { ok: false, reason: 'no release key in this build' }
  let env: Record<string, unknown>
  try { env = JSON.parse(text) as Record<string, unknown> } catch { env = {} }
  const { format, payload, keyId, sig } = (env && typeof env === 'object' ? env : {}) as Record<string, unknown>
  if (format !== 1 || typeof payload !== 'string' || payload.length > 200_000 || typeof keyId !== 'string' || !/^[0-9a-f]{16}$/.test(keyId) || typeof sig !== 'string' || sig.length > 200) {
    return { ok: false, reason: 'the release manifest is not a signed manifest' }
  }
  const k = keys.find((x) => releaseKeyId(Buffer.from(x, 'base64')) === keyId)
  if (!k) return { ok: false, reason: `the release manifest is signed with an unknown key (${keyId})` }
  const raw = Buffer.from(k, 'base64')
  if (raw.length !== 32) return { ok: false, reason: 'release key must be 32 bytes' }
  const pub = createPublicKey({ key: Buffer.concat([ED25519_SPKI, raw]), format: 'der', type: 'spki' })
  let good = false
  try { good = verify(null, Buffer.from(payload, 'utf8'), pub, Buffer.from(sig, 'base64')) } catch {}
  if (!good) return { ok: false, reason: 'the release manifest signature does not verify' }
  return { ok: true, payload, keyId }
}
