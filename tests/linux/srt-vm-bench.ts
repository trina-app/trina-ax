// Dev environment on srt: real work on a Starter-size VM (2 vCPU, 4 GB), through the real box_shell tool of a test
// server (tests/lib/b-harness.ts) with the real runner (systemd scopes, polkit, run-wrap, srt). It runs INSIDE the
// stand-in team server unit as the server account (scripts/dev-env/srt/vm-check.sh REPO bench).
//   1. npm install of a small Remotion project, then a 1080p 15 s render as a job (time, memory);
//   2. pip install in a venv in the project folder;
//   3. the allowlist: an allowed host works, a host not on the list fails;
//   4. escapes, each with a positive control (the server account outside srt can read the canary);
//   5. two heavy jobs on Starter (maxRunning 1): the second waits, then runs.
// Results: <base>/data/bench-results.json and one "bench <id> ..." line per check. Then it serves /health on
// 127.0.0.1:8099 (the restart check of vm-check.sh).
import fs from 'node:fs'
import path from 'node:path'
import { API, DEV_ENV_DEFAULT_LIMITS } from '@mycel/shared/api'
import { extraDomainProblem } from '@mycel/shared'
import { startHarness } from '../lib/b-harness'
import { parsePlan } from '../../server/src/devenv/srt/plan'
import { setSrtSystem } from '../../server/src/devenv/srt/runner'
import { systemdSystem } from '../../server/src/devenv/srt/system'
import { pollSrt } from '../../server/src/devenv/jobs'
import { newConsent, saveTeamSetting, teamSetting } from '../../server/src/devenv/setting'
import { boxShellTool } from '../../server/src/devenv/tool'

const ID = process.env.MYCEL_LABEL ?? 'mycel'
const BASE = process.env.MYCEL_INSTALL_BASE ?? `/var/lib/${ID}`
const RESULTS = `${BASE}/data/bench-results.json`
const SLICE_DIR = `/sys/fs/cgroup/${ID}.slice/${ID}-devenv.slice`
const REMOTION = '4.0.539'
const plan = parsePlan(fs.readFileSync(`${BASE}/root/dev-env.json`, 'utf8'))
if (!plan) throw new Error('no plan file')

const health = Bun.serve({ hostname: '127.0.0.1', port: 8099, fetch: () => new Response('ok') })

// ---- a sampler of every run scope (the cgroup is gone after the run, so it reads while the run is active) ----
interface Peak { peak: number; current: number; unreclaimable: number; pids: number; oomKill: number; firstSeen: number; lastSeen: number }
const peaks = new Map<string, Peak>()
let minAvail = Infinity
const mib = (n: number) => Math.round(n / 2 ** 20)
const read = (f: string) => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }
const stat = (txt: string, key: string) => Number(new RegExp(`^${key} (\\d+)$`, 'm').exec(txt)?.[1] ?? 0)
function sample() {
  minAvail = Math.min(minAvail, Math.round(stat(read('/proc/meminfo').replace(/:\s+/g, ' ').replace(/ kB/g, ''), 'MemAvailable') / 1024))
  let names: string[] = []
  try { names = fs.readdirSync(SLICE_DIR).filter((n) => n.startsWith('trina-dev-') && n.endsWith('.scope')) } catch { return }
  for (const n of names) {
    const d = `${SLICE_DIR}/${n}`, ms = read(`${d}/memory.stat`)
    const p = peaks.get(n) ?? { peak: 0, current: 0, unreclaimable: 0, pids: 0, oomKill: 0, firstSeen: Date.now(), lastSeen: 0 }
    p.peak = Math.max(p.peak, Number(read(`${d}/memory.peak`)) || 0)
    p.current = Math.max(p.current, Number(read(`${d}/memory.current`)) || 0)
    p.unreclaimable = Math.max(p.unreclaimable, stat(ms, 'anon') + stat(ms, 'shmem'))
    p.pids = Math.max(p.pids, Number(read(`${d}/pids.peak`)) || Number(read(`${d}/pids.current`)) || 0)
    p.oomKill = Math.max(p.oomKill, stat(read(`${d}/memory.events`), 'oom_kill'))
    p.lastSeen = Date.now()
    peaks.set(n, p)
  }
}
setInterval(sample, 250)
const peaksOf = (units: string[]) => {
  const ps = units.map((u) => peaks.get(u)).filter((p): p is Peak => !!p)
  return { units: units.length, peakMiB: mib(Math.max(0, ...ps.map((p) => p.peak))), chargedMiB: mib(Math.max(0, ...ps.map((p) => p.current))), unreclaimableMiB: mib(Math.max(0, ...ps.map((p) => p.unreclaimable))), pids: Math.max(0, ...ps.map((p) => p.pids)), oomKill: Math.max(0, ...ps.map((p) => p.oomKill)) }
}

