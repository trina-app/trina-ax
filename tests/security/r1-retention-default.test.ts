// Security round 1 (sharing-works #6): file versions were swept after 7 days while the admin screen reported 30.
// The sweep and GET /api/admin/settings must read the same value, so what the admin sees is what is kept.
// Fixture: alice = member (marketing), bob = member (finance), carol = admin, dana = owner.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { jsonBody, makeCApp, type CApp } from '../lib/c-app'
import { componentC } from '../../server/src/team-files/component'

let A: CApp
beforeAll(async () => { A = await makeCApp('sec-r1-retention') })
afterAll(async () => { await A.close() })

const DAY = 86_400_000
const q = (o: Record<string, string>) => '?' + new URLSearchParams(o).toString()

/** a file in shared/ with one stored version, backdated `days` days */
async function versionAged(name: string, days: number): Promise<string> {
  const p = `shared/${name}`
  expect((await A.json('/api/files/content', { as: 'alice', ...jsonBody({ path: p, content: 'v1\n', baseSha256: null }, 'PUT') })).status).toBe(200)
  const cur = await A.json('/api/files/content' + q({ path: p }), { as: 'bob' })
  expect((await A.json('/api/files/content', { as: 'bob', ...jsonBody({ path: p, content: 'v2 by bob\n', baseSha256: cur.body.sha256 }, 'PUT') })).status).toBe(200)
  A.ctx.db.query('UPDATE file_versions SET created_at = ? WHERE path = ?').run(new Date(Date.now() - days * DAY).toISOString(), p)
  return p
}
const versions = async (p: string) => (await A.json('/api/files/history' + q({ path: p }), { as: 'alice' })).body.items.length

describe('version retention: one value for the admin screen and the sweep', () => {
  test('with nothing stored, the sweep keeps versions exactly as long as the admin settings say', async () => {
    expect(A.ctx.db.query("SELECT COUNT(*) AS n FROM settings WHERE key = 'fileHistoryRetentionDays'").get()).toEqual({ n: 0 })
    const shown = (await A.json('/api/admin/settings', { as: 'carol' })).body.fileHistoryRetentionDays as number
    expect(shown).toBeGreaterThanOrEqual(1)
    const young = await versionAged('young.md', shown - 0.5)
    const old = await versionAged('old.md', shown + 0.5)
    expect(await versions(young)).toBe(1)
    expect(await versions(old)).toBe(1)
    componentC(A.ctx).sweep()
    expect(await versions(young)).toBe(1) // within what the admin was told is kept
    expect(await versions(old)).toBe(0)
  })

  test('a 10-day-old version survives when the admin keeps 30 days, and goes when they keep 9', async () => {
    expect((await A.json('/api/admin/settings', { as: 'carol', ...jsonBody({ fileHistoryRetentionDays: 30 }, 'PATCH') })).status).toBe(200)
    const p = await versionAged('ten-days.md', 10)
    componentC(A.ctx).sweep()
    expect(await versions(p)).toBe(1)
    expect((await A.json('/api/admin/settings', { as: 'carol', ...jsonBody({ fileHistoryRetentionDays: 9 }, 'PATCH') })).status).toBe(200)
    componentC(A.ctx).sweep()
    expect(await versions(p)).toBe(0)
  })

  test('trash purge dates follow the admin trash setting', async () => {
    expect((await A.json('/api/admin/settings', { as: 'carol', ...jsonBody({ trashRetentionDays: 14 }, 'PATCH') })).status).toBe(200)
    expect((await A.json('/api/files/content', { as: 'alice', ...jsonBody({ path: 'shared/to-trash.md', content: 'x\n', baseSha256: null }, 'PUT') })).status).toBe(200)
    const del = await A.json('/api/files' + q({ path: 'shared/to-trash.md' }), { as: 'alice', method: 'DELETE' })
    expect(del.status).toBe(200)
    const days = (Date.parse(del.body.purgeAt) - Date.now()) / DAY
    expect(days).toBeGreaterThan(13.9)
    expect(days).toBeLessThan(14.1)
  })
})
