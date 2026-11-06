// The staged roll-out of a release (server/src/system/rollout.ts, docs/RELEASE-CI.md "단계적 배포"): the shared vectors the
// root update timer checks too (native/cmd/mycel-ctl/testdata/rollout.json), the ramp over time, urgent releases and the
// beta channel, a missing install id, what the publish scripts write, the app's automatic update, and what servers that
// do not know `ramp` (0.4.0-beta.2 and older) make of such a feed.
import { describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { ReleaseFeed as ProtocolReleaseFeed } from '../../shared/src/cloud-protocol/release'
import { OfficeRelease } from '../../server/src/office/release'
import { DEFAULT_RAMP, LAST_BUCKET, inheritRollout, inRollout, newRollout, publishedMs, rampText, readRollout, rolloutBucket, rolloutPercent, rolloutTurn, type Rollout } from '../../server/src/system/rollout'
import type { BackupManager } from '../../server/src/system/backup'
import { ReleaseFeed, type UpdateManager } from '../../server/src/system/update'
import { autoUpdateDecision, runUpdate } from '../../server/src/system/update-job'

const VECTORS = path.resolve(import.meta.dir, '..', '..', 'native', 'cmd', 'mycel-ctl', 'testdata', 'rollout.json')
interface Case {
  why: string; rollout?: unknown; publishedAt: string; urgent?: boolean; channel: 'stable' | 'beta'; installId: string; now: string
  percent: number; in: boolean; wait: boolean; turn?: string | null
}
const T = JSON.parse(fs.readFileSync(VECTORS, 'utf8')) as {
  defaultRamp: unknown; lastBucket: number; buckets: { salt: string; installId: string; bucket: number }[]; cases: Case[]
  reads: { why: string; rollout?: unknown; reads: Rollout | null }[]
}

const SALT = '3f9a1c7e5b2d4086a1e0c9b8f7d6e5a4'
const PUBLISHED = '2026-11-04T01:00:00.000Z'
const hours = (h: number) => new Date(Date.parse(PUBLISHED) + h * 3_600_000)
const ramped = (o: Partial<ReleaseFeed> = {}): ReleaseFeed => ({
  version: '1.1.0', minFrom: null, urgent: false, needsRoot: false, notes: '', publishedAt: PUBLISHED, bundles: [],
  rollout: { percent: 100, salt: SALT, ramp: DEFAULT_RAMP.map((s) => ({ ...s })) }, ...o,
})

describe('the shared vectors (the root update timer reads the same file)', () => {
  test('the default ramp and the last bucket are the ones in the file', () => {
    expect(T.defaultRamp).toEqual(DEFAULT_RAMP)
    expect(T.lastBucket).toBe(LAST_BUCKET)
  })
  test('buckets: sha256(salt + install id), first two bytes big-endian, % 100; no install id is the last bucket', () => {
    expect(T.buckets.length).toBeGreaterThanOrEqual(10)
    for (const b of T.buckets) expect({ ...b, got: rolloutBucket(b.salt, b.installId) }).toEqual({ ...b, got: b.bucket })
    // the same arithmetic written out once more, without the module
    for (const b of T.buckets.filter((x) => x.installId)) expect(crypto.createHash('sha256').update(Buffer.from(b.salt + b.installId, 'utf8')).digest().readUInt16BE(0) % 100).toBe(b.bucket)
    expect(rolloutBucket(SALT, null)).toBe(99)
    expect(rolloutBucket(SALT, undefined)).toBe(99)
  })
  test('what a feed\'s rollout reads as: none when it cannot be read, a ramp or since left out; the feed always reads', () => {
    expect(T.reads.length).toBeGreaterThanOrEqual(30)
    const base = { version: '1.0.0', publishedAt: PUBLISHED, bundles: [] }
    for (const c of T.reads) {
      const feed = 'rollout' in c ? { ...base, rollout: c.rollout } : base
      expect({ why: c.why, got: readRollout(c.rollout) ?? null }).toEqual({ why: c.why, got: c.reads })
      // the server feed, the protocol's copy and the office manifest all read it, never refuse it
      expect({ why: c.why, got: readRollout(ReleaseFeed.parse(feed).rollout) ?? null }).toEqual({ why: c.why, got: c.reads })
      expect(ProtocolReleaseFeed.safeParse(feed).success, c.why).toBe(true)
      expect(OfficeRelease.shape.rollout.parse(c.rollout) === undefined, c.why).toBe(c.reads === null)
    }
  })
  test('percent, in the roll-out, and the turn', () => {
    expect(T.cases.length).toBeGreaterThanOrEqual(40)
    for (const c of T.cases) {
      const f = { rollout: readRollout(c.rollout), publishedAt: c.publishedAt, urgent: c.urgent ?? false }
      const o = { now: new Date(c.now), channel: c.channel }
      const t = rolloutTurn(f, c.installId, o)
      const got = { why: c.why, percent: rolloutPercent(f, o), in: inRollout(f, c.installId, o), wait: t.wait, turn: t.wait ? t.at?.toISOString() ?? null : undefined }
      expect(got).toEqual({ why: c.why, percent: c.percent, in: c.in, wait: c.wait, turn: c.wait ? c.turn : undefined })
    }
  })
  test('publishedAt is read as RFC 3339 only (what Go reads too)', () => {
    expect(publishedMs('2026-11-04T01:00:00Z')).toBe(Date.parse(PUBLISHED))
    for (const bad of ['', 'yesterday', '2026-11-04', '2026-11-04 01:00:00Z', '2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z', '2026-11-04T24:00:00Z', '2026-11-04T01:00:60Z', '2026-11-04t01:00:00z', undefined]) expect(publishedMs(bad)).toBeNull()
  })
})

describe('the ramp over three days', () => {
  test('about 10% the first day, 50% the second, everyone from the third', () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `install-${i}`)
    const share = (h: number) => ids.filter((id) => inRollout(ramped(), id, { now: hours(h), channel: 'stable' })).length / ids.length
    expect(share(0)).toBeGreaterThan(0.07); expect(share(0)).toBeLessThan(0.13)
    expect(share(23.9)).toBe(share(0))
    expect(share(24)).toBeGreaterThan(0.45); expect(share(24)).toBeLessThan(0.55)
    expect(share(48)).toBe(1)
    // a server once in stays in (the waves grow)
    for (const id of ids.slice(0, 200)) if (inRollout(ramped(), id, { now: hours(1), channel: 'stable' })) expect(inRollout(ramped(), id, { now: hours(30), channel: 'stable' })).toBe(true)
  })
  test('the turn is the step that reaches the bucket, and the install is in from that moment', () => {
    for (const id of ['install-3', 'install-0', '']) {
      const t = rolloutTurn(ramped(), id, { now: hours(1), channel: 'stable' })
      expect(t.wait).toBe(true)
      const at = (t as { at: Date }).at
      expect(inRollout(ramped(), id, { now: at, channel: 'stable' })).toBe(true)
      expect(inRollout(ramped(), id, { now: new Date(at.getTime() - 1), channel: 'stable' })).toBe(false)
    }
    expect(rolloutTurn(ramped(), 'install-4', { now: hours(1), channel: 'stable' })).toEqual({ wait: false })
  })
  test('urgent and beta skip the ramp; a server without an install id is in the last wave, never left out', () => {
    expect(inRollout(ramped({ urgent: true }), 'install-0', { now: hours(0), channel: 'stable' })).toBe(true)
    expect(inRollout(ramped(), 'install-0', { now: hours(0), channel: 'beta' })).toBe(true)
    expect(inRollout(ramped(), '', { now: hours(47.99), channel: 'stable' })).toBe(false)
    expect(inRollout(ramped(), '', { now: hours(48), channel: 'stable' })).toBe(true)
    expect(inRollout(ramped(), null, { now: hours(24 * 30), channel: 'stable' })).toBe(true)
  })
  test('a feed without a roll-out, or with percent alone, behaves exactly as before', () => {
    // the rule before the ramp (0.4.0-beta.2): sha256(salt + id)[0..2] % 100 < percent, no rollout = everyone
    const before = (f: { rollout?: { percent: number; salt: string } }, id: string) => !f.rollout || crypto.createHash('sha256').update(f.rollout.salt + id).digest().readUInt16BE(0) % 100 < f.rollout.percent
    const ids = Array.from({ length: 300 }, (_, i) => `id-${i}`)
    for (const f of [{}, { rollout: { percent: 0, salt: 'x' } }, { rollout: { percent: 30, salt: 'r1' } }, { rollout: { percent: 100, salt: 's' } }]) {
      for (const id of ids) {
        for (const o of [{ now: hours(0), channel: 'stable' }, { now: hours(100), channel: 'beta' }, undefined]) expect(inRollout({ ...f, publishedAt: PUBLISHED }, id, o)).toBe(before(f, id))
      }
    }
    // the two-argument call of before still works
    expect(inRollout({ rollout: { percent: 30, salt: 'r1' } }, 'install-0')).toBe(before({ rollout: { percent: 30, salt: 'r1' } }, 'install-0'))
  })
})