// ---- the test server and the team setting ----
const h = await startHarness({ name: 'srt-bench' })
const sys = systemdSystem(ID)
setSrtSystem(sys, { base: BASE, id: ID, plan })
const FALCON = 'projects/falcon'
const falconId = (await h.api('alice').call(API.createProject, { body: { name: 'Falcon', folderPath: FALCON, instructions: '' } })).id
const chatFalcon = (await h.api('alice').call(API.createChat, { body: { projectId: falconId } })).id
const chatPlain = (await h.api('alice').call(API.createChat, { body: {} })).id
const chatBob = (await h.api('bob').call(API.createChat, { body: {} })).id
const team = (patch: Partial<ReturnType<typeof teamSetting>> = {}) => saveTeamSetting(h.ctx.db, {
  ...teamSetting(h.ctx.db), enabled: true, scope: { mode: 'writers', groupIds: [], userIds: [] }, network: 'open',
  limits: { ...DEV_ENV_DEFAULT_LIMITS, cpus: 1, memoryMiB: plan.memoryMiB, pids: plan.pids }, extraDomains: [], consent: newConsent({ id: 'carol', name: 'Carol Park' }), ...patch,
})
team()
const PROJECT = fs.realpathSync(path.join(h.team, FALCON))

const results: Record<string, unknown>[] = []
const say = (id: string, pass: boolean | null, what: string, data: Record<string, unknown> = {}) => {
  results.push({ id, pass, what, ...data })
  console.log(`bench ${pass === null ? 'info' : pass ? 'pass' : 'FAIL'} ${id} ${what} ${JSON.stringify(data).slice(0, 600)}`)
  fs.writeFileSync(RESULTS, JSON.stringify({ plan, results }, null, 1))
}
const text = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? '').join('\n')
const exitOf = (t: string) => Number(/Exit code (\d+)\./.exec(t)?.[1] ?? -1)
let turn = 0
/** one box_shell call as a person in a chat; the scopes that appeared during the call and their peaks */
async function shell(input: Record<string, unknown>, o: { user?: string; project?: boolean; chat?: string } = {}) {
  const before = new Set(peaks.keys())
  const t0 = Date.now()
  const user = o.user ?? 'alice'
  const project = o.project === false ? null : { id: falconId, folderPath: FALCON, name: 'Falcon' }
  const r = await boxShellTool({ ctx: h.ctx, project, userId: user, turnId: `turn-${++turn}`, chatId: o.chat ?? chatFalcon, signal: new AbortController().signal, confirm: async () => null, redact: (s) => s }).call(input as never)
  await Bun.sleep(300); sample()
  const units = [...peaks.keys()].filter((u) => !before.has(u))
  const t = text(r)
  return { text: t, code: exitOf(t), seconds: (Date.now() - t0) / 1000, units, mem: peaksOf(units), isError: !!r.isError }
}
type Row = { id: string; name: string; state: string; unit: string; exit_code: number | null; end_reason: string; started_at: string; run_at: string | null; ended_at: string | null; log_tail: string }
const rowOf = (name: string) => h.ctx.db.query("SELECT * FROM dev_env_runs WHERE name = ? ORDER BY started_at DESC LIMIT 1").get(name) as Row | null
const activeScopes = () => { try { return fs.readdirSync(SLICE_DIR).filter((n) => n.startsWith('trina-dev-') && n.endsWith('.scope')).length } catch { return -1 } }
/** wait until the named jobs end; the tracker's poll every 2 s */
async function waitJobs(names: string[], maxMs: number, during?: () => void) {
  const end = Date.now() + maxMs
  while (Date.now() < end) {
    await pollSrt(h.ctx)
    during?.()
    if (names.every((n) => rowOf(n)?.ended_at)) break
    await Bun.sleep(2000)
  }
  // a job that is still running at the limit is stopped, so it does not hold the slot for the next checks
  for (const n of names) {
    const r = rowOf(n)
    if (r && !r.ended_at && r.unit) { console.log(`bench note: stopping ${n} at the wait limit`); await sys.stop(r.unit.slice('trina-dev-'.length, -'.scope'.length), 0); await Bun.sleep(3000); await pollSrt(h.ctx) }
  }
  return names.map((n) => rowOf(n)!)
}
const jobSeconds = (r: Row) => (r.run_at && r.ended_at ? (Date.parse(r.ended_at) - Date.parse(r.run_at)) / 1000 : null)
const logOf = (name: string) => read(path.join(BASE, 'devenv/logs/alice', `${name}.log`))

