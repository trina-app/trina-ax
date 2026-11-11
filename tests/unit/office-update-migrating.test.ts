// The office Mac's updater waits for a version that updates a large database before it starts (QA TC-278 follow-up):
// /api/health 503 {status: "migrating", version} keeps the wait going, bounded like a Linux server's bootstrap
// (--migrate-timeout). server/src/office/health.ts, update.ts waitVersion.
import { afterAll, describe, expect, test } from 'bun:test'
import { healthAnswer, isMigrating, MIGRATE_WAIT_MS, probeHealth, type HealthAnswer } from '../../server/src/office/health'
import { HEALTH_WAIT_MS, waitVersion, type UpdateDeps } from '../../server/src/office/update'

describe('healthAnswer', () => {
  test('answers, migrating (with progress) and no answer', () => {
    expect(healthAnswer(200, { ok: true, version: '0.3.0' })).toBe('0.3.0')
    expect(healthAnswer(503, { ok: false, status: 'migrating', version: '0.3.0', migrating: { pending: 2, copiedBytes: 3 << 20, dbBytes: 8 << 20 } }))
      .toEqual({ migrating: '0.3.0', progress: '2 migrations pending, copy before migrating 3 of 8 MB' })
    expect(healthAnswer(503, { ok: false, status: 'migrating', version: '0.3.0' })).toEqual({ migrating: '0.3.0', progress: '' })
    // through the tunnel a stand-in answers without version: not usable for a wait on 127.0.0.1
    expect(healthAnswer(503, { ok: false, status: 'migrating' })).toBeNull()
    expect(healthAnswer(503, { ok: false, version: '0.3.0' })).toBeNull()
    expect(healthAnswer(500, { error: 'x' })).toBeNull()
    expect(healthAnswer(200, null)).toBeNull()
    expect(isMigrating('0.3.0')).toBe(false)
    expect(isMigrating(null)).toBe(false)
  })

  const port = 19821
  const server = Bun.serve({
    hostname: '127.0.0.1', port,
    fetch: () => Response.json({ ok: false, status: 'migrating', version: '0.3.0', migrating: { since: 'x', pending: 1, copiedBytes: 0, dbBytes: 1 << 20 } }, { status: 503 }),
  })
  afterAll(() => server.stop(true))
  test('probeHealth reads a 503 "migrating" answer', async () => {
    expect(await probeHealth(port)).toEqual({ migrating: '0.3.0', progress: '1 migrations pending, copy before migrating 0 of 1 MB' })
    expect(await probeHealth(19822)).toBeNull() // nothing listens
  })
})

/** a fake clock; health(t) says what the server answers t ms after the wait began */
function deps(health: (t: number) => HealthAnswer) {
  const t0 = 1_000_000
  let t = t0
  const logs: string[] = []
  const d = {
    health: async () => health(t - t0),
    sleep: async (ms: number) => { t += ms },
    now: () => new Date(t),
    log: (l: string) => { logs.push(l) },
  } as unknown as UpdateDeps
  return { d, logs, elapsed: () => t - t0 }
}
const MIN = 60_000
const mig = (v: string): HealthAnswer => ({ migrating: v, progress: '' })

describe('waitVersion while the new version updates its database', () => {
  test('a 20-minute migration is waited for (the 150 s wait alone would roll it back), progress once a minute', async () => {
    const f = deps((t) => (t < 20 * MIN ? mig('0.3.0') : '0.3.0'))
    const r = await waitVersion(4000, '0.3.0', f.d, HEALTH_WAIT_MS)
    expect(r).toEqual({ version: '0.3.0', sawMigrating: true, stillMigrating: false })
    expect(f.elapsed()).toBeGreaterThanOrEqual(20 * MIN)
    expect(f.logs.length).toBeGreaterThanOrEqual(19)
    expect(f.logs.length).toBeLessThanOrEqual(21)
    expect(f.logs[0]).toContain('0.3.0 is updating its database')
  })

  test('migrating forever is bounded: no more time after MIGRATE_WAIT_MS', async () => {
    const f = deps(() => mig('0.3.0'))
    const r = await waitVersion(4000, '0.3.0', f.d, HEALTH_WAIT_MS)
    expect(r).toEqual({ version: null, sawMigrating: true, stillMigrating: true })
    expect(f.elapsed()).toBeGreaterThanOrEqual(MIGRATE_WAIT_MS)
    expect(f.elapsed()).toBeLessThanOrEqual(MIGRATE_WAIT_MS + 5000)
    // its own bound (tests and RunOptions.migrateWaitMs)
    const g = deps(() => mig('0.3.0'))
    await waitVersion(4000, '0.3.0', g.d, 10_000, 30_000)
    expect(g.elapsed()).toBeGreaterThanOrEqual(30_000)
    expect(g.elapsed()).toBeLessThan(35_000)
  })

  test('after the migration the start gets the usual wait, then the wait ends', async () => {
    const f = deps((t) => (t < 10 * MIN ? mig('0.3.0') : null))
    const r = await waitVersion(4000, '0.3.0', f.d, HEALTH_WAIT_MS)
    expect(r).toEqual({ version: null, sawMigrating: true, stillMigrating: false })
    expect(f.elapsed()).toBeGreaterThanOrEqual(10 * MIN + HEALTH_WAIT_MS - 2000)
    expect(f.elapsed()).toBeLessThanOrEqual(10 * MIN + HEALTH_WAIT_MS + 2000)
  })

  test('another version saying migrating, or no answer, gets only the health wait', async () => {
    const f = deps(() => mig('0.2.0'))
    expect(await waitVersion(4000, '0.3.0', f.d, HEALTH_WAIT_MS)).toEqual({ version: null, sawMigrating: false, stillMigrating: false })
    expect(f.elapsed()).toBeLessThanOrEqual(HEALTH_WAIT_MS + 2000)
    const g = deps(() => '0.2.0')
    expect((await waitVersion(4000, '0.3.0', g.d, HEALTH_WAIT_MS)).version).toBe('0.2.0')
    expect(g.elapsed()).toBeLessThanOrEqual(HEALTH_WAIT_MS + 2000)
  })
})
