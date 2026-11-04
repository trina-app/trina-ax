// Staged roll-out of a release (docs/RELEASE-CI.md "단계적 배포"): one rule for every updater that takes a release by
// itself, so a new stable release reaches about 10% of the installs on its first day, about 50% on the second and all of
// them from the third, and a bad release reaches few teams. The app's own updater (system/update-job.ts
// autoUpdateDecision), the office updater (office/update.ts) and the root update timer (native/cmd/mycel-ctl/rollout.go,
// the same rule in Go: native/cmd/mycel-ctl/testdata/rollout.json is checked by both) ask it. An administrator's
// "update now" (Admin › System, `sudo mycel-ctl update`, office "지금 업데이트") never does: who asks gets the release.
//
// A feed's `rollout` is { percent, salt, ramp? }. An install's bucket is the first two bytes (big-endian) of
// sha256(salt + install id), modulo 100; the install takes the release by itself while bucket < percent. The publish
// scripts pick a new random salt for every release, so every release has other early installs. `ramp` moves the percent
// with the time since the feed's signed publishedAt, so nothing is published again: the step with the largest
// afterHours that has passed counts (none yet: 0). Servers that do not know `ramp` (0.4.0-beta.2 and older) drop it when
// they parse the feed (zod strips unknown keys; Go's encoding/json ignores them) and read `percent` alone, which the
// publish scripts set to 100: they take the release as before.
//
// Not ramped: an urgent release (the feed's `urgent`) and the beta channel (a stable release is the beta channel's head
// too, with the same bytes): `percent` alone counts there. An install without an install id is in the last bucket (99),
// so it takes the release at the 100% step, never earlier and never later.
import crypto from 'node:crypto'
import { z } from 'zod'

export const RampStep = z.object({
  /** hours after the feed's publishedAt */
  afterHours: z.number().min(0).max(8760),
  percent: z.number().min(0).max(100),
})
export type RampStep = z.infer<typeof RampStep>

export const Rollout = z.object({
  percent: z.number().min(0).max(100),
  salt: z.string().max(100),
  /** the percent over time (feeds from this change on); servers that do not know it read `percent` */
  ramp: z.array(RampStep).max(20).optional(),
})
export type Rollout = z.infer<typeof Rollout>

/** a stable release: about 10% the first day, 50% the second, everyone from the third */
export const DEFAULT_RAMP: readonly RampStep[] = Object.freeze([{ afterHours: 0, percent: 10 }, { afterHours: 24, percent: 50 }, { afterHours: 48, percent: 100 }])
/** the bucket of an install without an install id: the last wave */
export const LAST_BUCKET = 99

const HOUR_MS = 3_600_000
const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/

/** publishedAt in ms, or null when it is not an RFC 3339 time (the Go side reads the same ones: time.RFC3339Nano) */
export function publishedMs(s: string | undefined): number | null {
  const m = s ? ISO_TIME.exec(s) : null
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const day = new Date(Date.UTC(y, mo - 1, d))
  if (mo < 1 || mo > 12 || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) return null // 2026-02-30
  const t = Date.parse(s!)
  return Number.isFinite(t) ? t : null
}

/** sha256(salt + install id)'s first two bytes, big-endian, % 100; no install id: the last bucket */
export function rolloutBucket(salt: string, installId: string | null | undefined): number {
  if (!installId) return LAST_BUCKET
  return crypto.createHash('sha256').update(salt + installId).digest().readUInt16BE(0) % 100
}

/** the step that counts: the largest afterHours (a tie: the larger percent) among those for which `ok` holds */
function pick(ramp: readonly RampStep[], ok: (s: RampStep) => boolean): RampStep | null {
  let best: RampStep | null = null
  for (const s of ramp) {
    if (!ok(s)) continue
    if (!best || s.afterHours > best.afterHours || (s.afterHours === best.afterHours && s.percent > best.percent)) best = s
  }
  return best
}

export interface RolloutFeed { rollout?: Rollout; publishedAt?: string; urgent?: boolean }
export interface RolloutOptions {
  now: Date
  /** the install's update channel: the beta channel skips the ramp */
  channel?: string
}

/** urgent releases and the beta channel take `percent` alone */
export const skipsRamp = (f: Pick<RolloutFeed, 'urgent'>, channel?: string) => !!f.urgent || channel === 'beta'

/** The percent of installs that take the release by themselves now. */
export function rolloutPercent(f: RolloutFeed, o: RolloutOptions): number {
  const r = f.rollout
  if (!r) return 100
  if (!r.ramp?.length || skipsRamp(f, o.channel)) return r.percent
  const at = publishedMs(f.publishedAt)
  // a time that cannot be read: the ramp's last step (the release is not held back for good)
  if (at === null) return pick(r.ramp, () => true)!.percent
  // a clock behind publishedAt counts as the first moment
  const elapsed = Math.max(0, o.now.getTime() - at)
  return pick(r.ramp, (s) => s.afterHours * HOUR_MS <= elapsed)?.percent ?? 0
}

/** Is this install in the release's roll-out now? (no `rollout`: everyone, as always) */
export function inRollout(f: RolloutFeed, installId: string | null | undefined, o: RolloutOptions = { now: new Date() }): boolean {
  if (!f.rollout) return true
  return rolloutBucket(f.rollout.salt, installId) < rolloutPercent(f, o)
}

export type RolloutTurn = { wait: false } | { wait: true; at: Date | null }

/** When this install's turn comes: wait false when it may take the release now; else the first ramp step that reaches
 * its bucket, or at null when this feed's roll-out leaves it out (a percent below its bucket and no step that reaches
 * it). Shown to administrators (Admin › System, `mycel-ctl status`); the updaters decide with inRollout. */
export function rolloutTurn(f: RolloutFeed, installId: string | null | undefined, o: RolloutOptions): RolloutTurn {
  if (inRollout(f, installId, o)) return { wait: false }
  const r = f.rollout!
  const at = publishedMs(f.publishedAt)
  if (!r.ramp?.length || skipsRamp(f, o.channel) || at === null) return { wait: true, at: null }
  // whole milliseconds, rounded up, so the step has passed at that moment (afterHours may be a fraction)
  const times = [...new Set(r.ramp.map((s) => Math.ceil(at + s.afterHours * HOUR_MS)))].filter((t) => t > o.now.getTime()).sort((x, y) => x - y)
  for (const t of times) if (inRollout(f, installId, { ...o, now: new Date(t) })) return { wait: true, at: new Date(t) }
  return { wait: true, at: null }
}

/** The `rollout` a publish script writes: a stable release ramps (DEFAULT_RAMP, a new random salt), unless it was
 * published with `Rollout: all` (docs/RELEASE-CI.md); a beta release does not. percent 100 is what servers that do not
 * know `ramp` read. */
export function newRollout(channel: 'stable' | 'beta', mode: 'staged' | 'all', salt = crypto.randomBytes(16).toString('hex')): Rollout | undefined {
  if (channel !== 'stable' || mode !== 'staged') return undefined
  return { percent: 100, salt, ramp: DEFAULT_RAMP.map((s) => ({ ...s })) }
}

/** "10% → 50% after 24 h → 100% after 48 h" (publish logs) */
export const rampText = (ramp: readonly RampStep[]) => ramp.map((s, i) => (i === 0 && s.afterHours === 0 ? `${s.percent}%` : `${s.percent}% after ${s.afterHours} h`)).join(' → ')
