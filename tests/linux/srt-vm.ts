// Dev environment on srt: the checks that need systemd and polkit (docs/research/srt-dev-env.md 10.3 and 11: S1, S4,
// S5, A17, A20-A22, A24, A25, the restart). It runs on a Debian 13 VM INSIDE a stand-in of the team server unit
// (<ID>-server.service made from scripts/linux/systemd/server.service.in), as the server account, after
// install-srt.sh. scripts/dev-env/srt/vm-check.sh makes that unit and reads the results. Each run goes through the real
// pieces of the runner: srtSettings, runEnv, scopeArgv and systemdSystem (systemd-run --scope, polkit, run-wrap, srt).
//   MYCEL_VM_PHASE=checks (default): run the checks, write <base>/data/vm-results.json, start one long run, then serve
//   /health on 127.0.0.1:8099. MYCEL_VM_PHASE=serve: only serve /health (after a restart of the unit).
import fs from 'node:fs'
import path from 'node:path'
import { devenvPaths, personHome, personLogs, runEnv, srtSettings, settingsProblems, unitName, type ScopeLimits } from '../../server/src/devenv/srt/config'
import type { FolderView } from '../../server/src/devenv/srt/access'
import { cgroupDir, systemdSystem } from '../../server/src/devenv/srt/system'

const ID = process.env.MYCEL_LABEL ?? 'mycel'
const BASE = process.env.MYCEL_INSTALL_BASE ?? `/var/lib/${ID}`
const TEAM = `${BASE}/team`
const ME = 'alice'
/** the person may write only the project folder (the Docker suite checks folder access in detail) */
const VIEW: FolderView = { read: [], write: ['projects/one'], denyRead: [], denyWrite: [] }
const DIR1 = `${TEAM}/projects/one`
const CANARY = 'CANARY-7f3a'
const RESULTS = `${BASE}/data/vm-results.json`
const STARTER: ScopeLimits = { cpus: 1.5, memoryMiB: 1536, pids: 512, runtimeMaxSec: 150 }
const sys = systemdSystem(ID)

const health = () => Bun.serve({ hostname: '127.0.0.1', port: 8099, fetch: () => new Response('ok') })
if (process.env.MYCEL_VM_PHASE === 'serve') { health(); await new Promise(() => {}) }

// ---- the folders of a team server, with canaries (the server account owns <base>) ----
for (const d of ['secrets', 'config', 'agent/codex-auth']) fs.mkdirSync(path.join(BASE, d), { recursive: true })
fs.mkdirSync(DIR1, { recursive: true })
fs.writeFileSync(`${BASE}/secrets/master.key`, `${CANARY}-secret`)
fs.writeFileSync(`${DIR1}/readme.md`, 'hello from p1\n')
const dp = { run: devenvPaths(BASE).run, home: personHome(BASE, ME), logs: personLogs(BASE, ME) }
for (const d of [dp.run, path.join(dp.home, 'tmp'), dp.logs]) fs.mkdirSync(d, { recursive: true, mode: 0o700 })