describe('what the publish scripts write', () => {
  test('a stable release ramps with a new random salt; Rollout: all and beta releases have none', () => {
    const a = newRollout('stable', 'staged')!, b = newRollout('stable', 'staged')!
    expect(a).toMatchObject({ percent: 100, ramp: [...DEFAULT_RAMP] })
    expect(a.salt).toMatch(/^[0-9a-f]{32}$/)
    expect(a.salt).not.toBe(b.salt)
    expect(newRollout('stable', 'all')).toBeUndefined()
    expect(newRollout('beta', 'staged')).toBeUndefined()
    expect(newRollout('beta', 'all')).toBeUndefined()
    expect(rampText(a.ramp!)).toBe('10% → 50% after 24 h → 100% after 48 h')
    // both feed schemas take it, and so does the office manifest
    const feed = ramped({ rollout: a })
    expect(ReleaseFeed.parse(feed).rollout).toEqual(a)
    expect(ProtocolReleaseFeed.parse({ ...feed, publishedAt: PUBLISHED }).rollout).toEqual(a)
    expect(OfficeRelease.shape.rollout.parse(a)).toEqual(a)
  })
})

describe('a burst of releases (inheritRollout, rollout.since)', () => {
  const at = (h: number) => hours(h).toISOString()
  /** what the publish scripts write for a stable release published at hour h after the previous head `prev` */
  const publish = (h: number, prev: ReleaseFeed | null, version: string): ReleaseFeed =>
    ({ ...ramped({ version, publishedAt: at(h) }), rollout: inheritRollout(newRollout('stable', 'staged'), prev, at(h)) })

  test('a release while the previous one still ramps takes over its salt and start; after 48 h a new ramp starts', () => {
    const a = publish(0, null, '1.1.0')
    expect(a.rollout?.since).toBeUndefined()
    const b = publish(12, a, '1.1.1')
    expect(b.rollout).toEqual({ percent: 100, salt: a.rollout!.salt, ramp: [...DEFAULT_RAMP], since: at(0) })
    // a third one inherits the first one's start, not the second one's publishedAt
    const c = publish(40, b, '1.1.2')
    expect(c.rollout).toMatchObject({ salt: a.rollout!.salt, since: at(0) })
    // the first ramp has ended (48 h): its own salt, no since
    const d = publish(48, c, '1.1.3')
    expect(d.rollout?.since).toBeUndefined()
    expect(d.rollout?.salt).not.toBe(a.rollout!.salt)
    // Rollout: all, an urgent or unramped previous head, a beta release: nothing inherited
    expect(inheritRollout(undefined, a, at(1))).toBeUndefined()
    expect(inheritRollout(newRollout('stable', 'staged', 'n'), { ...a, urgent: true }, at(1))?.salt).toBe('n')
    expect(inheritRollout(newRollout('stable', 'staged', 'n'), { ...a, rollout: { percent: 100, salt: 'x' } }, at(1))?.salt).toBe('n')
    expect(inheritRollout(newRollout('stable', 'staged', 'n'), null, at(1))?.salt).toBe('n')
    // what both readers read back is exactly what was written
    expect(readRollout(ReleaseFeed.parse(c).rollout)).toEqual(c.rollout)
    expect(readRollout(ProtocolReleaseFeed.parse(c).rollout)).toEqual(c.rollout)
  })
  test('a burst completes within 48 h of its first release; without inheritance it starves most installs', () => {
    const ids = Array.from({ length: 1000 }, (_, i) => `install-${i}`)
    const share = (f: ReleaseFeed, h: number) => ids.filter((id) => inRollout(f, id, { now: hours(h), channel: 'stable' })).length / ids.length
    let head: ReleaseFeed | null = null
    for (const h of [0, 12, 24, 36]) head = publish(h, head, `1.2.${h}`)
    expect(share(head!, 36)).toBeGreaterThan(0.45) // 36 h after the first: the first's 50% step
    expect(share(head!, 48)).toBe(1)
    // the old way: each release ramps from its own publishedAt, so at 48 h the 36 h release is at its first step
    const alone = ramped({ version: '1.2.36', publishedAt: at(36) })
    expect(share(alone, 48)).toBeLessThan(0.15)
  })
  test('releases every 20 hours for two weeks: every install is at most three days behind; each ramping alone, some never update', () => {
    const ids = Array.from({ length: 400 }, (_, i) => `install-${i}`)
    const release = (inherit: boolean) => {
      const out: ReleaseFeed[] = []
      for (let h = 0, prev: ReleaseFeed | null = null; h < 14 * 24; h += 20) {
        prev = inherit ? publish(h, prev, `2.0.${h}`) : ramped({ version: `2.0.${h}`, publishedAt: at(h), rollout: newRollout('stable', 'staged') })
        out.push(prev)
      }
      return out
    }
    /** hourly checks of every install (the app's own updater); how far behind the oldest-running install gets (hours since
     * the release it runs was published, once the first ramp has ended) and how many never took any release */
    const simulate = (releases: ReleaseFeed[]) => {
      const installed = new Map<string, number>() // the publish hour of the release it runs
      let worst = 0
      for (let h = 0; h < 14 * 24; h++) {
        const head = releases.filter((r) => Date.parse(r.publishedAt) <= hours(h).getTime()).at(-1)!
        const headAt = (Date.parse(head.publishedAt) - hours(0).getTime()) / 3_600_000
        for (const id of ids) {
          if (inRollout(head, id, { now: hours(h), channel: 'stable' })) installed.set(id, headAt)
          if (h >= 48) worst = Math.max(worst, h - (installed.get(id) ?? -48))
        }
      }
      return { worst, never: ids.filter((id) => !installed.has(id)).length }
    }
    const inherited = simulate(release(true))
    expect(inherited.never).toBe(0)
    expect(inherited.worst).toBeLessThanOrEqual(72)
    // the old way: a head every 20 h is never 24 h old, so each release reaches only its own 10%; the reviewer measured a
    // median lag of about five days and 9% not updated after two weeks
    const alone = simulate(release(false))
    expect(alone.never).toBeGreaterThan(ids.length * 0.05)
    expect(alone.worst).toBeGreaterThan(7 * 24)
  })
})

