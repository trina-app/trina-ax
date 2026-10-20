// Runs as axserver inside the container. The launcher (axagent) is already running.
import fs from 'node:fs'
import path from 'node:path'
import { runFuzz } from '../fuzz/fuzz'
import { makeEnv } from '../lib/env'
import { startServer } from '../../server/src/server'
import { fakeTurn } from '../lib/run-turn'
import { CANARY_RE } from '../lib/fixtures'

const AG = +process.env.AGENT_UID!
const out: any = { platform: process.platform, uid: process.getuid!(), mallory: process.env.MALLORY_SAYS }
const checks: { name: string; ok: boolean; detail?: string }[] = []
const check = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail: detail.slice(0, 400) })
check('mallory cannot use the launcher', /only the server|error/.test(process.env.MALLORY_SAYS ?? '') && !/"peer"/.test(process.env.MALLORY_SAYS ?? ''), process.env.MALLORY_SAYS)
const cfgOver = { runDir: '/run/mycel', agentRoot: '/srv/agent', agentUid: AG }
const start = { externalLauncher: '/run/mycel-launcher/launcher.sock', toolsSockMode: '0666' }

// 1) fuzzers on the case-sensitive file system (in-process, then through bridge/gate as the engine account)
for (const mode of ['inproc', 'socket'] as const) {
  const r = await runFuzz(mode, 'fuzz-' + mode, { cfg: cfgOver, start })
  out['fuzz_' + mode] = { calls: r.calls, fails: r.fails.length, caseSensitive: r.caseSensitive, sample: r.fails.slice(0, 5) }
  check(`fuzz ${mode}: ${r.calls} calls, 0 leaks`, r.fails.length === 0 && r.caseSensitive, JSON.stringify(r.fails.slice(0, 3)))
}

// 2) backstop: a compromised engine (runs code as axagent) during a turn, with a concurrent victim turn
const env = makeEnv('linux', cfgOver); env.db.close()
const srv = await startServer(env.cfg, start)
let bobToken = ''
const orig = srv.turns.create.bind(srv.turns)
;(srv.turns as any).create = (...a: any[]) => { const r = (orig as any)(...a); if (a[0] === 'bob') bobToken = r.token; return r }
const victim = fakeTurn(srv, 'bob', { calls: [{ tool: 'read', args: { file_path: 'users/bob/notes.md' } }], sleepMs: 12000 })
await Bun.sleep(1500)
const attack = await fakeTurn(srv, 'alice', { calls: [{ tool: 'read', args: { file_path: 'users/bob/notes.md' } }], attack: '/opt/mycel/tests/linux/attack.sh', attackEnv: { STOLEN: bobToken } })
const v = await victim
const atext = attack.lines.find((l: any) => l.attack)?.attack ?? ''
out.attack = atext
const line = (k: string) => atext.split('\n').find((l: string) => l.startsWith(`[${k}]`)) ?? ''
check('victim turn (bob) works', v.results[0]?.isError === false && /CANARY-BOB/.test(v.results[0]?.text ?? ''))
check('alice tool call for bob file denied', attack.results[0]?.isError === true)
check('no canary reachable from the engine account', !CANARY_RE.test(atext) && !atext.includes('CANARY-SRVENV'), atext)
for (const k of ['team-dir', 'team-file', 'db', 'server-home', 'mallory-home', 'private-sock-dir', 'server-environ', 'server-root', 'server-cwd'])
  check(`engine account cannot: ${k}`, /rc=0 *$/.test(line(k)) || /denied|No such|cannot|Permission/i.test(line(k)), line(k))
check('no turn token visible in other processes\' environ/cmdline', !/\[peer-(environ|cmdline)/.test(atext), atext.split('\n').filter((l: string) => l.startsWith('[peer-')).join(' | '))
check('stolen token from the attacker\'s own turn session is refused', /not authorized/.test(line('stolen-same-session')) && !/CANARY/.test(line('stolen-same-session')), line('stolen-same-session'))
check('stolen token from a setsid escapee is refused', /not authorized/.test(line('stolen-setsid')) && !/CANARY/.test(line('stolen-setsid')), line('stolen-setsid'))
check('server private socket unreachable', !/CONNECTED/.test(line('private-sock')), line('private-sock'))
// 3) reaper: the setsid escapee must be gone shortly after the turn
await Bun.sleep(7000)
const ps = Bun.spawnSync(['ps', '-u', 'axagent', '-o', 'pid=,ppid=,sess=,args=']).stdout.toString().trim()
out.agentProcsAfter = ps
check('only the launcher survives as axagent after turns (escapees reaped)', ps.split('\n').filter(Boolean).every((l) => /mycel-launcher/.test(l)), ps)
// 4) audit: everything recorded
const ev = srv.db.query("SELECT tool, ok, summary FROM tool_events WHERE tool = '(connect)' AND ok = 0").all() as any[]
check('rejected connections audited', ev.length >= 2, JSON.stringify(ev.slice(0, 3)))
await srv.close()

// 5) unit tests that depend on the file system (case-sensitive here)
const ut = Bun.spawnSync(['bun', 'test', 'unit/policy.test.ts', 'unit/files.test.ts', 'unit/engine.test.ts', 'unit/proxy.test.ts'], { cwd: path.resolve(import.meta.dir, '..'), env: { ...process.env } })
const utOut = ut.stdout.toString() + ut.stderr.toString()
out.unit = (utOut.match(/(\d+) pass[\s\S]*?(\d+) fail/) ?? [])[0]
check('unit tests (policy, files, engine, proxy) on Linux', ut.exitCode === 0, utOut.split('\n').filter((l) => /fail|✗/.test(l)).slice(0, 10).join('\n'))

out.checks = checks
out.failed = checks.filter((c) => !c.ok).length
console.log('MYCEL_LINUX_RESULT ' + JSON.stringify(out))
try { for (const n of fs.readdirSync('/srv/mycel')) fs.rmSync(path.join('/srv/mycel', n), { recursive: true, force: true }) } catch {}
process.exit(out.failed ? 1 : 0)
