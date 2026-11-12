// Dev environment on a Mac team server: attack checks on a real Mac (docs/DECISIONS.md "Dev environment on a Mac team
// server"; the Linux list is docs/research/srt-dev-env.md 10.2). Runs AS THE SERVER ACCOUNT of a TEST install
// (scripts/install-macos.sh --id <something>-test), started by tests/macos/srt-attack-mac.sh, which passes the server's
// environment (the MYCEL_DEV_ENV_* values of its LaunchDaemon). It makes team folders with canary strings in every place
// a run must not see, then runs each attack through the same pieces as the runner: folderView, srtSettings (darwin),
// runEnv, and the macOS SrtSystem (sudo to a dev slot account, run-wrap-mac, srt-mac.mjs). An attack passes when no
// canary comes back and its check holds. It prints one line per attack and exits 1 when one fails.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { RuleSet, type Access } from '../../server/src/policy/access'
import { folderView } from '../../server/src/devenv/srt/access'
import { holdPlaceholders } from '../../server/src/devenv/srt/placeholders'
import { chatWork, devenvPaths, personHome, personLogs, resolveRunCwd, runEnv, settingsProblems, srtSettings } from '../../server/src/devenv/srt/config'
import { macConfig, macSystem, realMacHost } from '../../server/src/devenv/srt/system-mac'

const BASE = process.env.MYCEL_INSTALL_BASE ?? ''
const ID = path.basename(BASE)
if (!/-test$/.test(ID) || !BASE.startsWith('/Library/Application Support/')) { console.error('only on a test install (an id that ends in -test)'); process.exit(2) }
const mc = macConfig(BASE)
if (!mc.ok) { console.error(mc.reason); process.exit(2) }
const sys = macSystem(mc.c)
const host = realMacHost()
const TEAM = `${BASE}/team`
const DIR1 = `${TEAM}/projects/one`
const CANARY = 'CANARY-mac-5e1d'
const ME = 'alice'
const SERVER_PORT = Number(process.env.ATTACK_SERVER_PORT ?? 0), PROXY_PORT = Number(process.env.ATTACK_PROXY_PORT ?? 0), TLS_PORT = Number(process.env.ATTACK_TLS_PORT ?? 0)
const LAN_IP = process.env.ATTACK_LAN_IP ?? ''
const OWNER_HOME = process.env.ATTACK_OWNER_HOME ?? '/Users'
const PROBE = process.env.ATTACK_PROBE ?? ''

// ---- the team server's folders, with canaries (the server account writes them) ----
const w = (rel: string, text: string) => { const f = path.join(TEAM, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text) }
for (const [d, f] of [['data', 'attack-canary.txt'], ['secrets', 'attack-canary'], ['config', 'attack-canary.json']] as const) fs.writeFileSync(path.join(BASE, d, f), `${CANARY}-${d}`)
w('projects/one/readme.md', 'hello from p1\n')
w('groups/finance/budget.md', `${CANARY}-finance`)
w('projects/two/private.md', `${CANARY}-other-project`)
w('users/alice/todo.md', 'alice todo\n')
w('users/bob/notes.md', `${CANARY}-bob`)
w('.system/history/old.bin', `${CANARY}-system`)
fs.mkdirSync(`${DIR1}/.git/hooks`, { recursive: true }); fs.writeFileSync(`${DIR1}/.git/config`, '[core]\n')
if (PROBE) fs.copyFileSync(PROBE, `${DIR1}/argv-probe`), fs.chmodSync(`${DIR1}/argv-probe`, 0o755)
for (const u of [ME, 'bob']) { fs.mkdirSync(path.join(personHome(BASE, u), 'tmp'), { recursive: true }); fs.mkdirSync(personLogs(BASE, u), { recursive: true }) }
fs.writeFileSync(path.join(personHome(BASE, 'bob'), 'secret'), `${CANARY}-other-home`)
fs.mkdirSync(chatWork(BASE, 'chat-2'), { recursive: true }); fs.writeFileSync(path.join(chatWork(BASE, 'chat-2'), 'x'), `${CANARY}-other-chat`)
fs.rmSync(`${DIR1}/link-to-data`, { force: true }); fs.symlinkSync(`${BASE}/data/attack-canary.txt`, `${DIR1}/link-to-data`)
const RULES = new RuleSet(([
  ['projects/one', 'user', ME, 'write'], ['projects/two', 'group', 'finance', 'write'], ['groups/finance', 'group', 'finance', 'write'],
] as [string, 'everyone' | 'group' | 'user', string | null, Access][]).map(([p, t, s, a]) => ({ path: p, subject_type: t, subject_id: s, access: a })))
const ALICE = { id: ME, name: 'Alice', role: 'member' as const, groups: [] as string[] }

