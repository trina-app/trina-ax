// Office mode release feed (docs/OFFICE.md "자동 업데이트"): what scripts/release/publish.ts uploads to this product's
// feed (RELEASE_CHANNEL.feed, shared/src/release-channel.ts) and what the office updater (./update.ts) checks before it
// installs anything. <dir> is RELEASE_CHANNEL.officeDir.
//
//   <feed>/<dir>/<channel>.json        the signed manifest of the channel (stable | beta), no-cache
//   <feed>/<dir>/<version>/<file>      the office zip, the Windows installer and its electron-updater latest.yml;
//                                      never overwritten once published (publish.ts refuses a different file)
//
// <channel>.json is one object, {format: 1, payload: "<JSON text>", keyId, sig}: an Ed25519 signature over the exact
// payload bytes, so the manifest and its signature are always uploaded together (no window where one is new and the
// other old). The private key lives only on the owner's Mac (~/.config/<keyDir>/release-key.pem, mode 600,
// scripts/release/keygen.ts); the public keys below are baked into every build. A key is replaced by adding the new
// one here first, shipping that build, then signing with the new key (the old one stays until every office has it).
import crypto from 'node:crypto'
import { z } from 'zod'
import { compareVersions, keyId } from '../system/update'
import { PRODUCT, RELEASE_CHANNEL } from '@mycel/shared'
import { RELEASE_KEYS } from '../system/release-keys'

/** the only address the office updater contacts unless config/office.env sets TEAMAX_UPDATE_FEED (tests) */
export const DEFAULT_FEED: string = RELEASE_CHANNEL.feed

/** the signed manifest's product: an office takes only its own product's releases */
export const OFFICE_PRODUCT: string = RELEASE_CHANNEL.officeProduct

/** Ed25519 release public keys (raw 32 bytes, base64). The private key: ~/.config/<keyDir>/release-key.pem. */
export const OFFICE_RELEASE_KEYS: readonly string[] = RELEASE_KEYS // system/release-keys.ts: the same key signs the server feed

export const CHANNELS = ['stable', 'beta'] as const
export type Channel = (typeof CHANNELS)[number]

/** 1.2.3 or 1.2.3-beta.1 (a folder and file name part, so nothing else) */
export const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+){0,3})?$/
const Version = z.string().regex(VERSION_RE)
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,150}$/
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/)

export const ReleaseFile = z.object({
  /** file name (also the last part of url) */
  file: z.string().regex(FILE_RE),
  url: z.string().url(),
  sha256: Sha256,
  size: z.number().int().positive().max(2 * 1024 ** 3),
})
export type ReleaseFile = z.infer<typeof ReleaseFile>

export const OfficeRelease = z.object({
  format: z.literal(1),
  product: z.literal(OFFICE_PRODUCT),
  channel: z.enum(CHANNELS),
  version: Version,
  /** the oldest installed version that may update to this one by itself (older ones install the zip by hand) */
  minFrom: Version,
  publishedAt: z.string().datetime(),
  notes: z.string().max(20_000).default(''),
  /** the office zip (<PRODUCT.officeBundle>-<version>-mac.zip). 'universal' = both Mac processors in one zip. */
  office: z.array(ReleaseFile.extend({ arch: z.enum(['universal', 'arm64', 'amd64']) })).min(1),
  /** the Windows desktop app the Mac offers its desks (data/downloads), with electron-updater's latest.yml */
  windows: z.object({ version: Version, installer: ReleaseFile, latestYml: ReleaseFile }).nullable().default(null),
})
export type OfficeRelease = z.infer<typeof OfficeRelease>

export const SignedManifest = z.object({ format: z.literal(1), payload: z.string().max(200_000), keyId: z.string().regex(/^[0-9a-f]{16}$/), sig: z.string().max(200) })
export type SignedManifest = z.infer<typeof SignedManifest>

export class ReleaseError extends Error { name = 'ReleaseError' }

function publicKey(b64: string): crypto.KeyObject {
  const raw = Buffer.from(b64, 'base64')
  if (raw.length !== 32) throw new ReleaseError('release key must be 32 bytes')
  return crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' })
}

