// The model proxy's Codex path against fake chatgpt.com / api.openai.com / auth.openai.com (docs/DECISIONS.md "AI 연결"
// D9/D10/D21): the real access token and account go upstream, the turn token never; what the engine sends to choose
// an account is ignored; the request filter (no remote MCP, code interpreter, file search, computer use, image
// generation, URL images / files, background, stored state, models outside the catalog; store forced off; the checked
// body written again); background calls answered locally; the engine's own refresh refused; WebSockets refused; the
// server's single-flight refresh with the rotated token stored first; invalid_grant -> needs reconnect; 401 -> one
// refresh and one retry; redirects never followed; 429 kinds. S-2, S-5, S-7, S-12, S-13, S-17.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import net from 'node:net'
import path from 'node:path'
import { makeEnv } from '../lib/env'
import { addCred, chatgptSecret, fakeJwt, testCredCtx } from '../lib/credentials'
import { issueProxyToken, startModelProxy, type ProxyTurnEvent } from '../../server/src/proxy/model-proxy'
import { setSetting } from '../../server/src/admin/settings'
import { SHARED_SUBSCRIPTIONS_KEY } from '../../server/src/credentials/policy'
import { createBroker, onUsage } from '../../server/src/credentials/broker'
import { afterCredentialUsage } from '../../server/src/credentials/limits'
import { getRow, secretOf } from '../../server/src/credentials/store'
import { refreshIdle } from '../../server/src/credentials/chatgpt-tokens'
import { CODEX_CLIENT_ID } from '../../server/src/credentials/openai-oauth'
import { monthUsage } from '../../server/src/credentials/store'
import { waitFor } from '../lib/wait'
import { TurnRegistry } from '../../server/src/turns'
import { openDb } from '../../server/src/db'

