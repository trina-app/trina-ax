// The REAL Codex CLI in managed mode against a FAKE model service (docs/DECISIONS.md "AI 연결" CR-20, S-19): no
// account, nothing spent. Real `codex exec` with the production lockdown arguments, the placeholder auth.json and the
// custom provider pointing at our model proxy; the proxy puts the connection's (fake) credential on the request and
// forwards to a local fake Responses endpoint. Checks what the spec claims from the Codex source (3.5.1): the provider's
// base_url wins, the placeholder login is used as-is (Authorization = the turn token on the way in, the real one on
// the way out), Codex never refreshes (no /codex/oauth/token call, auth.json unchanged), background calls are answered
// by the proxy, the answer streams back, usage is counted.
// Part 2 runs the same Codex through the REAL launcher (it writes and checks the placeholder login, refuses other
// provider addresses) with our team tools (MCP bridge + gate): the fake model service asks for the team folder
// listing (a function call), Codex calls our tool, the result goes back, the answer comes.
//   bun tests/engine/managed-real.ts [--codex <path>] [--keep]
// The run with the real backends is spike S1 (tests/engine/codex-managed-spike.ts, needs the owner's sign-in).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../../server/src/db'
import { codexArgs, writeLockedCatalog, CODEX_VERSION, type CodexConf } from '../../server/src/engine/codex'
import { issueProxyToken, startModelProxy } from '../../server/src/proxy/model-proxy'
import { createBroker } from '../../server/src/credentials/broker'
import { makeCredCtx } from '../../server/src/credentials/store'
import { insertRow } from '../../server/src/credentials/service'
import { dummyAuthJson } from '../../server/src/credentials/codex-home'

const argv = process.argv.slice(2)
const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
const codexBin = fs.realpathSync(opt('--codex') ?? Bun.which('codex') ?? '/usr/local/bin/codex')
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-real-'))
const REAL_ACCESS = 'eyJ.REAL-ACCESS-TOKEN-OF-THE-CONNECTION.sig'

