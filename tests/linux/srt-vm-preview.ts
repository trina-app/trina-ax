// Dev environment on srt: the preview on a real VM (docs/DECISIONS.md "Dev environment on srt: preview", design spike
// S2 and attack A26). It runs INSIDE the stand-in team server unit as the server account (NoNewPrivileges, no
// capabilities, ProtectSystem=strict, PrivateTmp), after install-srt.sh: scripts/dev-env/srt/vm-check.sh REPO preview.
// A test server (tests/lib/b-harness.ts) with the real runner (systemd scopes, polkit, srt), the real box_shell tool,
// the real mycel-sandbox port-forward (MYCEL_SANDBOX_HELPER) and the real gateway listener on 127.0.0.1:8098.
//   P1 (S2): a dev server that alice's AI starts with box_shell background=true opens through the gateway (curl with
//       the link's Host, the cookie, then /), and the forwarder is in the run's network namespace with no capabilities;
//   P2 (A26): erin's dev server on the same port in another run: each link reaches only its own run, a cookie of one
//       link does not open the other, and port-forward of run A for a port only run B listens on fails;
//   P3: the sandbox cannot open the preview socket or list the folder it is in;
//   P4: the run stops: the link answers 403, the forwarder and its socket are gone.
// Results: <base>/data/preview-results.json and one "preview <id> ..." line per check.
import fs from 'node:fs'
import path from 'node:path'
import { API, DEV_ENV_DEFAULT_LIMITS } from '@mycel/shared/api'

const ID = process.env.MYCEL_LABEL ?? 'mycel'
const BASE = process.env.MYCEL_INSTALL_BASE ?? `/var/lib/${ID}`
const RESULTS = `${BASE}/data/preview-results.json`
const GW = '127.0.0.1:8098'
const SUFFIX = 'preview.test'
// the gateway starts with the routes of the test server (routes/dev-env.ts init)
process.env.MYCEL_DEV_PREVIEW_ORIGIN = `http://*.${SUFFIX}:8098`
process.env.MYCEL_DEV_PREVIEW_LISTEN = GW

const { startHarness } = await import('../lib/b-harness')
const { parsePlan } = await import('../../server/src/devenv/srt/plan')
const { setSrtSystem } = await import('../../server/src/devenv/srt/runner')
const { systemdSystem } = await import('../../server/src/devenv/srt/system')
const { newConsent, saveTeamSetting, teamSetting } = await import('../../server/src/devenv/setting')
const { boxShellTool } = await import('../../server/src/devenv/tool')

const plan = parsePlan(fs.readFileSync(`${BASE}/root/dev-env.json`, 'utf8'))
if (!plan) throw new Error('no plan file')
const results: Record<string, unknown>[] = []
const say = (id: string, pass: boolean | null, what: string, data: Record<string, unknown> = {}) => {
  results.push({ id, pass, what, ...data })
  console.log(`preview ${pass === null ? 'info' : pass ? 'pass' : 'FAIL'} ${id} ${what} ${JSON.stringify(data).slice(0, 700)}`)
  fs.writeFileSync(RESULTS, JSON.stringify({ results }, null, 1))
}
process.on('uncaughtException', (e) => { say('CRASH', false, 'the driver failed', { error: String(e?.stack ?? e).slice(0, 1500) }); process.exit(1) })

const h = await startHarness({ name: 'srt-preview' })
const sys = systemdSystem(ID)
setSrtSystem(sys, { base: BASE, id: ID, plan })
saveTeamSetting(h.ctx.db, {
  ...teamSetting(h.ctx.db), enabled: true, scope: { mode: 'writers', groupIds: [], userIds: [] }, network: 'open',
  limits: { ...DEV_ENV_DEFAULT_LIMITS, cpus: 1, memoryMiB: plan.memoryMiB, pids: plan.pids }, extraDomains: [], consent: newConsent({ id: 'carol', name: 'Carol Park' }),
})
const chatA = (await h.api('alice').call(API.createChat, { body: {} })).id
const chatB = (await h.api('erin').call(API.createChat, { body: {} })).id
const chatC = (await h.api('alice').call(API.createChat, { body: {} })).id

const text = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? '').join('\n')
let turn = 0
const steps: unknown[] = []
const shell = async (user: string, chatId: string, input: Record<string, unknown>) =>
  text(await boxShellTool({ ctx: h.ctx, project: null, userId: user, turnId: `turn-${++turn}`, chatId, signal: new AbortController().signal, confirm: async () => null, redact: (s) => s, queueStep: (s) => steps.push(s) }).call(input as never))
