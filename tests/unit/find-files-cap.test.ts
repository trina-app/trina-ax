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