// ---- 0. what a run sees ----
{
  const r = await shell({ command: 'nproc; node -p "require(\'os\').availableParallelism()"; node --version; python3 --version; cat /proc/self/cgroup; id -un; echo HOME=$HOME; env | grep -c _PROXY' })
  say('E0', r.code === 0 ? null : false, 'a run: nproc, availableParallelism, node, cgroup, user', { code: r.code, out: r.text.slice(0, 600) })
}

// ---- 1. Remotion: install, browser, render ----
const REMO = 'remo'
const files: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'render-test', private: true, dependencies: { remotion: REMOTION, '@remotion/cli': REMOTION, react: '19.2.0', 'react-dom': '19.2.0' } }),
  'src/index.ts': "import { registerRoot } from 'remotion'\nimport { Root } from './Root'\nregisterRoot(Root)\n",
  'src/Root.tsx': read(path.join(import.meta.dir, 'srt-bench-root.tsx.txt')),
}
for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(PROJECT, REMO, f)), { recursive: true }); fs.writeFileSync(path.join(PROJECT, REMO, f), body) }
{
  const r = await shell({ command: `cd ${REMO} && npm install --no-audit --no-fund --loglevel=error 2>&1 | tail -5; echo "rc=\${PIPESTATUS[0]}"; du -sm node_modules`, timeout_sec: 900 })
  say('R1', /rc=0/.test(r.text) ? true : false, 'npm install of Remotion (foreground command, Starter limits, cpus 1)', { seconds: r.seconds, ...r.mem, minAvailMiB: minAvail, out: r.text.slice(-400) })
}
// the browser: first with the default list only; the hosts it needs then go on the team list (an admin's choice)
let browserOk = false
{
  const r = await shell({ command: `cd ${REMO} && npx --no-install remotion browser ensure 2>&1 | tail -15`, timeout_sec: 600 })
  browserOk = /chrome-headless-shell|already|downloaded|Got browser/i.test(r.text) && !/error|fail|403|blocked/i.test(r.text)
  const hosts = [...new Set([...r.text.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)].map((m) => m[1]!.toLowerCase()))]
  say('R2a', null, 'remotion browser ensure with the default allowlist', { seconds: r.seconds, ok: browserOk, hostsInOutput: hosts, out: r.text.slice(-700) })
  if (!browserOk) {
    const add = hosts.filter((d) => !extraDomainProblem(d) && !['registry.npmjs.org', 'github.com'].includes(d))
    const extra = add.length ? add : ['remotion.media']
    team({ extraDomains: extra })
    // Remotion's download lock holds a hostname and a pid. The failed try above left it; in a new srt run the pid
    // namespace is new, so a low pid of the old run is often alive again and Remotion waits for the lock forever
    // (first two VM runs). Show it with a short limit, then remove the lock as the AI would.
    const lock = `${REMO}/node_modules/.remotion/chrome-headless-shell/download.lock`
    const stale = await shell({ command: `cat ${lock} 2>&1; echo; npx --no-install remotion browser ensure 2>&1 | grep -v -i experimental | tail -3`, timeout_sec: 60 })
    say('R2-lock', null, 'after the failed try: the stale Remotion download lock (pid from another pid namespace)', { head: stale.text.split('\n').slice(0, 4).join(' | ').slice(0, 400), seconds: stale.seconds })
    const r2 = await shell({ command: `rm -f ${lock}; cd ${REMO} && npx --no-install remotion browser ensure 2>&1 | grep -v -i experimental | tail -4`, timeout_sec: 600 })
    browserOk = /Got Headless Shell|Has browser/.test(r2.text)
    say('R2b', browserOk, 'remotion browser ensure after the admin adds the host(s)', { extraDomains: extra, seconds: r2.seconds, ...r2.mem, out: r2.text.slice(-700) })
  }
}
const render = (out: string, concurrency: number | null) =>
  `cd ${REMO} && s=$(date +%s.%N); npx --no-install remotion render src/index.ts Main out/${out}.mp4 --log=verbose ${concurrency ? `--concurrency=${concurrency}` : ''} > out-${out}.log 2>&1; rc=$?; e=$(date +%s.%N); `
  + `echo "render_seconds $(awk -v a=$s -v b=$e 'BEGIN{printf "%.1f", b-a}') rc=$rc"; grep -m2 -iE 'concurrency|parallel' out-${out}.log | cut -c1-160; tail -3 out-${out}.log; `
  + `ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height,nb_frames -of csv=p=0 out/${out}.mp4 2>&1; exit $rc`
{
  const r = await shell({ command: render('r1', 1), job: true, log_name: 'render1' })
  const [row] = await waitJobs(['render1'], 1800_000)
  const m = peaksOf([row!.unit])
  say('R3', row!.exit_code === 0, 'render 1080p 15 s as a job: cpus 1, concurrency 1, Starter memory', { submit: r.text.split('\n')[0], exit: row!.exit_code, endReason: row!.end_reason, jobSeconds: jobSeconds(row!), ...m, minAvailMiB: minAvail, log: logOf('render1').slice(-600) })
}

