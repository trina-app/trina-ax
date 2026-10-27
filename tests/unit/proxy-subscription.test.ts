// A Claude subscription connection behind the model proxy (docs/DECISIONS.md "AI 연결"): the connection's token
// replaces the engine's per-turn token on the way out and never comes back; headers are filtered; SSE streams through
// unbuffered; the engine hanging up cancels the upstream request; upstream 401 / 429 / unreachable change only that
// connection; the token file's states for diagnostics; the port taken by someone else (fail closed, retry);
// refused and failed requests in the server log, without secrets.
import { setSetting } from '../../server/src/admin/settings'
import { SHARED_SUBSCRIPTIONS_KEY } from '../../server/src/credentials/policy'
import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeEnv } from '../lib/env'
import { waitFor } from '../lib/wait'
import { issueProxyToken, retryAfterSeconds, startModelProxy, type ProxyTurnEvent } from '../../server/src/proxy/model-proxy'
import { markTokenRejected, ModelProxyService, SETUP_TOKEN_LIFETIME_MS, subscriptionTokenStatus, TokenReader, tokenFile } from '../../server/src/proxy/subscription'
import { createBroker } from '../../server/src/credentials/broker'
import { getRow } from '../../server/src/credentials/store'
import { addCred, testCredCtx } from '../lib/credentials'