type Row = { id: string; unit: string; state: string; end_reason: string | null }
const rowOf = (user: string) => h.ctx.db.query("SELECT id, unit, state, end_reason FROM dev_env_runs WHERE user_id = ? AND kind = 'server' ORDER BY started_at DESC LIMIT 1").get(user) as Row
const runIdOf = (unit: string) => unit.slice('trina-dev-'.length, -'.scope'.length)
const sh = async (argv: string[]) => {
  const p = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', env: { PATH: '/usr/bin:/bin', LANG: 'C' } })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { code: await p.exited, out, err }
}
/** a request to the gateway as a browser sends it, with curl (outside this process) */
const curl = (url: string, cookie = '') => {
  const u = new URL(url)
  return sh(['curl', '-s', '-i', '-m', '20', '-H', `Host: ${u.host}`, ...(cookie ? ['-H', `Cookie: ${cookie}`] : []), `http://${GW}${u.pathname}${u.search}`])
}
const status = (r: { out: string }) => Number(/^HTTP\/[\d.]+ (\d+)/.exec(r.out)?.[1] ?? 0)
/** redeem a link: its origin and the session cookie */
async function open(user: string, rowId: string, port: number) {
  const l = await h.api(user).call(API.previewMyDevEnvRun, { params: { runId: rowId }, body: { port } })
  const r = await curl(l.url)
  const cookie = /^set-cookie: (mycel_pv=[0-9a-f]+)/im.exec(r.out)?.[1] ?? ''
  return { url: l.url, origin: new URL(l.url).origin, cookie, redeem: status(r) }
}
const page = async (origin: string, cookie: string) => { const r = await curl(`${origin}/`, cookie); return { status: status(r), body: r.out.slice(r.out.indexOf('\r\n\r\n') + 4) } }
const forwarders = async () => {
  const r = await sh(['pgrep', '-f', 'port-forward-inner'])
  return r.out.split('\n').filter(Boolean).map(Number)
}
const procLine = (pid: number, key: string) => { try { return (fs.readFileSync(`/proc/${pid}/status`, 'utf8').split('\n').find((l) => l.startsWith(key + ':')) ?? '').slice(key.length + 1).trim() } catch { return '' } }
const waitFor = async (f: () => Promise<boolean>, ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return true; await Bun.sleep(500) } return false }

// a dev server that serves one marker page (python3's http.server, as a person's own app would serve its pages)
const server = (mark: string, ports: number[]) => `mkdir -p site && echo ${mark} > site/index.html && cd site && ${ports.slice(1).map((p) => `python3 -m http.server ${p} --bind 127.0.0.1 >/dev/null 2>&1 & `).join('')}exec python3 -m http.server ${ports[0]} --bind 127.0.0.1`

// ---- P1 (S2): a dev server through box_shell, opened through the gateway ----
const gwUp = await waitFor(async () => (await sh(['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', `http://${GW}/`])).out === '404', 10_000)
say('P0', gwUp, 'the gateway listens (MYCEL_DEV_PREVIEW_LISTEN) and answers 404 to an unknown host')
const ta = await shell('alice', chatA, { command: server('MARK-RUN-A', [3000]), background: true, port: 3000, log_name: 'weba' })
const a = rowOf('alice')
say('P1a', /Preview button for port 3000/.test(ta) && a?.state === 'running', 'box_shell background=true port=3000 starts a dev server; the tool names the Preview button', { out: ta.slice(0, 300), step: steps.at(-1) })
await Bun.sleep(2500)
const la = await open('alice', a.id, 3000)
const pa = await page(la.origin, la.cookie)
say('P1b', la.redeem === 303 && !!la.cookie && pa.status === 200 && pa.body.includes('MARK-RUN-A'), 'S2: the link opens the dev server through the gateway (303 + cookie, then the page)', { redeem: la.redeem, status: pa.status, body: pa.body.slice(0, 120) })
{
  const pids = await forwarders()
  const f = pids[0]
  const runNet = (() => { try { const ps = fs.readFileSync(`/sys/fs/cgroup/${ID}.slice/${ID}-devenv.slice/trina-dev-${runIdOf(a.unit)}.scope/cgroup.procs`, 'utf8').split('\n').filter(Boolean); return new Set(ps.map((p) => { try { return fs.readlinkSync(`/proc/${p}/ns/net`) } catch { return '' } })) } catch { return new Set<string>() } })()
  const fNet = f ? fs.readlinkSync(`/proc/${f}/ns/net`) : ''
  const own = fs.readlinkSync('/proc/self/ns/net')
  const info = f ? { pid: f, CapEff: procLine(f, 'CapEff'), CapPrm: procLine(f, 'CapPrm'), NoNewPrivs: procLine(f, 'NoNewPrivs'), Uid: procLine(f, 'Uid'), net: fNet, runNets: [...runNet], own } : {}
  say('P1c', pids.length === 1 && /^0+$/.test(procLine(f!, 'CapEff')) && procLine(f!, 'NoNewPrivs') === '1' && fNet !== own && runNet.has(fNet), 'the forwarder is in the run\'s network namespace, with no capabilities and no_new_privs', info)
}