const env = makeEnv('proxy-codex')
type Seen = { path: string; headers: Record<string, string>; body: any }
const seen: Seen[] = []
const refreshes: any[] = []
let respMode: 'ok' | '401-old' | '429-usage' | '429-plan' | '429-short' | '429-credit' | 'redirect' | '500' | 'untyped' | 'text' | 'hold' = 'ok'
let refreshMode: 'ok' | 'invalid_grant' | 'redirect' | 'slow' = 'ok'
let validAccess = new Set<string>()
let n429 = 0
const sse = (o: unknown) => `event: x\ndata: ${JSON.stringify(o)}\n\n`
// an answer of chatgpt.com/backend-api/codex/responses as Codex 0.163 reads it (codex-api/src/sse/responses.rs
// ResponseCompletedUsage): named events, the usage only in response.completed, and no content-type header at all
const REAL_USAGE = { input_tokens: 9277, input_tokens_details: { cached_tokens: 8960 }, output_tokens: 31, output_tokens_details: { reasoning_tokens: 12 }, total_tokens: 9308 }
const realEv = (o: { type: string; [k: string]: unknown }) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`
const msg = { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hi there', annotations: [] }] }
const REAL_HEAD = realEv({ type: 'response.created', response: { id: 'resp_1', object: 'response', status: 'in_progress', model: 'gpt-5.4', output: [], usage: null } })
  + realEv({ type: 'response.output_item.added', output_index: 0, item: { ...msg, status: 'in_progress', content: [] } })
  + realEv({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'hi' })
const REAL_TAIL = realEv({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: ' there' })
  + realEv({ type: 'response.output_item.done', output_index: 0, item: msg })
  + realEv({ type: 'response.completed', response: { id: 'resp_1', object: 'response', status: 'completed', model: 'gpt-5.4-2026-03-05', output: [msg], usage: REAL_USAGE } })
let releaseUntyped: (() => void) | null = null
let untypedCancelled = false
let holdAborted = false
const fake = Bun.serve({
  port: 0, hostname: '127.0.0.1',
  async fetch(req) {
    const u = new URL(req.url)
    const text = await req.text()
    let body: any = null
    try { body = JSON.parse(text) } catch {}
    if (u.pathname === '/oauth/token') {
      refreshes.push(body)
      if (refreshMode === 'redirect') return new Response(null, { status: 307, headers: { location: 'http://127.0.0.1:1/x' } })
      if (refreshMode === 'invalid_grant') return Response.json({ error: 'invalid_grant', error_description: 'reused' }, { status: 400 })
      if (refreshMode === 'slow') await Bun.sleep(200)
      const access = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, n: refreshes.length })
      validAccess.add(access)
      return Response.json({ access_token: access, refresh_token: 'rt-rotated-' + refreshes.length, id_token: fakeJwt({ 'https://api.openai.com/auth': { chatgpt_plan_type: 'business', chatgpt_account_id: 'acc-1' } }) })
    }
    seen.push({ path: u.pathname, headers: Object.fromEntries(req.headers), body })
    if (respMode === 'redirect') return new Response(null, { status: 307, headers: { location: 'http://127.0.0.1:1/steal' } })
    if (respMode === '500') return new Response('down', { status: 500 })
    if (respMode === '401-old' && !validAccess.has((req.headers.get('authorization') ?? '').slice(7))) return Response.json({ error: { message: 'expired' } }, { status: 401 })
    if (respMode === '429-usage') return Response.json({ error: { type: 'usage_limit_reached', plan_type: 'plus', resets_at: Math.floor(Date.now() / 1000) + 7200 } }, { status: 429 })
    if (respMode === '429-plan') return Response.json({ error: { type: 'usage_not_included' } }, { status: 429 })
    if (respMode === '429-credit') return Response.json({ error: { type: 'insufficient_quota', code: 'insufficient_quota' } }, { status: 429 })
    if (respMode === '429-short' && n429++ === 0) return Response.json({ error: { type: 'rate_limit_exceeded' } }, { status: 429, headers: { 'retry-after': '1' } })
    if (respMode === 'untyped') {
      // the first events, then the rest once the test lets it go, then the end a moment later (Codex has hung up by then)
      const e = new TextEncoder()
      return new Response(new ReadableStream<Uint8Array>({
        async start(c) {
          c.enqueue(e.encode(REAL_HEAD))
          await new Promise<void>((r) => (releaseUntyped = r))
          try { c.enqueue(e.encode(REAL_TAIL)) } catch {}
          await Bun.sleep(300)
          try { c.close() } catch {}
        },
        cancel() { untypedCancelled = true },
      }), { headers: { 'x-codex-primary-used-percent': '33' } })
    }
    if (respMode === 'text') return new Response(REAL_HEAD + REAL_TAIL, { headers: { 'content-type': 'text/plain; charset=utf-8' } })
    if (respMode === 'hold') { await new Promise<void>((r) => req.signal.addEventListener('abort', () => { holdAborted = true; r() })); return new Response(null, { status: 499 }) }
    return new Response(sse({ type: 'response.output_text.delta', delta: 'hi' }) + sse({ type: 'response.completed', response: { model: 'gpt-5.4', output: [{ type: 'message' }], usage: { input_tokens: 300, input_tokens_details: { cached_tokens: 100 }, output_tokens: 20 } } }),
      { headers: { 'content-type': 'text/event-stream', 'x-codex-primary-used-percent': '33' } })
  },
})
const up = `http://127.0.0.1:${fake.port}`
const t = testCredCtx(env.db, path.join(env.fx.data, 'secrets'), { upstreams: { chatgpt: up + '/backend-api/codex', openai: up + '/v1', openaiAuth: up } })
env.db.query("INSERT INTO turns (id, chat_id, user_id, engine, status) VALUES ('cx', 'c', 'alice', 'codex', 'running')").run()
const OKEY = 'sk-proj-' + 'K'.repeat(40)
const K = addCred(t.cc, 'openai-api-key', OKEY)
const events: ProxyTurnEvent[] = []
const logged: Record<string, unknown>[] = []
const at = (level: string) => (msg: string, f: Record<string, unknown> = {}) => { logged.push({ level, msg, ...f }) }
const stopped = new Map<string, 'stopped' | 'timeout' | 'shutdown'>()
let stopLookupFails = false
const broker = createBroker(t.cc)
onUsage(t.cc, (_u, c) => afterCredentialUsage(t.cc, c)) // the monthly connection limits, as brokerOf() wires them
const proxy = await startModelProxy({ db: env.db, broker, codexModels: () => ['gpt-5.4', 'gpt-6.1-sol'], onTurnEvent: (_t, ev) => events.push(ev),
  log: { warn: at('warn'), info: at('info'), debug: at('debug') }, stopReason: (turnId) => { if (stopLookupFails) throw new Error('database closed'); return stopped.get(turnId) ?? null } })
afterAll(async () => { await proxy.stop(); fake.stop(true) })

let G = ''
let REAL = chatgptSecret('acc-1')
const freshChatgpt = (o: Parameters<typeof chatgptSecret>[1] = {}) => {
  if (G) env.db.query('DELETE FROM engine_credentials WHERE id = ?').run(G)
  REAL = chatgptSecret('acc-1', { access: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, real: 1 }), refresh: 'rt-REAL', ...o })
  validAccess = new Set([REAL.accessToken])
  G = addCred(t.cc, 'chatgpt', REAL, { plan: 'pro' })
}
freshChatgpt()
beforeEach(() => {
  setSetting(env.db, SHARED_SUBSCRIPTIONS_KEY, true) // this suite exercises an explicitly shared ChatGPT connection
  seen.length = 0; refreshes.length = 0; events.length = 0; respMode = 'ok'; refreshMode = 'ok'; n429 = 0
  env.db.query("UPDATE engine_credentials SET status = 'ok', status_code = NULL, limited_until = NULL WHERE id = ?").run(K)
})

