// Opening a .trinaplugin: bounded archive read, strict manifest, trust, then the file inventory (every payload byte
// listed, sizes and SHA-256 equal, nothing extra). Trust, in this order:
//   1. release pin: the canonical manifest digest, version and platform equal a pin in the official list shipped with
//      this release (catalog.ts releasePins) for an entry that is `available` -> official, no key needed
//   2. signature against the plugin trust root (official keys later, stage B5; test keys only in development)
// A pin of a `pending_clearance` entry vouches for nothing: such a package is refused as `not_available` unless a key
// (in development, a test key) accepts it. Nothing is written to disk here. buildPackage() is the writer used by the
// build scripts and tests.
import crypto from 'node:crypto'
import {
  PLUGIN_MANIFEST_DOMAIN, PLUGIN_MANIFEST_FILE, PLUGIN_SIGNATURE_FILE, PluginManifest, platformKey, SUPPORTED_PLUGIN_KINDS, type PluginFile,
} from '@mycel/shared/plugins'
import type { PluginRefusal, PluginTrust } from '@mycel/shared/api'
import { ArchiveError, readArchive, writeArchive } from './archive'
import type { ReleasePin } from './catalog'
import { canonicalJson, JsonError, parseStrictJson } from './json'
import { checkSignature, keyIdOf, publicKeyOfPem, signDetached, type SignatureCheck, type TrustRoot } from './trust'

export class PackageError extends Error {
  name = 'PackageError'
  constructor(readonly reason: PluginRefusal, message: string) { super(message) }
}

export interface VerifiedPackage {
  manifest: PluginManifest
  /** the signed byte form */
  canonical: string
  manifestSha256: string
  archiveSha256: string
  size: number
  /** payload files (without the manifest and signature) */
  files: Map<string, Buffer>
  /** the manifest file as stored: as written, or for a pinned package exactly the pinned canonical bytes */
  manifestText: string
  /** the detached signature as stored (never for a pinned package: every stored byte is then covered by the pin) */
  sigText: string | null
  trust: PluginTrust
  keyId: string | null
  /** official because a release pin lists this exact manifest (keyId is then null) */
  pinned: boolean
}

const sha256 = (b: Uint8Array | string) => crypto.createHash('sha256').update(b).digest('hex')
const MANIFEST_MAX = 256 * 1024

/**
 * Whether a release pin lists this manifest: same id, publisher, version, exactly the one platform the pin names (or
 * none for a data-only package) and the same canonical digest. 'available': it vouches for the package; 'pending':
 * the entry is not cleared for distribution; null: no pin matches.
 */
export function pinFor(m: PluginManifest, manifestSha256: string, pins: readonly ReleasePin[]): 'available' | 'pending' | null {
  const platform = m.platforms === undefined ? '' : m.platforms.length === 1 ? platformKey(m.platforms[0]) : null
  if (platform === null) return null
  let hit: 'available' | 'pending' | null = null
  for (const p of pins) {
    if (p.id !== m.id || p.publisher !== m.publisher.id || p.version !== m.version || platformKey(p.platform) !== platform || p.manifestSha256 !== manifestSha256) continue
    if (p.available) return 'available'
    hit = 'pending'
  }
  return hit
}