// ---- 2. pip in a venv ----
{
  const r = await shell({ command: 'python3 -m venv .venv && .venv/bin/pip install -q requests 2>&1 | tail -3; .venv/bin/python -c "import requests, sys; print(\'requests\', requests.__version__, sys.prefix)"', timeout_sec: 600 })
  say('P1', /requests \d/.test(r.text), 'pip install requests in a venv in the project folder, then import it', { seconds: r.seconds, ...r.mem, out: r.text.slice(-400) })
}

// ---- 3. the allowlist ----
{
  const r = await shell({ command: 'for u in https://registry.npmjs.org/ https://pypi.org/simple/ https://example.com/ https://www.google.com/; do printf "%s %s\\n" "$u" "$(curl -s -o /dev/null -m 15 -w "%{http_code}" "$u")"; done; printf "direct %s\\n" "$(curl -s --noproxy "*" -o /dev/null -m 8 -w "%{http_code}" https://registry.npmjs.org/)"' })
  const code = (u: string) => new RegExp(`${u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (\\d+)`).exec(r.text)?.[1] ?? ''
  const ok = code('https://registry.npmjs.org/') === '200' && code('https://pypi.org/simple/') === '200' && code('https://example.com/') !== '200' && code('https://www.google.com/') !== '200' && /direct 000/.test(r.text)
  say('N1', ok, 'allowlist: npm and PyPI 200; example.com and google.com blocked; no direct route', { out: r.text })
}