describe('a ramp or rollout that cannot be read never stops an update', () => {
  test('the feed reads, the ramp is left out, percent 100 lets the automatic update go; a rollout that does not read is none', () => {
    const text = JSON.stringify({ ...ramped(), rollout: { percent: 100, salt: SALT, ramp: [{ afterHours: 0, percent: 10 }, { afterHours: 24, percent: 'half' }] } })
    const f = ReleaseFeed.parse(JSON.parse(text))
    expect(readRollout(f.rollout)).toEqual({ percent: 100, salt: SALT })
    const base = { current: '1.0.0', tz: 'UTC', window: '00:00-23:59', running: 0, history: [], channel: 'stable' as const }
    expect(autoUpdateDecision({ ...base, feed: f, installId: 'install-0', now: hours(0) })).toEqual({ go: true, version: '1.1.0' })
    for (const rollout of [null, 'x', { percent: 101, salt: SALT }, { percent: 50 }]) {
      const g = ReleaseFeed.parse(JSON.parse(JSON.stringify({ ...ramped(), rollout })))
      expect(g.rollout).toBeUndefined()
      expect(autoUpdateDecision({ ...base, feed: g, installId: 'install-0', now: hours(0) })).toEqual({ go: true, version: '1.1.0' })
    }
  })
})

