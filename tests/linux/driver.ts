// Runs as axserver inside the container. The launcher (axagent) is already running.
import fs from 'node:fs'
import path from 'node:path'
import { runFuzz } from '../fuzz/fuzz'
import { makeEnv } from '../lib/env'
import { startServer } from '../../server/src/server'
import { fakeTurn } from '../lib/run-turn'
import { CANARY_RE } from '../lib/fixtures'
import { API } from '@mycel/shared/api'
import { HARNESS_KEYS, ask, startHarness } from '../lib/b-harness'

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

// 2) backstop: a compromised engine runs code as axagent during a turn, beside a concurrent victim turn. With the
// turn sandbox on (MYCEL_T1_BASE, the entrypoint started the launcher with --sandbox bwrap) the engine runs inside
// bubblewrap + mycel-sandbox + nftables + a turn cgroup; the driver drives containment probes through the engine and
// asserts the sandbox shut it out. The per-syscall blocking (seccomp, Landlock) has its own Go tests; this is the
// end-to-end path (spec 3.9.1). Without the base the old attack.sh backstop runs (a machine with a shell in reach).
const SANDBOX = !!process.env.MYCEL_T1_BASE
const CG = process.env.MYCEL_T1_CGROUP ?? '/sys/fs/cgroup'
const TURNS_CG = CG + '/launcher/turns'
const env = makeEnv('linux', cfgOver); env.db.close()
const srv = await startServer(env.cfg, start)
let bobToken = ''
const orig = srv.turns.create.bind(srv.turns)
;(srv.turns as any).create = (...a: any[]) => { const r = (orig as any)(...a); if (a[0] === 'bob') bobToken = r.token; return r }