// ---- 4. escapes, each with a positive control ----
const CANARY = 'CANARY-BENCH-5e1d'
fs.mkdirSync(`${BASE}/secrets`, { recursive: true }); fs.writeFileSync(`${BASE}/secrets/master.key`, `${CANARY}-secret\n`)
fs.writeFileSync(`${BASE}/data/canary-db.txt`, `${CANARY}-data\n`)
fs.mkdirSync(`${BASE}/data/.ssh`, { recursive: true, mode: 0o700 }); fs.writeFileSync(`${BASE}/data/.ssh/id_ed25519`, `${CANARY}-ssh\n`, { mode: 0o600 })
const targets: [string, string, RegExp][] = [
  ['server secrets', `${BASE}/secrets/master.key`, /CANARY-BENCH/],
  ['server data dir', `${BASE}/data/canary-db.txt`, /CANARY-BENCH/],
  ['the Trina DB', path.join(h.dataDir, 'app.db'), /SQLite format/],
  ['server ~/.ssh (HOME of the server account)', `${BASE}/data/.ssh/id_ed25519`, /CANARY-BENCH/],
  ['/etc/default/<ID> (server env)', `/etc/default/${ID}`, /CANARY-7f3a/],
  ['another group folder (finance)', path.join(h.team, 'groups/finance/budget.md'), /CANARY-FIN/],
  ['another person (users/bob)', path.join(h.team, 'users/bob/notes.md'), /CANARY-BOB/],
  ['a folder she may not open (salaries)', path.join(h.team, 'groups/marketing/salaries/2026.md'), /CANARY-SAL/],
  ['.system', path.join(h.team, '.system/history/old.bin'), /CANARY-SYS/],
  ['/etc/shadow', '/etc/shadow', /root:/],
  ['admin ~/.ssh', '/home/admin/.ssh/authorized_keys', /ssh-ed25519/],
]
for (const [what, file, re] of targets) {
  const outside = re.test(read(file))
  const r = await shell({ command: `cat '${file}' 2>&1 | head -c 300; echo; ls -la '${path.dirname(file)}' 2>&1 | head -5` })
  const leaked = re.test(r.text)
  say('X-read', !leaked, `read ${what}`, { file, positiveControl: outside ? 'the server account reads it outside srt' : 'NOT readable by the server account either (no srt evidence)', out: r.text.slice(0, 300) })
}
{
  const r = await shell({ command: 'TOKEN=$(curl -s -m 5 -X PUT -H "X-aws-ec2-metadata-token-ttl-seconds: 60" http://169.254.169.254/latest/api/token -w " %{http_code}"); echo "proxy: ${TOKEN##* }"; T2=$(curl -s --noproxy "*" -m 5 -X PUT -H "X-aws-ec2-metadata-token-ttl-seconds: 60" http://169.254.169.254/latest/api/token -w " %{http_code}"); echo "direct: ${T2##* }"' })
  let host = 0
  try { host = (await fetch('http://169.254.169.254/latest/api/token', { method: 'PUT', headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '60' }, signal: AbortSignal.timeout(5000) })).status } catch {}
  const ok = !/proxy: 200/.test(r.text) && !/direct: 200/.test(r.text)
  say('X-imds', host === 200 ? ok : false, 'IMDS token from the run (through the proxy and direct)', { serverAccountOutsideSrt: host, out: r.text })
}
{
  const tries = [`/usr/local/bin/bench-x`, `/opt/trina/srt/bench-x`, `${BASE}/data/bench-x`, `${BASE}/devenv/logs/alice/bench-x`, path.join(h.team, 'skills/bench-x'), path.join(h.team, 'groups/finance/bench-x'), '/etc/bench-x', '/var/tmp/bench-x', `${PROJECT}/.git/hooks/pre-commit`]
  fs.mkdirSync(`${PROJECT}/.git/hooks`, { recursive: true })
  const r = await shell({ command: tries.map((f) => `echo x > '${f}' 2>/dev/null && echo "WROTE ${f}" || echo "denied ${f}"`).join('; ') + '; echo ok > own-file.txt && echo "WROTE-PROJECT"' })
  const made = tries.filter((f) => fs.existsSync(f))
  say('X-write', made.length === 0 && /WROTE-PROJECT/.test(r.text) && fs.existsSync(`${PROJECT}/own-file.txt`), 'write outside the folders she may write (and the project file works)', { madeOnDisk: made, out: r.text.slice(0, 900) })
}
{
  const before = process.pid
  const r = await shell({ command: ':(){ :|:& };: ; sleep 15; echo after', timeout_sec: 25 })
  say('X-fork', r.mem.pids > 0 && r.mem.pids <= plan.pids && process.pid === before, 'fork bomb: stops at TasksMax; the server lives', { pidsPeak: r.mem.pids, tasksMax: plan.pids, head: r.text.split('\n')[0], seconds: r.seconds })
}
{
  let healthFails = 0, checks = 0
  const pid = process.pid
  const r = await shell({ command: 'python3 -c "b=[]\nwhile True: b.append(bytearray(64*2**20))"', job: true, log_name: 'membomb' })
  const [row] = await waitJobs(['membomb'], 300_000, () => { checks++; fetch('http://127.0.0.1:8099/health', { signal: AbortSignal.timeout(2000) }).then((x) => { if (!x.ok) healthFails++ }).catch(() => healthFails++) })
  const m = peaksOf([row!.unit])
  say('X-mem', row!.end_reason === 'oom' && process.pid === pid && healthFails === 0, 'memory bomb as a job: ends "oom"; the stand-in server lives and answers', { submit: r.text.split('\n')[0], endReason: row!.end_reason, exit: row!.exit_code, ...m, healthChecks: checks, healthFails, minAvailMiB: minAvail })
}

