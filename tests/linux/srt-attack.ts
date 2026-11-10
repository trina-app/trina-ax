// Dev environment on srt: attack suite (docs/research/srt-dev-env.md 10.2). Runs INSIDE the Docker image of
// tests/linux/Dockerfile.srt as root: it makes a team server's folders with canary strings in every place a run must
// not see, then runs each attack as the server account through the same pieces as the runner (folderView from the
// folder rules of one person, srtSettings, runEnv, resolveRunCwd, run-wrap, srt), with no systemd scope. A run has the
// folder access of the person who owns the chat: it must see her folders, write only where she writes, and see nothing
// of the folders she may not open, of other people's personal folders, logs and homes, or of the server. An attack
// passes when no canary comes back and its check holds. Lines that need systemd and polkit (A17, A21-A23, A25, A26)
// and chromium (A24) run on the spike VM.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { RuleSet, type Access } from '../../server/src/policy/access'
import { folderView } from '../../server/src/devenv/srt/access'
import { holdPlaceholders, SRT_DENY_DIRS, SRT_DENY_FILES } from '../../server/src/devenv/srt/placeholders'
import { chatWork, devenvPaths, isFull, personHome, personLogs, resolveRunCwd, runEnv, srtSettings, settingsProblems, wrappedArgv } from '../../server/src/devenv/srt/config'

const ID = 'mycel'
const BASE = `/var/lib/${ID}`
const TEAM = `${BASE}/team`
const DIR1 = `${TEAM}/projects/one`
const WORK = chatWork(BASE, 'chat-1')
const SRV = 'axserver'
const CANARY = 'CANARY-7f3a'
const ME = 'alice'

function sh(cmd: string) { const r = Bun.spawnSync(['bash', '-c', cmd]); if (r.exitCode !== 0) throw new Error(`${cmd}: ${r.stderr.toString()}`) }

