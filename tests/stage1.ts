// Stage 1 ("권한 바닥 공사") test run. One command: `bun run test:stage1` (flags: --no-claude, --no-docker, --no-codex).
// Done criteria (design 개요): bypass/fuzz suites pass on macOS and Linux with 0 leaks; lockdown regression passes;
// all file changes in the audit log; concurrent-edit tests pass; grep < 1 s on 20k files.
import fs from 'node:fs'
import path from 'node:path'
import { runFuzz } from './fuzz/fuzz'
import { runRedos } from './perf/redos'
import { runBench } from './perf/bench'
import { WORK } from './lib/env'
import { runLinuxJob } from './linux/run'

const ROOT = path.resolve(import.meta.dir, '..')
const args = new Set(process.argv.slice(2))
const results: { step: string; ok: boolean; seconds: number; summary: string; detail?: unknown }[] = []
async function step(name: string, fn: () => Promise<{ ok: boolean; summary: string; detail?: unknown }>) {
  const t0 = Date.now()
  process.stdout.write(`• ${name} ... `)
  let r: { ok: boolean; summary: string; detail?: unknown }
  try { r = await fn() } catch (e: any) { r = { ok: false, summary: 'crashed: ' + (e?.stack ?? e).toString().slice(0, 500) } }
  const seconds = Math.round((Date.now() - t0) / 100) / 10
  results.push({ step: name, ok: r.ok, seconds, summary: r.summary, detail: r.detail })
  console.log(`${r.ok ? 'PASS' : 'FAIL'} (${seconds}s) ${r.summary}`)
}
const sh = (cmd: string[], cwd = ROOT, env: Record<string, string> = {}) => { const p = Bun.spawnSync(cmd, { cwd, env: { ...process.env, ...env } }); return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() } }

await step('typecheck', async () => { const r = sh(['bunx', 'tsc', '-p', 'tsconfig.json', '--noEmit']); return { ok: r.code === 0, summary: r.code === 0 ? 'no errors' : r.out.slice(0, 800) } })
await step('native build (darwin + linux) + go vet', async () => {
  const v = sh(['go', 'vet', './...'], path.join(ROOT, 'native')); const b = sh(['bash', 'native/build.sh'])
  return { ok: v.code === 0 && b.code === 0, summary: b.out.trim().split('\n').join(', ') + (v.code ? ' vet: ' + v.out : '') }
})
await step('unit tests (policy table, names, files, conflicts, trash, audit, parsers, engine flags, proxy, gate/launcher)', async () => {
  const r = sh(['bun', 'test', 'unit'], path.join(ROOT, 'tests'))
  const m = /(\d+) pass[\s\S]*?(\d+) fail/.exec(r.out)
  return { ok: r.code === 0, summary: m ? `${m[1]} pass, ${m[2]} fail` : r.out.slice(-500), detail: r.code ? r.out.split('\n').filter((l) => /\(fail\)/.test(l)) : undefined }
})
for (const mode of ['inproc', 'socket'] as const)
  await step(`path fuzzer macOS (${mode})`, async () => { const r = await runFuzz(mode); return { ok: r.fails.length === 0, summary: `${r.calls} calls, ${r.fails.length} failures`, detail: r.fails.slice(0, 10) } })
await step('ReDoS', async () => { const r = await runRedos(); return { ok: r.fails === 0, summary: r.rows.map((x: any) => `${x.label} ${x.ms}ms`).join('; '), detail: r.rows } })
await step('grep benchmark (20k files)', async () => {
  const r = await runBench(5)
  return { ok: r.worstMs < 1000 && !r.leaks && !r.errors, summary: `${r.gen.files} files; worst median ${r.worstMedianMs} ms, worst single ${r.worstMs} ms; leaks ${r.leaks}; office index ${r.indexMs} ms`, detail: r.rows }
})
if (!args.has('--no-docker')) await step('Linux job in Docker (unprivileged accounts: fuzzers, backstop, reaper, unit)', async () => runLinuxJob())
if (!args.has('--no-claude')) {
  const { runClaudeLockdown } = await import('./engine/lockdown-claude')
  const { runCodexLockdown } = await import('./engine/lockdown-codex')
  const { runE2E } = await import('./e2e/e2e')
  await step('engine lockdown regression: Claude Code (1 real call)', async () => { const r = await runClaudeLockdown(); return { ok: !r.failed, summary: `claude ${r.claudeVersion} ${r.model}; tools ${r.tools.join(',')}; ${r.checks.length - r.failed}/${r.checks.length} checks${r.ownerEmailInContext ? '; note: the signed-in account email is in the engine context (local-login)' : ''}`, detail: r.checks } })
  // the sub-agent lockdown (docs/DECISIONS.md "Sub-agents"): this machine's claude against a scripted fake model, free;
  // before the pinned version moves, run it on that version (no --any-version) with and without --oauth
  await step('engine lockdown regression: Claude Code sub-agents (fake model, no real call)', async () => {
    const r = sh(['bun', 'run', 'tests/engine/lockdown-claude-subagents.ts', '--any-version'], ROOT)
    return { ok: r.code === 0, summary: (/\d+\/\d+ checks passed.*/.exec(r.out) ?? [r.out.slice(-300)])[0]!, detail: r.out.split('\n').filter((l) => l.startsWith('FAIL')) }
  })
  if (!args.has('--no-codex')) await step('engine lockdown regression: Codex CLI (1 real call)', async () => { const r: any = await runCodexLockdown(); return { ok: !r.failed, summary: r.skipped ?? `model ${r.model}; items ${JSON.stringify(r.items)}; ${r.checks.length - r.failed}/${r.checks.length} checks`, detail: r.checks } })
  await step('e2e as alice (5 Claude turns + 1 Codex turn)', async () => { const r = await runE2E({ codex: !args.has('--no-codex') }); return { ok: !r.failed, summary: `${r.checks.length - r.failed}/${r.checks.length} checks; turns: ${r.turns.map((t: any) => `${t.engine}:${t.seconds}s[${t.tools.join('+')}]`).join(' ')}`, detail: { checks: r.checks, turns: r.turns } } })
}

const failed = results.filter((r) => !r.ok)
fs.mkdirSync(path.join(ROOT, 'tests', 'out'), { recursive: true })
fs.writeFileSync(path.join(ROOT, 'tests', 'out', 'stage1-report.json'), JSON.stringify({ at: new Date().toISOString(), platform: process.platform, results }, null, 1))
// large generated fixtures are removed; generators stay
fs.rmSync(WORK, { recursive: true, force: true })
console.log(`\nstage 1: ${results.length - failed.length}/${results.length} steps passed${failed.length ? ' — FAILED: ' + failed.map((f) => f.step).join('; ') : ''}`)
console.log('report: tests/out/stage1-report.json')
process.exit(failed.length ? 1 : 0)
