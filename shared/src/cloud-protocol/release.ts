// Server release manifests (control-plane 3.7.1, linux-runtime 3.6.3). MIT (see LICENSE in this folder).
//
//   https://updates.treesoop.com/server/<channel>.json (+ .sig)       channel head (stable / beta)
//   https://updates.treesoop.com/server/<version>/release.json (+ .sig) one version, so the control plane can roll out a
//                                                                       version that is no longer the channel head
// Both are the server's ReleaseFeed (server/src/system/update.ts) with optional fields added (never removed or
// changed): `rollout` (linux runtime), readerLevel / minReaderRequired / checks / notesI18n / engines / desktop (control
// plane). The .sig file is { keyId, sig }: Ed25519 over the exact bytes of the .json (the office release key).
import { z } from 'zod'
import { HttpsUrl, IsoTime, Sha256Hex } from './common.ts'

const Version = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/)
const Download = z.object({ url: HttpsUrl, sha256: Sha256Hex, size: z.number().int().positive() })
const LongI18n = z.object({ ko: z.string().max(4000), en: z.string().max(4000), id: z.string().max(4000) })

export const ReleaseChecks = z.object({
  unit: z.boolean(),
  /** engine lockdown test with the pinned claude-code / codex-cli (linux-runtime T3) */
  lockdown: z.boolean(),
  /** tests/linux/attack.sh with the cross-chat read asserted to FAIL */
  attack: z.boolean(),
  relay: z.boolean(),
  at: IsoTime,
})

export const ReleaseFeed = z.object({
  version: Version,
  minFrom: Version.nullable().default(null),
  urgent: z.boolean().default(false),
  needsRoot: z.boolean().default(false),
  notes: z.string().default(''),
  publishedAt: IsoTime,
  bundles: z.array(z.object({ os: z.string(), arch: z.string(), url: HttpsUrl, sha256: Sha256Hex, size: z.number().int() })),
  // ---- linux runtime (3.6.3) ----
  /** self-hosted servers apply it automatically only when sha256(salt + installId)[0..2] % 100 < percent */
  rollout: z.object({ percent: z.number().int().min(0).max(100), salt: z.string().min(1).max(64) }).optional(),
  // ---- control plane (3.7.1) ----
  /** SCHEMA_READER_LEVEL of this build (server/src/db.ts) */
  readerLevel: z.number().int().min(1).optional(),
  /** the highest min_compatible_reader among this build's migrations */
  minReaderRequired: z.number().int().min(1).optional(),
  checks: ReleaseChecks.optional(),
  /** what customers read in the changelog and the "new version" notice */
  notesI18n: LongI18n.optional(),
  engines: z.object({ claudeCode: z.string().max(40), codexCli: z.string().max(40), bun: z.string().max(40) }).optional(),
  /** desktop installers the tenant puts into data/downloads (control-plane D35) */
  desktop: z.object({
    windows: z.object({ installer: Download, latestYml: Download }).nullable(),
    mac: z.object({ dmg: Download, latestYml: Download.nullable() }).nullable(),
  }).optional(),
})
export type ReleaseFeed = z.infer<typeof ReleaseFeed>

export const BundleSignature = z.object({ keyId: z.string().regex(/^[0-9a-f]{16}$/), sig: z.string().regex(/^[A-Za-z0-9+/]+=*$/).max(200) })
export type BundleSignature = z.infer<typeof BundleSignature>

export const releaseChannelPath = (channel: 'stable' | 'beta') => `server/${channel}.json`
export const releaseManifestPath = (version: string) => `server/${version}/release.json`

/**
 * A release whose migrations old builds cannot read (minReaderRequired above the previous build's readerLevel): the
 * app's own roll-back cannot open the new DB, only the VM snapshot can (control-plane 3.7.2: pilot bakes 72 h).
 */
export function onlySnapshotRollback(previousReaderLevel: number, r: Pick<ReleaseFeed, 'minReaderRequired'>): boolean {
  return (r.minReaderRequired ?? 1) > previousReaderLevel
}