// "the server's" process: an argv and an environment with a canary, as the server account
const victim = Bun.spawn(['/bin/sleep', '600'], { env: { PATH: '/usr/bin:/bin', SERVER_SECRET: `${CANARY}-server-env` }, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })

// runs of an earlier attack run that stopped half-way: their state files would refuse the same run ids
for (const f of fs.readdirSync(devenvPaths(BASE).run)) if (f.startsWith('mattack')) fs.rmSync(path.join(devenvPaths(BASE).run, f), { force: true })

// ---- one run, as the runner does it ----
let n = 0
interface Res { code: number | null; out: string; oom: boolean; timeout: boolean; ms: number; runId: string }
async function run(command: string, o: { timeoutMs?: number; limits?: { memoryMiB?: number; pids?: number }; during?: (runId: string) => Promise<void>; background?: boolean } = {}): Promise<Res> {
  const runId = `mattack${String(++n).padStart(9, '0')}`
  const view = folderView(RULES, ALICE, { start: 'projects/one' })
  const input = { base: BASE, id: ID, teamRoot: TEAM, userId: ME, view, start: 'projects/one', work: null, network: 'open' as const, extraDomains: [], userDomains: [], full: false, denyHosts: ['team.trina.test'], denyAddrs: LAN_IP ? [LAN_IP] : [], platform: 'darwin' as const, serverPaths: [`${BASE}/data`, `${BASE}/secrets`, `${BASE}/config`] }
  const settings = srtSettings(input)
  const problems = settingsProblems(settings, input)
  if (problems.length) throw new Error(problems.join('; '))
  const cwd = resolveRunCwd(DIR1, '')!
  const settingsFile = path.join(devenvPaths(BASE).run, `${runId}.json`)
  fs.mkdirSync(devenvPaths(BASE).run, { recursive: true, mode: 0o700 })
  fs.writeFileSync(settingsFile, JSON.stringify(settings), { mode: 0o600 })
  const exitFile = path.join(personLogs(BASE, ME), `${runId}.exit`)
  const outFile = path.join(personLogs(BASE, ME), `${runId}.out`)
  const release = holdPlaceholders(cwd)
  const t0 = Date.now()
  const sp = await sys.spawn({
    runId, id: ID, cwd, env: runEnv({ base: BASE, userId: ME, teamRoot: TEAM, work: null, platform: 'darwin' }),
    limits: { cpus: 1, memoryMiB: o.limits?.memoryMiB ?? 1024, pids: o.limits?.pids ?? 256, runtimeMaxSec: Math.ceil((o.timeoutMs ?? 60_000) / 1000) + 30 },
    exitFile, settingsFile, command, stdoutFile: outFile, stderrFile: outFile, writable: settings.filesystem.allowWrite,
  })
  if (o.background) return { code: null, out: '', oom: false, timeout: false, ms: 0, runId }
  const timer = setTimeout(() => void sys.stop(runId), o.timeoutMs ?? 60_000)
  if (o.during) void o.during(runId)
  await sp.exited
  clearTimeout(timer)
  const r = await finish(runId, exitFile, outFile, settingsFile)
  release()
  return { ...r, ms: Date.now() - t0, runId }
}
async function finish(runId: string, exitFile: string, outFile: string, settingsFile: string) {
  const code = fs.existsSync(exitFile) ? Number(fs.readFileSync(exitFile, 'utf8').trim()) : null
  const oom = sys.oomKills(runId) === 1, timeout = (await sys.unit(runId)).result === 'timeout'
  const out = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : ''
  await sys.forget(runId)
  for (const f of [exitFile, outFile, settingsFile]) fs.rmSync(f, { force: true })
  return { code, out, oom, timeout }
}
/** every slot is empty, within 5 s (the watchdog checks the slot for a moment after the run ended) */
const slotEmpty = async () => {
  const empty = () => mc.c.slots.every((a) => { const u = host.uid(a); return u === null || host.procs([u]).length === 0 })
  for (let i = 0; i < 50 && !empty(); i++) await Bun.sleep(100)
  return empty()
}
async function health(): Promise<boolean> {
  try { return (await fetch(`http://127.0.0.1:${SERVER_PORT}/api/health`, { signal: AbortSignal.timeout(5000) })).ok } catch { return false }
}
async function serverCanSpawn(): Promise<boolean> {
  const p = Bun.spawn(['/usr/bin/true'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
  return (await Promise.race([p.exited, Bun.sleep(5000).then(() => -1)])) === 0
}

type Check = (r: Res) => string | null
const failsQuietly: Check = (r) => (r.code === 0 ? `exit code 0: ${r.out.slice(0, 200)}` : null)
const ok: Check = (r) => (r.code === 0 ? null : `exit code ${r.code}: ${r.out.slice(0, 300)}`)
const has = (s: string): Check => (r) => (r.out.includes(s) ? null : `no "${s}" in: ${r.out.slice(0, 300)}`)
/** the output without the refusals (a refused cat or ls names the path it was refused) */
const shown = (out: string) => out.split('\n').filter((l) => !/Operation not permitted|Permission denied|No such file or directory/.test(l)).join('\n')
const not = (re: RegExp, why: string): Check => (r) => (re.test(shown(r.out)) ? `${why}: ${shown(r.out).slice(0, 300)}` : null)
const both = (...cs: Check[]): Check => (r) => cs.map((c) => c(r)).find((x) => x) ?? null
const noCanary: Check = (r) => (r.out.includes(CANARY) ? `a canary came back: ${r.out.slice(r.out.indexOf(CANARY) - 80, r.out.indexOf(CANARY) + 60)}` : null)

const results: { id: string; what: string; pass: boolean; note: string }[] = []
async function attack(id: string, what: string, cmd: string, check: Check, o: Parameters<typeof run>[1] = {}, after?: () => Promise<string | null> | string | null) {
  let note = ''
  try {
    const r = await run(cmd, o)
    note = noCanary(r) ?? check(r) ?? (after ? (await after()) ?? '' : '')
    if (!note) note = `ok (${r.ms} ms${r.oom ? ', oom' : ''}${r.timeout ? ', timeout' : ''})`, results.push({ id, what, pass: true, note })
    else results.push({ id, what, pass: false, note })
  } catch (e) { results.push({ id, what, pass: false, note: `error: ${(e as Error).message.slice(0, 300)}` }) }
  const last = results[results.length - 1]!
  console.log(`${last.pass ? 'PASS' : 'FAIL'} ${id} ${what}: ${last.note}`)
}

// the restart check (srt-attack-mac.sh): started by a LaunchDaemon as the server account, this process starts one run
// and waits; launchd then ends this job, and the run must keep going (a server restart or update keeps the runs)
if (process.env.ATTACK_MODE === 'restart-spawn') {
  const r = await run('sleep 45; echo survived', { background: true })
  // a file, not stdout: bun keeps stdout to a file in its buffer while this process sleeps
  fs.writeFileSync(process.env.ATTACK_RESTART_OUT ?? '/dev/null', `RUN ${r.runId} ${sys.slotOf(r.runId)?.account}\n`)
  await Bun.sleep(600_000)
  process.exit(0)
}

// ---- the checks ----
await attack('M0', 'a normal run: the project folder reads and writes, node runs, an allowed site answers, the slot account is not the server\'s',
  'id -un; cat readme.md && echo new > new.txt && cat new.txt && node -e "console.log(\'node-ok\')" && curl -s -o /dev/null -w "npm:%{http_code}\\n" https://registry.npmjs.org/ && echo PORT=$PORT',
  both(ok, has('hello from p1'), has('node-ok'), has('npm:200'), has('PORT='), not(/^_axserver|server$/m, 'runs as the server account')), { timeoutMs: 120_000 },
  () => (fs.existsSync(`${DIR1}/new.txt`) && fs.statSync(`${DIR1}/new.txt`).uid !== process.getuid!() ? null : 'new.txt is missing or the server\'s'))
await attack('M1', 'read the server\'s DB folder, secrets and config (canaries); list the base folder', `cat "${BASE}/data/attack-canary.txt"; cat "${BASE}/secrets/attack-canary"; cat "${BASE}/config/attack-canary.json"; ls "${BASE}"; grep -rs ${CANARY} "${BASE}/data" "${BASE}/secrets"; true`, () => null)
await attack('M1b', 'a link in the project folder to the DB folder\'s canary', 'cat link-to-data; true', () => null)
await attack('M2', 'folders the person may not open: another project, another group, another person\'s folder, .system', `cat "${TEAM}/projects/two/private.md"; cat "${TEAM}/groups/finance/budget.md"; cat "${TEAM}/users/bob/notes.md"; cat "${TEAM}/.system/history/old.bin"; ls -a "${TEAM}" "${TEAM}/users"; true`,
  not(/\bbob\b|\.system|\bfinance\b/, 'a hidden folder is listed'))
await attack('M2b', 'another person\'s home and another chat\'s work folder', `cat "${personHome(BASE, 'bob')}/secret"; cat "${chatWork(BASE, 'chat-2')}/x"; ls "${devenvPaths(BASE).home}"; true`, not(/\bbob\b/, 'another person is listed'))
await attack('M3', 'the Mac: people\'s homes, the server\'s logs, its temp folder, other disks, sudoers, the password database', `ls ${OWNER_HOME}; cat ${OWNER_HOME}/.zshrc ${OWNER_HOME}/.ssh/id_ed25519; ls "/Library/Logs/${ID}" /private/var/folders /Volumes /private/etc/sudoers.d; cat /private/etc/master.passwd /etc/sudoers; ls /Library/Keychains; true`,
  not(/id_ed25519|\bserver\b.*\blog\b|PRIVATE KEY/, 'a host file was read'))
await attack('M3b', 'write the system and the Trina tools', 'touch /opt/trina/srt/x || touch /opt/trina/node/bin/x || touch /usr/local/x || touch /Library/x || touch /tmp/x', failsQuietly)
await attack('M4', 'write the logs (the exit files) and the run folder (settings files)', `echo 0 > "${personLogs(BASE, ME)}/forged.exit" || echo x > "${devenvPaths(BASE).run}/x.json"`, failsQuietly,
  {}, () => (fs.existsSync(`${personLogs(BASE, ME)}/forged.exit`) ? 'an exit file was forged' : null))
await attack('M5', 'a canary that appears in the secrets folder while the run runs', `sleep 3; cat "${BASE}/secrets/late-canary"; ls "${BASE}/secrets"; true`, () => null,
  { during: async () => { await Bun.sleep(1000); fs.writeFileSync(`${BASE}/secrets/late-canary`, `${CANARY}-late`) } })
await attack('M6', '.git/hooks and .git/config of the project stay read-only', 'echo "curl evil" > .git/hooks/pre-commit || echo "[core] hooksPath=/x" >> .git/config', failsQuietly,
  {}, () => (fs.existsSync(`${DIR1}/.git/hooks/pre-commit`) || fs.readFileSync(`${DIR1}/.git/config`, 'utf8').includes('hooksPath') ? 'a git file changed' : null))
// localhost is the whole Mac's
await attack('M7', 'reach the server\'s port, the model proxy and the office TLS port on localhost, ::1 and the LAN address (direct and through srt\'s proxy)',
  [SERVER_PORT, PROXY_PORT, TLS_PORT].filter(Boolean).flatMap((p) => [`curl -s -m 4 --noproxy '*' http://127.0.0.1:${p}/api/health`, `curl -s -m 4 --noproxy '*' 'http://[::1]:${p}/api/health'`, `curl -s -m 4 http://127.0.0.1:${p}/api/health`, ...(LAN_IP ? [`curl -sk -m 4 --noproxy '*' https://${LAN_IP}:${p}/api/health`, `curl -sk -m 4 https://${LAN_IP}:${p}/api/health`] : [])]).map((c) => `${c}; echo " <- ${c.replace(/[^a-z0-9:./[\]-]/gi, '').slice(0, 60)}"`).join('; '),
  not(/"ok"|version|status/i, 'the server answered'))
await attack('M8', 'the internet with no proxy, UDP DNS, a site not on the list, the metadata address, a private address', `curl -s -m 4 --noproxy '*' https://1.1.1.1/ && echo DIRECT; dig +time=2 +tries=1 @8.8.8.8 example.com | grep -c ANSWER; curl -s -m 5 -o /dev/null -w "blocked-site:%{http_code}\\n" https://example.org/; curl -s -m 4 -o /dev/null -w "meta:%{http_code}\\n" http://169.254.169.254/latest/meta-data/; curl -s -m 4 -o /dev/null -w "private:%{http_code}\\n" http://192.168.1.1/; true`,
  both(not(/DIRECT/, 'the internet without the proxy'), not(/blocked-site:200|meta:200|private:200/, 'a blocked place answered')))
await attack('M9', 'the server\'s Unix sockets (tools, launcher)', `nc -U -w 2 "${BASE}/run/tools/tools.sock" </dev/null && echo TOOLS; nc -U -w 2 "${BASE}/run-launcher/launcher.sock" </dev/null && echo LAUNCHER; true`, not(/TOOLS|LAUNCHER/, 'a server socket answered'))
await attack('M10', 'the process list of the Mac, kill the server, sudo, ps (setuid)', `sysctl kern.proc.all >/dev/null 2>&1 && echo LISTED; kill -9 ${process.pid} && echo KILLED; sudo -n true && echo SUDO; /bin/ps ax | head -3; true`,
  not(/LISTED|KILLED|SUDO|PID +TT/, 'it worked'), {}, async () => (await health() ? null : 'the server does not answer'))
// KERN_PROCARGS2: the reason for a uid per run
if (PROBE) {
  const b = await run(`export B_SECRET=${CANARY}-run-b-env; exec -a ${CANARY}-run-b-argv /bin/sleep 60`, { background: true })
  await Bun.sleep(2500)
  const bAcct = sys.slotOf(b.runId)?.account ?? ''
  const bPids = host.procs([host.uid(bAcct) ?? -1]).map((p) => p.pid)
  const serverPids = [victim.pid, process.pid]
  await attack('M11', `read the argv and environment of the server's processes and of another run (pids ${[...serverPids, ...bPids].join(' ')}) with KERN_PROCARGS2`, `./argv-probe ${[...serverPids, ...bPids].join(' ')}`,
    (r) => (/error/.test(r.out) ? null : `the probe read something: ${r.out.slice(0, 200)}`))
  await sys.stop(b.runId)
  await finish(b.runId, path.join(personLogs(BASE, ME), `${b.runId}.exit`), path.join(personLogs(BASE, ME), `${b.runId}.out`), path.join(devenvPaths(BASE).run, `${b.runId}.json`))
} else results.push({ id: 'M11', what: 'KERN_PROCARGS2', pass: false, note: 'not run: no probe (needs cc)' })
// another run's dev server, and the preview from the server
{
  const b = await run('node -e "require(\'http\').createServer((q,r)=>r.end(\'run-b-dev-server\')).listen(process.env.PORT)"', { background: true })
  await Bun.sleep(2500)
  const port = sys.slotOf(b.runId)?.port ?? 0
  let preview = ''
  try { preview = await (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) })).text() } catch (e) { preview = String(e) }
  results.push({ id: 'M12a', what: `preview: the server reaches a run's dev server on 127.0.0.1:${port}`, pass: preview === 'run-b-dev-server', note: preview.slice(0, 100) })
  console.log(`${preview === 'run-b-dev-server' ? 'PASS' : 'FAIL'} M12a preview from the server: ${preview.slice(0, 80)}`)
  await attack('M12', `another run's dev server on port ${port}; listen on a port that is not the run's own, or on the server's port`, `curl -s -m 3 --noproxy '*' http://127.0.0.1:${port}/; curl -s -m 3 http://127.0.0.1:${port}/; node -e "require('net').createServer().listen(${mc.c.portBase + mc.c.slots.length + 50}).on('error',e=>console.log('bind-other:'+e.code)).on('listening',()=>{console.log('BOUND');process.exit()})"; node -e "require('net').createServer().listen(${port}).on('error',e=>console.log('bind-run-b:'+e.code)).on('listening',()=>{console.log('BOUND');process.exit()})"; node -e "require('net').createServer().listen(${SERVER_PORT}).on('error',e=>console.log('bind-server:'+e.code)).on('listening',()=>{console.log('BOUND');process.exit()})"; true`,
    both(not(/run-b-dev-server|BOUND/, 'another run was reached or a port was taken'), has('bind-other:EPERM')))
  // from another computer (pf: nothing from outside the Mac reaches a run's port): from this Mac the LAN address goes
  // over lo0, so ATTACK_OUTSIDE_WAIT keeps the dev server up for that many seconds while srt-attack-mac.sh's caller
  // tries it from outside (curl http://<this Mac>:<port>/)
  const wait = Number(process.env.ATTACK_OUTSIDE_WAIT ?? 0)
  if (wait > 0) { console.log(`OUTSIDE try now: curl -m 3 http://<this Mac>:${port}/ (${wait} s)`); await Bun.sleep(wait * 1000) }
  await sys.stop(b.runId)
  await finish(b.runId, path.join(personLogs(BASE, ME), `${b.runId}.exit`), path.join(personLogs(BASE, ME), `${b.runId}.out`), path.join(devenvPaths(BASE).run, `${b.runId}.json`))
}
await attack('M13', 'a process that leaves the session (setsid nohup sleep &): gone when the command ends', 'perl -e \'use POSIX; if (fork) { exit 0 } setsid(); exec "/bin/sleep", "600"\'; nohup /bin/sleep 600 >/dev/null 2>&1 & disown; echo started', has('started'),
  {}, async () => (await slotEmpty() ? null : 'a process of the slot is still there'))
