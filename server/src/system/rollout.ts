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
//
// `since` (optional): when the ramp started, if earlier than this release. A release published while the previous
// stable release still ramps takes over its salt, ramp and start (inheritRollout, the publish scripts), so a burst of
// releases a few hours apart completes within 48 hours of the first one instead of starting again at 10% each time.
//
// Read leniently, so a later change of the format never makes a reader refuse the whole feed (which would stop "update
// now" too): a `rollout` that cannot be read (not an object, null, percent missing or out of 0-100, salt not a string
// of at most 100 characters) counts as no roll-out; a `ramp` or `since` that cannot be read is left out (percent alone, or
// publishedAt). The Go side reads the same way (rollout.go readRollout; testdata/rollout.json "reads").
import crypto from 'node:crypto'
import { z } from 'zod'

export const RampStep = z.object({
  /** hours after the ramp's start (since, else the feed's publishedAt) */
  afterHours: z.number().min(0).max(8760),
  percent: z.number().min(0).max(100),
})
export type RampStep = z.infer<typeof RampStep>

/** an RFC 3339 time as publishedMs reads it */
const IsoTime = z.string().refine((s) => publishedMs(s) !== null)

export const Rollout = z.object({
  percent: z.number().min(0).max(100),
  salt: z.string().max(100),
  /** the percent over time (feeds from this change on); servers that do not know it read `percent`. Unreadable: left out */
  ramp: z.array(RampStep).max(20).optional().catch(undefined),
  /** when the ramp started (an earlier release's start, inheritRollout); unreadable: left out, publishedAt counts */
  since: IsoTime.optional().catch(undefined),
})
export type Rollout = z.infer<typeof Rollout>

/** `rollout` as a feed or a manifest reads it: one that cannot be read is no roll-out (the feed itself still reads) */
export const FeedRollout = Rollout.optional().catch(undefined)

/** what an unknown value reads as (FeedRollout), without the keys that were left out */
export function readRollout(v: unknown): Rollout | undefined {
  const r = FeedRollout.parse(v)
  if (!r) return undefined
  return { percent: r.percent, salt: r.salt, ...(r.ramp ? { ramp: r.ramp } : {}), ...(r.since ? { since: r.since } : {}) }
}

/** a stable release: about 10% the first day, 50% the second, everyone from the third */
export const DEFAULT_RAMP: readonly RampStep[] = Object.freeze([{ afterHours: 0, percent: 10 }, { afterHours: 24, percent: 50 }, { afterHours: 48, percent: 100 }])
/** the bucket of an install without an install id: the last wave */
export const LAST_BUCKET = 99

const HOUR_MS = 3_600_000
const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/

/** publishedAt in ms, or null when it is not an RFC 3339 time (the Go side checks the same pattern before time.Parse) */
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

/** When the ramp started (ms): the feed's `since` when it is a time not after publishedAt and not after now, else
 * publishedAt; null when publishedAt cannot be read. */
export function rampStart(f: RolloutFeed, now: Date): number | null {
  const at = publishedMs(f.publishedAt)
  if (at === null) return null
  const since = publishedMs(f.rollout?.since)
  return since !== null && since <= at && since <= now.getTime() ? since : at
}

/** the percent at `nowMs` of a ramp that started at `start` (null: publishedAt cannot be read, the last step) */
function percentAt(ramp: readonly RampStep[], start: number | null, nowMs: number): number {
  // a time that cannot be read: the ramp's last step (the release is not held back for good)
  if (start === null) return pick(ramp, () => true)!.percent
  // a clock behind the start counts as the first moment
  const elapsed = Math.max(0, nowMs - start)
  return pick(ramp, (s) => s.afterHours * HOUR_MS <= elapsed)?.percent ?? 0
}

/** The percent of installs that take the release by themselves now. */
export function rolloutPercent(f: RolloutFeed, o: RolloutOptions): number {
  const r = f.rollout
  if (!r) return 100
  if (!r.ramp?.length || skipsRamp(f, o.channel)) return r.percent
  return percentAt(r.ramp, rampStart(f, o.now), o.now.getTime())
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
  const start = rampStart(f, o.now)
  if (!r.ramp?.length || skipsRamp(f, o.channel) || start === null) return { wait: true, at: null }
  const b = rolloutBucket(r.salt, installId)
  // whole milliseconds, rounded up, so the step has passed at that moment (afterHours may be a fraction); the start as
  // it reads now
  const times = [...new Set(r.ramp.map((s) => Math.ceil(start + s.afterHours * HOUR_MS)))].filter((t) => t > o.now.getTime()).sort((x, y) => x - y)
  for (const t of times) if (b < percentAt(r.ramp, start, t)) return { wait: true, at: new Date(t) }
  return { wait: true, at: null }
}

/**
 * The roll-out of a stable release published while the channel's previous release still ramps (`prev`, the head it
 * replaces): it takes over that release's salt, ramp and start (`since`), so the installs already in stay in and a
 * burst of releases completes within the first one's ramp (48 hours) instead of starting again at 10% for each. Once
 * the previous ramp has ended (or it had none, or was urgent), the new release starts its own. One rule, on the publish
 * side; servers only read `since`.
 */
export function inheritRollout(next: Rollout | undefined, prev: RolloutFeed | null | undefined, publishedAt: string): Rollout | undefined {
  if (!next?.ramp?.length || !prev?.rollout?.ramp?.length || prev.urgent) return next
  const now = publishedMs(publishedAt)
  if (now === null) return next
  const start = rampStart(prev, new Date(now))
  if (start === null) return next
  const end = start + Math.max(...prev.rollout.ramp.map((s) => s.afterHours)) * HOUR_MS
  if (now >= end) return next
  return { percent: next.percent, salt: prev.rollout.salt, ramp: prev.rollout.ramp.map((s) => ({ ...s })), since: new Date(start).toISOString() }
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