const PROXY = +process.env.PROBE_PROXY_PORT!
// the model proxy's port: a stand-in listener while the plain turns probe the network (P-net-proxy), the real model
// proxy of the managed turns (6) later
const proxyStandIn = SANDBOX ? Bun.listen({ hostname: '127.0.0.1', port: PROXY, socket: { open(s) { s.write('ok'); s.end() }, data() {}, error() {} } }) : null
if (SANDBOX) {
  const read = (p: string) => { try { return fs.readFileSync(p, 'utf8').trim() } catch (e) { return 'ERR ' + (e as Error).message } }
  // P-net-proxy already proven by any turn (the engine reaches the model proxy through the bridge); here we read the
  // victim's canary file through the tool (works) and confirm cross-chat reads are denied for the attacker.
  const victim = fakeTurn(srv, 'bob', { calls: [{ tool: 'read', args: { file_path: 'users/bob/notes.md' } }], sleepMs: 9000 })
  await Bun.sleep(1500)
  // while bob's turn runs: its turn cgroup exists with the plan's per-turn memory.max (Basic plan: 800 MiB)
  let bobCg = ''
  for (const d of (() => { try { return fs.readdirSync(TURNS_CG) } catch { return [] } })()) if (d.startsWith('t-')) bobCg = d
  const cgMax = bobCg ? read(`${TURNS_CG}/${bobCg}/memory.max`) : 'no turn cgroup'
  check('turn cgroup exists with the plan memory.max (800 MiB)', cgMax === String(800 * 1048576), `${bobCg}=${cgMax}`)
  check('turn cgroup oom.group is set', !!bobCg && read(`${TURNS_CG}/${bobCg}/memory.oom.group`) === '1', bobCg)
  const attack = await fakeTurn(srv, 'alice', {
    calls: [{ tool: 'read', args: { file_path: 'users/bob/notes.md' } }],
    probe: [
      { id: 'P-net-proxy', kind: 'connect', host: '127.0.0.1', port: PROXY },
      { id: 'P-net-api', kind: 'connect', host: '127.0.0.1', port: 19174 },
      { id: 'P-net-peer', kind: 'connect', host: '127.0.0.1', port: 19190 },
      { id: 'P-net-v6', kind: 'connect', host: '::1', port: PROXY },
      { id: 'P-net-metadata', kind: 'connect', host: '169.254.169.254', port: 80 },
      { id: 'P-net-internet', kind: 'connect', host: '1.1.1.1', port: 443 },
      { id: 'P-net-dns', kind: 'connect', host: '127.0.0.1', port: 53, proto: 'udp' },
      { id: 'P-team', kind: 'stat', path: '/srv/mycel' },
      { id: 'P-db', kind: 'stat', path: '/srv/mycel/linux/data/app.db' },
      { id: 'P-codex-auth', kind: 'read', path: '/srv/agent/codex-auth/auth.json' },
      { id: 'P-agent-root', kind: 'stat', path: '/srv/agent' },
      { id: 'P-tmp', kind: 'stat', path: '/tmp' },
      { id: 'P-sys', kind: 'stat', path: '/sys' },
      { id: 'P-write-root', kind: 'write', path: '/x' },
      { id: 'P-etc', kind: 'read', path: '/etc/passwd' },
      { id: 'P-stolen-same', kind: 'usetoken', sock: '/run/mycel/tools.sock', token: bobToken, file: 'users/bob/notes.md' },
    ],
  })
  const v = await victim
  const pr: Record<string, any> = {}
  for (const l of attack.lines) if (l.probe) pr[l.probe] = l.result
  out.probe = pr
  check('victim turn (bob) works through the sandbox', v.results[0]?.isError === false && /CANARY-BOB/.test(v.results[0]?.text ?? ''))
  check('alice tool call for bob file denied', attack.results[0]?.isError === true)
  check('P-net-proxy: the model proxy port is reachable', pr['P-net-proxy'] === 'ok', String(pr['P-net-proxy']))
  check('P-net-api: the server API port is blocked (listener present)', pr['P-net-api'] !== 'ok', String(pr['P-net-api']))
  check('P-net-peer: another loopback service is blocked (listener present)', pr['P-net-peer'] !== 'ok', String(pr['P-net-peer']))
  for (const id of ['P-net-v6', 'P-net-metadata', 'P-net-internet', 'P-net-dns'])
    check(`${id}: blocked`, pr[id] !== 'ok' && pr[id] !== 'sent', String(pr[id]))
  for (const id of ['P-team', 'P-db', 'P-codex-auth', 'P-tmp', 'P-sys'])
    check(`${id}: not present in the sandbox`, /ENOENT|EACCES|EPERM/.test(String(pr[id])), String(pr[id]))
  check('P-agent-root: only this chat is visible', pr['P-agent-root']?.entries === 1, JSON.stringify(pr['P-agent-root']))
  check('P-write-root: the root is read-only', /EROFS|EACCES|EPERM|ENOENT/.test(String(pr['P-write-root'])), String(pr['P-write-root']))
  check('P-etc: /etc/passwd is the two-line sandbox copy', pr['P-etc']?.text?.trim().split('\n').length === 2, JSON.stringify(pr['P-etc']))
  check('P-stolen-same: a stolen turn token is refused', /not authorized/.test(String(pr['P-stolen-same'])) && !/CANARY/.test(String(pr['P-stolen-same'])), String(pr['P-stolen-same']))
  // fail closed: when root takes firewall.json away, the next turn is refused
  fs.writeFileSync('/run/test-ctl/fw-off', ''); for (let i = 0; i < 50 && !fs.existsSync('/run/test-ctl/fw-off.done'); i++) await Bun.sleep(100)
  const refused = await fakeTurn(srv, 'alice', { calls: [] })
  check('fail closed: no firewall status -> turn refused', refused.exit?.ev === 'error' && /firewall_not_loaded/.test(refused.exit?.message ?? ''), JSON.stringify(refused.exit))
  fs.rmSync('/run/test-ctl/fw-off.done', { force: true })
  fs.writeFileSync('/run/test-ctl/fw-on', ''); for (let i = 0; i < 50 && !fs.existsSync('/run/test-ctl/fw-on.done'); i++) await Bun.sleep(100)
  fs.rmSync('/run/test-ctl/fw-on.done', { force: true })
  // the turn cgroups are gone after the turns
  await Bun.sleep(500)
  const leftover = (() => { try { return fs.readdirSync(TURNS_CG).filter((d) => d.startsWith('t-')) } catch { return [] } })()
  check('turn cgroups removed after the turns', leftover.length === 0, leftover.join(','))
  // forget deletes a chat's engine folder (the server account cannot)
  const { launcherForget, launcherStatus } = await import('../../server/src/native')
  const st = await launcherStatus('/run/mycel-launcher/launcher.sock')
  out.launcherStatus = st
  check('launcher status: bwrap + seccomp + a turn cgroup', !!st && st.sandbox === 'bwrap' && st.seccomp === true && st.cgroup === 'delegated', JSON.stringify(st))
  // the server account cannot look into the agent root (axagent 700): a turn leaves a marker in its chat folder,
  // forget removes the folder, and a new turn in the same chat (a fresh, empty folder) must not find the marker
  const chatId = 'c_' + Math.random().toString(36).slice(2, 8)
  const mark = await fakeTurn(srv, 'alice', { calls: [], probe: [{ id: 'mark', kind: 'write', path: 'marker' }] }, { chatId })
  const forgot = await launcherForget('/run/mycel-launcher/launcher.sock', chatId)
  const again = await fakeTurn(srv, 'alice', { calls: [], probe: [{ id: 'after', kind: 'stat', path: 'marker' }] }, { chatId })
  const markR = mark.lines.find((l: any) => l.probe === 'mark')?.result
  const afterR = again.lines.find((l: any) => l.probe === 'after')?.result
  check('forget deletes the engine folder (a later turn starts empty)', markR === 'wrote' && forgot.ok === true && afterR === 'ENOENT', JSON.stringify({ markR, forgot, afterR }))
} else {
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
}