// ---- the team server's folders (as install-linux.sh and the server make them) ----
for (const d of ['data', 'secrets', 'config', 'agent/codex-auth', 'root', 'run/tools', 'devenv/run']) fs.mkdirSync(path.join(BASE, d), { recursive: true })
const w = (rel: string, text: string) => { const f = path.join(TEAM, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text) }
fs.writeFileSync(`${BASE}/data/app.db`, `${CANARY}-db`)
fs.writeFileSync(`${BASE}/secrets/master.key`, `${CANARY}-secret`)
fs.writeFileSync(`${BASE}/config/server.json`, `{"x":"${CANARY}-config"}`)
fs.writeFileSync(`${BASE}/agent/codex-auth/auth.json`, `${CANARY}-codex`)
// the team folder: what alice may open (shared, her group, her project, her own folder, skills read-only) and what
// she may not (finance, another project, a hidden folder inside her group, bob's folder, .system)
w('projects/one/readme.md', 'hello from p1\n')
w('projects/one/public/notice.md', 'read only for alice\n')
w('shared/s.md', 'shared text\n')
w('skills/rules.md', 'skills text\n')
w('groups/marketing/brief.md', 'marketing brief\n')
w('groups/marketing/salaries/2026.md', `${CANARY}-salaries`)
w('groups/finance/budget.md', `${CANARY}-finance`)
w('projects/two/private.md', `${CANARY}-other-project`)
w('users/alice/todo.md', 'alice todo\n')
// a shared repo and her group folder: she may write them by the rules, but in a run they are read-only (Q0 (b)), so
// her AI cannot plant code there that another person's AI runs later (G-SRT-11)
w('shared/repo/package.json', '{"scripts":{"test":"echo ok"}}\n')
fs.mkdirSync(`${TEAM}/shared/repo/.git/hooks`, { recursive: true }); fs.writeFileSync(`${TEAM}/shared/repo/.git/config`, '[core]\n')
w('groups/marketing/Makefile', 'all:\n\techo ok\n')
// git repos in group folders: their hooks run in the next person's git command (G-SRT-11)
for (const g of ['groups/marketing', 'groups/finance']) { fs.mkdirSync(`${TEAM}/${g}/.git/hooks`, { recursive: true }); fs.writeFileSync(`${TEAM}/${g}/.git/config`, '[core]\n') }
// a project folder inside her group folder (no rule of its own): in a run that starts there, the group folder above is
// read-only and the project folder is writable inside it
w('groups/marketing/campaign/plan.md', 'campaign plan\n')
w('users/bob/notes.md', `${CANARY}-bob`)
w('.system/history/old.bin', `${CANARY}-system`)
fs.mkdirSync(`${DIR1}/.git/hooks`, { recursive: true }); fs.writeFileSync(`${DIR1}/.git/config`, '[core]\n')
const RULES = new RuleSet(([
  ['shared', 'everyone', null, 'write'], ['skills', 'everyone', null, 'read'],
  ['groups/marketing', 'group', 'marketing', 'write'], ['groups/marketing/salaries', 'group', 'marketing', 'none'],
  ['groups/finance', 'group', 'finance', 'write'],
  ['projects/one', 'user', ME, 'write'], ['projects/one/public', 'everyone', null, 'read'],
  ['projects/two', 'group', 'finance', 'write'],
] as [string, 'everyone' | 'group' | 'user', string | null, Access][]).map(([p, t, s, a]) => ({ path: p, subject_type: t, subject_id: s, access: a })))
const ALICE = { id: ME, name: 'Alice', role: 'member' as const, groups: ['marketing'] }
/** an admin: the rules give her write in the whole team folder, so in a run the team root is read-only (Q0 (b)) */
const CAROL = { id: 'carol', name: 'Carol', role: 'admin' as const, groups: [] as string[] }
fs.mkdirSync('/etc/default', { recursive: true }); fs.writeFileSync(`/etc/default/${ID}`, `MYCEL_TOKEN=${CANARY}-etcdefault\n`)
fs.mkdirSync('/tmp/server-private', { recursive: true }); fs.writeFileSync('/tmp/server-private/t', `${CANARY}-tmp`)
fs.mkdirSync(`/run/${ID}`, { recursive: true }); fs.writeFileSync(`/run/${ID}/x`, `${CANARY}-run`)
w('users/carol/c.md', 'carol note\n')
for (const u of [ME, 'bob', 'carol']) { fs.mkdirSync(path.join(personHome(BASE, u), 'tmp'), { recursive: true }); fs.mkdirSync(personLogs(BASE, u), { recursive: true }) }
fs.writeFileSync(path.join(personHome(BASE, 'bob'), 'secret'), `${CANARY}-other-home`)
fs.writeFileSync(path.join(personLogs(BASE, 'bob'), 'job.log'), `${CANARY}-other-log`)
fs.mkdirSync(WORK, { recursive: true }); fs.mkdirSync(chatWork(BASE, 'chat-2'), { recursive: true })
fs.writeFileSync(path.join(chatWork(BASE, 'chat-2'), 'x'), `${CANARY}-other-chat`)
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
const SRT_NAMES = new Set([...SRT_DENY_FILES, ...SRT_DENY_DIRS.flatMap((d) => d.split('/').map((_, i, a) => a.slice(0, i + 1).join('/')))])
let n = 0
async function run(command: string, o: { network?: 'open' | 'offline'; cwd?: string; extra?: string[]; user?: string[]; full?: boolean; during?: () => void; timeoutMs?: number; work?: boolean; start?: string; who?: typeof ALICE | typeof CAROL; people?: (typeof ALICE | typeof CAROL)[] } = {}): Promise<{ code: number | null; out: string; refused?: string }> {
  const runId = `attack${String(++n).padStart(10, '0')}`
  const work = o.work ? WORK : null
  // the run's view: the person's folder rules, writable only in the starting folder and her own folder
  const start = work ? null : o.start ?? 'projects/one'
  const who = o.who ?? ALICE
  // with people (the runner passes the team's active people): a project run reads only what all who see it may read
  const view = folderView(RULES, who, { start }, o.people)
  const input = { base: BASE, id: ID, teamRoot: TEAM, userId: who.id, view, start, work, network: o.network ?? 'open', extraDomains: o.extra ?? [], userDomains: o.user ?? [], full: o.full ?? false, denyHosts: ['team.trina.test'], denyAddrs: ['203.0.113.7'] }
  const settings = srtSettings(input)
  const problems = settingsProblems(settings, input)
  if (problems.length) throw new Error(problems.join('; '))
  const root = work ?? `${TEAM}/${start}`
  const cwd = resolveRunCwd(root, o.cwd ?? '')
  if (!cwd) return { code: null, out: '', refused: 'cwd' }
  const settingsFile = path.join(devenvPaths(BASE).run, `${runId}.json`)
  fs.writeFileSync(settingsFile, JSON.stringify(settings), { mode: 0o600 }); sh(`chown ${SRV} ${settingsFile}`)
  const exitFile = path.join(personLogs(BASE, who.id), `${runId}.exit`)
  const argv = ['setpriv', `--reuid=${SRV}`, `--regid=${SRV}`, '--init-groups', '--', ...wrappedArgv({ exitFile, settingsFile, command, full: isFull(settings) })]
  // as the runner: srt's protected names exist in the cwd before the run (placeholders.ts), owned by the server account
  const release = holdPlaceholders(cwd)
  sh(`chown -h ${SRV}:${SRV} ${[...SRT_NAMES].map((n) => `'${path.join(cwd, n)}'`).join(' ')} 2>/dev/null || true`)
  const p = Bun.spawn(argv, { cwd, env: runEnv({ base: BASE, userId: who.id, teamRoot: TEAM, work }), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const t = setTimeout(() => p.kill('SIGKILL'), o.timeoutMs ?? 60_000)
  if (o.during) setTimeout(o.during, 1500)
  const [a, b] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  await p.exited; clearTimeout(t)
  const code = fs.existsSync(exitFile) ? Number(fs.readFileSync(exitFile, 'utf8').trim()) : null
  release()
  fs.rmSync(settingsFile, { force: true }); fs.rmSync(exitFile, { force: true })
  return { code, out: a + b }
}

/** a git repo in a team folder changed: a hook was added, or .git/config names another hooks folder */
const gitChanged = (rel: string) => (fs.readdirSync(`${TEAM}/${rel}/.git/hooks`).length || fs.readFileSync(`${TEAM}/${rel}/.git/config`, 'utf8').includes('hooksPath') ? `${rel}/.git changed` : null)
type Check = (r: { code: number | null; out: string; refused?: string }) => string | null
const failsQuietly: Check = (r) => (r.code === 0 ? `exit code 0: ${r.out.slice(0, 200)}` : null)
const ok: Check = (r) => (r.code === 0 ? null : `exit code ${r.code}: ${r.out.slice(0, 300)}`)
const has = (s: string): Check => (r) => (r.out.includes(s) ? null : `no "${s}" in: ${r.out.slice(0, 300)}`)
const both = (...cs: Check[]): Check => (r) => cs.map((c) => c(r)).find((x) => x) ?? null

const attacks: { id: string; what: string; cmd: string; check: Check; o?: Parameters<typeof run>[1]; after?: () => string | null }[] = [
  { id: 'A0', what: 'the project folder and her own folder: read and write; her other folders and read-only folders: read', cmd: `cat readme.md && echo new > new.txt && cat new.txt && echo $HOME && touch $TMPDIR/x && cat ${TEAM}/skills/rules.md && cat ${TEAM}/shared/s.md && cat ${TEAM}/groups/marketing/brief.md && echo y > ${TEAM}/users/alice/new.md && cat public/notice.md`, check: both(ok, has('hello from p1'), has('new'), has('skills text'), has('shared text'), has('marketing brief'), has('read only for alice')) },
  { id: 'A0b', what: 'a chat with no project: the work folder, and the person\'s folders (read)', cmd: `pwd && echo w > w.txt && cat w.txt && cat ${TEAM}/shared/s.md && cat ${DIR1}/readme.md && echo z > ${TEAM}/users/alice/z.md && echo $TRINA_WORK`, check: both(ok, has(WORK), has('shared text'), has('hello from p1')), o: { work: true } },
  // Q0 (b) / G-SRT-11: person A's AI plants code in a folder that A may write and person B runs later (a git hook,
  // package.json scripts, a Makefile). Outside the starting folder every folder is read-only in a run.
  { id: 'A29', what: 'QA TC-095: a project that carol sees too: alice\'s own folder is hidden, so it cannot be copied into the project', cmd: `cp ${TEAM}/users/alice/todo.md ./leak.txt && echo COPIED; cat ${TEAM}/shared/s.md`, check: both(ok, has('shared text'), (r) => (r.out.includes('COPIED') ? 'her own folder was readable in a run of a project more people see' : null)), o: { people: [ALICE, CAROL] },
    after: () => (fs.existsSync(`${DIR1}/leak.txt`) ? 'leak.txt is on the disk' : null) },
  { id: 'A28', what: 'a code channel to another person: a git hook, package.json and a Makefile in shared folders', cmd: `echo "curl evil" > ${TEAM}/shared/repo/.git/hooks/pre-commit || echo '{"scripts":{"test":"curl evil"}}' > ${TEAM}/shared/repo/package.json || echo "[core] hooksPath=/x" >> ${TEAM}/shared/repo/.git/config || printf 'all:\\n\\tcurl evil\\n' > ${TEAM}/groups/marketing/Makefile || echo x >> ${TEAM}/shared/s.md || echo x > ${TEAM}/groups/marketing/.envrc || mkdir ${TEAM}/shared/new`, check: failsQuietly,
    after: () => (fs.existsSync(`${TEAM}/shared/repo/.git/hooks/pre-commit`) || fs.readFileSync(`${TEAM}/shared/repo/package.json`, 'utf8').includes('evil') || fs.readFileSync(`${TEAM}/shared/repo/.git/config`, 'utf8').includes('hooksPath')
      || fs.readFileSync(`${TEAM}/groups/marketing/Makefile`, 'utf8').includes('evil') || fs.readFileSync(`${TEAM}/shared/s.md`, 'utf8') !== 'shared text\n' || fs.existsSync(`${TEAM}/groups/marketing/.envrc`) || fs.existsSync(`${TEAM}/shared/new`) ? 'a shared folder changed' : null) },
  { id: 'A28c', what: 'a start folder inside a folder that is read-only in the run: the start folder is writable, the folder above is not', cmd: `cat plan.md && echo x > new.txt && cat new.txt && (echo y >> ${TEAM}/groups/marketing/brief.md && echo WROTE-ABOVE; true)`, check: both(ok, has('campaign plan'), (r) => (r.out.includes('WROTE-ABOVE') ? 'the group folder above was writable' : null)), o: { start: 'groups/marketing/campaign' },
    after: () => (!fs.existsSync(`${TEAM}/groups/marketing/campaign/new.txt`) ? 'new.txt is not on the disk' : fs.readFileSync(`${TEAM}/groups/marketing/brief.md`, 'utf8') !== 'marketing brief\n' ? 'brief.md changed' : null) },
  { id: 'A28d', what: 'an admin: the project folder and her own folder are writable; the team root and every other folder are read-only', cmd: `cat readme.md && echo a > admin.txt && cat admin.txt && echo c >> ${TEAM}/users/carol/c.md && cat ${TEAM}/groups/finance/budget.md | head -c 0 && (echo z > ${TEAM}/top.txt && echo WROTE-ROOT; echo z >> ${TEAM}/groups/finance/budget.md && echo WROTE-FINANCE; true)`, check: both(ok, has('hello from p1'), (r) => (/WROTE-(ROOT|FINANCE)/.test(r.out) ? 'a folder outside the project was writable' : null)), o: { who: CAROL },
    after: () => (!fs.existsSync(`${DIR1}/admin.txt`) ? 'admin.txt is not on the disk' : fs.existsSync(`${TEAM}/top.txt`) ? 'the team root changed' : !fs.readFileSync(`${TEAM}/users/carol/c.md`, 'utf8').includes('c\n') ? 'her own folder was not writable' : null) },
  { id: 'A28e', what: 'an admin\'s run (the start folder bound back writable): .git/hooks, .git/config and .bashrc there stay read-only', cmd: 'echo "curl evil" > .git/hooks/pre-commit || echo "[core] hooksPath=/x" >> .git/config || echo evil >> .bashrc', check: failsQuietly, o: { who: CAROL },
    after: () => (fs.existsSync(`${DIR1}/.git/hooks/pre-commit`) || fs.readFileSync(`${DIR1}/.git/config`, 'utf8').includes('hooksPath') || (fs.existsSync(`${DIR1}/.bashrc`) && fs.readFileSync(`${DIR1}/.bashrc`, 'utf8').includes('evil')) ? 'a protected file changed' : null) },
  // the same code channel through .git/hooks of a group folder: from a project run, from a run that starts inside the
  // group folder (the group folder above is read-only, the start folder bound back), and from an admin's run (the
  // rules give her write everywhere)
  { id: 'A28f', what: 'a git hook and .git/config in her group folder, from a project run', cmd: `echo "curl evil" > ${TEAM}/groups/marketing/.git/hooks/pre-commit || echo "[core] hooksPath=/x" >> ${TEAM}/groups/marketing/.git/config || mkdir ${TEAM}/groups/marketing/.git/hooks/x`, check: failsQuietly, after: () => gitChanged('groups/marketing') },
  { id: 'A28g', what: 'a git hook in the group folder above the start folder', cmd: `echo "curl evil" > ${TEAM}/groups/marketing/.git/hooks/pre-commit || echo "[core] hooksPath=/x" >> ${TEAM}/groups/marketing/.git/config || echo "curl evil" > ../.git/hooks/post-checkout`, check: failsQuietly, o: { start: 'groups/marketing/campaign' }, after: () => gitChanged('groups/marketing') },
  { id: 'A28h', what: 'an admin: git hooks, package.json and new folders in shared and group folders', cmd: `echo "curl evil" > ${TEAM}/shared/repo/.git/hooks/pre-commit || echo '{"scripts":{"test":"curl evil"}}' > ${TEAM}/shared/repo/package.json || echo "curl evil" > ${TEAM}/groups/finance/.git/hooks/pre-commit || echo "[core] hooksPath=/x" >> ${TEAM}/groups/finance/.git/config || echo "curl evil" > ${TEAM}/groups/marketing/.git/hooks/pre-commit || mkdir ${TEAM}/shared/new || mkdir ${TEAM}/newtop || echo x > ${TEAM}/projects/two/x.md`, check: failsQuietly, o: { who: CAROL },
    after: () => gitChanged('shared/repo') ?? gitChanged('groups/finance') ?? gitChanged('groups/marketing') ?? (fs.readFileSync(`${TEAM}/shared/repo/package.json`, 'utf8').includes('evil') || fs.existsSync(`${TEAM}/shared/new`) || fs.existsSync(`${TEAM}/newtop`) || fs.existsSync(`${TEAM}/projects/two/x.md`) ? 'a team folder outside the project changed' : null) },
  { id: 'A28b', what: 'a chat with no project: the project folder and the shared folders are read-only', cmd: `echo x > ${DIR1}/planted.js || echo x >> ${DIR1}/readme.md || echo "curl evil" > ${TEAM}/shared/repo/.git/hooks/post-checkout || echo x >> ${TEAM}/shared/s.md`, check: failsQuietly, o: { work: true },
    after: () => (fs.existsSync(`${DIR1}/planted.js`) || fs.readFileSync(`${DIR1}/readme.md`, 'utf8') !== 'hello from p1\n' || fs.existsSync(`${TEAM}/shared/repo/.git/hooks/post-checkout`) || fs.readFileSync(`${TEAM}/shared/s.md`, 'utf8') !== 'shared text\n' ? 'a team folder outside the work folder changed' : null) },
  { id: 'A1', what: 'the DB, secrets, config, engine logins', cmd: `cat ${BASE}/data/app.db || cat ${BASE}/secrets/master.key || cat ${BASE}/config/server.json || cat ${BASE}/agent/codex-auth/auth.json || grep -r ${CANARY} ${BASE}`, check: failsQuietly },
  // srt shows the folders on the way to an allowed folder, with only those paths in them
  { id: 'A2', what: 'folders the person may not open: another project, another group, a hidden folder inside her group, another person\'s folder, .system', cmd: `cat ${TEAM}/projects/two/private.md; cat ${TEAM}/groups/finance/budget.md; cat ${TEAM}/groups/marketing/salaries/2026.md; cat ${TEAM}/users/bob/notes.md; cat ${TEAM}/.system/history/old.bin; ls -a ${TEAM} ${TEAM}/projects ${TEAM}/groups ${TEAM}/users ${TEAM}/groups/marketing`, check: (r) => (/\btwo\b|\bfinance\b|\bbob\b|\.system|\bdata\b/.test(r.out.replace(/No such file or directory/g, '').replace(/cat: [^\n]*\n/g, '')) ? `a hidden folder is listed: ${r.out.slice(0, 300)}` : null) },
  // srt shows the path to the own work folder, so the work folder list names only this chat
  { id: 'A2b', what: 'another chat\'s work folder; another person\'s logs and home', cmd: `cat ${chatWork(BASE, 'chat-2')}/x || cat ${personLogs(BASE, 'bob')}/job.log || ls ${personLogs(BASE, 'bob')} || cat ${personHome(BASE, 'bob')}/secret`, check: failsQuietly, o: { work: true } },
  { id: 'A2d', what: 'the list of work folders names only this chat', cmd: `ls ${devenvPaths(BASE).work}`, check: (r) => (r.out.includes('chat-2') ? `another chat is listed: ${r.out.slice(0, 200)}` : null), o: { work: true } },
  { id: 'A2c', what: 'write where the person reads only: skills/, the read-only folder in her project', cmd: `echo x > ${TEAM}/skills/x || echo x > public/x || echo x >> public/notice.md`, check: failsQuietly, after: () => (fs.existsSync(`${TEAM}/skills/x`) || fs.existsSync(`${DIR1}/public/x`) || fs.readFileSync(`${DIR1}/public/notice.md`, 'utf8').includes('x\n') ? 'a read-only folder changed' : null) },
  { id: 'A3', what: 'environment: no server values', cmd: 'env; cat /proc/self/environ | tr "\\0" "\\n"; cat /proc/1/environ', check: (r) => (/MYCEL_/.test(r.out) ? 'a MYCEL_ variable' : null) },
  { id: 'A4', what: '/etc/default/<ID>, the server /tmp, /run/<ID>', cmd: `cat /etc/default/${ID} || cat /tmp/server-private/t || cat /run/${ID}/x || ls /tmp/server-private || ls /run/${ID}`, check: failsQuietly },
  { id: 'A5', what: 'a secret made after the run started', cmd: `sleep 4; cat ${BASE}/secrets/late.key || ls ${BASE}/secrets`, check: failsQuietly, o: { during: () => { fs.writeFileSync(`${BASE}/secrets/late.key`, `${CANARY}-late`); sh(`chown ${SRV} ${BASE}/secrets/late.key`) } } },
  { id: 'A6', what: 'write system tools, srt, the logs, another home', cmd: `touch /usr/local/bin/x || touch /opt/trina/srt/0.0.81/x || touch $TRINA_LOGS/x || touch ${personHome(BASE, 'bob')}/x || cat ${personHome(BASE, 'bob')}/secret || echo pwned > /opt/trina/devenv/run-wrap`, check: failsQuietly },
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
  // sites a person allows (always or once) and Full internet: the deny lists stay in force (docs/DECISIONS.md "Dev
  // environment: sites a person allows")
  { id: 'A12c', what: 'a site the person allowed works in her run', cmd: 'curl -fsS -m 20 -o /dev/null -w "%{http_code}" https://example.com/', check: both(ok, has('200')), o: { user: ['example.com'] } },
  { id: 'A12e', what: 'Full internet: a site on no list works', cmd: 'curl -fsS -m 20 -o /dev/null -w "%{http_code}" https://example.com/', check: both(ok, has('200')), o: { full: true } },
  { id: 'A13f', what: 'Full internet: metadata, private ranges, names that resolve inside, the VM address', cmd: 'curl -fsS -m 5 http://169.254.169.254/latest/meta-data/ || curl -fsS -m 5 http://10.11.12.13/ || curl -fsS -m 5 http://private.attack.test/ || curl -fsS -m 5 http://loop.attack.test:8099/ || curl -fsS -m 5 http://203.0.113.7/ || curl -fsS -m 5 http://metadata.google.internal/ || curl -fsS -m 5 http://[fd00::1]/ || curl -fsS -m 5 http://2852039166/ || curl -fsS -m 5 http://192.168.1.1/ || curl -fsS -m 5 http://100.64.0.1/', check: failsQuietly, o: { full: true } },
  { id: 'A14f', what: 'Full internet: the Trina server port and host name', cmd: 'curl -fsS -m 5 http://127.0.0.1:8099/ || curl -fsS -m 5 http://localhost:8099/ || curl -fsS -m 5 https://team.trina.test/ || curl -fsS -m 5 https://team.trina.test./ || curl -fsS -m 5 https://Team.Trina.Test../ || curl -fsS -m 5 --noproxy "*" https://1.1.1.1/', check: failsQuietly, o: { full: true } },
  { id: 'A27f', what: 'offline wins over Full internet and allowed sites', cmd: 'curl -fsS -m 10 -o /dev/null -w "%{http_code}" https://example.com/ || curl -fsS -m 10 -o /dev/null https://registry.npmjs.org/', check: failsQuietly, o: { network: 'offline', full: true, user: ['example.com'] } },
  { id: 'A27', what: 'offline: nothing, also the allowed sites', cmd: 'curl -fsS -m 10 -o /dev/null -w "%{http_code}" https://registry.npmjs.org/', check: failsQuietly, o: { network: 'offline' } },
]

fs.symlinkSync(`${BASE}/secrets`, `${DIR1}/escape`)
// preflight: a plain command must run through srt. If srt or bwrap cannot start (for example the AppArmor userns
// restriction of an Ubuntu 24.04 host), every attack that expects a failure would pass without a test.
const pre = await run('true')
if (pre.code !== 0) {
  console.log(`FAIL preflight: \`true\` did not run through srt (exit code ${pre.code}): ${pre.out.slice(0, 300).replace(/\n/g, ' ')}`)
  server.stop(true); us.close()
  process.exit(1)
}
console.log('pass preflight: a plain command runs through srt')
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
