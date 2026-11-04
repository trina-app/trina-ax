// Dev environment on srt: attack suite (docs/research/srt-dev-env.md 10.2). Runs INSIDE the Docker image of
// tests/linux/Dockerfile.srt as root: it makes a team server's folders with canary strings in every place a run must
// not see, then runs each attack as the server account through the same pieces as the runner (srtSettings, runEnv,
// resolveRunCwd, run-wrap, srt), with no systemd scope. An attack passes when no canary comes back and its check holds.
// Lines that need systemd and polkit (A17, A21-A23, A25, A26) and chromium (A24) run on the spike VM.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { devenvPaths, resolveRunCwd, runEnv, srtSettings, settingsProblems, wrappedArgv } from '../../server/src/devenv/srt/config'

const ID = 'mycel'
const BASE = `/var/lib/${ID}`
const TEAM = `${BASE}/team`
const P1 = 'p1', P2 = 'p2'
const DIR1 = `${TEAM}/projects/one`, DIR2 = `${TEAM}/projects/two`
const SRV = 'axserver'
const CANARY = 'CANARY-7f3a'

function sh(cmd: string) { const r = Bun.spawnSync(['bash', '-c', cmd]); if (r.exitCode !== 0) throw new Error(`${cmd}: ${r.stderr.toString()}`) }

// ---- the team server's folders (as install-linux.sh and the server make them) ----
for (const d of ['data', 'secrets', 'config', 'agent/codex-auth', 'root', 'run/tools', 'devenv/run']) fs.mkdirSync(path.join(BASE, d), { recursive: true })
fs.mkdirSync(DIR1, { recursive: true }); fs.mkdirSync(DIR2, { recursive: true })
fs.writeFileSync(`${BASE}/data/app.db`, `${CANARY}-db`)
fs.writeFileSync(`${BASE}/secrets/master.key`, `${CANARY}-secret`)
fs.writeFileSync(`${BASE}/config/server.json`, `{"x":"${CANARY}-config"}`)
fs.writeFileSync(`${BASE}/agent/codex-auth/auth.json`, `${CANARY}-codex`)
fs.writeFileSync(`${DIR2}/private.md`, `${CANARY}-other-project`)
fs.writeFileSync(`${DIR1}/readme.md`, 'hello from p1\n')
fs.mkdirSync(`${DIR1}/.git/hooks`, { recursive: true }); fs.writeFileSync(`${DIR1}/.git/config`, '[core]\n')
fs.mkdirSync('/etc/default', { recursive: true }); fs.writeFileSync(`/etc/default/${ID}`, `MYCEL_TOKEN=${CANARY}-etcdefault\n`)
fs.mkdirSync('/tmp/server-private', { recursive: true }); fs.writeFileSync('/tmp/server-private/t', `${CANARY}-tmp`)
fs.mkdirSync(`/run/${ID}`, { recursive: true }); fs.writeFileSync(`/run/${ID}/x`, `${CANARY}-run`)
for (const p of [P1, P2]) { const d = devenvPaths(BASE, p); fs.mkdirSync(path.join(d.home, 'tmp'), { recursive: true }); fs.mkdirSync(d.logs, { recursive: true }) }
fs.writeFileSync(path.join(devenvPaths(BASE, P2).home, 'secret'), `${CANARY}-other-home`)
sh(`chown -R ${SRV}:${SRV} ${BASE} /tmp/server-private /run/${ID} && chown root:${SRV} /etc/default/${ID} && chmod 640 /etc/default/${ID}`)
// a host name that resolves to a private address, one to loopback (the resolved-address check)
fs.appendFileSync('/etc/hosts', '10.11.12.13 private.attack.test\n127.0.0.1 loop.attack.test\n')
// "the Trina server": a port on the host's loopback, and a unix socket
const server = Bun.serve({ hostname: '127.0.0.1', port: 8099, fetch: () => new Response(`${CANARY}-server`) })
const unixSock = `${DIR1}/server.sock`
const us = net.createServer((c) => c.end(`${CANARY}-unix`)).listen(unixSock)
await new Promise((r) => us.on('listening', r))
sh(`chown ${SRV} ${unixSock}`)
process.env.MYCEL_LEAK = `${CANARY}-env`

