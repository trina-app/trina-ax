// The widening list's budget at 10x, by hand (docs/AGENTS/plan/20261114-shared-chats-everywhere.md "Performance
// budget"; the CI bench is tests/unit/b-widening-answers-bench.test.ts at 10,000 answers): a fresh database in a temp
// folder, the same world with 100,000 answers in 500 chats, then the count and the first page 5 times, with the time
// and the number of queries. Made-up data only; nothing outside the temp folder is touched.
//
//   bun scripts/bench/widening-answers.ts [--answers 100000] [--chats 500]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../../server/src/db'
import { RuleSet } from '../../server/src/policy/access'
import { wideningAnswers, type WideningStats } from '../../server/src/chat/widening'
import { buildWideningWorld, countingDb } from '../../tests/lib/widening-world'

const argv = process.argv.slice(2)
const opt = (n: string, d: string) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1]! : d }
const answers = Number(opt('answers', '100000')), chats = Number(opt('chats', '500'))
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'widening-bench-'))
try {
  const db = openDb(path.join(dir, 'bench.db'))
  db.query("INSERT INTO users (id, username, name, role) VALUES ('owner', 'owner', 'Bench Owner', 'owner')").run()
  const t0 = performance.now()
  const world = buildWideningWorld(db, { answers, chats, owner: 'owner' })
  console.log(`world: ${answers} answers in ${chats} chats, built in ${(performance.now() - t0).toFixed(0)} ms`)
  const rules = RuleSet.load(db)
  const counted = countingDb(db)
  for (let i = 0; i < 6; i++) {
    counted.reset()
    const stats: WideningStats = { checks: 0 }
    const t = performance.now()
    const r = wideningAnswers(counted.db, { now: rules, after: rules }, { kind: 'project', projectId: world.projectId }, world.adding, world.viewer, { limit: 20 }, { stats })
    console.log(`${i === 0 ? 'cold' : 'warm'}: ${(performance.now() - t).toFixed(1)} ms, total ${r.total}${r.totalCapped ? '+' : ''}, ${r.items.length} items, ${counted.count()} queries, ${stats.checks} rule checks`)
  }
  db.close()
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}
