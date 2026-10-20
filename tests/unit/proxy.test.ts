import { afterAll, describe, expect, test } from 'bun:test'
import { makeEnv } from '../lib/env'
import { waitFor } from '../lib/wait'
import { issueProxyToken, revokeProxyTokens, startModelProxy } from '../../server/src/proxy/model-proxy'

const env = makeEnv('unit-proxy')
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
const key = startModelProxy({ db: env.db, upstream: { baseUrl: `http://127.0.0.1:${upstream.port}`, kind: 'api-key', secret: 'sk-real-company-key' } })
const oauth = startModelProxy({ db: env.db, upstream: { baseUrl: `http://127.0.0.1:${upstream.port}`, kind: 'oauth', secret: 'sk-ant-oat-real-subscription' } })
afterAll(() => { key.stop(); oauth.stop(); upstream.stop(true) })
const call = (base: string, h: Record<string, string>, body: unknown = { model: 'claude-opus-x', max_tokens: 5, messages: [] }) =>
  fetch(base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...h }, body: JSON.stringify(body) })

describe('model proxy', () => {
  const tok = issueProxyToken(env.db, turnId, 'alice')
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
    expect(t.input_tokens).toBe(100); expect(t.output_tokens).toBe(10); expect(t.cost_usd).toBeCloseTo((100 * 15 + 10 * 75) / 1e6, 8)
  })
  test('oauth upstream: Bearer from CLAUDE_CODE_OAUTH_TOKEN is swapped, beta header kept + oauth beta added', async () => {
    const r = await call(oauth.url, { authorization: 'Bearer ' + tok, 'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14' })
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
  test('budget block and per-turn cap return 429', async () => {
    env.db.query("INSERT INTO budgets (id, subject_type, subject_id, period, limit_usd, action) VALUES ('b1','user','alice','day', 0.000001, 'block')").run()
    expect((await call(key.url, { 'x-api-key': tok })).status).toBe(429)
    env.db.query("DELETE FROM budgets").run()
    const capped = issueProxyToken(env.db, turnId, 'alice', { budgetUsd: 0.000001 })
    expect((await call(key.url, { 'x-api-key': capped })).status).toBe(429)
  })
  test('revoked token (turn ended) is refused', async () => {
    revokeProxyTokens(env.db, turnId)
    expect((await call(key.url, { 'x-api-key': tok })).status).toBe(401)
  })
  test('peer check can refuse callers outside the turn', async () => {
    const p = startModelProxy({ db: env.db, upstream: { baseUrl: `http://127.0.0.1:${upstream.port}`, kind: 'api-key', secret: 'k' }, peerCheck: async () => false })
    env.db.query("INSERT INTO turns (id, chat_id, user_id, engine) VALUES ('tp2', 'c', 'alice', 'x')").run()
    expect((await call(p.url, { 'x-api-key': issueProxyToken(env.db, 'tp2', 'alice') })).status).toBe(403)
    p.stop()
  })
})