// 3) reaper: setsid escapees of a turn must be gone shortly after it
await Bun.sleep(7000)
const ps = Bun.spawnSync(['ps', '-u', 'axagent', '-o', 'pid=,ppid=,sess=,args=']).stdout.toString().trim()
out.agentProcsAfter = ps
check('no turn processes survive as axagent after the turns (escapees reaped)', ps.split('\n').filter(Boolean).every((l) => /mycel-launcher/.test(l)), ps)
// 4) audit: rejected connections recorded
const ev = srv.db.query("SELECT tool, ok, summary FROM tool_events WHERE tool = '(connect)' AND ok = 0").all() as any[]
check('rejected connections audited', ev.length >= 1 || SANDBOX, JSON.stringify(ev.slice(0, 3)))
await srv.close()
proxyStandIn?.stop(true)

// 6) managed turns under the sandbox (docs/DECISIONS.md "AI 연결", spec 3.4): the whole chat runtime in managed mode
// with the team's API-key connections, the real model proxy on the one port nft lets the engine account reach, the
// engine account's launcher in bwrap mode, and a fake upstream on another loopback port. A managed Claude turn and a
// managed Codex turn each call the model: the request must arrive at the upstream through the proxy with the real key
// swapped in, plain HTTP to the proxy (Codex without any CONNECT tunnel), and the engine must see no real key and reach
// neither the upstream nor the server API port itself.
if (SANDBOX) {
  const UP = 19191
  const seen: { path: string; headers: Record<string, string>; body: string }[] = []
  const sse = (evs: unknown[]) => new Response(evs.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  const up = Bun.serve({ hostname: '127.0.0.1', port: UP, async fetch(req) {
    const u = new URL(req.url)
    const body = await req.text()
    seen.push({ path: u.pathname, headers: Object.fromEntries(req.headers), body })
    if (u.pathname.endsWith('/v1/messages')) return sse([
      { type: 'message_start', message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 10, output_tokens: 1 } } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'claude via proxy' } },
      { type: 'message_delta', usage: { output_tokens: 3 } },
    ])
    if (u.pathname.endsWith('/responses')) return sse([
      { type: 'response.created', response: { id: 'r1' } },
      { type: 'response.output_text.delta', delta: 'codex via proxy' },
      { type: 'response.completed', response: { id: 'r1', model: 'gpt-5.4', output: [{ type: 'message' }], usage: { input_tokens: 5, output_tokens: 2 } } },
    ])
    return new Response('not found', { status: 404 })
  } })
  const upUrl = `http://127.0.0.1:${UP}`
  let h: Awaited<ReturnType<typeof startHarness>> | null = null
  try {
    h = await startHarness({
      name: 'linux-managed', askUserTimeoutMs: 3000, turnTimeoutMs: 60_000,
      externalLauncher: { sock: '/run/mycel-launcher/launcher.sock', proxyPort: PROXY, toolsSockMode: '0666' },
      engineConfig: { runDir: '/run/mycel', agentRoot: '/srv/agent', agentUid: AG },
      engineBins: { claude: '/opt/fake-engine/claude', codex: '/opt/fake-engine/codex' },
      upstreams: { anthropic: upUrl, openai: upUrl + '/v1', chatgpt: upUrl + '/backend-api/codex', openaiAuth: upUrl },
    })
    const sock = await h.ws('alice', { windowId: 'win-t1-managed' })
    await sock.next('hello')
    const fake = (...d: unknown[]) => d.map((x) => '@fake ' + JSON.stringify(x)).join('\n')
    const turn = async (engine: 'claude-code' | 'codex', ...d: unknown[]) => {
      const chat = await h!.api('alice').call(API.createChat, { body: { engine } })
      const r = await ask(h!, sock, 'alice', chat.id, fake(...d), { ms: 60_000 })
      return { status: r.done.status, text: r.done.content, error: (r.done as { error?: unknown }).error }
    }
    const real = [HARNESS_KEYS.anthropic, HARNESS_KEYS.openai]
    const noReal = (s: string) => real.every((k) => !s.includes(k))
    for (const engine of ['claude-code', 'codex'] as const) {
      const name = engine === 'codex' ? 'managed Codex' : 'managed Claude'
      seen.length = 0
      const model = await turn(engine, engine === 'codex' ? { codexModel: 'hi' } : { model: 'hi' })
      const req = seen[0]
      const want = engine === 'codex' ? { path: '/v1/responses', header: 'authorization', value: 'Bearer ' + HARNESS_KEYS.openai } : { path: '/v1/messages', header: 'x-api-key', value: HARNESS_KEYS.anthropic }
      check(`${name}: the answer comes from the upstream through the model proxy`, model.status === 'done' && model.text === (engine === 'codex' ? 'codex via proxy' : 'claude via proxy'), JSON.stringify(model))
      check(`${name}: the upstream got the real key (swapped in by the proxy), never the turn token`,
        seen.length === 1 && req?.path === want.path && req?.headers[want.header] === want.value && !JSON.stringify(req).includes('mpx_'), JSON.stringify(seen.map((x) => ({ path: x.path, h: Object.keys(x.headers) }))))
      const env = await turn(engine, { echo: 'secrets' })
      check(`${name}: no real key or turn token in the engine's environment or argv`, /envSecrets=none argvSecrets=none/.test(env.text) && noReal(env.text), env.text)
      const direct = await turn(engine, { direct: upUrl + '/v1/messages' }, { say: ' ' }, { direct: 'http://127.0.0.1:19174/' })
      check(`${name}: the engine reaches neither the upstream nor the server API port directly`, direct.text === 'direct=blocked direct=blocked', direct.text)
    }
    // managed Codex specifics: the provider is the proxy over plain HTTP, no HTTPS_PROXY / CONNECT, no real key on disk
    const cenv = await turn('codex', { echo: 'codexEnv' })
    let ce: any = {}
    try { ce = JSON.parse(cenv.text) } catch {}
    check('managed Codex: the provider is the local model proxy over plain HTTP, no proxy variables',
      String(ce.baseUrl).startsWith(`http://127.0.0.1:${PROXY}/codex/openai`) && ce.proxyHost === null && ce.authMode === 'apikey' && ce.turnToken === true, cenv.text)
    const tunnel = await turn('codex', { connect: 'api.openai.com:443' })
    check('managed Codex: a CONNECT tunnel through the proxy is refused', /403/.test(tunnel.text), tunnel.text)
    const dump = await turn('codex', { dumpHome: true })
    const files = (() => { try { return Buffer.from(dump.text, 'base64').toString('utf8') } catch { return dump.text } })()
    check('managed Codex: nothing in CODEX_HOME, HOME or the chat folder holds a real key', /\.codex\/auth\.json/.test(files) && noReal(files), files.slice(0, 300))
    sock.close()
  } catch (e) {
    check('managed turns under the sandbox ran', false, String((e as Error)?.stack ?? e))
  } finally {
    await h?.close().catch(() => {})
    up.stop(true)
  }
}

