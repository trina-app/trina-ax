// File version history (fix/prod-ops): every stored version is an earlier content of the file, so the newest one can
// be restored too (the web only offered restore below the newest and treated the newest as "the current file").
// GET /api/files/history now says what the file is now (currentSha256) and whether the caller may restore
// (canRestore = write access, the same rule POST /api/files/restore applies). Permission rules are unchanged.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { jsonBody, makeCApp, sha256hex, type CApp } from '../lib/c-app'

// the app setup (database, migrations, team folder, server) takes seconds on a busy machine: room for it and the cases
setDefaultTimeout(30_000)

let A: CApp
beforeAll(async () => { A = await makeCApp('c-history-restore') })
afterAll(async () => { await A.close() })
const q = (o: Record<string, string>) => '?' + new URLSearchParams(o).toString()
const read = (rel: string) => fs.readFileSync(path.join(A.team, rel), 'utf8')

describe('history: restore any version', () => {
  const p = 'projects/falcon/plan-v.md' // alice writes here, bob (finance) only reads
  test('the newest version restores; history marks what the file is now; readers may not restore', async () => {
    fs.writeFileSync(path.join(A.team, p), 'one')
    const save = (content: string, base: string) => A.json('/api/files/content', { ...jsonBody({ path: p, content, baseSha256: sha256hex(base) }, 'PUT'), as: 'alice' })
    expect((await save('two', 'one')).status).toBe(200)
    expect((await save('three', 'two')).status).toBe(200)

    const h = await A.json('/api/files/history' + q({ path: p }), { as: 'alice' })
    expect(h.status).toBe(200)
    expect(h.body.items.map((v: any) => v.version)).toEqual([2, 1])
    expect(h.body.currentSha256).toBe(sha256hex('three'))
    expect(h.body.canRestore).toBe(true)
    // no listed version is the current content: each one can be restored, the newest (v2 = "two") included
    expect(h.body.items.some((v: any) => v.sha256 === h.body.currentSha256)).toBe(false)
    const newest = h.body.items[0]
    expect(newest.sha256).toBe(sha256hex('two'))
    const r = await A.json('/api/files/restore', { ...jsonBody({ path: p, versionId: newest.id }), as: 'alice' })
    expect(r.status).toBe(200)
    expect(read(p)).toBe('two')

    // what was current ("three") is kept as a restore version; v2 is now the same as the file
    const h2 = await A.json('/api/files/history' + q({ path: p }), { as: 'alice' })
    expect(h2.body.currentSha256).toBe(sha256hex('two'))
    expect(h2.body.items.map((v: any) => [v.version, v.kind])).toEqual([[3, 'restore'], [2, 'edit'], [1, 'edit']])
    expect(h2.body.items.filter((v: any) => v.sha256 === h2.body.currentSha256).map((v: any) => v.version)).toEqual([2])
    // the oldest one still restores
    const v1 = h2.body.items.find((v: any) => v.version === 1)
    expect((await A.json('/api/files/restore', { ...jsonBody({ path: p, versionId: v1.id }), as: 'alice' })).status).toBe(200)
    expect(read(p)).toBe('one')

    // bob reads projects/falcon: he sees the history and may download, but not restore (permission rules unchanged)
    const hb = await A.json('/api/files/history' + q({ path: p }), { as: 'bob' })
    expect(hb.status).toBe(200)
    expect(hb.body.canRestore).toBe(false)
    expect(hb.body.items.length).toBeGreaterThan(0)
    expect((await A.req(`/api/files/history/${hb.body.items[0].id}/download`, { as: 'bob' })).status).toBe(200)
    const denied = await A.json('/api/files/restore', { ...jsonBody({ path: p, versionId: hb.body.items[0].id }), as: 'bob' })
    expect([403, 404]).toContain(denied.status)
    expect(read(p)).toBe('one')
  })

  test('a file that no longer exists: currentSha256 is null and its versions can be restored back', async () => {
    const p2 = 'shared/gone-v.md'
    fs.writeFileSync(path.join(A.team, p2), 'a')
    await A.json('/api/files/content', { ...jsonBody({ path: p2, content: 'b', baseSha256: sha256hex('a') }, 'PUT'), as: 'alice' })
    fs.rmSync(path.join(A.team, p2))
    const h = await A.json('/api/files/history' + q({ path: p2 }), { as: 'alice' })
    expect(h.status).toBe(200)
    expect(h.body.currentSha256).toBeNull()
    expect(h.body.canRestore).toBe(true)
    expect((await A.json('/api/files/restore', { ...jsonBody({ path: p2, versionId: h.body.items[0].id }), as: 'alice' })).status).toBe(200)
    expect(read(p2)).toBe('a')
  })
})
