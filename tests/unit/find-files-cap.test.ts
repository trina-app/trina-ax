// File-name find on a big folder (team-files/find.ts findFiles): the permission check of every name that matches
// (visiblePath) runs in chunks with the event loop free in between, at most HIT_CAP files are kept, and every path it
// lists still passed visiblePath (QA TC-277: 5,000 checks in one go stalled every request for 60-400 ms).
import { afterAll, beforeAll, expect, setDefaultTimeout, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { startHarness, type Harness } from '../lib/b-harness'
import { componentC } from '../../server/src/team-files/component'
import { CHECK_CHUNK, HIT_CAP, findFiles } from '../../server/src/team-files/find'
import * as authorize from '../../server/src/policy/authorize'
import * as search from '../../server/src/files/search'
const { visiblePath } = authorize

setDefaultTimeout(60_000)
let h: Harness
// under the name cap (2 x HIT_CAP), so every matching name is checked whatever order ripgrep lists them in
const BULK = 1800
const write = (rel: string, s = 'x\n') => { const p = path.join(h.team, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s) }
const userId = (name: string) => (h.ctx.db.query('SELECT id FROM users WHERE username = ?').get(name) as { id: string }).id
const future = new Date(Date.now() + 86_400_000)
const origVisible = authorize.visiblePath

beforeAll(async () => {
  h = await startHarness({ name: 'find-files-cap' })
  for (let i = 0; i < BULK; i++) write(`shared/bulk/d${i % 26}/bulkname-${i}.md`)
  // newest of all, so the sort would put them first: none may ever be listed for alice
  write('groups/finance/bulkname-secret.md'); write('groups/marketing/salaries/bulkname-pay.md'); write('users/bob/bulkname-bob.md')
  fs.linkSync(path.join(h.team, 'groups/finance/bulkname-secret.md'), path.join(h.team, 'users/alice/bulkname-link.md'))
  for (const r of ['groups/finance/bulkname-secret.md', 'groups/marketing/salaries/bulkname-pay.md', 'users/bob/bulkname-bob.md', 'users/alice/bulkname-link.md'])
    fs.utimesSync(path.join(h.team, r), future, future)
  write('users/alice/bulkname-mine.md'); fs.utimesSync(path.join(h.team, 'users/alice/bulkname-mine.md'), future, future)
})
afterAll(async () => { await h.close() })

test('a broad name search on a big folder: newest readable first, truncated, nothing the caller cannot read', async () => {
  const files = componentC(h.ctx).files
  const alice = userId('alice')
  const r = await findFiles(files, alice, 'bulkname', '', 100)
  expect(r.items).toHaveLength(100)
  expect(r.truncated).toBe(true)
  const paths = r.items.map((i) => i.path)
  expect(paths[0]).toBe('users/alice/bulkname-mine.md')
  for (const p of ['groups/finance/bulkname-secret.md', 'groups/marketing/salaries/bulkname-pay.md', 'users/bob/bulkname-bob.md', 'users/alice/bulkname-link.md'])
    expect(paths).not.toContain(p)
  // every listed path passes the same check as the file screen
  const user = files.principal(alice), rules = files.rules()
  for (const p of paths) expect(visiblePath(files.fx, rules, user, p), p).toBeTruthy()
  // bob sees his own file, the same search
  expect((await findFiles(files, userId('bob'), 'bulkname-bob', '', 10)).items.map((i) => i.path)).toEqual(['users/bob/bulkname-bob.md'])
})

test('the newest readable file wins even when ripgrep lists it after the first HIT_CAP names', async () => {
  const files = componentC(h.ctx).files
  const origRg = search.runRg
  // list the names in a fixed order with the newest file last (ripgrep's own order is not fixed)
  const spy = spyOn(search, 'runRg').mockImplementation(async (rg, args, cwd, sep, onRecord, timeoutMs, o) => {
    const recs: string[] = []
    const r = await origRg(rg, args, cwd, sep, (rec) => { recs.push(rec) }, timeoutMs, o)
    const last = (x: string) => x.includes('bulkname-mine') ? 1 : 0
    for (const rec of recs.sort((a, b) => last(a) - last(b) || a.localeCompare(b))) if (onRecord(rec) === false) break
    return r
  })
  try {
    const r = await findFiles(files, userId('alice'), 'bulkname', '', 100)
    expect(r.items[0]!.path).toBe('users/alice/bulkname-mine.md')
    expect(r.items).toHaveLength(100)
    expect(r.truncated).toBe(true)
    // all of them fit under the limit: nothing is cut and the newest is still first
    const all = await findFiles(files, userId('alice'), 'bulkname', '', HIT_CAP + 100)
    expect(all.items).toHaveLength(HIT_CAP)
    expect(all.items[0]!.path).toBe('users/alice/bulkname-mine.md')
    expect(all.truncated).toBe(true)
  } finally { spy.mockRestore() }
})

test('the checks run in chunks: at most CHECK_CHUNK permission checks between two turns of the event loop', async () => {
  expect(HIT_CAP).toBeLessThanOrEqual(1000)
  const files = componentC(h.ctx).files
  let sinceTick = 0, most = 0, total = 0, done = false
  const spy = spyOn(authorize, 'visiblePath').mockImplementation((...a: Parameters<typeof visiblePath>) => {
    sinceTick++; total++; most = Math.max(most, sinceTick)
    return origVisible(...a)
  })
  const spin = () => { sinceTick = 0; if (!done) setImmediate(spin) }
  setImmediate(spin)
  try {
    const r = await findFiles(files, userId('alice'), 'bulkname', '', 50)
    expect(r.items).toHaveLength(50)
  } finally { done = true; spy.mockRestore() }
  expect(total).toBeGreaterThanOrEqual(HIT_CAP)
  expect(most).toBeLessThanOrEqual(CHECK_CHUNK)
})

test('a narrow search is unchanged: exact matches, not truncated', async () => {
  const r = await findFiles(componentC(h.ctx).files, userId('alice'), 'bulkname-1799', '', 50)
  expect(r).toMatchObject({ truncated: false })
  expect(r.items.map((i) => i.path)).toEqual(['shared/bulk/d5/bulkname-1799.md'])
})

test('a typing mistake in any word: near names when none holds every word, the closest first, still only what the caller reads', async () => {
  const files = componentC(h.ctx).files
  const alice = userId('alice'), bob = userId('bob')
  write('shared/near/Quarterly report budget.xlsx'); write('shared/near/Quarterly budget reports.xlsx'); write('shared/near/견적서 Sincere.pdf')
  write('shared/near/Marketing plans/readme.md'); write('groups/finance/Quarterly report secret.xlsx')
  const find = async (who: string, q: string, folders = false) => (await findFiles(files, who, q, '', 20, { folders })).items.map((i) => i.path)
  // the first, the middle and the last word
  for (const q of ['qaurterly report budget', 'quarterly reprot budget', 'quarterly report budgte']) expect(await find(alice, q), q).toEqual(['shared/near/Quarterly report budget.xlsx', 'shared/near/Quarterly budget reports.xlsx'])
  // Korean and English together, a mistake in either
  expect(await find(alice, '견적서 sincre')).toEqual(['shared/near/견적서 Sincere.pdf'])
  expect(await find(alice, '견젹서 sincere')).toEqual(['shared/near/견적서 Sincere.pdf'])
  // exact names first, then a word's start, then near: "report" whole beats "reports"
  expect((await find(alice, 'quarterly report budgte'))[0]).toBe('shared/near/Quarterly report budget.xlsx')
  // folders too
  expect(await find(alice, 'marketng plans', true)).toContain('shared/near/Marketing plans')
  // a name the caller cannot read is never listed, near or not; its owner's group finds it
  expect(await find(alice, 'quarterly reprot secret')).toEqual([])
  expect(await find(bob, 'quarterly reprot secret')).toEqual(['groups/finance/Quarterly report secret.xlsx'])
  // names that hold every word as typed: no near names with them; whole words before a word's start, then the newest
  expect(await find(alice, 'quarterly report budget')).toEqual(['shared/near/Quarterly report budget.xlsx', 'shared/near/Quarterly budget reports.xlsx'])
  expect(await find(alice, 'budget quarterly')).toEqual(['shared/near/Quarterly budget reports.xlsx', 'shared/near/Quarterly report budget.xlsx'])
  // short words are never near
  expect(await find(alice, 'quartrly rpt')).toEqual([])
  // on the big folder (1,800 names and more): a near search of every name
  const t = performance.now()
  expect((await find(alice, 'bulknmae-mine')).length).toBe(0)
  expect(await find(alice, 'bulknmae mine')).toEqual(['users/alice/bulkname-mine.md'])
  console.log(`near name search of ${BULK}+ names: ${(performance.now() - t).toFixed(0)} ms`)
})
