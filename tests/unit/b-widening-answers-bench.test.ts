// The widening list's budget (the owner, 2026-11-14; docs/AGENTS/plan/20261114-shared-chats-everywhere.md
// "Performance budget"): the warning's count plus the list's first page in under 300 ms on a project with 10,000 shared
// answers in 50 chats (the median of 5 warm runs), with at most 3 SQL queries and each place checked at most once per
// person set (the new people, the adder). Fails over budget. The timing is skipped only on a known slow runner
// (CI_SLOW_RUNNER=1); the query and check counts are always asserted. 10x by hand: scripts/bench/widening-answers.ts.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { startHarness, type Harness } from '../lib/b-harness'
import { buildWideningWorld, countingDb, type WideningWorld } from '../lib/widening-world'
import { RuleSet } from '../../server/src/policy/access'
import { wideningAnswers, type WideningStats } from '../../server/src/chat/widening'
import { sourceKey } from '../../server/src/chat/read-scope'

setDefaultTimeout(120_000)
const BUDGET_MS = 300
let h: Harness
let world: WideningWorld
beforeAll(async () => {
  h = await startHarness({ name: 'b-widening-answers-bench' })
  world = buildWideningWorld(h.ctx.db, { answers: 10_000, owner: 'alice' })
})
afterAll(async () => { await h.close() })

const run = (db = h.ctx.db, stats?: WideningStats) => {
  const rules = RuleSet.load(h.ctx.db)
  return wideningAnswers(db, { now: rules, after: rules }, { kind: 'project', projectId: world.projectId }, world.adding, world.viewer, { limit: 20 }, { stats })
}

test('the count and the first page: at most 3 queries, each place checked once per person set', () => {
  // warm (the cutover is read once per database, then kept)
  const counted = countingDb(h.ctx.db)
  run(counted.db)
  counted.reset()
  const stats: WideningStats = { checks: 0 }
  const r = run(counted.db, stats)
  expect(r.total).toBeGreaterThan(1000)
  expect(r.items).toHaveLength(20)
  expect(r.nextRowid).not.toBeNull()
  expect(counted.count()).toBeLessThanOrEqual(3)
  const places = new Set(world.places.map(sourceKey)).size
  expect(stats.checks).toBeLessThanOrEqual(places * 2)
})

test(`the count and the first page within ${BUDGET_MS} ms (median of 5 warm runs, 10,000 answers in 50 chats)`, () => {
  run()
  const times: number[] = []
  for (let i = 0; i < 5; i++) { const t = performance.now(); run(); times.push(performance.now() - t) }
  const median = times.sort((a, b) => a - b)[2]!
  console.log(`widening-answers bench: median ${median.toFixed(1)} ms (${times.map((x) => x.toFixed(0)).join(', ')})`)
  if (process.env.CI_SLOW_RUNNER === '1') return
  expect(median).toBeLessThan(BUDGET_MS)
})