describe('older servers and offices (0.4.0-beta.2 and before) with a ramped feed', () => {
  // server/src/system/update.ts ReleaseFeed and inRollout as released up to 0.4.0-beta.2 (git show v0.3.0:...; the same
  // since v0.2.2): a plain z.object, so unknown keys are dropped, and only percent counts
  const OldReleaseFeed = z.object({
    version: z.string(),
    minFrom: z.string().nullable().default(null),
    urgent: z.boolean().default(false),
    needsRoot: z.boolean().default(false),
    notes: z.string().default(''),
    publishedAt: z.string(),
    bundles: z.array(z.object({ os: z.string(), arch: z.string(), url: z.url(), sha256: z.string(), size: z.number().int() })),
    rollout: z.object({ percent: z.number().min(0).max(100), salt: z.string().max(100) }).optional(),
    rootSince: z.string().optional(),
  })
  const oldInRollout = (feed: { rollout?: { percent: number; salt: string } }, installId: string) =>
    !feed.rollout || crypto.createHash('sha256').update(feed.rollout.salt + installId).digest().readUInt16BE(0) % 100 < feed.rollout.percent
  // server/src/office/release.ts OfficeRelease of those versions: also a plain z.object (no rollout)
  const OldOfficeRelease = OfficeRelease.omit({ rollout: true })

  test('the server feed parses; ramp is dropped and percent 100 lets every install take it, as before', () => {
    const text = JSON.stringify({ ...ramped({ rollout: newRollout('stable', 'staged') }), minReaderRequired: 3 }, null, 1) + '\n'
    const old = OldReleaseFeed.parse(JSON.parse(text))
    expect(old.rollout).toEqual({ percent: 100, salt: expect.stringMatching(/^[0-9a-f]{32}$/) })
    expect('ramp' in old.rollout!).toBe(false)
    for (let i = 0; i < 500; i++) expect(oldInRollout(old, `install-${i}`)).toBe(true)
    // the strict parse a newer schema could have done would refuse it: the old one is not strict
    expect(OldReleaseFeed.strict().safeParse(JSON.parse(text)).success).toBe(false)
  })
  test('the office manifest parses too; ramp and rollout are dropped', () => {
    const r = { format: 1, product: OfficeRelease.shape.product.value, channel: 'stable', version: '1.1.0', minFrom: '0.2.0-0', publishedAt: PUBLISHED, notes: '',
      office: [{ arch: 'universal', file: 'x.zip', url: 'https://feed.test/office/1.1.0/x.zip', sha256: 'a'.repeat(64), size: 1 }], windows: null, rollout: newRollout('stable', 'staged') }
    const old = OldOfficeRelease.parse(r)
    expect('rollout' in old).toBe(false)
    expect(OfficeRelease.parse(r).rollout?.ramp).toEqual([...DEFAULT_RAMP])
  })
})