export function verifyPackage(bytes: Uint8Array, root: TrustRoot, pins: readonly ReleasePin[] = []): VerifiedPackage {
  let entries: Map<string, Buffer>
  try { entries = readArchive(bytes) } catch (e) {
    throw new PackageError('archive', e instanceof ArchiveError ? e.message : 'unreadable archive')
  }
  const manifestBytes = entries.get(PLUGIN_MANIFEST_FILE)
  if (!manifestBytes) throw new PackageError('manifest', `${PLUGIN_MANIFEST_FILE} is missing`)
  if (manifestBytes.length > MANIFEST_MAX) throw new PackageError('manifest', 'manifest too large')
  const manifestText = manifestBytes.toString('utf8')
  let raw: unknown
  try { raw = parseStrictJson(manifestText) } catch (e) { throw new PackageError('manifest', e instanceof JsonError ? e.message : 'invalid JSON') }
  const parsed = PluginManifest.safeParse(raw)
  if (!parsed.success) throw new PackageError('manifest', parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'manifest'}: ${i.message}`).join('; '))
  const manifest = parsed.data
  if (manifest.kinds.some((k) => !SUPPORTED_PLUGIN_KINDS.includes(k))) throw new PackageError('kind', 'this server cannot install this kind of plugin yet')

  // the digested and signed form is the document as written (strictly parsed), not a normalized copy
  const canonical = canonicalJson(raw)
  const manifestSha256 = sha256(canonical)
  const sigBytes = entries.get(PLUGIN_SIGNATURE_FILE)
  const sigText = sigBytes ? sigBytes.toString('utf8') : null
  const pin = pinFor(manifest, manifestSha256, pins)
  let check: SignatureCheck
  if (pin === 'available') check = { ok: true, trust: 'official', keyId: null }
  else {
    check = checkSignature(root, PLUGIN_MANIFEST_DOMAIN, canonical, manifest.signature ? sigText : null, { publisher: manifest.publisher.id, id: manifest.id })
    // the manifest names the key it was signed with; a signature by another (even trusted) key does not count
    if (check.ok && check.keyId && manifest.signature?.keyId !== check.keyId) check = root.allowUnsigned ? { ok: true, trust: 'unverified', keyId: null } : { ok: false, reason: 'signature' }
  }
  if (!check.ok && pin === 'pending') throw new PackageError('not_available', 'this official plugin is not cleared for distribution yet')
  if (!check.ok) throw new PackageError(check.reason, check.reason === 'untrusted' ? 'signed by a key this server does not trust for this plugin' : 'not in the official list of this release and no valid signature')

  // inventory: exactly the listed files, byte for byte
  const listed = new Map(manifest.files.map((f) => [f.path, f]))
  const files = new Map<string, Buffer>()
  for (const [p, data] of entries) {
    if (p === PLUGIN_MANIFEST_FILE || p === PLUGIN_SIGNATURE_FILE) continue
    const f = listed.get(p)
    if (!f) throw new PackageError('tampered', `unlisted file ${p}`)
    if (f.size !== data.length || f.sha256 !== sha256(data)) throw new PackageError('tampered', `file ${p} does not match the manifest`)
    files.set(p, data)
  }
  for (const f of manifest.files) if (!files.has(f.path)) throw new PackageError('tampered', `listed file ${f.path} is missing`)

  const pinned = pin === 'available'
  return {
    manifest, canonical, manifestSha256, archiveSha256: sha256(bytes), size: bytes.length, files,
    manifestText: pinned ? canonical : manifestText, sigText: pinned ? null : sigText, trust: check.trust, keyId: check.keyId, pinned,
  }
}

export type ManifestDraft = Omit<PluginManifest, 'files' | 'signature'>

/** The inventory of a payload. */
export function inventory(payload: Map<string, Uint8Array>, executables: ReadonlySet<string> = new Set()): PluginFile[] {
  return [...payload.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, d]) => ({ path: p, sha256: sha256(d), size: d.length, ...(executables.has(p) ? { executable: true } : {}) }))
}

/** Build (and with a key, sign) a package. */
export function buildPackage(o: { manifest: ManifestDraft; payload: Map<string, Uint8Array>; executables?: ReadonlySet<string>; keyPem?: string | null; gzip?: boolean }): { bytes: Buffer; manifest: PluginManifest } {
  const executables = o.executables ?? new Set<string>()
  const draft: PluginManifest = {
    ...o.manifest,
    files: inventory(o.payload, executables),
    ...(o.keyPem ? { signature: { algorithm: 'Ed25519' as const, keyId: keyIdOf(publicKeyOfPem(o.keyPem)), file: PLUGIN_SIGNATURE_FILE } } : {}),
  }
  const manifest = PluginManifest.parse(draft)
  const canonical = canonicalJson(manifest)
  const all = new Map<string, Uint8Array>(o.payload)
  all.set(PLUGIN_MANIFEST_FILE, Buffer.from(JSON.stringify(manifest, null, 2) + '\n'))
  if (o.keyPem) all.set(PLUGIN_SIGNATURE_FILE, Buffer.from(signDetached(o.keyPem, PLUGIN_MANIFEST_DOMAIN, canonical)))
  return { bytes: writeArchive(all, { gzip: o.gzip, executables: new Set(executables) }), manifest }
}