// ---------------- a fake chatgpt.com / api.openai.com Responses endpoint ----------------
const seen: { path: string; method: string; headers: Record<string, string>; body: any }[] = []
/** part 2: the fake asks for this tool once, then answers with the tool's output in view */
let toolTurn = false
const toolNames = (tools: any[]): string[] => (tools ?? []).flatMap((t: any) => (Array.isArray(t?.tools) ? toolNames(t.tools) : typeof t?.name === 'string' ? [t.name] : []))
const ev = (type: string, o: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`
const fake = Bun.serve({
  port: 0, hostname: '127.0.0.1', idleTimeout: 0,
  async fetch(req) {
    const u = new URL(req.url)
    let body: any = null
    try { body = await req.json() } catch {}
    seen.push({ path: u.pathname, method: req.method, headers: Object.fromEntries(req.headers), body })
    if (!u.pathname.endsWith('/responses')) return new Response('not here', { status: 404 })
    const id = 'resp_' + Math.random().toString(36).slice(2, 10)
    if (toolTurn) {
      const out = (body?.input ?? []).find((x: any) => x?.type === 'function_call_output')
      if (!out) {
        // the team tools come as a namespace (mcp__team) in the tool list (top level, or an additional_tools input item)
        const all = [...(body?.tools ?? []), ...(body?.input ?? []).filter((x: any) => Array.isArray(x?.tools)).flatMap((x: any) => x.tools)]
        const ns = all.find((t: any) => Array.isArray(t?.tools) && t.tools.some((u: any) => u?.name === 'list'))
        const call = { id: 'fc_1', type: 'function_call', status: 'completed', call_id: 'call_1', name: 'list', ...(ns ? { namespace: ns.name } : {}), arguments: '{}' }
        return new Response(ev('response.created', { response: { id, status: 'in_progress', output: [] } }) + ev('response.output_item.done', { output_index: 0, item: call })
          + ev('response.completed', { response: { id, status: 'completed', model: body?.model, output: [call], usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } }), { headers: { 'content-type': 'text/event-stream' } })
      }
      const text = `TEAM-TOOL-OK ${JSON.stringify(out.output).includes('shared') ? 'saw-shared' : 'no-shared'}`
      const m2 = { id: 'msg_2', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
      return new Response(ev('response.created', { response: { id, status: 'in_progress', output: [] } }) + ev('response.output_item.added', { output_index: 0, item: { ...m2, status: 'in_progress', content: [] } })
        + ev('response.content_part.added', { item_id: 'msg_2', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
        + ev('response.output_text.delta', { item_id: 'msg_2', output_index: 0, content_index: 0, delta: text })
        + ev('response.output_item.done', { output_index: 0, item: m2 }) + ev('response.completed', { response: { id, status: 'completed', model: body?.model, output: [m2], usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } }), { headers: { 'content-type': 'text/event-stream' } })
    }
    const msg = { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'MANAGED-OK', annotations: [] }] }
    const usage = { input_tokens: 1234, input_tokens_details: { cached_tokens: 0 }, output_tokens: 7, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 1241 }
    const sse = ev('response.created', { response: { id, object: 'response', status: 'in_progress', model: body?.model, output: [] } })
      + ev('response.output_item.added', { output_index: 0, item: { ...msg, status: 'in_progress', content: [] } })
      + ev('response.content_part.added', { item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
      + ev('response.output_text.delta', { item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'MANAGED-OK' })
      + ev('response.output_text.done', { item_id: 'msg_1', output_index: 0, content_index: 0, text: 'MANAGED-OK' })
      + ev('response.output_item.done', { output_index: 0, item: msg })
      + ev('response.completed', { response: { id, object: 'response', status: 'completed', model: body?.model, output: [msg], usage } })
    return new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
  },
})
const up = `http://127.0.0.1:${fake.port}`

// ---------------- the team server's pieces ----------------
const db = openDb(path.join(W, 'app.db'))
db.query("INSERT INTO users (id, username, name, role) VALUES ('owner', 'owner', 'Owner', 'owner')").run()
const cc = makeCredCtx({ db, secretsDir: path.join(W, 'secrets'), config: { mode: 'dev', dataDir: W, engine: { authMode: 'managed', modelUpstreams: { chatgpt: up + '/backend-api/codex', openai: up + '/v1', openaiAuth: up } } }, log: { info() {}, warn() {}, error() {} } })
const G = insertRow(cc, { kind: 'chatgpt', label: 'fake plan', secret: { idToken: 'x.eyJ9.y', accessToken: REAL_ACCESS, refreshToken: 'rt-REAL', accountId: 'acc-real', lastRefresh: new Date().toISOString() }, ownerUserId: null, priority: 100, assignments: [], createdBy: null, meta: { planType: 'pro' } })
const K = insertRow(cc, { kind: 'openai-api-key', label: 'fake key', secret: { key: 'sk-proj-REALKEY' + 'x'.repeat(30) }, ownerUserId: null, priority: 100, assignments: [], createdBy: null })
const catalogSrc = path.join(os.homedir(), '.codex', 'models_cache.json')
const catalog = path.join(W, 'catalog.json')
const models = fs.existsSync(catalogSrc) ? writeLockedCatalog(catalogSrc, catalog) : (() => { throw new Error('no ~/.codex/models_cache.json (run codex once)') })()
const model = models[0]!
const proxy = await startModelProxy({ db, broker: createBroker(cc), codexModels: () => models })

const checks: { name: string; ok: boolean; detail?: string }[] = []
const check = (name: string, ok: boolean, detail = '') => { checks.push({ name, ok, detail: String(detail).slice(0, 500) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `  ${String(detail).slice(0, 500)}`}`) }

async function turn(mode: 'chatgpt' | 'openai', cred: string) {
  const turnId = `mr-${mode}-${Math.random().toString(36).slice(2, 8)}`
  db.query("INSERT INTO turns (id, chat_id, user_id, engine, status) VALUES (?, 'c', 'owner', 'codex', 'running')").run(turnId)
  const token = issueProxyToken(db, turnId, 'owner', { credentialId: cred, family: 'openai', ttlMs: 10 * 60_000 })
  const dir = fs.mkdtempSync(path.join(W, 'chat-'))
  const home = path.join(dir, '.codex'); fs.mkdirSync(home, { mode: 0o700 }); fs.mkdirSync(path.join(dir, '.home'), { mode: 0o700 })
  const auth = dummyAuthJson({ credentialId: cred, kind: mode === 'chatgpt' ? 'chatgpt' : 'openai-api-key', planType: 'pro', fedramp: false }, token)
  fs.writeFileSync(path.join(home, 'auth.json'), auth, { mode: 0o600 })
  const conf: CodexConf = { bin: codexBin, codexHome: home, agentHome: path.join(dir, '.home'), catalog, model, auth: 'managed' }
  let args = codexArgs(conf, { model, managed: { port: proxy.port, mode, codexVersion: CODEX_VERSION } })
  args = args.filter((a, i) => !a.startsWith('mcp_servers.') && !(a === '-c' && args[i + 1]?.startsWith('mcp_servers.')))
  const n0 = seen.length
  const p = Bun.spawn([codexBin, ...args], {
    cwd: dir, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    env: { PATH: '/usr/bin:/bin', HOME: path.join(dir, '.home'), CODEX_HOME: home, LANG: 'en_US.UTF-8', CODEX_REFRESH_TOKEN_URL_OVERRIDE: `http://127.0.0.1:${proxy.port}/codex/oauth/token` },
  })
  p.stdin.write('Say the word you are told to say.'); p.stdin.end()
  const t = setTimeout(() => p.kill(), 120_000)
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  clearTimeout(t)
  const events = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const text = events.filter((e: any) => e.type === 'item.completed' && e.item?.type === 'agent_message').map((e: any) => e.item.text).join(' ')
  const mine = seen.slice(n0)
  const authAfter = fs.readFileSync(path.join(home, 'auth.json'), 'utf8')
  const turnRow = db.query('SELECT input_tokens, output_tokens FROM turns WHERE id = ?').get(turnId) as { input_tokens: number; output_tokens: number }
  const refused = db.query("SELECT detail FROM audit_log WHERE action = 'proxy.refused' AND (target = ? OR target IS NULL)").all(turnId) as { detail: string }[]
  return { code, events, text, mine, authAfter, auth, token, turnRow, refused, err }
}

