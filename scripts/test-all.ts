// `bun run test`: every unit and component test of the repo, one after the other, with one summary at the end.
//   unit      tests/unit: server components A–G, shared contracts, desktop logic, integration wiring (bun test)
//   web       web/test/unit (bun test in the web workspace)
//   relay     tests/relay: relay conformance + hardening against a real Node 25 relay (about 90 s)
// Flags: --no-relay (skip the slow relay suite), --only <unit|web|relay>. Engines are never called for real here;
// real-engine, Docker, Playwright and packaged-app runs have their own scripts (see README).
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '..')
const args = process.argv.slice(2)
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null

interface Suite { name: string; cmd: string[]; cwd: string; skip?: string | null }

function nodeMajor(): number {
  const node = Bun.which('node')
  if (!node) return 0
  return Number(/^v(\d+)/.exec(Bun.spawnSync([node, '--version']).stdout.toString())?.[1] ?? 0)
}

const suites: Suite[] = [
  { name: 'unit', cmd: ['bun', 'test', 'tests/unit'], cwd: ROOT },
  { name: 'web', cmd: ['bun', 'test', 'test/unit'], cwd: path.join(ROOT, 'web') },
  {
    name: 'relay', cmd: ['bun', 'test', 'tests/relay'], cwd: ROOT,
    skip: args.includes('--no-relay') ? 'skipped (--no-relay)' : nodeMajor() < 25 ? 'skipped: needs Node 25+ on PATH (the relay runs on Node)' : null,
  },
]

const results: { name: string; status: 'pass' | 'fail' | 'skip'; seconds: number; summary: string }[] = []
for (const s of suites) {
  if (only && s.name !== only) continue
  if (s.skip) { results.push({ name: s.name, status: 'skip', seconds: 0, summary: s.skip }); continue }
  console.log(`\n=== ${s.name}: ${s.cmd.join(' ')}`)
  const t0 = Date.now()
  const p = Bun.spawn(s.cmd, { cwd: s.cwd, stdout: 'pipe', stderr: 'pipe', env: process.env })
  let out = ''
  const pump = async (st: ReadableStream<Uint8Array>, to: NodeJS.WriteStream) => {
    const td = new TextDecoder()
    for await (const ch of st) { const t = td.decode(ch, { stream: true }); out += t; to.write(t) }
  }
  await Promise.all([pump(p.stdout, process.stdout), pump(p.stderr, process.stderr)])
  const code = await p.exited
  const m = /(\d+) pass[\s\S]*?(\d+) fail/.exec(out.slice(-4000))
  results.push({ name: s.name, status: code === 0 ? 'pass' : 'fail', seconds: Math.round((Date.now() - t0) / 1000), summary: m ? `${m[1]} pass, ${m[2]} fail` : `exit ${code}` })
}

console.log('\n=== summary')
for (const r of results) console.log(`${r.status.toUpperCase().padEnd(4)} ${r.name.padEnd(6)} ${r.status === 'skip' ? '' : `${r.seconds}s `}${r.summary}`)
process.exit(results.some((r) => r.status === 'fail') ? 1 : 0)