describe('an administrator\'s "update now" (runUpdate) does not wait for the turn', () => {
  test('the third wave on day 1: the release is downloaded and switched to', async () => {
    const f = ramped({ version: '1.1.0' })
    expect(inRollout(f, 'install-0', { now: hours(1), channel: 'stable' })).toBe(false)
    const did: string[] = []
    const updates = {
      checkFeed: async () => f, needsRoot: () => false,
      download: async () => { did.push('download') }, switchTo: async (v: string) => { did.push(`switch ${v}`); return { from: '1.0.0', to: v } },
    } as unknown as UpdateManager
    const backups = { run: async () => { did.push('backup') } } as unknown as BackupManager
    const r = await runUpdate({ updates, backups, running: () => 0, restart: () => did.push('restart'), locale: 'en', sleep: async () => {} }, '1.1.0', { staged: false, rollback: false })
    expect(r).toEqual({ fromVersion: '1.0.0', toVersion: '1.1.0', rolledBack: false })
    expect(did).toEqual(['backup', 'download', 'switch 1.1.0', 'restart'])
  })
})

describe('the app\'s automatic update (autoUpdateDecision)', () => {
  const base = { current: '1.0.0', tz: 'UTC', window: '00:00-23:59', running: 0, history: [], channel: 'stable' as const }
  test('waits for its turn on a stable server; goes on its turn; beta and urgent do not wait', () => {
    expect(autoUpdateDecision({ ...base, feed: ramped(), installId: 'install-3', now: hours(2), channel: 'stable' })).toEqual({ go: false, why: 'rollout' })
    expect(autoUpdateDecision({ ...base, feed: ramped(), installId: 'install-3', now: hours(24), channel: 'stable' })).toEqual({ go: true, version: '1.1.0' })
    expect(autoUpdateDecision({ ...base, feed: ramped(), installId: 'install-4', now: hours(0.1), channel: 'stable' })).toEqual({ go: true, version: '1.1.0' })
    expect(autoUpdateDecision({ ...base, feed: ramped(), installId: 'install-0', now: hours(2), channel: 'beta' })).toEqual({ go: true, version: '1.1.0' })
    expect(autoUpdateDecision({ ...base, feed: ramped({ urgent: true }), installId: 'install-0', now: hours(2), channel: 'stable' })).toEqual({ go: true, version: '1.1.0' })
    // the third wave: day 2 still waits, day 3 goes; ignoreWindow (Admin Home's hold) still sees the roll-out
    expect(autoUpdateDecision({ ...base, feed: ramped(), installId: 'install-0', now: hours(30) })).toEqual({ go: false, why: 'rollout' })
    expect(autoUpdateDecision({ ...base, feed: ramped(), installId: 'install-0', now: hours(30), ignoreWindow: true })).toEqual({ go: false, why: 'rollout' })
    expect(autoUpdateDecision({ ...base, feed: ramped(), installId: 'install-0', now: hours(48) })).toEqual({ go: true, version: '1.1.0' })
  })
  test('the roll-out comes after "not newer" and "needs root", before the window', () => {
    expect(autoUpdateDecision({ ...base, feed: ramped(), installId: 'install-0', now: hours(2), current: '1.1.0' })).toMatchObject({ why: 'up_to_date' })
    expect(autoUpdateDecision({ ...base, feed: ramped({ needsRoot: true }), installId: 'install-0', now: hours(2) })).toMatchObject({ why: 'needs_root' })
    expect(autoUpdateDecision({ ...base, feed: ramped(), installId: 'install-0', now: hours(2), window: '00:00-00:00' })).toMatchObject({ why: 'rollout' })
  })
})