const tokFor = (cred: string) => issueProxyToken(env.db, 'cx', 'alice', { credentialId: cred, family: 'openai' })
const body = (o: Record<string, unknown> = {}) => ({ model: 'gpt-5.4', instructions: 'x', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }], tools: [{ type: 'function', name: 'team__read', parameters: {} }, { type: 'web_search' }], stream: true, store: false, ...o })
const post = (mode: 'chatgpt' | 'openai', token: string, b: unknown = body(), extra: Record<string, string> = {}) =>
  fetch(`${proxy.url}/codex/${mode}/responses`, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'text/event-stream', originator: 'codex_exec', version: '0.163.0', ...extra }, body: typeof b === 'string' ? b : JSON.stringify(b) })

describe('S-2 / S-5: the real credential goes upstream, never the turn token, whatever the engine sends', () => {
  test('ChatGPT: real access token and account id; engine headers to pick another account dropped; usage counted', async () => {
    const tok = tokFor(G)
    const r = await post('chatgpt', tok, body({ store: true }), { 'chatgpt-account-id': 'acc-attacker', 'x-openai-fedramp': 'true', cookie: 'a=b', 'openai-organization': 'org-x' })
    expect(r.status).toBe(200)
    const text = await r.text()
    expect(text).toContain('response.completed')
    expect(r.headers.get('x-codex-primary-used-percent')).toBe('33')
    const s = seen[0]!
    expect(s.path).toBe('/backend-api/codex/responses')
    expect(s.headers.authorization).toBe('Bearer ' + REAL.accessToken)
    expect(s.headers['chatgpt-account-id']).toBe('acc-1')
    expect(s.headers['x-openai-fedramp']).toBeUndefined(); expect(s.headers.cookie).toBeUndefined(); expect(s.headers['openai-organization']).toBeUndefined()
    expect(s.headers.originator).toBe('codex_exec'); expect(s.headers.version).toBe('0.163.0')
    expect(s.body.store).toBe(false)
    expect(JSON.stringify(s)).not.toContain(tok)
    const turn = env.db.query('SELECT input_tokens, output_tokens, cost_usd FROM turns WHERE id = ?').get('cx') as any
    expect(turn.input_tokens).toBeGreaterThanOrEqual(300); expect(turn.cost_usd).toBe(0) // a subscription: tokens, no price
  })
  test('OpenAI API key: the key as the Bearer, no account header', async () => {
    const r = await post('openai', tokFor(K))
    expect(r.status).toBe(200)
    expect(seen[0]!.path).toBe('/v1/responses')
    expect(seen[0]!.headers.authorization).toBe('Bearer ' + OKEY)
    expect(seen[0]!.headers['chatgpt-account-id']).toBeUndefined()
  })
  test('the token\'s connection decides the path: a ChatGPT token on /codex/openai is refused', async () => {
    expect((await post('openai', tokFor(G))).status).toBe(403)
    expect((await post('chatgpt', tokFor(K))).status).toBe(403)
    expect(seen).toEqual([])
  })
})