// limits
let bombHealth = true, bombSpawn = true
await attack('M14', 'a fork bomb: stopped at the process limit; the server answers and can still start a program; nothing left after', ':(){ :|:& };:', () => null,
  { timeoutMs: 20_000, limits: { pids: 256 }, during: async () => { for (let i = 0; i < 4; i++) { await Bun.sleep(3000); bombHealth &&= await health(); bombSpawn &&= await serverCanSpawn() } } },
  async () => { await Bun.sleep(1000); return !bombHealth ? 'the server did not answer during the bomb' : !bombSpawn ? 'the server could not start a program during the bomb' : (await slotEmpty()) ? null : 'processes are left' })
for (const [kind, js] of [['ones', 'Buffer.alloc(64<<20, 1)'], ['zeros written', 'Buffer.alloc(64<<20).fill(0)'], ['random', 'require("crypto").randomFillSync(Buffer.allocUnsafe(64<<20))']] as const) {
  await attack(`M15 ${kind}`, `a RAM flood (${kind}) over the run's 1024 MiB: the watchdog ends it (oom); the server answers`, `node -e 'const a=[];setInterval(()=>a.push(${js}),40)'`,
    (r) => (r.oom ? null : `not ended as oom (code ${r.code}, ${r.ms} ms)`), { timeoutMs: 60_000, limits: { memoryMiB: 1024 } },
    async () => (await health() ? ((await slotEmpty()) ? null : 'processes are left') : 'the server does not answer'))
}
await attack('M16', 'the time limit: the run ends (stopped by the runner\'s timer)', 'sleep 120', (r) => (r.ms < 20_000 ? null : `ran ${r.ms} ms`), { timeoutMs: 5000 })

victim.kill()
for (const f of ['data/attack-canary.txt', 'secrets/attack-canary', 'secrets/late-canary', 'config/attack-canary.json']) fs.rmSync(path.join(BASE, f), { force: true })
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length} of ${results.length} passed`)
fs.writeFileSync(process.env.ATTACK_REPORT ?? '/dev/null', JSON.stringify(results, null, 1))
process.exit(failed.length ? 1 : 0)
