// Subscription mode of the model proxy (design tab 1 "프록시 동작"): the owner's setup-token replaces the engine's
// per-turn token on the way out and never comes back; headers are filtered; SSE streams through unbuffered; the engine
// hanging up cancels the upstream request; upstream 401 / 429 / unreachable; the token file's states for diagnostics;
// the port taken by someone else (fail closed, retry).
import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeEnv } from '../lib/env'
import { waitFor } from '../lib/wait'
import { issueProxyToken, retryAfterSeconds, startModelProxy, type ProxyTurnEvent } from '../../server/src/proxy/model-proxy'
import { markTokenRejected, ModelProxyService, SETUP_TOKEN_LIFETIME_MS, subscriptionTokenStatus, TokenReader, tokenFile } from '../../server/src/proxy/subscription'

const env = makeEnv('unit-proxy-sub')
const REAL = 'sk-ant-oat01-' + 'R'.repeat(40)
const seen: { headers: Record<string, string>; body: string; path: string }[] = []
let gate: (() => void) | null = null
let upstreamAborted = false
let mode: 'ok' | '401' | '429short' | '429long' | 'slow' = 'ok'
const enc = new TextEncoder()
const sse = (ev: unknown) => enc.encode(`event: x\ndata: ${JSON.stringify(ev)}\n\n`)
const upstream = Bun.serve({
  port: 0, hostname: '127.0.0.1', idleTimeout: 0,
  async fetch(req) {
    const u = new URL(req.url)
    seen.push({ headers: Object.fromEntries(req.headers), body: await req.text(), path: u.pathname + u.search })
    if (mode === '401') return Response.json({ type: 'error', error: { type: 'authentication_error', message: 'invalid bearer token' } }, { status: 401 })
    if (mode === '429short') return Response.json({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, { status: 429, headers: { 'retry-after': '7' } })
    if (mode === '429long') return Response.json({ type: 'error', error: { type: 'rate_limit_error', message: 'limit' } }, { status: 429, headers: { 'retry-after': '3600' } })
    if (mode === 'slow') {
      // message_start right away, the rest only when the test opens the gate (or never: the client hangs up)
      return new Response(new ReadableStream<Uint8Array>({
        async start(ctl) {
          ctl.enqueue(sse({ type: 'message_start', message: { model: 'claude-sonnet-x', usage: { input_tokens: 70, cache_read_input_tokens: 30, output_tokens: 1 } } }))
          await new Promise<void>((r) => (gate = r))
          try {
            ctl.enqueue(sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'rest' } }))
            ctl.enqueue(sse({ type: 'message_delta', usage: { output_tokens: 9 } }))
            ctl.close()
          } catch {}
        },
        cancel() { upstreamAborted = true },
      }), { headers: { 'content-type': 'text/event-stream', 'set-cookie': 'x=1', 'request-id': 'req_1' } })
    }
    return Response.json({ id: 'm', model: 'claude-opus-x', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 100, output_tokens: 10 } })
  },
})
const turnId = 'ts1'
env.db.query("INSERT INTO turns (id, chat_id, user_id, engine) VALUES (?, 'c', 'alice', 'claude-code')").run(turnId)
const events: ProxyTurnEvent[] = []
const rejected: (string | null)[] = []
let secret: string | null = REAL
const proxy = await startModelProxy({
  db: env.db, upstream: { baseUrl: `http://127.0.0.1:${upstream.port}`, kind: 'oauth', secret: () => secret },
  onTurnEvent: (t, ev) => { if (t === turnId) events.push(ev) }, onAuthRejected: (s) => rejected.push(s),
})
afterAll(() => { proxy.stop(); upstream.stop(true) })
const body = (o: Record<string, unknown> = {}) => JSON.stringify({ model: 'claude-sonnet-x', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }], ...o })
const call = (tok: string, extra: Record<string, string> = {}, b = body(), init: RequestInit = {}) =>
  fetch(proxy.url + '/v1/messages?beta=true', { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', authorization: 'Bearer ' + tok, ...extra }, body: b, ...init })

describe('subscription proxy', () => {
  const tok = issueProxyToken(env.db, turnId, 'alice')

  test('the real token goes out as the Bearer, the turn token never; only allowed headers and beta flags pass', async () => {
    mode = 'ok'
    const r = await call(tok, { 'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14,evil value', 'x-api-key': tok, 'x-stainless-os': 'MacOS', cookie: 'a=b', 'user-agent': 'claude-cli/2.1.305 (external, cli)', 'x-app': 'cli', 'x-forwarded-for': '10.0.0.1' })
    expect(r.status).toBe(200)
    const h = seen.at(-1)!.headers
    expect(h.authorization).toBe('Bearer ' + REAL)
    expect(h['x-api-key']).toBeUndefined(); expect(h.cookie).toBeUndefined(); expect(h['x-stainless-os']).toBeUndefined(); expect(h['x-forwarded-for']).toBeUndefined()
    expect(h['anthropic-beta']!.split(',')).toEqual(['fine-grained-tool-streaming-2025-05-14', 'oauth-2025-04-20'])
    expect(h['user-agent']).toBe('claude-cli/2.1.305 (external, cli)'); expect(h['x-app']).toBe('cli')
    expect(JSON.stringify(seen.at(-1))).not.toContain(tok)
    expect(seen.at(-1)!.path).toBe('/v1/messages?beta=true')
    // what comes back never carries the real token
    expect(JSON.stringify([...r.headers]) + await r.text()).not.toContain(REAL)
    const t = env.db.query('SELECT input_tokens, output_tokens, cost_usd, usage_source FROM turns WHERE id = ?').get(turnId) as any
    expect(t).toEqual({ input_tokens: 100, output_tokens: 10, cost_usd: 0, usage_source: 'proxy' }) // subscription: no price
  })

  test('SSE streams through as it arrives (not buffered) and usage is counted', async () => {
    mode = 'slow'
    const before = env.db.query('SELECT input_tokens, output_tokens FROM turns WHERE id = ?').get(turnId) as any
    const r = await call(tok, {}, body({ stream: true }))
    expect(r.status).toBe(200)
    expect(r.headers.get('set-cookie')).toBeNull(); expect(r.headers.get('request-id')).toBe('req_1')
    const reader = r.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toContain('message_start') // arrived while the upstream still holds the rest
    gate!()
    let rest = ''
    for (;;) { const { value, done } = await reader.read(); if (done) break; rest += new TextDecoder().decode(value) }
    expect(rest).toContain('text_delta')
    expect(await waitFor(() => {
      const t = env.db.query('SELECT input_tokens, output_tokens FROM turns WHERE id = ?').get(turnId) as any
      return t.input_tokens - before.input_tokens === 100 && t.output_tokens - before.output_tokens === 9
    }, { timeoutMs: 3000 })).toBe(true)
  })

  test('the engine hanging up cancels the upstream request; what was seen still counts', async () => {
    mode = 'slow'; upstreamAborted = false
    const before = (env.db.query('SELECT input_tokens FROM turns WHERE id = ?').get(turnId) as any).input_tokens
    const ac = new AbortController()
    const r = await call(tok, {}, body({ stream: true }), { signal: ac.signal })
    const reader = r.body!.getReader()
    await reader.read()
    ac.abort()
    expect(await waitFor(() => upstreamAborted, { timeoutMs: 3000 })).toBe(true)
    expect(await waitFor(() => (env.db.query('SELECT input_tokens FROM turns WHERE id = ?').get(turnId) as any).input_tokens - before === 100, { timeoutMs: 3000 })).toBe(true)
    gate?.()
  })

  test('upstream 401: passed back, the turn gets an auth event, the token is reported as refused', async () => {
    mode = '401'; events.length = 0
    const r = await call(tok)
    expect(r.status).toBe(401)
    expect(events).toEqual([{ type: 'auth' }])
    expect(rejected.at(-1)).toBe(REAL)
  })

  test('no token on the server: 401 and an auth event, nothing goes upstream', async () => {
    mode = 'ok'; events.length = 0; secret = null
    const n = seen.length
    expect((await call(tok)).status).toBe(401)
    expect(events).toEqual([{ type: 'auth' }])
    expect(seen.length).toBe(n)
    secret = REAL
  })

  test('429: a short retry-after passes through; the subscription limit becomes 403 subscription_limited and holds', async () => {
    mode = '429short'; events.length = 0
    let r = await call(tok)
    expect(r.status).toBe(429); expect(r.headers.get('retry-after')).toBe('7')
    expect(events).toEqual([])
    mode = '429long'
    r = await call(tok)
    expect(r.status).toBe(403)
    expect((await r.json()).error.message).toBe('subscription_limited')
    expect(events[0]!.type).toBe('rate_limit')
    const n = seen.length
    mode = 'ok'
    r = await call(tok) // still limited: refused here, not sent
    expect(r.status).toBe(403); expect(seen.length).toBe(n)
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(3000)
  })

  test('upstream unreachable: 502', async () => {
    const dead = await startModelProxy({ db: env.db, upstream: { baseUrl: 'http://127.0.0.1:9', kind: 'oauth', secret: REAL } })
    const t2 = issueProxyToken(env.db, turnId, 'alice')
    const r = await fetch(dead.url + '/v1/messages', { method: 'POST', headers: { authorization: 'Bearer ' + t2, 'content-type': 'application/json' }, body: body() })
    expect(r.status).toBe(502)
    dead.stop()
  })

  test('retry-after in seconds or as a date', () => {
    expect(retryAfterSeconds('12')).toBe(12)
    expect(retryAfterSeconds(new Date(Date.now() + 120_000).toUTCString())).toBeGreaterThan(100)
    expect(retryAfterSeconds(null)).toBeNull(); expect(retryAfterSeconds('soon')).toBeNull()
  })
})

describe('setup-token file', () => {
  const dir = path.join(env.fx.data, 'secrets-test')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const f = tokenFile(dir)

  test('missing, malformed, ok, expiring, expired, refused by the upstream; a new token clears "refused"', () => {
    expect(subscriptionTokenStatus(dir, env.db).state).toBe('missing')
    fs.writeFileSync(f, 'hello\n', { mode: 0o600 })
    expect(subscriptionTokenStatus(dir, env.db).state).toBe('malformed')
    fs.writeFileSync(f, REAL + '\n', { mode: 0o600 })
    const st = subscriptionTokenStatus(dir, env.db)
    expect(st.state).toBe('ok')
    expect(Date.parse(st.expiresAt!) - Date.now()).toBeGreaterThan(SETUP_TOKEN_LIFETIME_MS - 60_000)
    const mtime = fs.statSync(f).mtimeMs
    expect(subscriptionTokenStatus(dir, env.db, mtime + SETUP_TOKEN_LIFETIME_MS - 3 * 24 * 3600_000).state).toBe('expiring')
    expect(subscriptionTokenStatus(dir, env.db, mtime + SETUP_TOKEN_LIFETIME_MS + 1).state).toBe('expired')
    markTokenRejected(env.db, REAL)
    expect(subscriptionTokenStatus(dir, env.db).state).toBe('invalid')
    fs.writeFileSync(f, REAL.replace(/R+$/, 'N'.repeat(40)) + '\n', { mode: 0o600 })
    expect(subscriptionTokenStatus(dir, env.db).state).toBe('ok')
  })

  test('the reader follows a replaced file and never a planted link', () => {
    const r = new TokenReader(f)
    fs.writeFileSync(f, 'first\n'); expect(r.read()).toBe('first')
    fs.writeFileSync(f, 'second-longer\n'); expect(r.read()).toBe('second-longer')
    fs.rmSync(f); fs.writeFileSync(path.join(dir, 'other'), 'x'); fs.symlinkSync(path.join(dir, 'other'), f)
    expect(r.read()).toBeNull()
    expect(subscriptionTokenStatus(dir, null).state).toBe('missing')
    fs.rmSync(f)
  })
})

describe('proxy port', () => {
  test('taken by another program: no turns (not ready), retried until it is free', async () => {
    const squatter = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('squat') })
    const port = squatter.port!
    const svc = new ModelProxyService({ db: env.db, port, upstreamUrl: 'http://127.0.0.1:9', secretsDir: env.fx.data, retryMs: 100 }).start()
    await svc.started
    expect(svc.state).toBe('port_in_use'); expect(svc.ready).toBe(false)
    squatter.stop(true)
    expect(await waitFor(() => svc.ready, { timeoutMs: 3000 })).toBe(true)
    const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST' })
    expect(r.status).toBe(401) // our proxy now
    svc.stop()
  })
})
