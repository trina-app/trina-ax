// QA TC-4950 benchmark: the time of each read piece of an 18 MB one-line JSON (Python style, spaces between tokens).
// Before, every piece parsed, checked and reformatted the whole file again (about 0.5 s a piece on an M1, ~3 million
// view lines = ~2,000 pieces, so reading it through kept the server busy for ~17 minutes). Run with
// BENCH_JSON_TIDY=1 to print the numbers; without it the test is skipped (timing is not checked in CI).
import { expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeEnv } from '../lib/env'

test.skipIf(!process.env.BENCH_JSON_TIDY)('bench: pieces of an 18 MB one-line JSON', async () => {
  const env = makeEnv('unit-files-json-tidy-bench')
  const kids: unknown[] = []
  for (let i = 0, s = 0; s < 16_500_000; i++, s += 80) kids.push({ id: i, a: i % 7, b: [1, 2, 3, i], c: { d: true, e: null, f: 'text ' + i } })
  const json = JSON.stringify({ id: 1, kids }).replace(/,"/g, ', "').replace(/":/g, '": ')
  fs.mkdirSync(path.join(env.fx.team, 'shared'), { recursive: true })
  fs.writeFileSync(path.join(env.fx.team, 'shared/big.json'), json)
  const c = env.ctx('alice')
  const ms: number[] = []
  let args: Record<string, unknown> = { file_path: 'shared/big.json' }
  for (let i = 0; i < 20; i++) {
    const t = performance.now()
    const r = await env.files.call('read', args, c)
    ms.push(performance.now() - t)
    const m = /read again with offset=(\d+) pretty=true/i.exec(r.text)
    expect(m).not.toBeNull()
    args = { file_path: 'shared/big.json', pretty: true, offset: Number(m![1]) }
  }
  const rest = ms.slice(1).sort((a, b) => a - b)
  console.log(`json chars ${json.length}; first piece ${ms[0]!.toFixed(0)} ms; next 19 pieces median ${rest[9]!.toFixed(0)} ms, max ${rest.at(-1)!.toFixed(0)} ms`)
}, 600_000)
