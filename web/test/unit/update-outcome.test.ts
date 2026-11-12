// Admin › System › Updates (QA TC-336): Go back is not offered to a version that cannot read the database, the row
// says why, and an update job is "finished" only once the server answers with that version; a Go back that bounced
// says it could not go back (src/lib/updateOutcome.ts, src/pages/admin/jobs.tsx).
import { describe, expect, test } from 'bun:test'
import type { Health, Job } from '@mycel/shared/api'
import { translate } from '../../src/i18n'
import { goBackOffered, releasePaused, updateOutcome } from '../../src/lib/updateOutcome'

const job = (o: Partial<Job> = {}): Job => ({
  id: '01900000-0000-7000-8000-0000000000aa', kind: 'update', status: 'done', progress: 1, message: null,
  result: { fromVersion: '0.5.0', toVersion: '0.4.0', rolledBack: true }, error: null,
  createdAt: '2026-11-12T03:00:00.000Z', finishedAt: '2026-11-12T03:00:01.000Z', ...o,
})
const health = (version: string | null, uptimeSec?: number): Health | null => (version === null ? null : { ok: true, version, time: '2026-11-12T03:00:00.000Z', ...(uptimeSec !== undefined ? { uptimeSec } : {}) })

/** a fake clock and a /api/health that answers from a script, one entry per poll (null: no answer) */
function run(script: (Health | null)[], o: { fetched?: Job; waitMs?: number } = {}) {
  let t = 0, i = 0
  const fetches: string[] = []
  return updateOutcome(job(), {
    now: () => t,
    sleep: async (ms) => { t += ms },
    health: async () => { const h = script[Math.min(i++, script.length - 1)]; if (!h) throw new Error('down'); return h },
    fetchJob: async (id) => { fetches.push(id); return o.fetched ?? job() },
    waitMs: o.waitMs,
  }).then((r) => ({ r, fetches }))
}

describe('Go back is offered only where it can work', () => {
  test('previous that can read the database: offered; one that cannot, the hosted cloud, none: not', () => {
    expect(goBackOffered({ previous: '0.5.0', previousNeedsRestore: false })).toBe(true)
    expect(goBackOffered({ previous: '0.5.0' })).toBe(true) // an older server without the field
    expect(goBackOffered({ previous: '0.4.0', previousNeedsRestore: true })).toBe(false)
    expect(goBackOffered({ previous: '0.4.0', managed: true })).toBe(false)
    expect(goBackOffered({ previous: null })).toBe(false)
  })
  test('the row says plainly why and where to go, in English first and the other languages', () => {
    expect(translate('en', 'system.previousNeedsRestore', { version: '0.4.0' })).toBe('0.4.0 cannot read the database that this version has already updated, so there is no Go back here. To return to 0.4.0, the backup made before the update has to be restored (see the backup and restore guide).')
    for (const l of ['ko', 'id', 'ja', 'es'] as const) {
      const s = translate(l, 'system.previousNeedsRestore', { version: '0.4.0' })
      expect(s).toContain('0.4.0')
      expect(s).not.toBe(translate('en', 'system.previousNeedsRestore', { version: '0.4.0' }))
    }
  })
})

describe('what an update job really did', () => {
  test('the server answers with the version the job named: finished', async () => {
    const { r } = await run([health('0.5.0', 9000), null, health('0.4.0', 3)])
    expect(r).toEqual({ kind: 'ok' })
  })
  test('a Go back that bounced: gone, then back on 0.5.0: the job is read again and its words are used', async () => {
    const failed = job({ status: 'failed', error: { code: 'conflict', message: 'Could not go back to 0.4.0; still on 0.5.0. 0.4.0 cannot read the database that 0.5.0 has already updated.' } })
    const { r, fetches } = await run([health('0.5.0', 9000), null, null, health('0.5.0', 4)], { fetched: failed })
    expect(r).toEqual({ kind: 'not_kept', version: '0.4.0', current: '0.5.0', message: failed.error!.message })
    expect(fetches).toHaveLength(1)
  })
  test('back on 0.5.0 without a gap seen: its uptime is shorter than the wait, so it restarted', async () => {
    const { r } = await run([health('0.5.0', 9000), health('0.5.0', 9002), health('0.5.0', 1)])
    expect(r).toMatchObject({ kind: 'not_kept', message: null })
    expect(translate('en', 'system.updateNotKept', { version: '0.4.0', current: '0.5.0' })).toBe('Could not switch to 0.4.0; still on 0.5.0.')
  })
  test('a missed answer before the restart (the old server, its long uptime) is no bounce', async () => {
    const { r } = await run([null, health('0.5.0', 9000), null, health('0.4.0', 2)])
    expect(r).toEqual({ kind: 'ok' })
  })
  test('without uptime (signed out): a gap, then the old version again, is a bounce', async () => {
    const { r } = await run([health('0.5.0'), null, health('0.5.0')])
    expect(r).toMatchObject({ kind: 'not_kept' })
  })
  test('the old server before its restart is not taken for a bounce; no answer either way: still restarting', async () => {
    const { r } = await run([health('0.5.0', 9000)], { waitMs: 20_000 })
    expect(r).toEqual({ kind: 'restarting' })
  })
  test('a job without a result (an older server): finished as before', async () => {
    const r = await updateOutcome(job({ result: null }), { health: async () => { throw new Error('not asked') }, fetchJob: async () => job() })
    expect(r).toEqual({ kind: 'ok' })
  })
})

describe('a paused release (QA TC-361)', () => {
  test('only the publisher\'s pause counts: Home and System offer no install then', () => {
    expect(releasePaused({ hold: 'paused' })).toBe(true)
    for (const hold of [undefined, null, 'rollout', 'failed', 'root_failed'] as const) expect(releasePaused({ hold }), String(hold)).toBe(false)
  })
})
