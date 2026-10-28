// The real Claude Code binary in managed mode (AI connections): the real engine core (sandboxed launcher with the
// production profile, LOCAL_LOGIN=0, model proxy on engine.proxyPort) runs `claude -p` exactly as a production turn.
//   default      a recording fake model service stands in for api.anthropic.com: checks that Claude Code reads the
//                per-turn token from the inherited fd (CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR), sends it to
//                ANTHROPIC_BASE_URL, and that only the connection's token reaches the model service. Costs nothing.
//   --real       spike S2 (docs/DECISIONS.md "AI 연결" CR-01): with the owner's real
//                `claude setup-token` in TEAMAX_SPIKE_SETUP_TOKEN (never printed): ① the free check the server does
//                when a token is added (POST /v1/messages/count_tokens with the OAuth token: 200 / 401 / other is
//                recorded) and ② one managed turn against the real api.anthropic.com (a few tokens of the plan).
// Usage: bun tests/e2e/g-subscription-real-claude.ts [--real] [--claude <path>] [--port <proxy port>]
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { ask, startHarness } from '../lib/b-harness'
import { tokenFile } from '../../server/src/proxy/subscription'
import { resolveLayout } from '../../server/src/system/layout'
import { importTokenFile } from '../../server/src/credentials/migrate'
import { credentialsOf, getRow, listRows } from '../../server/src/credentials/store'
import { verifySecret } from '../../server/src/credentials/validate'

const argv = process.argv.slice(2)
const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
const claude = fs.realpathSync(opt('--claude') ?? Bun.which('claude') ?? path.join(process.env.HOME ?? '', '.local', 'bin', 'claude'))
const proxyPort = Number(opt('--port') ?? 19702)
const real = argv.includes('--real')
const REAL = real ? (process.env.TEAMAX_SPIKE_SETUP_TOKEN ?? '').trim() : 'sk-ant-oat01-' + 'Z'.repeat(80)
if (real && !/^sk-ant-oat\d{2}-/.test(REAL)) { console.error('--real needs TEAMAX_SPIKE_SETUP_TOKEN=<the output of `claude setup-token`>'); process.exit(2) }

const seen: { method: string; path: string; headers: Record<string, string>; body: string }[] = []
const enc = new TextEncoder()
const ev = (type: string, o: Record<string, unknown>) => enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`)
const upstream = Bun.serve({
  port: Number(opt('--upstream-port') ?? 19701), hostname: '127.0.0.1', idleTimeout: 0,
  async fetch(req) {
    const u = new URL(req.url)
    const body = await req.text()
    seen.push({ method: req.method, path: u.pathname + u.search, headers: Object.fromEntries(req.headers), body })
    if (req.headers.get('authorization') !== 'Bearer ' + REAL) return Response.json({ type: 'error', error: { type: 'authentication_error', message: 'bad token' } }, { status: 401 })
    if (u.pathname.endsWith('/count_tokens')) return Response.json({ input_tokens: 42 })
    let j: { stream?: boolean; model?: string } = {}
    try { j = JSON.parse(body) } catch {}
    const model = j.model ?? 'claude-sonnet-4-5'
    const text = 'Hello from the fake model service.'
    const usage = { input_tokens: 321, output_tokens: 12, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    if (!j.stream) return Response.json({ id: 'msg_fake', type: 'message', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage })
    return new Response(new ReadableStream({
      start(ctl) {
        ctl.enqueue(ev('message_start', { message: { id: 'msg_fake', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } }))
        ctl.enqueue(ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }))
        for (const part of text.match(/.{1,8}/g)!) ctl.enqueue(ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: part } }))
        ctl.enqueue(ev('content_block_stop', { index: 0 }))
        ctl.enqueue(ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } }))
        ctl.enqueue(ev('message_stop', {}))
        ctl.close()
      },
    }), { headers: { 'content-type': 'text/event-stream', 'request-id': 'req_fake' } })
  },
})

const anthropic = real ? 'https://api.anthropic.com' : `http://127.0.0.1:${upstream.port}`
const h = await startHarness({
  name: 'g-sub-real', turnTimeoutMs: 120_000, credentials: [],
  realCore: { engine: { authMode: 'managed', claudeBin: claude, codexBin: '/nonexistent/codex', proxyPort, modelUpstream: anthropic } },
})
const secrets = resolveLayout(h.ctx.config).secretsDir
fs.mkdirSync(secrets, { recursive: true, mode: 0o700 })
fs.writeFileSync(tokenFile(secrets), REAL + '\n', { mode: 0o600 })
importTokenFile(credentialsOf(h.ctx), secrets)
if (real) {
  // S2 ①: what the server's free check gets for an OAuth token (decides nothing: 200 = verified, 401 = refused, any
  // other = saved as "checked on the first question"; DECISIONS "AI 연결" 3.8.1)
  const v = await verifySecret(credentialsOf(h.ctx), 'anthropic-oauth', REAL)
  console.log(JSON.stringify({ spike: 'S2-count_tokens', result: v.result, upstreamStatus: v.upstreamStatus }))
}
let ok = false
try {
  const sock = await h.ws('alice', { windowId: 'win-real' })
  await sock.next('hello')
  const chat = await h.api('alice').call(API.createChat, { body: {} })
  const { started, done } = await ask(h, sock, 'alice', chat.id, real ? 'Say hello in three words.' : 'Say hello.', { ms: 120_000 })
  const cred = listRows(h.ctx.db)[0]
  if (real) console.log(JSON.stringify({ spike: 'S2-managed-turn', status: done.status, error: done.error ?? null, answered: done.content.length > 0, credentialState: cred ? getRow(h.ctx.db, cred.id)?.status : null, checkedAt: cred ? getRow(h.ctx.db, cred.id)?.checked_at : null }))
  const turn = h.ctx.db.query('SELECT status, input_tokens, output_tokens, usage_source, error FROM turns WHERE id = ?').get(started.turnId)
  const refused = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'proxy.refused'").all()
  const leaks = seen.filter((s) => /mpx_/.test(JSON.stringify(s.headers) + s.body))
  const auths = [...new Set(seen.map((s) => s.headers.authorization))]
  console.log(JSON.stringify({
    answer: { status: done.status, content: done.content, error: done.error ?? null },
    turn, upstreamRequests: seen.map((s) => `${s.method} ${s.path}`), authorizations: auths.map((a) => a?.slice(0, 12) + '…'),
    betas: [...new Set(seen.map((s) => s.headers['anthropic-beta']))], userAgents: [...new Set(seen.map((s) => s.headers['user-agent']))],
    perTurnTokenLeaks: leaks.length, proxyRefused: refused,
  }, null, 2))
  ok = real ? done.status === 'done' && done.content.length > 0
    : done.status === 'done' && done.content.includes('Hello from the fake model service') && leaks.length === 0 && auths.length === 1 && auths[0] === 'Bearer ' + REAL
  sock.close()
} finally {
  await h.close()
  upstream.stop(true)
}
console.log(ok ? 'PASS' : 'FAIL')
process.exit(ok ? 0 : 1)