/** raw base64 public key of an Ed25519 private key (PKCS#8 PEM) */
export function publicKeyOf(privatePem: string): string {
  const der = crypto.createPublicKey(crypto.createPrivateKey(privatePem)).export({ format: 'der', type: 'spki' }) as Buffer
  return der.subarray(der.length - 32).toString('base64')
}

const DIR = RELEASE_CHANNEL.officeDir
/** <feed>/<dir>/<channel>.json */
export const manifestUrl = (feed: string, channel: Channel) => `${feed.replace(/\/+$/, '')}/${DIR}/${channel}.json`
/** <feed>/<dir>/<version>/<file> */
export const fileUrl = (feed: string, version: string, file: string) => `${feed.replace(/\/+$/, '')}/${DIR}/${version}/${file}`

/** Sign a release: the manifest text uploaded as <feed>/<dir>/<channel>.json. */
export function signRelease(r: OfficeRelease, privatePem: string): string {
  const payload = JSON.stringify(OfficeRelease.parse(r), null, 1)
  const key = crypto.createPrivateKey(privatePem)
  const env: SignedManifest = { format: 1, payload, keyId: keyId(Buffer.from(publicKeyOf(privatePem), 'base64')), sig: crypto.sign(null, Buffer.from(payload, 'utf8'), key).toString('base64') }
  return JSON.stringify(env, null, 1) + '\n'
}

export interface VerifyContext {
  keys: readonly string[]
  /** the channel that was asked for: a manifest of another channel is refused (a beta build offered as stable) */
  channel: Channel
  /** every file URL must be under this feed (the only address the updater contacts) */
  feed: string
}

/**
 * Check a downloaded <channel>.json: signed by a baked key, the asked channel, every file on the feed and named by
 * its URL. Throws ReleaseError saying why not; returns the release.
 */
export function verifyRelease(text: string, o: VerifyContext): OfficeRelease {
  if (!o.keys.length) throw new ReleaseError('no release key in this build')
  let env: SignedManifest
  try { env = SignedManifest.parse(JSON.parse(text)) } catch { throw new ReleaseError('the release manifest is not a signed manifest') }
  const k = o.keys.find((x) => keyId(Buffer.from(x, 'base64')) === env.keyId)
  if (!k) throw new ReleaseError(`the release manifest is signed with an unknown key (${env.keyId})`)
  if (!crypto.verify(null, Buffer.from(env.payload, 'utf8'), publicKey(k), Buffer.from(env.sig, 'base64'))) throw new ReleaseError('the release manifest signature does not verify')
  let r: OfficeRelease
  try { r = OfficeRelease.parse(JSON.parse(env.payload)) } catch (e) { throw new ReleaseError(`the release manifest is signed but not readable by this version: ${(e as Error).message.slice(0, 300)}`) }
  if (r.channel !== o.channel) throw new ReleaseError(`the ${o.channel} manifest is a ${r.channel} release`)
  if (compareVersions(r.minFrom, r.version) > 0) throw new ReleaseError(`minFrom ${r.minFrom} is newer than the release ${r.version}`)
  const base = o.feed.replace(/\/+$/, '') + '/'
  const files = [...r.office, ...(r.windows ? [r.windows.installer, r.windows.latestYml] : [])]
  for (const f of files) {
    if (!f.url.startsWith(base)) throw new ReleaseError(`${f.file} is not on the release feed (${f.url})`)
    if (decodeURIComponent(new URL(f.url).pathname.split('/').pop() ?? '') !== f.file) throw new ReleaseError(`${f.url} does not name ${f.file}`)
  }
  return r
}

/** What an installed version should do with a verified release. */
export type Decision =
  | { kind: 'install' }
  | { kind: 'current' }
  | { kind: 'older'; reason: string }
  | { kind: 'too-old'; reason: string }

export function decide(installed: string, r: Pick<OfficeRelease, 'version' | 'minFrom'>): Decision {
  const c = compareVersions(r.version, installed)
  if (c === 0) return { kind: 'current' }
  if (c < 0) return { kind: 'older', reason: `the feed offers ${r.version}, older than the installed ${installed}: never installed (no downgrades)` }
  if (compareVersions(installed, r.minFrom) < 0) return { kind: 'too-old', reason: `${r.version} updates only from ${r.minFrom} or newer; install ${PRODUCT.officeBundle}-${r.version}-mac.zip by hand once (office-install.sh)` }
  return { kind: 'install' }
}