// ---- one run, as the runner does it (no scope) ----
let n = 0
async function run(command: string, o: { network?: 'open' | 'offline'; cwd?: string; extra?: string[]; during?: () => void; timeoutMs?: number } = {}): Promise<{ code: number | null; out: string; refused?: string }> {
  const runId = `attack${String(++n).padStart(10, '0')}`
  const settings = srtSettings({ base: BASE, id: ID, projectId: P1, projectDir: DIR1, teamRoot: TEAM, network: o.network ?? 'open', extraDomains: o.extra ?? [], denyHosts: ['team.trina.test'], denyAddrs: ['203.0.113.7'] })
  const problems = settingsProblems(settings, { base: BASE, projectDir: DIR1, teamRoot: TEAM })
  if (problems.length) throw new Error(problems.join('; '))
  const cwd = resolveRunCwd(DIR1, o.cwd ?? '')
  if (!cwd) return { code: null, out: '', refused: 'cwd' }
  const settingsFile = path.join(devenvPaths(BASE).run, `${runId}.json`)
  fs.writeFileSync(settingsFile, JSON.stringify(settings), { mode: 0o600 }); sh(`chown ${SRV} ${settingsFile}`)
  const exitFile = path.join(devenvPaths(BASE, P1).logs, `${runId}.exit`)
  const argv = ['setpriv', `--reuid=${SRV}`, `--regid=${SRV}`, '--init-groups', '--', ...wrappedArgv({ exitFile, settingsFile, command })]
  const p = Bun.spawn(argv, { cwd, env: runEnv({ base: BASE, projectId: P1 }), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const t = setTimeout(() => p.kill('SIGKILL'), o.timeoutMs ?? 60_000)
  if (o.during) setTimeout(o.during, 1500)
  const [a, b] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  await p.exited; clearTimeout(t)
  const code = fs.existsSync(exitFile) ? Number(fs.readFileSync(exitFile, 'utf8').trim()) : null
  fs.rmSync(settingsFile, { force: true }); fs.rmSync(exitFile, { force: true })
  return { code, out: a + b }
}

type Check = (r: { code: number | null; out: string; refused?: string }) => string | null
const failsQuietly: Check = (r) => (r.code === 0 ? `exit code 0: ${r.out.slice(0, 200)}` : null)
const ok: Check = (r) => (r.code === 0 ? null : `exit code ${r.code}: ${r.out.slice(0, 300)}`)
const has = (s: string): Check => (r) => (r.out.includes(s) ? null : `no "${s}" in: ${r.out.slice(0, 300)}`)
const both = (...cs: Check[]): Check => (r) => cs.map((c) => c(r)).find((x) => x) ?? null

const attacks: { id: string; what: string; cmd: string; check: Check; o?: Parameters<typeof run>[1]; after?: () => string | null }[] = [
  { id: 'A0', what: 'the project folder: read and write', cmd: 'cat readme.md && echo new > new.txt && cat new.txt && echo $HOME && touch $TMPDIR/x', check: both(ok, has('hello from p1'), has('new')) },
  { id: 'A1', what: 'the DB, secrets, config, engine logins', cmd: `cat ${BASE}/data/app.db || cat ${BASE}/secrets/master.key || cat ${BASE}/config/server.json || cat ${BASE}/agent/codex-auth/auth.json || grep -r ${CANARY} ${BASE}`, check: failsQuietly },
  // srt shows the folders on the way to the project folder, with only that path in them
  { id: 'A2', what: 'another project folder; the team folder list', cmd: `cat ${DIR2}/private.md 2>/dev/null; ls -a ${TEAM} ${TEAM}/projects`, check: (r) => (/\btwo\b|\bdata\b/.test(r.out) ? `another folder is listed: ${r.out.slice(0, 200)}` : null) },
  { id: 'A3', what: 'environment: no server values', cmd: 'env; cat /proc/self/environ | tr "\\0" "\\n"; cat /proc/1/environ', check: (r) => (/MYCEL_/.test(r.out) ? 'a MYCEL_ variable' : null) },
  { id: 'A4', what: '/etc/default/<ID>, the server /tmp, /run/<ID>', cmd: `cat /etc/default/${ID} || cat /tmp/server-private/t || cat /run/${ID}/x || ls /tmp/server-private || ls /run/${ID}`, check: failsQuietly },
  { id: 'A5', what: 'a secret made after the run started', cmd: `sleep 4; cat ${BASE}/secrets/late.key || ls ${BASE}/secrets`, check: failsQuietly, o: { during: () => { fs.writeFileSync(`${BASE}/secrets/late.key`, `${CANARY}-late`); sh(`chown ${SRV} ${BASE}/secrets/late.key`) } } },
  { id: 'A6', what: 'write system tools, srt, the logs, another home', cmd: `touch /usr/local/bin/x || touch /opt/trina/srt/0.0.81/x || touch $TRINA_LOGS/x || touch ${devenvPaths(BASE, P2).home}/x || cat ${devenvPaths(BASE, P2).home}/secret || echo pwned > /opt/trina/devenv/run-wrap`, check: failsQuietly },
  { id: 'A7', what: 'forge an exit file; read or write a settings file', cmd: `echo 0 > $TRINA_LOGS/forged.exit || ls ${BASE}/devenv/run || echo {} > ${BASE}/devenv/run/x.json`, check: failsQuietly },
  { id: 'A8', what: '.git/hooks and .git/config', cmd: 'echo "curl evil" > .git/hooks/pre-commit || echo "[core] hooksPath=/tmp" >> .git/config', check: failsQuietly, after: () => (fs.existsSync(`${DIR1}/.git/hooks/pre-commit`) || fs.readFileSync(`${DIR1}/.git/config`, 'utf8').includes('hooksPath') ? 'a git file changed' : null) },
  { id: 'A9', what: 'a link to a denied file', cmd: `ln -sf ${BASE}/secrets/master.key l && cat l; ln ${BASE}/secrets/master.key hl && cat hl`, check: failsQuietly },
  { id: 'A10', what: 'a cwd through a link out of the project', cmd: 'cat master.key', check: (r) => (r.refused === 'cwd' ? null : 'the cwd was not refused'), o: { cwd: 'escape' } },
  { id: 'A11', what: 'network with no proxy: TCP, DNS, UDP', cmd: 'curl -fsS -m 5 --noproxy "*" https://1.1.1.1/ || python3 -c "import socket;s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.settimeout(3);s.sendto(b\\"x\\",(\\"8.8.8.8\\",53));print(s.recv(10))"', check: failsQuietly },
  { id: 'A12', what: 'a site not on the list, through the proxy', cmd: 'curl -fsS -m 10 -o /dev/null -w "%{http_code}" https://example.com/', check: failsQuietly },
  { id: 'A12b', what: 'a site on the list works', cmd: 'curl -fsS -m 20 -o /dev/null -w "%{http_code}" https://registry.npmjs.org/', check: both(ok, has('200')) },
  { id: 'A13', what: 'metadata, private ranges, names that resolve inside', cmd: 'curl -fsS -m 5 http://169.254.169.254/latest/meta-data/ || curl -fsS -m 5 http://10.11.12.13/ || curl -fsS -m 5 http://private.attack.test/ || curl -fsS -m 5 http://loop.attack.test:8099/ || curl -fsS -m 5 http://203.0.113.7/', check: failsQuietly, o: { extra: ['private.attack.test', 'loop.attack.test'] } },
  { id: 'A14', what: 'the Trina server port and host name', cmd: 'curl -fsS -m 5 http://127.0.0.1:8099/ || curl -fsS -m 5 --noproxy "*" http://127.0.0.1:8099/ || curl -fsS -m 5 https://team.trina.test/', check: failsQuietly },
  { id: 'A15', what: 'git over ssh', cmd: 'GIT_TERMINAL_PROMPT=0 timeout 20 git clone ssh://git@example.com/x.git /tmp/x', check: failsQuietly },
  { id: 'A16', what: 'a unix socket of the server', cmd: `python3 -c "import socket;s=socket.socket(socket.AF_UNIX);s.connect('${unixSock}');print(s.recv(100))"`, check: failsQuietly },
  // the sandbox has its own pid space: the same number names one of its own processes, never the server
  { id: 'A18', what: 'see the server process', cmd: `ps axww; cat /proc/${process.pid}/cmdline; ls /proc/${process.pid}/root/opt/mycel`, check: (r) => (r.out.includes('srt-attack.ts') ? 'the server process is visible' : null) },
  { id: 'A19', what: 'new namespaces, mount, chroot', cmd: 'unshare -U true || unshare -Urm true || mount -t tmpfs x /mnt || chroot / true', check: failsQuietly },
  { id: 'A20', what: 'a process left behind ends with the run', cmd: 'setsid nohup sleep 7777 >/dev/null 2>&1 & echo started', check: ok, after: () => { Bun.sleepSync(1000); return Bun.spawnSync(['pgrep', '-f', 'sleep 7777']).exitCode === 0 ? 'sleep 7777 still runs' : null } },
  { id: 'A27', what: 'offline: nothing, also the allowed sites', cmd: 'curl -fsS -m 10 -o /dev/null -w "%{http_code}" https://registry.npmjs.org/', check: failsQuietly, o: { network: 'offline' } },
]

fs.symlinkSync(`${BASE}/secrets`, `${DIR1}/escape`)
let failed = 0
for (const a of attacks) {
  const r = await run(a.cmd, a.o)
  const why = (r.out.includes(CANARY) ? `canary: ${r.out.slice(r.out.indexOf(CANARY) - 40, r.out.indexOf(CANARY) + 40)}` : null) ?? a.check(r) ?? a.after?.() ?? null
  console.log(`${why ? 'FAIL' : 'pass'} ${a.id} ${a.what}${why ? `\n     ${why.replace(/\n/g, ' ')}` : ''}`)
  if (why) failed++
}
server.stop(true); us.close()
console.log(failed ? `\n${failed} of ${attacks.length} attacks got through` : `\nall ${attacks.length} attacks held`)
process.exit(failed ? 1 : 0)