try {
  for (const [mode, cred] of [['chatgpt', G], ['openai', K]] as const) {
    const r = await turn(mode, cred)
    const resp = r.mine.filter((s) => s.path.endsWith('/responses'))
    check(`${mode}: the turn completed with the answer from the (fake) model service (exit 0)`, r.code === 0 && r.events.some((e: any) => e.type === 'turn.completed') && r.text.includes('MANAGED-OK'), `exit ${r.code}; ${r.err.split('\n').slice(-5).join(' | ')}; events ${r.events.map((e: any) => e.type).join(',')}`)
    check(`${mode}: requests went to the provider base_url (our proxy) and on to the real path`, resp.length > 0 && resp.every((s) => s.path === (mode === 'chatgpt' ? '/backend-api/codex/responses' : '/v1/responses')), JSON.stringify(r.mine.map((s) => s.path)))
    check(`${mode}: upstream got the connection's credential, never the turn token`, resp.length > 0 && resp.every((s) => (mode === 'chatgpt' ? s.headers.authorization === 'Bearer ' + REAL_ACCESS && s.headers['chatgpt-account-id'] === 'acc-real' : s.headers.authorization?.startsWith('Bearer sk-proj-REALKEY'))) && !JSON.stringify(r.mine).includes(r.token), JSON.stringify(resp.map((s) => ({ a: s.headers.authorization?.slice(0, 20), acct: s.headers['chatgpt-account-id'] }))))
    check(`${mode}: store false, model from the locked catalog, only allowed tool types`, resp.every((s) => s.body?.store === false && models.includes(s.body?.model)), JSON.stringify(resp.map((s) => ({ store: s.body?.store, model: s.body?.model, tools: (s.body?.tools ?? []).map((x: any) => x.type) }))))
    check(`${mode}: Codex never refreshed and never rewrote auth.json`, r.authAfter === r.auth && !r.refused.some((x) => /engine refresh attempt/.test(x.detail)), r.refused.map((x) => x.detail).join(' '))
    check(`${mode}: usage counted by the proxy`, r.turnRow.input_tokens >= 1234 && r.turnRow.output_tokens >= 7, JSON.stringify(r.turnRow))
    check(`${mode}: the version header (as the built-in provider) was sent`, resp.every((s) => s.headers.version === CODEX_VERSION), JSON.stringify(resp.map((s) => s.headers.version)))
    for (const e of r.events.filter((e: any) => e.type === 'error' || e.type === 'turn.failed')) console.log('  event:', JSON.stringify(e).slice(0, 400))
    console.log(`  requests: ${[...new Set(r.mine.map((s) => `${s.method} ${s.path}`))].join(', ')}`)
  }
  // ---------------- part 2: the real launcher and our team tools ----------------
  toolTurn = true
  const { startHarness, ask } = await import('../lib/b-harness')
  const { StaticEngines } = await import('../../server/src/chat/engines')
  const { API } = await import('@mycel/shared/api')
  const h = await startHarness({ name: 'managed-real', allowCmds: [codexBin], codexModels: models, upstreams: { chatgpt: up + '/backend-api/codex', openai: up + '/v1', openaiAuth: up },
    credentials: [{ kind: 'openai-api-key', secret: 'sk-proj-REALKEY' + 'y'.repeat(30) }] })
  ;(h.rt() as unknown as { engines: unknown }).engines = new StaticEngines({ claude: null, codex: { bin: codexBin, codexHome: '', agentHome: '', catalog, model, auth: 'managed' }, problems: {}, codexModels: models })
  try {
    const sock = await h.ws('alice', { windowId: 'win-managed-real' })
    await sock.next('hello')
    const chat = await h.api('alice').call(API.createChat, { body: { engine: 'codex' } })
    // keep the engine's own event lines (the --json stream) for the report
    const core = await h.ctx.core()
    const lines: string[] = []
    const launcher = core.launcher!
    const orig = launcher.launch.bind(launcher)
    launcher.launch = (req) => {
      const hd = orig(req)
      const src = hd.events
      return { kill: hd.kill, events: { async *[Symbol.asyncIterator]() { for await (const e of src) { if (e.ev === 'stdout') lines.push(...Buffer.from(e.b64, 'base64').toString('utf8').split('\n').filter(Boolean)); yield e } } } }
    }
    const n0 = seen.length
    const r = await ask(h, sock, 'alice', chat.id, 'List the team folder.', { ms: 120_000 })
    const tools = h.ctx.db.query('SELECT tool, ok FROM tool_events WHERE turn_id = ?').all(r.started.turnId) as { tool: string; ok: number }[]
    if (process.env.DEBUG_TOOLS) console.log('TOOLS', JSON.stringify(seen.slice(n0).map((x) => (x.body?.input ?? []).filter((i: any) => Array.isArray(i?.tools)).map((i: any) => i.tools.map((t: any) => `${t.type}:${t.name ?? ''}${Array.isArray(t.tools) ? '[' + t.tools.map((u: any) => u.name).join(',') + ']' : ''}`)))).slice(0, 3000))
    check('launcher: the managed turn ran (placeholder login written and accepted by the launcher)', r.done.status === 'done', JSON.stringify(r.done.error) + ' events: ' + lines.map((l) => { try { const j = JSON.parse(l); return j.type === 'error' || j.type === 'turn.failed' ? JSON.stringify(j) : j.type + (j.item?.type ? ':' + j.item.type : '') } catch { return l.slice(0, 80) } }).join(' | '))
    check('team tools: Codex called our list tool through the bridge and the gate', tools.some((t) => t.tool === 'list' && t.ok === 1), JSON.stringify(tools) + ' tools offered: ' + JSON.stringify((seen[n0]?.body?.input ?? []).filter((x: any) => Array.isArray(x?.tools)).flatMap((x: any) => toolNames(x.tools))))
    check('the tool result went back to the model and the answer came', r.done.content.includes('TEAM-TOOL-OK saw-shared'), r.done.content)
    check('the chat folder kept nothing of the turn\'s login', !fs.existsSync(path.join(h.ctx.engineConfig.agentRoot, chat.id, '.codex')), '')
    sock.close()
  } finally { await h.close() }
} finally {
  await proxy.stop(); fake.stop(true); db.close()
  if (!argv.includes('--keep')) fs.rmSync(W, { recursive: true, force: true })
}
const failed = checks.filter((c) => !c.ok).length
console.log(`${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
