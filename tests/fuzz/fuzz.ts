// Path fuzzer. Mode "inproc": FileService directly. Mode "socket": the whole path (launcher -> fake engine ->
// bridge -> gate -> server) as user alice. Prints a JSON summary; exit code 1 on any failure.
import path from 'node:path'
import { makeEnv } from '../lib/env'
import { startServer } from '../../server/src/server'
import { fakeTurn } from '../lib/run-turn'
import { buildCases, judge, scanForPwn } from './cases'

export async function runFuzz(mode: 'inproc' | 'socket', name = 'fuzz-' + mode) {
  const env = makeEnv(name)
  const cases = buildCases(env.fx.base, env.fx.team, env.fx.caseSensitive)
  const fails: { label: string; why: string; text: string }[] = []
  if (mode === 'inproc') {
    const ctx = env.ctx('alice', 'fuzz-turn')
    for (const c of cases) {
      const r = await env.files.call(c.tool, c.args, ctx)
      const why = judge(c, r.text, !!r.isError); if (why) fails.push({ label: c.label, why, text: r.text.slice(0, 200) })
    }
    env.db.close()
  } else {
    env.db.close()
    const srv = await startServer(env.cfg, { launcher: { allowCmds: [process.execPath] } })
    const r = await fakeTurn(srv, 'alice', { calls: cases.map((c) => ({ tool: c.tool, args: c.args })) })
    if (r.results.length !== cases.length) fails.push({ label: 'socket run', why: `only ${r.results.length}/${cases.length} results`, text: r.stderr.slice(0, 500) })
    r.results.forEach((res: any, i: number) => { const why = judge(cases[i], res.text, res.isError); if (why) fails.push({ label: cases[i].label, why, text: res.text.slice(0, 200) }) })
    const audited = (srv.db.query("SELECT COUNT(*) AS n FROM tool_events WHERE turn_id = ? AND tool != '(connect)'").get(r.turnId) as any).n
    if (audited !== cases.length) fails.push({ label: 'audit', why: `tool_events ${audited} != calls ${cases.length}`, text: '' })
    await srv.close()
  }
  const pwn = scanForPwn(env.fx.team)
  for (const p of pwn) fails.push({ label: 'write outside allowed areas', why: 'file created', text: p })
  return { mode, platform: process.platform, caseSensitive: env.fx.caseSensitive, calls: cases.length, fails }
}

if (import.meta.main) {
  const mode = (process.argv[2] ?? 'inproc') as 'inproc' | 'socket'
  const r = await runFuzz(mode)
  console.log(JSON.stringify({ ...r, fails: r.fails.slice(0, 30), failCount: r.fails.length }, null, 1))
  process.exit(r.fails.length ? 1 : 0)
}
void path