// 5) unit tests that depend on the file system (case-sensitive here)
// (+ the AI connections: the key file's mode / owner checks, the resolver, the proxy's per-connection state and its
// Codex path against fake providers, on Linux; docs/DECISIONS.md "AI 연결" CR-20)
// (+ images and PDF pages the AI sees: the real normalizer and pdftoppm in bwrap and the converter cgroup, the access
// matrix, and no OCR anywhere on Linux; docs/DECISIONS.md "AI sees images and PDF pages")
const ut = Bun.spawnSync(['bun', 'test', 'unit/policy.test.ts', 'unit/files.test.ts', 'unit/engine.test.ts', 'unit/proxy.test.ts',
  'unit/a-credentials-store.test.ts', 'unit/a-credentials-resolve.test.ts', 'unit/proxy-credentials.test.ts', 'unit/proxy-codex.test.ts', 'unit/a-prices.test.ts',
  'unit/vision-read.test.ts', 'unit/vision-ocr-boundary.test.ts', 'security/vision-matrix.test.ts'], { cwd: path.resolve(import.meta.dir, '..'), env: { ...process.env } })
const utOut = ut.stdout.toString() + ut.stderr.toString()
out.unit = (utOut.match(/(\d+) pass[\s\S]*?(\d+) fail/) ?? [])[0]
check('unit tests (policy, files, engine, proxy, AI connections, AI image reads) on Linux', ut.exitCode === 0, utOut.split('\n').filter((l) => /fail|✗/.test(l)).slice(0, 10).join('\n'))

out.checks = checks
out.failed = checks.filter((c) => !c.ok).length
console.log('MYCEL_LINUX_RESULT ' + JSON.stringify(out))
try { for (const n of fs.readdirSync('/srv/mycel')) fs.rmSync(path.join('/srv/mycel', n), { recursive: true, force: true }) } catch {}
process.exit(out.failed ? 1 : 0)