const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('')
const sh = async (argv: string[]) => {
  const p = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', env: { PATH: '/usr/bin:/bin', LANG: 'C' } })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { code: await p.exited, out: out + err }
}
const show = async (runId: string, props: string) => {
  const r = await sh(['systemctl', 'show', '-p', props, unitName(runId)])
  return Object.fromEntries(r.out.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
}
const memAvailableMiB = () => Math.round(Number(/^MemAvailable:\s+(\d+)/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'))![1]) / 1024)

interface Run { runId: string; code: number | null; out: string; info: Record<string, string>; peakMiB: number; minAvailMiB: number }
/** One run as the runner makes it. during(runId) runs while it runs. */
async function run(command: string, o: { limits?: Partial<ScopeLimits>; network?: 'open' | 'offline'; during?: (runId: string) => Promise<void>; wait?: boolean } = {}): Promise<Run> {
  const runId = randomId()
  const input = { base: BASE, id: ID, teamRoot: TEAM, userId: ME, view: VIEW, start: 'projects/one', work: null, network: o.network ?? 'open', extraDomains: [], denyHosts: [], denyAddrs: [] }
  const settings = srtSettings(input)
  const problems = settingsProblems(settings, input)
  if (problems.length) throw new Error(problems.join('; '))
  const settingsFile = path.join(dp.run, `${runId}.json`)
  fs.writeFileSync(settingsFile, JSON.stringify(settings), { mode: 0o600 })
  const exitFile = path.join(dp.logs, `${runId}.exit`), outFile = path.join(dp.logs, `cmd-${runId}.out`)
  const s = sys.spawn({ runId, id: ID, cwd: DIR1, env: runEnv({ base: BASE, userId: ME, teamRoot: TEAM, work: null }), limits: { ...STARTER, ...o.limits }, exitFile, settingsFile, command, stdoutFile: outFile, stderrFile: outFile })
  if (o.wait === false) return { runId, code: null, out: '', info: {}, peakMiB: 0, minAvailMiB: 0 }
  let peak = 0, minAvail = memAvailableMiB(), done = false
  const watch = (async () => {
    while (!done) {
      const u = await sys.unit(runId)
      if (u.memoryBytes) peak = Math.max(peak, Math.round(u.memoryBytes / 2 ** 20))
      minAvail = Math.min(minAvail, memAvailableMiB())
      await Bun.sleep(500)
    }
  })()
  if (o.during) await Bun.sleep(1500).then(() => o.during!(runId))
  await s.exited
  done = true; await watch
  const info = await show(runId, 'ActiveState,Result,LoadState')
  await sys.forget(runId)
  const code = fs.existsSync(exitFile) ? Number(fs.readFileSync(exitFile, 'utf8').trim()) : null
  const out = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : ''
  for (const f of [settingsFile, exitFile, outFile]) fs.rmSync(f, { force: true })
  return { runId, code, out, info, peakMiB: peak, minAvailMiB: minAvail }
}

const results: { id: string; what: string; pass: boolean | null; note: string }[] = []
const check = (id: string, what: string, pass: boolean | null, note: string) => {
  results.push({ id, what, pass, note: note.replace(/\s+/g, ' ').slice(0, 400) })
  console.log(`${pass === null ? 'info' : pass ? 'pass' : 'FAIL'} ${id} ${what}: ${note.replace(/\s+/g, ' ').slice(0, 200)}`)
}
const leak = (s: string) => s.includes(CANARY)

// S1: the server account starts a scope through polkit, from the delegated cgroup of its unit
check('S1a', 'self test: the server account can start a scope', (await sys.selfTest(ID)) === '', await sys.selfTest(ID) || 'ok')
{
  const r = await run('cat /proc/self/cgroup; echo hello > made.txt; cat readme.md')
  const inScope = r.out.includes(`${ID}-devenv.slice/${unitName(r.runId)}`)
  check('S1b', 'a run is in its scope in the devenv slice; project folder read and write', r.code === 0 && inScope && fs.existsSync(`${DIR1}/made.txt`), `code=${r.code} inScope=${inScope} ${r.out.slice(0, 160)}`)
}
{
  let props: Record<string, string> = {}
  await run('sleep 3', { during: async (id) => { props = await show(id, 'MemoryMax,TasksMax,CPUQuotaPerSecUSec,RuntimeMaxUSec,OOMPolicy,Slice') } })
  const okLimits = props.MemoryMax === String(1536 * 2 ** 20) && props.TasksMax === '512' && props.CPUQuotaPerSecUSec === '1.500000s' && props.OOMPolicy === 'kill' && props.Slice === `${ID}-devenv.slice`
  check('S1d', 'scope limits: MemoryMax 1536M, TasksMax 512, CPUQuota 150%, OOMPolicy kill, the devenv slice', okLimits, JSON.stringify(props))
}
// RuntimeMaxSec
{
  const r = await run('sleep 60', { limits: { runtimeMaxSec: 4 } })
  check('RT', 'RuntimeMaxSec stops a run: Result=timeout', r.info.Result === 'timeout' && r.code === null, JSON.stringify(r.info) + ` code=${r.code}`)
}
// A21: a memory bomb. The kernel kills the run, not the server.
{
  const before = process.pid
  let oom: number | null = null
  const r = await run('python3 -c "b=[]\nwhile True: b.append(bytearray(64*2**20))"', { limits: { runtimeMaxSec: 120 }, during: async (id) => { for (let i = 0; i < 40 && oom === null; i++) { await Bun.sleep(250); oom = sys.oomKills(id) } } })
  check('A21', 'memory bomb: Result=oom-kill, the server lives', r.info.Result === 'oom-kill' && process.pid === before, `${JSON.stringify(r.info)} code=${r.code} peak=${r.peakMiB}MiB minAvail=${r.minAvailMiB}MiB oomKillsSeen=${oom}`)
}
// A22: a fork bomb stops at TasksMax
{
  let pids = ''
  const r = await run(':(){ :|:& };: ; sleep 30', { limits: { runtimeMaxSec: 12 }, during: async (id) => { await Bun.sleep(3000); try { pids = fs.readFileSync(`${cgroupDir(ID, id)}/pids.current`, 'utf8').trim() + ' events=' + fs.readFileSync(`${cgroupDir(ID, id)}/pids.events`, 'utf8').trim() } catch (e) { pids = String(e) } } })
  const n = Number(pids.split(' ')[0])
  check('A22', 'fork bomb: at most TasksMax tasks; the run ends; the server lives', n > 0 && n <= 512 && r.info.ActiveState !== 'active', `pids.current=${pids} ${JSON.stringify(r.info)}`)
}
// A17: systemd from the sandbox
{
  const r = await run('systemd-run --scope --quiet true 2>&1; systemctl stop ' + ID + '-server.service 2>&1; busctl list 2>&1 | head -3; systemctl --user status 2>&1 | head -2; echo END')
  const alive = (await sh(['systemctl', 'is-active', `${ID}-server.service`])).out.trim()
  check('A17', 'systemd-run, systemctl stop and the bus from the sandbox fail', alive === 'active' && !/^Running scope/m.test(r.out), `server=${alive} ${r.out.slice(0, 300)}`)
}
// A20: a process left behind ends with the run
{
  const r = await run('setsid nohup sleep 7777 >/dev/null 2>&1 & echo started')
  await Bun.sleep(1000)
  const left = (await sh(['pgrep', '-f', 'sleep 7777'])).code === 0
  check('A20', 'a process left behind ends with the run', r.code === 0 && !left, `code=${r.code} left=${left}`)
}
// A24 and S4: chromium in the sandbox
{
  const r = await run(`chromium --headless --no-sandbox --disable-dev-shm-usage --disable-gpu --dump-dom file://${BASE}/secrets/master.key 2>&1 | head -c 400`, { limits: { runtimeMaxSec: 60 } })
  check('A24', 'chromium cannot open a denied file', !leak(r.out), r.out.slice(0, 200))
  const s4 = await run('chromium --headless --no-sandbox --disable-dev-shm-usage --disable-gpu --proxy-server="$HTTPS_PROXY" --dump-dom https://registry.npmjs.org/ 2>/dev/null | head -c 200; echo; chromium --headless --no-sandbox --disable-dev-shm-usage --disable-gpu --proxy-server="$HTTPS_PROXY" --dump-dom https://example.com/ 2>/dev/null | head -c 200', { limits: { runtimeMaxSec: 90 } })
  check('S4', 'chromium headless through the proxy (an allowed site; example.com is not allowed)', null, `code=${s4.code} peak=${s4.peakMiB}MiB ${s4.out.slice(0, 300)}`)
}
// A1 in a scope (the Docker suite has the rest): the base folder stays hidden
{
  const r = await run(`cat ${BASE}/secrets/master.key; grep -r ${CANARY} ${BASE} 2>/dev/null; cat /etc/default/${ID}`)
  check('A1', 'base folder and /etc/default/<ID> hidden in a scope', !leak(r.out), r.out.slice(0, 200))
}
// A25: the server account, outside the sandbox: only trina-dev-<16>.scope
{
  const id16 = randomId()
  const tries: [string, string[]][] = [
    ['a .service with the run name', ['systemd-run', '--quiet', '--no-ask-password', `--unit=trina-dev-${id16}.service`, '/bin/true']],
    ['a .service as root', ['systemd-run', '--quiet', '--no-ask-password', '-p', 'User=root', '/bin/true']],
    ['another scope name', ['systemd-run', '--scope', '--quiet', '--no-ask-password', '--unit=other.scope', '/bin/true']],
    ['a short run name', ['systemd-run', '--scope', '--quiet', '--no-ask-password', '--unit=trina-dev-x.scope', '/bin/true']],
    ['stop another unit', ['systemctl', 'stop', '--no-ask-password', 'ssh.service']],
  ]
  for (const [what, argv] of tries) {
    const r = await sh(argv)
    check('A25', `polkit says no: ${what}`, r.code !== 0, `code=${r.code} ${r.out.slice(0, 160)}`)
  }
  const slice = await sh(['systemd-run', '--scope', '--quiet', '--no-ask-password', `--unit=trina-dev-${randomId()}.scope`, '--slice=-.slice', '/bin/true'])
  check('A25b', 'a run scope outside the devenv slice (the rule does not check the slice)', null, `code=${slice.code} ${slice.out.slice(0, 160)}`)
}
// S5: memory of a real build (npm install and a Next.js build) on the Starter limits
{
  const pre = memAvailableMiB()
  const r = await run([
    'mkdir -p next && cd next && npm init -y >/dev/null',
    'npm i --no-audit --no-fund --loglevel=error next@15 react@19 react-dom@19 >/dev/null',
    'mkdir -p app && printf "export default function P(){return <p>hi</p>}\\n" > app/page.jsx',
    'printf "export default function L({children}){return <html><body>{children}</body></html>}\\n" > app/layout.jsx',
    'NEXT_TELEMETRY_DISABLED=1 npx next build 2>&1 | tail -5',
  ].join(' && '), { limits: { runtimeMaxSec: 900 } })
  check('S5', 'npm install + next build on Starter limits (memory of the scope, MemAvailable of the VM)', r.code === 0 ? null : false, `code=${r.code} peak=${r.peakMiB}MiB vmAvailBefore=${pre}MiB vmAvailMin=${r.minAvailMiB}MiB ${JSON.stringify(r.info)} ${r.out.slice(-200)}`)
}
// the restart: a long run must outlive a restart of the server unit (vm-check.sh restarts it and checks)
const survivor = await run('sleep 600', { wait: false, limits: { runtimeMaxSec: 900 } })
await Bun.sleep(2000)
check('RS', 'a long run before the server restart', (await sys.unit(survivor.runId)).state === 'active', unitName(survivor.runId))
fs.writeFileSync(RESULTS, JSON.stringify({ survivor: unitName(survivor.runId), results }, null, 1))
console.log(`results in ${RESULTS}`)
health()
await new Promise(() => {})