const env = makeEnv('unit-proxy-sub')
setSetting(env.db, SHARED_SUBSCRIPTIONS_KEY, true) // explicitly opt in for these shared-subscription proxy checks
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
const logged: Record<string, unknown>[] = []
const log = { warn: (msg: string, f: Record<string, unknown> = {}) => { logged.push({ msg, ...f }) } }
const t = testCredCtx(env.db, path.join(env.fx.data, 'secrets'), { upstreams: { anthropic: `http://127.0.0.1:${upstream.port}` } })
const CRED = addCred(t.cc, 'anthropic-oauth', REAL, { label: 'Team Max' })
const proxy = await startModelProxy({ db: env.db, broker: createBroker(t.cc), log, onTurnEvent: (tid, ev) => { if (tid === turnId) events.push(ev) } })
afterAll(() => { proxy.stop(); upstream.stop(true) })
const body = (o: Record<string, unknown> = {}) => JSON.stringify({ model: 'claude-sonnet-x', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }], ...o })
const call = (tok: string, extra: Record<string, string> = {}, b = body(), init: RequestInit = {}) =>
  fetch(proxy.url + '/v1/messages?beta=true', { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', authorization: 'Bearer ' + tok, ...extra }, body: b, ...init })
const reset = () => env.db.query("UPDATE engine_credentials SET status = 'ok', status_code = NULL, limited_until = NULL, disabled = 0 WHERE id = ?").run(CRED)

describe('subscription connection behind the proxy', () => {
  const tok = issueProxyToken(env.db, turnId, 'alice', { credentialId: CRED, family: 'anthropic' })

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
    const tr = env.db.query('SELECT input_tokens, output_tokens, cost_usd, usage_source, credential_id FROM turns WHERE id = ?').get(turnId) as any
    expect(tr).toEqual({ input_tokens: 100, output_tokens: 10, cost_usd: 0, usage_source: 'proxy', credential_id: CRED }) // subscription: no price
    // the connection's own day of use and last use
    const d = env.db.query('SELECT requests, input_tokens, output_tokens, cost_usd FROM credential_usage_daily WHERE credential_id = ?').get(CRED) as any
    expect(d).toEqual({ requests: 1, input_tokens: 100, output_tokens: 10, cost_usd: 0 })
    expect(getRow(env.db, CRED)!.last_used_at).not.toBeNull()
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
      const x = env.db.query('SELECT input_tokens, output_tokens FROM turns WHERE id = ?').get(turnId) as any
      return x.input_tokens - before.input_tokens === 100 && x.output_tokens - before.output_tokens === 9
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

  test('upstream 401: passed back, the turn gets a credential event, this connection is marked refused, admins are told', async () => {
    mode = '401'; events.length = 0; t.notices.length = 0
    const r = await call(tok)
    expect(r.status).toBe(401)
    expect(events).toEqual([{ type: 'credential', credentialId: CRED, reason: 'invalid' }])
    expect(getRow(env.db, CRED)!.status).toBe('invalid')
    expect(t.notices.map((x) => x.n.code)).toEqual(['credential_rejected'])
    expect(JSON.stringify(t.notices)).not.toContain(REAL)
    // the next request does not go out on a refused connection
    const n = seen.length
    mode = 'ok'; events.length = 0
    expect((await call(tok)).status).toBe(403)
    expect(seen.length).toBe(n)
    expect(events).toEqual([{ type: 'credential', credentialId: CRED, reason: 'invalid' }])
    reset()
  })

  test('a connection switched off or removed during the turn: the next request does not go out', async () => {
    mode = 'ok'; events.length = 0
    const n = seen.length
    env.db.query('UPDATE engine_credentials SET disabled = 1 WHERE id = ?').run(CRED)
    expect((await call(tok)).status).toBe(403)
    expect(events.at(-1)).toEqual({ type: 'credential', credentialId: CRED, reason: 'gone' })
    expect(seen.length).toBe(n)
    reset()
  })

  test('refused and failed requests are logged with status and reason only, never a token', async () => {
    reset(); logged.length = 0
    mode = 'ok'
    expect((await call(tok, {}, body({ mcp_servers: [{ url: 'https://example.com' }] }))).status).toBe(403)
    mode = '401'
    expect((await call(tok)).status).toBe(401)
    mode = 'ok'; reset()
    expect(logged).toEqual([
      { msg: 'model proxy: request not ok', status: 403, path: '/v1/messages', reason: 'permission_error: refused by the team server: mcp_servers is not allowed' },
      { msg: 'model proxy: request not ok', status: 401, path: '/v1/messages', reason: 'authentication_error: invalid bearer token' },
    ])
    // the model service out of reach (a connection whose upstream is down), and the request handler itself throwing: both 502
    const down = testCredCtx(env.db, path.join(env.fx.data, 'secrets'), { upstreams: { anthropic: 'http://127.0.0.1:9' } })
    const dead = await startModelProxy({ db: env.db, broker: createBroker(down.cc), log })
    const throws = await startModelProxy({ db: env.db, broker: createBroker(t.cc), log, peerCheck: async () => { throw new Error('peer lookup broke') } })
    for (const p of [dead, throws]) {
      const r = await fetch(p.url + '/v1/messages', { method: 'POST', headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, body: body() })
      expect(r.status).toBe(502)
      p.stop()
    }
    expect(logged.slice(2)).toEqual([
      { msg: 'model proxy: request not ok', status: 502, path: '/v1/messages', reason: 'api_error: the model service could not be reached' },
      { msg: 'model proxy: request failed', err: 'peer lookup broke' },
    ])
    const all = JSON.stringify(logged)
    expect(all).not.toContain(REAL); expect(all).not.toContain(tok); expect(all).not.toContain('example.com')
    reset()
  })

  test('429: a short retry-after passes through; the long limit becomes 403 subscription_limited on this connection and holds', async () => {
    mode = '429short'; events.length = 0
    let r = await call(tok)
    expect(r.status).toBe(429); expect(r.headers.get('retry-after')).toBe('7')
    expect(events).toEqual([])
    mode = '429long'
    r = await call(tok)
    expect(r.status).toBe(403)
    expect((await r.json()).error.message).toBe('subscription_limited')
    expect(events[0]).toMatchObject({ type: 'rate_limit', credentialId: CRED })
    // kept in the database: a proxy restart does not forget it
    expect(Date.parse(getRow(env.db, CRED)!.limited_until!)).toBeGreaterThan(Date.now() + 3000_000)
    const n = seen.length
    mode = 'ok'
    r = await call(tok) // still limited: refused here, not sent
    expect(r.status).toBe(403); expect(seen.length).toBe(n)
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(3000)
    reset()
  })

  test('upstream unreachable: 502, the connection stays as it was', async () => {
    const t2 = testCredCtx(env.db, path.join(env.fx.data, 'secrets'), { upstreams: { anthropic: 'http://127.0.0.1:9' } })
    const dead = await startModelProxy({ db: env.db, broker: createBroker(t2.cc) })
    const tk = issueProxyToken(env.db, turnId, 'alice', { credentialId: CRED, family: 'anthropic' })
    const r = await fetch(dead.url + '/v1/messages', { method: 'POST', headers: { authorization: 'Bearer ' + tk, 'content-type': 'application/json' }, body: body() })
    expect(r.status).toBe(502)
    expect(getRow(env.db, CRED)!.status).toBe('ok')
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
    const warned: Record<string, unknown>[] = []
    const svc = new ModelProxyService({ db: env.db, port, broker: null, secretsDir: env.fx.data, retryMs: 100, log: { info() {}, warn: (msg, f) => { warned.push({ msg, ...f }) } } }).start()
    await svc.started
    expect(svc.state).toBe('port_in_use'); expect(svc.ready).toBe(false)
    squatter.stop(true)
    expect(await waitFor(() => svc.ready, { timeoutMs: 3000 })).toBe(true)
    const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST' })
    expect(r.status).toBe(401) // our proxy now
    expect(warned.at(-1)).toEqual({ msg: 'model proxy: request not ok', status: 401, path: '/v1/messages', reason: 'authentication_error: missing proxy token' })
    svc.stop()
  })
})
