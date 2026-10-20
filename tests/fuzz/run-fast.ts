// Fast fuzz for CI: path fuzzer in-process and through the real socket path (gate + launcher + bridge), and the
// ReDoS guard. Exit 1 on any failure. (The full stage-1 run adds the 20k-file benchmark and the Linux job.)
import fs from 'node:fs'
import { runFuzz } from './fuzz'
import { runRedos } from '../perf/redos'
import { WORK } from '../lib/env'

let failed = 0
for (const mode of ['inproc', 'socket'] as const) {
  const r = await runFuzz(mode, `fuzz-fast-${mode}`)
  console.log(`path fuzzer (${mode}): ${r.calls} calls, ${r.fails.length} failures`)
  for (const f of r.fails.slice(0, 10)) console.log('  FAIL', f.label, '-', f.why, '-', f.text)
  failed += r.fails.length
}
const red = await runRedos()
console.log('ReDoS:', red.rows.map((x: any) => `${x.label} ${x.ms}ms`).join('; '))
failed += red.fails
fs.rmSync(WORK, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