describe('S-7: what may reach OpenAI with the team\'s credential', () => {
  test('refused before anything goes out', async () => {
    const tok = tokFor(K)
    const refused: [string, unknown][] = [
      ['remote MCP', body({ tools: [{ type: 'mcp', server_url: 'https://evil.example/mcp', server_label: 'x' }] })],
      ['code interpreter', body({ tools: [{ type: 'code_interpreter', container: { type: 'auto' } }] })],
      ['file search', body({ tools: [{ type: 'file_search', vector_store_ids: ['vs'] }] })],
      ['computer use', body({ tools: [{ type: 'computer_use_preview', display_width: 1, display_height: 1 }] })],
      ['image generation', body({ tools: [{ type: 'image_generation' }] })],
      ['local shell', body({ tools: [{ type: 'local_shell' }] })],
      ['custom tool', body({ tools: [{ type: 'custom', name: 'x' }] })],
      ['inside a namespace', body({ tools: [{ type: 'namespace', name: 'ns', tools: [{ type: 'function', name: 'a' }, { type: 'mcp', server_url: 'https://e.example' }] }] })],
      // Codex 0.163 with a "responses lite" model lists its tools in an input item (found with the real CLI)
      ['in an additional_tools input item', body({ tools: undefined, input: [{ type: 'additional_tools', role: 'developer', tools: [{ type: 'namespace', name: 'mcp__team', tools: [{ type: 'function', name: 'list' }] }, { type: 'code_interpreter', container: { type: 'auto' } }] }] })],
      ['image from a URL', body({ input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'https://evil.example/?d=secret' }] }] })],
      ['image by file id', body({ input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', file_id: 'file-1' }] }] })],
      ['file from a URL', body({ input: [{ type: 'message', role: 'user', content: [{ type: 'input_file', file_url: 'https://evil.example/f.pdf' }] }] })],
      ['file by id', body({ input: [{ type: 'message', role: 'user', content: [{ type: 'input_file', file_id: 'file-1' }] }] })],
      ['URL image inside a function output', body({ input: [{ type: 'function_call_output', call_id: 'c', output: [{ type: 'input_image', image_url: 'http://x.example/a.png' }] }] })],
      ['background', body({ background: true })],
      ['stored conversation', body({ previous_response_id: 'resp_1' })],
      ['conversation', body({ conversation: 'conv_1' })],
      ['stored prompt', body({ prompt: { id: 'pmpt_1' } })],
      ['priority tier', body({ service_tier: 'priority' })],
      ['model outside the catalog', body({ model: 'o3-pro' })],
    ]
    for (const [label, b] of refused) {
      const r = await post('openai', tok, b)
      expect(r.status, label).toBe(403)
      expect((await r.json()).error.message, label).toContain('refused by the team server')
    }
    expect(seen).toEqual([])
    // what the real Codex sends for its team tools passes (namespace of functions in an additional_tools item)
    expect((await post('openai', tok, body({ tools: undefined, input: [{ type: 'additional_tools', role: 'developer', tools: [{ type: 'namespace', name: 'mcp__team', tools: [{ type: 'function', name: 'list', parameters: {} }] }, { type: 'web_search' }] }] }))).status).toBe(200)
    // inline data passes
    const ok = await post('openai', tok, body({ input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AA==' }, { type: 'input_file', filename: 'a.pdf', file_data: 'data:application/pdf;base64,AA==' }] }] }))
    expect(ok.status).toBe(200)
  })
  test('nesting: what Codex really sends passes (found with the real CLI, tests/engine/managed-real.ts); absurd nesting does not', async () => {
    const tok = tokFor(K)
    const deepOk = body({ input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x' }] }, { type: 'reasoning', summary: [{ type: 'summary_text', text: 'r' }], content: null, encrypted_content: null },
      { type: 'function_call', name: 'f', arguments: '{"a":{"b":{"c":[1,2,{"d":[3]}]}}}', call_id: 'c1' }, { type: 'function_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'ok' }] }] })
    expect((await post('openai', tok, deepOk)).status).toBe(200)
    let nested: unknown = [{ type: 'input_text', text: 'x' }]
    for (let i = 0; i < 10; i++) nested = [{ type: 'function_call_output', call_id: 'c', output: nested }]
    expect((await post('openai', tok, body({ input: nested }))).status).toBe(403)
  })
  test('the checked body is what goes out (a duplicate key cannot smuggle a refused tool)', async () => {
    const raw = `{"model":"gpt-5.4","tools":[{"type":"mcp","server_url":"https://evil.example"}],"input":[],"tools":[{"type":"function","name":"a"}],"store":true}`
    const r = await post('openai', tokFor(K), raw)
    expect(r.status).toBe(200)
    expect(seen[0]!.body.tools).toEqual([{ type: 'function', name: 'a' }])
    expect(JSON.stringify(seen[0]!.body)).not.toContain('evil')
    expect(seen[0]!.body.store).toBe(false)
  })
  test('web search stays on the cached index: every web_search goes out with external_web_access false; web_search_preview (always live) is refused', async () => {
    // a live search could open any address outside the team server's address rules (docs/DECISIONS.md "Outbound web channels")
    const tok = tokFor(K)
    expect((await post('openai', tok, body({ tools: [{ type: 'web_search', external_web_access: true }] }))).status).toBe(200)
    expect(seen.at(-1)!.body.tools).toEqual([{ type: 'web_search', external_web_access: false }])
    expect((await post('openai', tok, body())).status).toBe(200)
    expect(seen.at(-1)!.body.tools[1]).toEqual({ type: 'web_search', external_web_access: false })
    expect((await post('openai', tok, body({ tools: undefined, input: [{ type: 'additional_tools', role: 'developer', tools: [{ type: 'namespace', name: 'mcp__team', tools: [{ type: 'function', name: 'list', parameters: {} }] }, { type: 'web_search', external_web_access: true }] }] }))).status).toBe(200)
    expect(seen.at(-1)!.body.input[0].tools[1]).toEqual({ type: 'web_search', external_web_access: false })
    const before = seen.length
    for (const b of [body({ tools: [{ type: 'web_search_preview' }] }), body({ tools: [{ type: 'web_search_preview', tools: [] }] }), body({ tools: undefined, input: [{ type: 'additional_tools', role: 'developer', tools: [{ type: 'web_search_preview' }] }] })]) {
      const r = await post('openai', tok, b)
      expect(r.status).toBe(403)
      expect((await r.json()).error.message).toContain('web_search_preview')
    }
    expect(seen.length).toBe(before)
  })
  test('background calls are answered here; the engine\'s own refresh is refused and audited; unknown paths 404', async () => {
    expect(await (await fetch(proxy.url + '/codex/backend/wham/config/bundle')).json()).toEqual({})
    expect((await fetch(proxy.url + '/codex/backend/wham/accounts/check')).status).toBe(404)
    expect((await fetch(proxy.url + '/codex/backend/codex/analytics-events/events', { method: 'POST', body: '{}' })).status).toBe(404)
    expect((await fetch(proxy.url + '/codex/openai/models')).status).toBe(404)
    const ref = await fetch(proxy.url + '/codex/oauth/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: 'teamax-no-refresh' }) })
    expect(ref.status).toBe(400); expect((await ref.json()).error).toBe('invalid_grant')
    const a = env.db.query("SELECT detail FROM audit_log WHERE action = 'proxy.refused' ORDER BY id DESC LIMIT 1").get() as { detail: string }
    expect(JSON.parse(a.detail).reason).toBe('engine refresh attempt')
    expect(seen).toEqual([]); expect(refreshes).toEqual([])
  })
  test('S-17: a WebSocket upgrade is refused; nothing upstream', async () => {
    const tok = tokFor(G)
    const status = await new Promise<string>((res) => {
      const c = net.connect(proxy.port, '127.0.0.1')
      let b = ''
      c.on('connect', () => c.write(`GET /codex/chatgpt/responses HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nAuthorization: Bearer ${tok}\r\n\r\n`))
      c.on('data', (x) => { b += x.toString(); if (b.includes('\r\n')) { c.destroy(); res(b.split('\r\n')[0]!) } })
      c.on('error', (e) => res('error ' + e.message))
      c.on('close', () => res(b.split('\r\n')[0] || 'closed'))
    })
    expect(status).not.toMatch(/ 101 /)
    expect(status).toMatch(/ 4\d\d /)
    expect(seen).toEqual([])
  })
})

describe('S-12: the server refreshes ChatGPT sign-ins, one at a time', () => {
  test('20 requests meet an expiring access token: one refresh, the rotated refresh token is stored first, all use the new token', async () => {
    freshChatgpt({ access: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 60 }) }) // ends within 5 minutes
    refreshMode = 'slow'
    const tok = tokFor(G)
    const rs = await Promise.all(Array.from({ length: 20 }, () => post('chatgpt', tok)))
    for (const r of rs) expect(r.status).toBe(200)
    expect(refreshes.length).toBe(1)
    expect(refreshes[0]).toEqual({ grant_type: 'refresh_token', client_id: CODEX_CLIENT_ID, refresh_token: 'rt-REAL' })
    t.cc.cache.clear()
    const stored = secretOf(t.cc, getRow(env.db, G)! as never) as { refreshToken: string; accessToken: string }
    expect(stored.refreshToken).toBe('rt-rotated-1')
    expect(new Set(seen.map((s) => s.headers.authorization))).toEqual(new Set(['Bearer ' + stored.accessToken]))
    expect(JSON.parse(getRow(env.db, G)!.meta).planType).toBe('business') // the new id_token's plan
    expect(getRow(env.db, G)!.secret_enc).not.toContain('rt-rotated-1')
  })
  test('an upstream 401: one refresh (or the one already done), one retry with the new token', async () => {
    freshChatgpt()
    respMode = '401-old'
    validAccess = new Set() // the stored access token was revoked upstream
    const r = await post('chatgpt', tokFor(G))
    expect(r.status).toBe(200)
    expect(refreshes.length).toBe(1)
    expect(seen.length).toBe(2)
  })
  test('invalid_grant: needs reconnect, the owner is told, the turn hears it (403, never 401), the next request does not go out', async () => {
    freshChatgpt({ access: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 10 }) })
    refreshMode = 'invalid_grant'; t.notices.length = 0
    const tok = tokFor(G)
    const r = await post('chatgpt', tok)
    expect(r.status).toBe(403)
    expect(getRow(env.db, G)).toMatchObject({ status: 'needs_reconnect', status_code: 'invalid_grant' })
    expect(events.at(-1)).toEqual({ type: 'credential', credentialId: G, reason: 'needs_reconnect' })
    expect(t.notices.map((x) => x.n.code)).toContain('credential_needs_reconnect')
    expect((env.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'credential.refresh_failed' AND target = ?").get(G) as { n: number }).n).toBe(1)
    refreshes.length = 0; seen.length = 0
    expect((await post('chatgpt', tok)).status).toBe(403)
    expect(refreshes).toEqual([]); expect(seen).toEqual([])
  })
  test('a sign-in nobody used for 8 days is refreshed by the daily round', async () => {
    freshChatgpt({ lastRefresh: new Date(Date.now() - 9 * 86400_000).toISOString() })
    expect(await refreshIdle(t.cc)).toBe(1)
    expect(refreshes.length).toBe(1)
    expect(await refreshIdle(t.cc)).toBe(0)
  })
})

describe('S-13 and the upstream\'s answers', () => {
  test('a redirect of the Responses endpoint or of the refresh is not followed (502)', async () => {
    freshChatgpt()
    respMode = 'redirect'
    expect((await post('chatgpt', tokFor(G))).status).toBe(502)
    respMode = 'ok'
    freshChatgpt({ access: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 10 }) })
    refreshMode = 'redirect'
    const r = await post('chatgpt', tokFor(G))
    expect(r.status).toBe(502)
    expect(getRow(env.db, G)!.status).toBe('ok') // a temporary failure changes nothing
  })
  test('429 usage_limit_reached: limited until resets_at, this connection only; passed to the engine', async () => {
    freshChatgpt()
    respMode = '429-usage'
    const r = await post('chatgpt', tokFor(G))
    expect(r.status).toBe(429)
    const until = Date.parse(getRow(env.db, G)!.limited_until!)
    expect(until).toBeGreaterThan(Date.now() + 7000_000)
    expect(events.at(-1)).toMatchObject({ type: 'rate_limit', credentialId: G })
    seen.length = 0
    expect((await post('chatgpt', tokFor(G))).status).toBe(403) // held here now
    expect(seen).toEqual([])
    respMode = 'ok'
    expect((await post('openai', tokFor(K))).status).toBe(200)
  })
  test('429 usage_not_included: the plan has no Codex (refused); out of credit: an hour; a short 429 is retried once here', async () => {
    freshChatgpt()
    respMode = '429-plan'
    expect((await post('chatgpt', tokFor(G))).status).toBe(429)
    expect(getRow(env.db, G)).toMatchObject({ status: 'invalid', status_code: 'usage_not_included' })
    respMode = '429-credit'
    expect((await post('openai', tokFor(K))).status).toBe(429)
    expect(Date.parse(getRow(env.db, K)!.limited_until!)).toBeGreaterThan(Date.now() + 3500_000)
    env.db.query('UPDATE engine_credentials SET limited_until = NULL WHERE id = ?').run(K)
    respMode = '429-short'; seen.length = 0
    expect((await post('openai', tokFor(K))).status).toBe(200)
    expect(seen.length).toBe(2)
  })
  test('a 5xx is a 502 for the engine (it retries); the connection stays as it was', async () => {
    respMode = '500'
    expect((await post('openai', tokFor(K))).status).toBe(502)
    expect(getRow(env.db, K)!.status).toBe('ok')
  })
})

describe('usage of a ChatGPT answer (QA 2026-10-30: 54 Codex turns, 0 tokens on the connection, no "last used")', () => {
  const zero = () => {
    env.db.query("UPDATE turns SET input_tokens = 0, output_tokens = 0, cost_usd = 0, usage_source = NULL WHERE id = 'cx'").run()
    env.db.query('DELETE FROM credential_usage_daily').run()
  }
  const turn = () => env.db.query("SELECT input_tokens, output_tokens, cost_usd, usage_source FROM turns WHERE id = 'cx'").get()
  const days = (id: string) => env.db.query('SELECT requests, input_tokens, output_tokens, cost_usd FROM credential_usage_daily WHERE credential_id = ?').all(id)

  test('the fake answers like chatgpt.com: no content-type', async () => {
    respMode = 'untyped'
    const r = await fetch(`${up}/backend-api/codex/responses`, { method: 'POST', body: '{}' })
    expect(r.headers.get('content-type')).toBeNull()
    await r.body!.cancel(); releaseUntyped?.()
  })

  test('an untyped answer streams through as it comes; counted at response.completed, where Codex 0.163 hangs up', async () => {
    freshChatgpt(); zero()
    respMode = 'untyped'; releaseUntyped = null; untypedCancelled = false; logged.length = 0
    expect(getRow(env.db, G)!.last_used_at).toBeNull()
    const hangUp = new AbortController()
    const r = await fetch(`${proxy.url}/codex/chatgpt/responses`, { method: 'POST', signal: hangUp.signal, headers: { authorization: 'Bearer ' + tokFor(G), 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(body()) })
    expect(r.status).toBe(200)
    expect(r.headers.get('x-codex-primary-used-percent')).toBe('33')
    const reader = r.body!.getReader()
    const dec = new TextDecoder()
    let got = ''
    // the first delta reaches the engine while the upstream still holds the rest: passed through, not buffered
    while (!got.includes('"delta":"hi"')) got += dec.decode((await reader.read()).value, { stream: true })
    expect(turn()).toMatchObject({ input_tokens: 0, output_tokens: 0 })
    releaseUntyped!()
    while (!got.includes('"type":"response.completed"')) got += dec.decode((await reader.read()).value, { stream: true })
    // counted before the stream ends (the upstream keeps it open; Codex never reads further)
    expect(turn()).toEqual({ input_tokens: 9277, output_tokens: 31, cost_usd: 0, usage_source: 'proxy' })
    expect(days(G)).toEqual([{ requests: 1, input_tokens: 9277, output_tokens: 31, cost_usd: 0 }])
    expect(getRow(env.db, G)!.last_used_at).not.toBeNull()
    hangUp.abort() // Codex drops the connection here
    expect(await waitFor(() => untypedCancelled, { timeoutMs: 5000 })).toBe(true) // the upstream request ends with it
    expect(days(G)).toEqual([{ requests: 1, input_tokens: 9277, output_tokens: 31, cost_usd: 0 }]) // once
    expect(logged.filter((l) => l.level === 'warn')).toEqual([])
  })

  test('the engine reading to the end counts once too; the month of the connection shows it', async () => {
    freshChatgpt(); zero()
    respMode = 'untyped'; releaseUntyped = null
    const r = await post('chatgpt', tokFor(G))
    const text = r.text()
    expect(await waitFor(() => releaseUntyped !== null, { timeoutMs: 5000 })).toBe(true)
    releaseUntyped!()
    expect(await text).toContain('"type":"response.completed"')
    expect(days(G)).toEqual([{ requests: 1, input_tokens: 9277, output_tokens: 31, cost_usd: 0 }])
    expect(monthUsage(env.db, G, new Date())).toEqual({ usd: 0, tokens: 9277 + 31, requests: 1 })
  })

  test('events under another content-type are still counted (an API key answer here)', async () => {
    zero()
    respMode = 'text'
    const r = await post('openai', tokFor(K))
    expect(r.status).toBe(200)
    expect(await r.text()).toContain('response.completed')
    expect(turn()).toMatchObject({ input_tokens: 9277, output_tokens: 31, usage_source: 'proxy' })
    expect((turn() as { cost_usd: number }).cost_usd).toBeGreaterThan(0) // an API key: list price (gpt-5.4 row)
    expect(days(K)).toEqual([expect.objectContaining({ requests: 1, input_tokens: 9277, output_tokens: 31 })])
  })

  test('a monthly token limit on the ChatGPT connection now fills: warn tells the admins, block holds the next request', async () => {
    freshChatgpt(); zero()
    env.db.query("UPDATE engine_credentials SET spend_limit_tokens = 5000, spend_limit_action = 'warn' WHERE id = ?").run(G)
    t.notices.length = 0
    respMode = 'untyped'; releaseUntyped = null
    const r = await post('chatgpt', tokFor(G))
    expect(await waitFor(() => releaseUntyped !== null, { timeoutMs: 5000 })).toBe(true)
    releaseUntyped!()
    await r.text()
    expect(t.notices.map((x) => x.n.code)).toEqual(['credential_limit', 'credential_limit']) // 80 % and 100 %, once each
    expect((await post('chatgpt', tokFor(G), body(), {})).status).toBe(200) // warn only: it still works
    env.db.query("UPDATE engine_credentials SET spend_limit_action = 'block' WHERE id = ?").run(G)
    seen.length = 0
    const held = await post('chatgpt', tokFor(G))
    expect(held.status).toBe(403)
    expect((await held.json()).error.message).toBe('credential_over_limit')
    expect(events.at(-1)).toEqual({ type: 'credential', credentialId: G, reason: 'over_limit' })
    expect(seen).toEqual([])
    env.db.query('UPDATE engine_credentials SET spend_limit_tokens = NULL WHERE id = ?').run(G)
  })
})

describe('what is logged', () => {
  test("Codex 0.163's background GETs are answered 404 on purpose and not warned about; any other path still is", async () => {
    logged.length = 0
    for (const p of ['/codex/backend/api/codex/accounts/check', '/codex/backend/api/codex/settings/user', '/codex/backend/api/codex/accounts/check']) {
      expect((await fetch(proxy.url + p, { headers: { authorization: 'Bearer mpx_x', 'chatgpt-account-id': 'teamax-x' } })).status).toBe(404)
    }
    expect(logged).toEqual([
      { level: 'debug', msg: 'model proxy: answered here', status: 404, path: '/codex/backend/api/codex/accounts/check' },
      { level: 'debug', msg: 'model proxy: answered here', status: 404, path: '/codex/backend/api/codex/settings/user' },
      { level: 'debug', msg: 'model proxy: answered here', status: 404, path: '/codex/backend/api/codex/accounts/check' },
    ])
    logged.length = 0
    expect((await fetch(proxy.url + '/codex/backend/api/codex/accounts/check', { method: 'POST', body: '{}' })).status).toBe(404)
    expect((await fetch(proxy.url + '/codex/backend/api/codex/tasks/list')).status).toBe(404)
    expect(logged).toEqual([
      { level: 'warn', msg: 'model proxy: request not ok', status: 404, path: '/codex/backend/api/codex/accounts/check', reason: 'not_found_error: not found' },
      { level: 'warn', msg: 'model proxy: request not ok', status: 404, path: '/codex/backend/api/codex/tasks/list', reason: 'not_found_error: not found' },
    ])
    expect(seen).toEqual([])
  })

  /** the engine goes away while its request waits for the model's first byte (the Stop button kills it) */
  const hangUp = async (tok: string) => {
    holdAborted = false; logged.length = 0; seen.length = 0
    const ac = new AbortController()
    const p = fetch(`${proxy.url}/codex/chatgpt/responses`, { method: 'POST', signal: ac.signal, headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(body()) }).catch(() => null)
    expect(await waitFor(() => seen.length === 1, { timeoutMs: 5000 })).toBe(true)
    ac.abort()
    await p
    expect(await waitFor(() => holdAborted && logged.length > 0, { timeoutMs: 5000 })).toBe(true) // the upstream call is cancelled too
  }
  test('Stop: the request the engine gave up is one info line "ended by a stop" (by the person), never "could not be reached"', async () => {
    freshChatgpt()
    respMode = 'hold'
    stopped.set('cx', 'stopped')
    try {
      await hangUp(tokFor(G))
      expect(logged).toEqual([{ level: 'info', msg: 'model proxy: request ended by a stop', path: '/codex/chatgpt/responses', turn: 'cx', by: 'person' }])
      // the connection is as it was, nothing counted, nothing refused
      expect(getRow(env.db, G)).toMatchObject({ status: 'ok', status_code: null, limited_until: null })
      expect(env.db.query("SELECT COUNT(*) AS n FROM credential_usage_daily WHERE credential_id = ?").get(G)).toEqual({ n: 0 })
      stopped.set('cx', 'timeout')
      await hangUp(tokFor(G))
      expect(logged.filter((l) => (l.msg as string).includes('ended by a stop')).map((l) => l.by)).toEqual(['time_limit'])
    } finally { stopped.delete('cx'); respMode = 'ok' }
  })
  test('the engine hanging up while its turn runs is still a warning, of its own', async () => {
    freshChatgpt()
    respMode = 'hold'
    try {
      await hangUp(tokFor(G))
      expect(logged.filter((l) => l.level === 'warn')).toContainEqual({ level: 'warn', msg: 'model proxy: the engine hung up before its answer', path: '/codex/chatgpt/responses', turn: 'cx' })
      expect(JSON.stringify(logged)).not.toContain('could not be reached')
    } finally { respMode = 'ok' }
  })
  test('after a stop, a request with the revoked token is refused (401) and logged as the stop', async () => {
    stopped.set('cx', 'stopped')
    try {
      const tok = tokFor(G)
      env.db.query("UPDATE proxy_tokens SET revoked_at = ? WHERE turn_id = 'cx'").run(new Date().toISOString())
      logged.length = 0
      expect((await post('chatgpt', tok)).status).toBe(401)
      expect(logged).toEqual([{ level: 'info', msg: 'model proxy: request ended by a stop', path: '/codex/chatgpt/responses', turn: 'cx', by: 'person' }])
      stopped.delete('cx')
      logged.length = 0
      expect((await post('chatgpt', tok)).status).toBe(401) // a revoked token of a turn nobody stopped: a warning as before
      expect(logged).toEqual([{ level: 'warn', msg: 'model proxy: request not ok', status: 401, path: '/codex/chatgpt/responses', reason: 'authentication_error: invalid proxy token' }])
    } finally { stopped.delete('cx') }
  })
  test('a stop-reason lookup that fails (the database closing at shutdown) loses only the attribution: the usual answer and line', async () => {
    // the lookup runs outside the request handler's try: a throw there answered 500 and logged nothing
    freshChatgpt()
    stopLookupFails = true
    try {
      respMode = 'hold'
      await hangUp(tokFor(G))
      expect(logged).toEqual([{ level: 'warn', msg: 'model proxy: the engine hung up before its answer', path: '/codex/chatgpt/responses', turn: 'cx' }])
      respMode = 'ok'
      const tok = tokFor(G)
      env.db.query("UPDATE proxy_tokens SET revoked_at = ? WHERE turn_id = 'cx'").run(new Date().toISOString())
      logged.length = 0
      expect((await post('chatgpt', tok)).status).toBe(401)
      expect(logged).toEqual([{ level: 'warn', msg: 'model proxy: request not ok', status: 401, path: '/codex/chatgpt/responses', reason: 'authentication_error: invalid proxy token' }])
    } finally { stopLookupFails = false; respMode = 'ok' }
  })
  test('the turn registry keeps why a turn was stopped after it ended: a time limit or shutdown reaches the log just after', () => {
    // the engine's connection closes while the runtime records the end; the turn row says 'error' / 'interrupted' then
    const db = openDb(':memory:')
    try {
      db.query("INSERT INTO users(id,username,name,role) VALUES('u','u','U','member')").run()
      const reg = new TurnRegistry(db, 0)
      const [a, b, c, d] = [0, 1, 2, 3].map(() => reg.create('u', 'c', 'codex').turn.id) as [string, string, string, string]
      reg.invalidate(a, 'timeout'); reg.invalidate(b, 'shutdown'); reg.invalidate(c, 'stopped')
      expect([a, b, c, d].map((id) => reg.stopReason(id))).toEqual(['timeout', 'shutdown', 'stopped', null])
      reg.revoke(a, 'error'); reg.revoke(b, 'interrupted'); reg.revoke(c, 'stopped'); reg.revoke(d, 'done')
      expect(reg.get(a)).toBeUndefined()
      expect([a, b, c, d].map((id) => reg.stopReason(id))).toEqual(['timeout', 'shutdown', 'stopped', null])
      // the newest 256 only
      for (let i = 0; i < 256; i++) { const id = reg.create('u', 'c', 'codex').turn.id; reg.invalidate(id, 'stopped'); reg.revoke(id, 'stopped') }
      expect(reg.stopReason(a)).toBeNull()
    } finally { db.close() }
  })
})