// ---- P2 (A26): another run on the same port ----
const tb = await shell('erin', chatB, { command: server('MARK-RUN-B', [3000, 3001]), background: true, port: 3000, log_name: 'webb' })
const b = rowOf('erin')
await Bun.sleep(2500)
const lb = await open('erin', b.id, 3000)
const pb = await page(lb.origin, lb.cookie)
const pa2 = await page(la.origin, la.cookie)
say('P2a', pb.status === 200 && pb.body.includes('MARK-RUN-B') && !pb.body.includes('MARK-RUN-A') && pa2.body.includes('MARK-RUN-A') && !pa2.body.includes('MARK-RUN-B'), 'A26: two runs on port 3000; each link reaches only its own run', { b: pb.body.slice(0, 80), a: pa2.body.slice(0, 80), out: tb.slice(0, 200) })
const cross = [await page(la.origin, lb.cookie), await page(lb.origin, la.cookie)]
say('P2b', cross.every((c) => c.status === 403), 'A26: the cookie of one link does not open the other', { statuses: cross.map((c) => c.status) })
{
  const sock = path.join(BASE, 'devenv/run', `${runIdOf(a.unit)}-3001.sock`)
  const f = sys.forward ? await sys.forward({ runId: runIdOf(a.unit), port: 3001, socket: sock }) : { error: 'no forward' }
  const refused = 'error' in f
  if (!refused) f.stop()
  say('P2c', refused && /nothing listens/.test((f as { error: string }).error) && !fs.existsSync(sock), 'A26: port-forward of run A for a port only run B listens on (3001) is refused', { result: refused ? (f as { error: string }).error : 'started' })
  const rel = sys.forward ? await sys.forward({ runId: runIdOf(a.unit), port: 3128, socket: path.join(BASE, 'devenv/run', `${runIdOf(a.unit)}-3128.sock`) }) : { error: '' }
  say('P2d', 'error' in rel && /proxy/.test(rel.error), 'port-forward refuses srt\'s proxy port 3128', { result: 'error' in rel ? rel.error : 'started' })
  if (!('error' in rel)) rel.stop()
}

// ---- P3: the sandbox and the preview socket ----
{
  const sock = path.join(BASE, 'devenv/run', `${runIdOf(a.unit)}-3000.sock`)
  const t = await shell('alice', chatC, { command: `ls -la ${path.dirname(sock)} 2>&1 | head -3; echo ---; python3 -c "import socket; s=socket.socket(socket.AF_UNIX); s.connect('${sock}'); print('CONNECTED')" 2>&1 | tail -1; echo ---; curl -s -m 5 --unix-socket ${sock} http://localhost/ 2>&1 | head -c 200; echo; echo END` })
  say('P3', fs.existsSync(sock) && !/CONNECTED|MARK-RUN-A/.test(t) && /END/.test(t), 'the sandbox cannot list the run folder or connect to a preview socket (AF_UNIX denied, the folder hidden)', { out: t.slice(0, 500) })
}

// ---- P4: the run stops ----
{
  const sock = path.join(BASE, 'devenv/run', `${runIdOf(a.unit)}-3000.sock`)
  await h.api('alice').call(API.stopMyDevEnvRun, { params: { runId: a.id } })
  const after = await page(la.origin, la.cookie)
  const gone = await waitFor(async () => (await forwarders()).length === 1 && !fs.existsSync(sock), 10_000)
  const pbAfter = await page(lb.origin, lb.cookie)
  say('P4', after.status === 403 && gone && pbAfter.body.includes('MARK-RUN-B'), 'the run stops: its link answers 403, its forwarder and socket go; the other run still serves', { status: after.status, forwarders: (await forwarders()).length, socket: fs.existsSync(sock), b: pbAfter.status })
  await h.api('erin').call(API.stopMyDevEnvRun, { params: { runId: b.id } })
  const none = await waitFor(async () => (await forwarders()).length === 0, 10_000)
  say('P4b', none, 'no forwarder is left when no dev server runs')
}

say('END', null, 'done', { serverPid: process.pid })
console.log(`results in ${RESULTS}`)
// stay up like the other drivers (vm-check.sh reads the results; the unit has Restart=no in this mode)
await new Promise(() => {})