// srt's write denies in the cwd: a run killed at its time limit leaves no empty dotfiles; a run that ends first does
// not lift the denies of another run in the same folder (placeholders.ts)
const DOT = ['.bashrc', '.mcp.json', '.gitconfig', '.vscode', '.idea', '.claude', '.profile', '.zshrc']
{
  const r = await shell({ command: 'sleep 60', timeout_sec: 5 })
  const left = DOT.filter((f) => fs.existsSync(path.join(PROJECT, f)))
  say('X-left', left.length === 0, 'a command stopped at its time limit leaves no srt mount points in the project', { head: r.text.split('\n')[0], left })
}
{
  const a = await shell({ command: 'sleep 8; echo a-done', job: true, log_name: 'racea' })
  const b = await shell({ command: 'echo x > .bashrc 2>/dev/null && echo EARLY-WRITE-OK || echo early-denied; sleep 15; echo y > .bashrc 2>/dev/null && echo LATE-WRITE-OK || echo late-denied; echo z > .mcp.json 2>/dev/null && echo LATE-MCP-OK || echo late-mcp-denied', timeout_sec: 60 })
  const [ra] = await waitJobs(['racea'], 60_000)
  const left = DOT.filter((f) => fs.existsSync(path.join(PROJECT, f)))
  say('X-race', !/WRITE-OK|MCP-OK/.test(b.text) && ra!.exit_code === 0 && left.length === 0, 'a job in the same folder ends first: the command still cannot write .bashrc or .mcp.json', { job: a.text.split('\n')[0], out: b.text.slice(0, 300), left })
}

// ---- 5. two heavy jobs on Starter: the second waits (one person, then another person) ----
team({ limits: { ...DEV_ENV_DEFAULT_LIMITS, cpus: plan.cpus, memoryMiB: plan.memoryMiB, pids: plan.pids }, extraDomains: teamSetting(h.ctx.db).extraDomains })
{
  const a = await shell({ command: render('qa', null), job: true, log_name: 'renderA' })
  const b = await shell({ command: render('qb', null), job: true, log_name: 'renderB' })
  await Bun.sleep(1000); await pollSrt(h.ctx)
  const ra = rowOf('renderA')!, rb = rowOf('renderB')!
  const scopes = activeScopes()
  say('Q1', ra.state === 'running' && rb.state === 'waiting' && /position 1/.test(b.text) && scopes === 1, 'second heavy job waits (maxRunning 1)', { a: a.text.split('\n')[0], b: b.text.split('\n')[0], states: [ra.state, rb.state], activeScopes: scopes })
  let maxScopes = 0
  const rows = await waitJobs(['renderA', 'renderB'], 2400_000, () => { maxScopes = Math.max(maxScopes, activeScopes()) })
  const [ea, eb] = rows
  const order = ea!.ended_at && eb!.run_at ? Date.parse(eb!.run_at) >= Date.parse(ea!.ended_at) - 3000 : false
  say('Q2', ea!.exit_code === 0 && eb!.exit_code === 0 && order && maxScopes <= 1, 'both renders end with exit 0; B starts after A ends; never two scopes', {
    maxScopes, A: { jobSeconds: jobSeconds(ea!), waitSeconds: 0, ...peaksOf([ea!.unit]), log: logOf('renderA').slice(-500) },
    B: { waitSeconds: eb!.run_at ? (Date.parse(eb!.run_at) - Date.parse(eb!.started_at)) / 1000 : null, jobSeconds: jobSeconds(eb!), ...peaksOf([eb!.unit]), log: logOf('renderB').slice(-500) }, minAvailMiB: minAvail,
  })
}
// a chat with no project and another person: the same queue (per team)
{
  const a = await shell({ command: 'sleep 20; echo done-a', job: true, log_name: 'sa' }, { project: false, chat: chatPlain })
  const b = await shell({ command: 'echo done-b', job: true, log_name: 'sb' }, { user: 'bob', project: false, chat: chatBob })
  const rows = await waitJobs(['sa', 'sb'], 120_000)
  say('Q3', /Started as job/.test(a.text) && /Queued as job/.test(b.text) && rows.every((r) => r.exit_code === 0), 'a chat with no project and another person share the team queue', { a: a.text.split('\n')[0], b: b.text.split('\n')[0], exits: rows.map((r) => r.exit_code) })
}

say('END', null, 'done', { minAvailMiB: minAvail, serverPid: process.pid })
console.log(`results in ${RESULTS}`)
void health
await new Promise(() => {})
