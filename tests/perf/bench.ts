// grep/glob benchmark on a 20k-file tree as user alice. Target (design): < 1 s per query. Removes the tree after.
import fs from 'node:fs'
import path from 'node:path'
import { openDb } from '../../server/src/db'
import { defaultConfig } from '../../server/src/config'
import { FileService, TurnFiles } from '../../server/src/files/service'
import { RuleSet } from '../../server/src/policy/access'
import { allowedRoots } from '../../server/src/files/search'
import { seed, CANARY_RE } from '../lib/fixtures'
import { WORK } from '../lib/env'
import { genBig } from './gen-big'

export async function runBench(reps = 5, keep = false) {
  const base = path.join(WORK, 'bench20k')
  fs.rmSync(base, { recursive: true, force: true })
  const team = path.join(base, 'team'), data = path.join(base, 'data')
  fs.mkdirSync(team, { recursive: true }); fs.mkdirSync(data, { recursive: true })
  const gen = genBig(team)
  const cfg = defaultConfig({ teamRoot: team, dataDir: data })
  const db = openDb(path.join(data, 'app.db')); seed(db)
  const files = new FileService(db, cfg)
  const user = files.principal('alice')
  const ctx = { user, turnId: 'bench', files: new TurnFiles() }
  // office text is extracted at upload/change time in production; warm it here (timed separately)
  const t0 = performance.now()
  const rules = RuleSet.load(db)
  const { roots, excludes } = allowedRoots(files.fx, rules, user, [])
  await files.office.refresh(cfg.rg, roots, excludes, (rel) => fs.lstatSync(path.join(team, rel)), { budget: 100000 })
  const indexMs = Math.round(performance.now() - t0)
  const big = (() => { let best = '', bs = 0; const w = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) w(p); else if (p.endsWith('.md')) { const s = fs.statSync(p).size; if (s > bs) { bs = s; best = p } } } }; w(path.join(team, 'shared/area00')); return path.relative(team, best) })()
  const Q: [string, string, any][] = [
    ['literal', 'grep', { pattern: 'INVOICE-2026', output_mode: 'content' }],
    ['regex alternation', 'grep', { pattern: 'INVOICE-2026-\\d{5} (approved|rejected)|Falcon (kickoff|budget)', output_mode: 'content' }],
    ['case-insensitive', 'grep', { pattern: 'project falcon', '-i': true, output_mode: 'content' }],
    ['glob *.md', 'grep', { pattern: 'Falcon', glob: '*.md', output_mode: 'content' }],
    ['context -C2', 'grep', { pattern: 'INVOICE-2026', output_mode: 'content', '-C': 2 }],
    ['files_with_matches', 'grep', { pattern: 'Falcon', head_limit: 5000 }],
    ['count', 'grep', { pattern: 'Falcon', output_mode: 'count', head_limit: 5000 }],
    ['many hits (capped 200)', 'grep', { pattern: '회의', output_mode: 'content' }],
    ['many hits -C5 cap 2000', 'grep', { pattern: '회의 결정', output_mode: 'content', '-C': 5, head_limit: 2000 }],
    ['no match', 'grep', { pattern: 'ZZZ_NOT_THERE_42', output_mode: 'content' }],
    ['canary (hidden areas)', 'grep', { pattern: 'CANARY-(FIN|BOB)', output_mode: 'content' }],
    ['subfolder', 'grep', { pattern: 'Falcon', path: 'groups/marketing', output_mode: 'content' }],
    ['office text', 'grep', { pattern: 'Falcon budget line', output_mode: 'files_with_matches' }],
    ['glob **/*.md', 'glob', { pattern: '**/*.md' }],
    ['read ~200KB', 'read', { file_path: big }],
  ]
  const rows: any[] = []
  for (const [label, tool, args] of Q) {
    const times: number[] = []; let last: any
    for (let r = 0; r < reps + 1; r++) { const t = performance.now(); last = await files.call(tool, args, ctx); times.push(performance.now() - t) }
    const warm = times.slice(1).sort((a, b) => a - b)
    rows.push({ label, first_ms: Math.round(times[0]), median_ms: Math.round(warm[Math.floor(warm.length / 2)]), max_ms: Math.round(warm[warm.length - 1]),
      lines: last.text.split('\n').length, error: !!last.isError, leak: CANARY_RE.test(last.text) || /^(groups\/finance|users\/bob|projects\/atlas|shared\/link-to-finance)/m.test(last.text) })
  }
  db.close()
  if (!keep) fs.rmSync(base, { recursive: true, force: true })
  return { gen, indexMs, rows, worstMedianMs: Math.max(...rows.map((r) => r.median_ms)), worstMs: Math.max(...rows.map((r) => r.max_ms)), leaks: rows.filter((r) => r.leak).length, errors: rows.filter((r) => r.error).length }
}

if (import.meta.main) {
  const r = await runBench(+(process.argv[2] ?? 5), process.argv.includes('--keep'))
  console.log(JSON.stringify(r.gen), 'office index ms', r.indexMs)
  console.table(r.rows)
  console.log(JSON.stringify({ worstMedianMs: r.worstMedianMs, worstMs: r.worstMs, leaks: r.leaks, errors: r.errors }))
  process.exit(r.worstMs < 1000 && !r.leaks && !r.errors ? 0 : 1)
}
