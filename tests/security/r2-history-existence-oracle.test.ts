// Security regression (round 2, files-http): GET /api/files/history was an existence oracle for entries hidden from
// the caller. history() asked authorize('read', {mustExist:false}); for a path that does not exist that ran the
// near-duplicate name scan (meant only for creating a new name), so a hidden sibling with the same fold key answered
// 404 while any other missing name answered 200 {items:[]}. The exact hidden name and a case variant (on a
// case-insensitive volume the walk resolves it to the hidden entry) were refused as "no access" (404) as well. A read
// route needs only READ on the parent, so alice could confirm skills/performance-reviews (a 'none' folder an admin put
// under the everyone-read skills/) or groups/marketing/salaries without seeing them anywhere.
// Now the scan runs only for writes, and history answers every path that is not an existing entry the caller may read
// the same way: the version rows of that path they may read, else the plain 404 of content/download (hidden, missing,
// look-alike, case variant, a file below any of them, hidden files that do have versions).
// Fixture: alice = member of marketing (skills/ read-only, groups/marketing write, salaries/ and groups/finance none);
// carol = admin; dana = owner.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { jsonBody, makeCApp, type CApp } from '../lib/c-app'

let A: CApp
beforeAll(async () => {
  A = await makeCApp('sec-r2-history-oracle')
  // an admin-made 'none' folder under the everyone-read skills/ (alice: read-only parent)
  const r = await A.json('/api/admin/folders', { as: 'dana', ...jsonBody({ path: 'skills/performance-reviews', create: true, rules: [
    { subjectType: 'everyone', subjectId: null, access: 'none' }, { subjectType: 'user', subjectId: 'carol', access: 'write' }] }) })
  expect(r.status).toBeLessThan(300)
  fs.writeFileSync(path.join(A.team, 'skills', 'performance-reviews', 'q3.md'), 'secret review\n')
  // the hidden files get versions of their own (saved by carol, who may see them)
  for (const p of ['skills/performance-reviews/q3.md', 'groups/marketing/salaries/2026.md']) await save('carol', p, `edited by carol: ${p}\n`)
})
afterAll(async () => { await A.close() })

const sha = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(path.join(A.team, p))).digest('hex')
async function save(as: 'alice' | 'carol', p: string, content: string) {
  const r = await A.json('/api/files/content', { as, ...jsonBody({ path: p, content, baseSha256: sha(p) }, 'PUT') })
  expect(r.status).toBe(200)
}
const hist = (p: string, as: 'alice' | 'carol' = 'alice') => A.json('/api/files/history?path=' + encodeURIComponent(p), { as })
// the 404 body without its per-request id
const same = (r: { status: number; body: any }) => ({ status: r.status, body: r.body?.error ? { ...r.body, error: { ...r.body.error, requestId: undefined } } : r.body })

// [parent, the hidden entry's real name, probes that point at it, a name that does not exist]
const CASES: [string, string, string[], string][] = [
  ['skills', 'performance-reviews', ['performance-reviews', 'Performance-Reviews', 'PERFORMANCE-REVIEWS', 'performance-reviewſ' /* long s: NFKC 's' */, 'ｐerformance-reviews' /* fullwidth p */], 'performance-reviewz'],
  ['groups/marketing', 'salaries', ['salaries', 'Salaries', 'ſalaries', 'ⓢalaries'], 'zalaries'],
  ['groups', 'finance', ['finance', 'FINANCE', 'ﬁnance' /* fi ligature */], 'fynance'],
]

describe('history answers a hidden path exactly like one that does not exist', () => {
  test('setup: the hidden entries are not in alice\'s tree, she may not write in skills/, carol sees them', async () => {
    for (const [parent, real] of CASES) {
      const t = await A.json('/api/files/tree?path=' + encodeURIComponent(parent), { as: 'alice' })
      expect(t.status).toBe(200)
      expect(JSON.stringify(t.body)).not.toContain(`"${real}"`)
    }
    expect((await A.json('/api/files/mkdir', { as: 'alice', ...jsonBody({ path: 'skills/xtest' }) })).status).toBe(403)
    expect((await hist('skills/performance-reviews/q3.md', 'carol')).body.items.length).toBeGreaterThan(0)
    expect((await hist('groups/marketing/salaries/2026.md', 'carol')).body.items.length).toBeGreaterThan(0)
  })

  for (const [parent, real, probes, missing] of CASES) {
    test(`${parent}/: exact name, case variants and look-alikes of '${real}' (also a file below them) match '${missing}'`, async () => {
      for (const below of ['', '/q3.md', '/2026.md']) {
        const control = same(await hist(`${parent}/${missing}${below}`))
        expect(control.status).toBe(404)
        expect(control.body.error.code).toBe('not_found')
        for (const probe of probes) {
          const p = `${parent}/${probe}${below}`
          const r = await hist(p)
          expect({ p, ...same(r) }).toEqual({ p, ...control })
          // the hidden spelling never comes back unless alice typed it herself
          if (probe !== real) expect(JSON.stringify(r.body)).not.toContain(real)
        }
      }
    })
  }

})

describe('history still works for the people it is meant for', () => {
  test('alice sees the versions of a shared file (any spelling that resolves to it)', async () => {
    await save('alice', 'shared/edit-me.md', '# Shared plan\nStatus: v2\n')
    await save('alice', 'shared/edit-me.md', '# Shared plan\nStatus: v3\n')
    const r = await hist('shared/edit-me.md')
    expect(r.status).toBe(200)
    expect(r.body.path).toBe('shared/edit-me.md')
    expect(r.body.items.length).toBeGreaterThanOrEqual(2)
    if (fs.existsSync(path.join(A.team, 'SHARED'))) { // case-insensitive volume: the actual spelling is answered
      const c = await hist('Shared/Edit-Me.md')
      expect(c.body.path).toBe('shared/edit-me.md')
      expect(c.body.items.length).toBe(r.body.items.length)
    }
  })

  test('the history of a deleted file the caller may read is still listed', async () => {
    const n = (await hist('shared/edit-me.md')).body.items.length
    expect((await A.json('/api/files?path=' + encodeURIComponent('shared/edit-me.md'), { as: 'alice', method: 'DELETE', headers: { 'x-mycel-csrf': '1' } })).status).toBeLessThan(300)
    const r = await hist('shared/edit-me.md')
    expect(r.status).toBe(200)
    expect(r.body.items.length).toBe(n)
  })

  test('an existing file alice may read without versions: 200 with no items', async () => {
    expect((await hist('skills/team-rules.md')).body).toEqual({ path: 'skills/team-rules.md', items: [] })
  })

  test('carol (may read salaries/) gets its versions; for alice the same path is a missing one', async () => {
    expect((await hist('groups/marketing/salaries/2026.md', 'carol')).body.items.length).toBeGreaterThan(0)
    expect(same(await hist('groups/marketing/salaries/2026.md'))).toEqual(same(await hist('groups/marketing/zalaries/2026.md')))
  })
})
