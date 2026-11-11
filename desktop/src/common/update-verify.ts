// The Windows app installs a downloaded update only when the product's signed release names it (owner decision
// 2026-11-11, docs/DECISIONS.md). The installer and latest.yml come from the team server, so latest.yml's sha512 alone
// proves nothing about where they came from; the signed office manifest (<feed>/<officeDir>/<channel>.json,
// server/src/office/release.ts) does: Ed25519 with a key baked into this build (RELEASE_CHANNEL.keys), and it names the
// Windows installer's version and SHA-256. The team server puts that manifest next to the installer as
// /downloads/<channel>.json (server/src/office/update.ts offerWindows), so an office without internet still updates;
// otherwise the release feed itself is asked. No Electron here (unit-tested in tests/unit/office-update-desktop.test.ts).
import { RELEASE_CHANNEL } from '@mycel/shared'
import { openSignedManifest } from '@mycel/shared/release-manifest'
import { compareVersions } from './update'

export const UPDATE_CHANNELS = ['stable', 'beta'] as const
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number]

/** a release version (also part of a feed URL, so nothing else) */
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+){0,3})?$/

export interface InstallerCheck {
  /** the signed manifest text ({format, payload, keyId, sig}) */
  manifest: string
  /** SHA-256 (hex) of the downloaded installer */
  installerSha256: string
  /** the channel whose manifest this is (the file name it was read under) */
  channel: UpdateChannel
  /** the version electron-updater downloaded (latest.yml) */
  version: string
  /** the version running now: the update must be newer */
  current: string
  /** default RELEASE_CHANNEL.officeProduct */
  product?: string
  /** default RELEASE_CHANNEL.keys */
  keys?: readonly string[]
}

export type InstallerVerdict = { ok: true; keyId: string } | { ok: false; reason: string }

/** Does the signed manifest name exactly this installer, as a newer release of this product on that channel? */
export function verifyInstaller(c: InstallerCheck): InstallerVerdict {
  const env = openSignedManifest(c.manifest, c.keys ?? RELEASE_CHANNEL.keys)
  if (!env.ok) return env
  let r: Record<string, unknown>
  try { r = JSON.parse(env.payload) as Record<string, unknown> } catch { return { ok: false, reason: 'the signed release is not readable' } }
  if (!r || typeof r !== 'object') return { ok: false, reason: 'the signed release is not readable' }
  const product = c.product ?? RELEASE_CHANNEL.officeProduct
  if (r.product !== product) return { ok: false, reason: `the signed release is for ${String(r.product)}, not ${product}` }
  if (r.channel !== c.channel) return { ok: false, reason: `the ${c.channel} manifest is a ${String(r.channel)} release` }
  const w = r.windows as { version?: unknown; installer?: { sha256?: unknown } } | null | undefined
  if (!w || typeof w !== 'object') return { ok: false, reason: 'the signed release has no Windows app' }
  if (typeof w.version !== 'string' || !VERSION_RE.test(w.version)) return { ok: false, reason: 'the signed release names no Windows version' }
  if (w.version !== c.version) return { ok: false, reason: `the signed release names the Windows app ${w.version}, not ${c.version}` }
  if (compareVersions(c.version, c.current) <= 0) return { ok: false, reason: `${c.version} is not newer than the installed ${c.current}` }
  const sha = w.installer && typeof w.installer === 'object' ? w.installer.sha256 : undefined
  if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/.test(sha)) return { ok: false, reason: 'the signed release names no installer SHA-256' }
  if (sha !== c.installerSha256.toLowerCase()) return { ok: false, reason: 'the downloaded installer is not the one the signed release names' }
  return { ok: true, keyId: env.keyId }
}

export interface ManifestSource { url: string; channel: UpdateChannel; team: boolean }

/** Where the signed manifest of `version` is looked for, in order: the team's /downloads/<channel>.json (the server
 * offers one channel; a pre-release version is tried as beta first), then the feed's copy of that version
 * (<feed>/<dir>/<version>/<channel>.json, kept for every release), then the channel's head. */
export function manifestSources(teamFeed: string, version: string, feed: string = RELEASE_CHANNEL.feed, dir: string = RELEASE_CHANNEL.officeDir): ManifestSource[] {
  const order: UpdateChannel[] = version.includes('-') ? ['beta', 'stable'] : ['stable', 'beta']
  const base = teamFeed.endsWith('/') ? teamFeed : `${teamFeed}/`
  const root = `${feed.replace(/\/+$/, '')}/${dir}`
  const out: ManifestSource[] = order.map((channel) => ({ url: `${base}${channel}.json`, channel, team: true }))
  if (VERSION_RE.test(version)) for (const channel of order) out.push({ url: `${root}/${version}/${channel}.json`, channel, team: false })
  for (const channel of order) out.push({ url: `${root}/${channel}.json`, channel, team: false })
  return out
}

/** The check may be skipped only in a development run (not packaged) that asks for it, or a build without keys
 * (a fork that has not run scripts/edition-release.ts); a packaged app always checks. */
export function verificationRequired(packaged: boolean, keys: readonly string[] = RELEASE_CHANNEL.keys, env: Record<string, string | undefined> = process.env): boolean {
  if (packaged) return true
  return !(env.MYCEL_DESKTOP_UPDATE_UNVERIFIED === '1' || keys.length === 0)
}
