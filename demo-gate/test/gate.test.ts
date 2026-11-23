// The gate as it runs: a real Node gate process, fake instances (./fake-instance.ts), a fake model API and a fake
// Turnstile. Pages, start, cookie routing, WebSocket piping, deny paths, the instance's config and env, the pool
// (busy, expiry, orphans, code version), IP limits, and the model upstream (path secrets, credential modes, header
// allowlist, error rewrite, prompt-too-long, weighted counting, daily cap, PAUSE, stream limit).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  DUMMY_CREDENTIAL, FAKE_CREDENTIAL, NODE, SSE, fakeTurnstile, fakeUpstream, get, startGate, startVisit, until, visitor, warm, wsEcho,
  type Gate, writeSnapshot } from './harness.ts'

// each test starts real gate and instance processes (clone, config, health and fence checks): 5 s is too short on a
// loaded machine
setDefaultTimeout(30_000)

const BUSY = 'The demo is busy, try again in a bit.'
const skip = !NODE
if (skip) console.warn('demo-gate tests skipped: needs Node 24+ on PATH')

const upstream = fakeUpstream()
const turnstile = fakeTurnstile()
afterAll(() => { upstream.stop(); turnstile.stop() })

/** the instance's model upstream address from its server.json (what its model proxy would call) */
function instanceUpstream(g: Gate, id: string): string {
  const c = JSON.parse(fs.readFileSync(path.join(g.instancesDir, id, 'config', 'server.json'), 'utf8'))
  return c.engine.modelUpstreams.anthropic
}
async function liveInstance(g: Gate) {
  const h = await g.health()
  return h.instances.find((i: { state: string }) => i.state === 'live') as { id: string; tokens: number }
}
const msg = (base: string, init: { body?: unknown; headers?: Record<string, string>; path?: string } = {}) =>
  fetch(base + (init.path ?? '/v1/messages'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${DUMMY_CREDENTIAL}`, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'prompt-caching-2024-07-31', ...init.headers },
    body: JSON.stringify(init.body ?? { model: 'claude-test', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10, stream: true }),
  })

describe.skipIf(skip)('gate: pages, start, routing', () => {
  let g: Gate
  beforeAll(async () => { g = await startGate({ upstream: upstream.url, turnstile: turnstile.url }); await warm(g, 1, 'en'); await warm(g, 1, 'ko') })
  afterAll(() => g?.stop())

  test('landing page in en and ko; ?lang= wins', async () => {
    const en = await get(g, visitor(), '/')
    expect(en.status).toBe(200)
    const html = await en.text()
    expect(html).toContain('<html lang="en">')
    expect(html).toContain('cf-turnstile')
    expect(en.headers.get('content-security-policy')).toContain('challenges.cloudflare.com')
    // no-referrer would make browsers send `Origin: null` on the Start form, which start() refuses
    expect(en.headers.get('referrer-policy')).toBe('same-origin')
    const ko = await get(g, visitor(), '/?lang=ko', { headers: { 'accept-language': 'en-US' } })
    expect(await ko.text()).toContain('<html lang="ko">')
    const byBrowser = await get(g, visitor(), '/', { headers: { 'accept-language': 'ko-KR,ko;q=0.9' } })
    expect(await byBrowser.text()).toContain('<html lang="ko">')
    // a language the live config does not run (pool.locales en, ko here) shows the English page
    const ja = await get(g, visitor(), '/?lang=ja', { headers: { 'accept-language': 'ja-JP' } })
    expect(await ja.text()).toContain('<html lang="en">')
  })

  test('start needs a passed Turnstile from this host and our own origin', async () => {
    const v = visitor()
    expect((await startVisit(g, v, { token: 'nope' })).status).toBe(400)
    expect((await startVisit(g, v, { token: 'elsewhere' })).status).toBe(400)
    const evil = await startVisit(g, v, { origin: 'https://evil.example' })
    expect(evil.status).toBe(403)
    expect(v.cookies.size).toBe(0)
    // a refused start clears nothing in the browser
    expect(evil.headers.get('clear-site-data')).toBeNull()
    expect((await startVisit(g, v, { token: 'nope' })).headers.get('clear-site-data')).toBeNull()
  })

  test('the language the visitor used in the app (mycel_locale) picks the ended and landing pages over the browser', async () => {
    const ended = visitor()
    ended.cookies.set('__Host-tdg', 'gone')
    ended.cookies.set('mycel_locale', 'ko')
    const r = await get(g, ended, '/', { headers: { 'accept-language': 'en-US' } })
    const html = await r.text()
    expect(html).toContain('<html lang="ko">')
    expect(html).toContain('데모 시간이 끝났어요')
    const fresh = visitor()
    fresh.cookies.set('mycel_locale', 'ko')
    expect(await (await get(g, fresh, '/', { headers: { 'accept-language': 'en-US' } })).text()).toContain('<html lang="ko">')
    // ?lang= still wins; a language the gate does not run, or junk, is ignored
    expect(await (await get(g, fresh, '/?lang=en', { headers: { 'accept-language': 'ko-KR' } })).text()).toContain('<html lang="en">')
    for (const bad of ['ja', '%22%3E%3Cscript%3E']) {
      const o = visitor()
      o.cookies.set('mycel_locale', bad)
      const t = await (await get(g, o, '/', { headers: { 'accept-language': 'en-US' } })).text()
      expect(t).toContain('<html lang="en">')
      expect(t).not.toContain('<script>')
    }
  })

  test('start: 303 to /, a Secure visitor cookie and the instance session cookie with Secure forced', async () => {
    const v = visitor()
    await warm(g, 1, 'ko')
    const r = await startVisit(g, v, { lang: 'ko' })
    expect(r.status).toBe(303)
    // a new start lands on /?fresh=1 (the web app clears the tab's storage: Safari ignores Clear-Site-Data here)
    expect(r.headers.get('location')).toBe('/?fresh=1')
    const set = r.headers.getSetCookie()
    const gate = set.find((c) => c.startsWith('__Host-tdg='))!
    expect(gate).toMatch(/HttpOnly/)
    expect(gate).toMatch(/Secure/)
    expect(gate).toMatch(/SameSite=Lax/)
    expect(gate).toMatch(/Path=\//)
    const sid = set.find((c) => c.startsWith('__Host-sid='))!
    expect(sid).toMatch(/; Secure$/)
    // a __Host- cookie the browser keeps (review finding 2 on #105): Secure once, Path=/, no Domain
    expect(sid.split('; ').filter((x) => x === 'Secure')).toHaveLength(1)
    expect(sid).toContain('; Path=/;')
    expect(sid).not.toMatch(/domain=/i)
    // the language goes with the visitor (the gate's later pages read it); readable by the web app, which writes it too
    expect(set).toContain('mycel_locale=ko; Path=/; Max-Age=31536000; SameSite=Lax; Secure')
    // the last visitor's drafts in this browser go: storage only (cookies stay, so the new session survives), exactly
    expect(r.headers.get('clear-site-data')).toBe('"storage"')
    // starting again while the copy is live goes back to it and clears nothing
    const again = await startVisit(g, v, { lang: 'ko' })
    expect(again.status).toBe(303)
    expect(again.headers.get('location')).toBe('/')
    expect(again.headers.get('clear-site-data')).toBeNull()
    // routed by the cookie to a ko instance; the instance never sees the gate cookie or the edge headers
    const e = await (await get(g, v, '/echo')).json() as { headers: Record<string, string>; dir: string; config: any; env: Record<string, string> }
    // the instance gets its session and the language cookie (the web app writes that one on the instance too)
    expect(e.headers.cookie.split('; ').map((c) => c.split('=')[0]).sort()).toEqual(['__Host-sid', 'mycel_locale'])
    expect(e.headers.cookie).not.toContain('__Host-tdg')
    expect(e.headers['cf-connecting-ip']).toBeUndefined()
    expect(e.headers.host).toBe(`127.0.0.1:${e.config.listen.port}`)
    expect(fs.readFileSync(path.join(e.dir, 'data', 'seed.txt'), 'utf8')).toBe('seed ko')
  })

  test('resume ("Continue as Mina"): a signed-out visitor gets a new session on their own instance, nobody else does', async () => {
    const v = visitor()
    await warm(g)
    expect((await startVisit(g, v)).status).toBe(303)
    const first = v.cookies.get('__Host-sid')!
    const dir = ((await (await get(g, v, '/echo')).json()) as { dir: string }).dir
    // signed out on the instance: the session cookie is gone, the gate cookie stays
    v.cookies.delete('__Host-sid')
    const r = await get(g, v, '/__demo/resume', { method: 'POST', headers: { origin: 'https://demo.trina.app' } })
    expect(r.status).toBe(303)
    expect(r.headers.get('location')).toBe('/')
    // the same visitor's own copy: their drafts stay
    expect(r.headers.get('clear-site-data')).toBeNull()
    const sid = r.headers.getSetCookie().find((c) => c.startsWith('__Host-sid='))!
    expect(sid).toMatch(/; Secure$/)
    expect(v.cookies.get('__Host-sid')).not.toBe(first)
    expect(((await (await get(g, v, '/echo')).json()) as { dir: string }).dir).toBe(dir)
    // another site cannot sign the visitor in again; a GET does nothing; a stranger without the gate cookie gets no session
    expect((await get(g, v, '/__demo/resume', { method: 'POST', headers: { origin: 'https://evil.example' } })).status).toBe(403)
    expect((await get(g, v, '/__demo/resume')).status).toBe(303)
    const stranger = visitor()
    const s = await get(g, stranger, '/__demo/resume', { method: 'POST', headers: { origin: 'https://demo.trina.app' } })
    expect(s.status).toBe(303)
    expect(s.headers.getSetCookie()).toEqual([])
    // the instance's own persona switch stays closed to visitors
    expect((await get(g, v, '/api/demo/persona', { method: 'POST', headers: { origin: 'https://demo.trina.app', 'content-type': 'application/json' }, body: '{"key":"newHire"}' })).status).toBe(404)
  })

  test('the instance config and an environment built from scratch', async () => {
    const v = visitor()
    await warm(g)
    expect((await startVisit(g, v)).status).toBe(303)
    const e = await (await get(g, v, '/echo')).json() as { dir: string; config: any; env: Record<string, string> }
    const id = path.basename(e.dir)
    expect(id).toMatch(/^[0-9a-f]{8}$/)
    expect(e.config.listen).toEqual({ host: '127.0.0.1', port: e.config.listen.port })
    expect(e.config.engine.proxyPort).toBeGreaterThan(1024)
    expect(e.config.engine.proxyPort).not.toBe(e.config.listen.port)
    // the model proxy's internal server gets the third port of the range (the Linux firewall allows only the range)
    const ports = [e.config.listen.port, e.config.engine.proxyPort, e.config.engine.proxyInnerPort]
    expect(new Set(ports).size).toBe(3)
    for (const p of ports) expect(p).toBeGreaterThan(1024)
    expect(e.config.engine.modelUpstream).toBeUndefined()
    expect(e.config.engine.modelUpstreams.anthropic).toMatch(new RegExp(`^${g.upstreamBase.replace(/[.]/g, '\\.')}/i/${id}\\.[A-Za-z0-9_-]{43}$`))
    expect(e.config.publicOrigins).toEqual(['https://demo.trina.app'])
    expect(e.config.relay.url).toBeNull()
    expect(e.config.update).toEqual({ channel: 'stable', feedUrl: null, auto: false })
    expect(e.config.dataDir).toBe('../data')
    expect(e.env.MYCEL_PUBLIC_ORIGINS).toBe('https://demo.trina.app')
    expect(e.env.MYCEL_SPEECH_PREFETCH).toBe('0')
    expect(e.env.MYCEL_RELAY_URL).toBe('')
    expect(fs.realpathSync(e.env.MYCEL_DEMO!)).toBe(path.join(e.dir, 'demo.json'))
    expect(e.env.GATE_ONLY_VALUE).toBeUndefined()
    expect(fs.realpathSync(e.env.HOME!)).toBe(e.dir)
    expect(JSON.stringify(e.env)).not.toContain(FAKE_CREDENTIAL)
    expect(JSON.stringify(e.config)).not.toContain(FAKE_CREDENTIAL)
    const mode = fs.statSync(path.join(e.dir, 'config', 'server.json')).mode & 0o777
    expect(mode).toBe(0o600)
    // the snapshot's group-readable files are the instance user's alone in the clone (the server refuses a shared key)
    expect(fs.statSync(path.join(e.dir, 'secrets', 'credentials.key')).mode & 0o077).toBe(0)
    expect(fs.statSync(e.dir).mode & 0o077).toBe(0)
  })

  test('deny paths never reach the instance; WebSocket and HTTP denials alike', async () => {
    const v = visitor()
    await warm(g)
    expect((await startVisit(g, v)).status).toBe(303)
    for (const p of ['/api/admin/credentials', '/api/setup', '/api/credentials/sealing-key', '/api/invites/x/accept', '/api/team-link/join', '/api/password-resets/x', '/api/integrations/oauth/callback', '/mcp', '/oauth/token', '/api/demo/persona', '/api%2Fadmin/x']) {
      const r = await get(g, v, p, { method: p === '/api/demo/persona' ? 'POST' : 'GET' })
      expect({ p, status: r.status }).toEqual({ p, status: 404 })
      expect(await r.text()).toContain('Not available in the demo.')
    }
    expect((await get(g, v, '/api/chats')).status).toBe(200)
    const cookie = [...v.cookies].map(([k, x]) => `${k}=${x}`).join('; ')
    const port = Number(new URL(g.base).port)
    expect((await wsEcho(port, '/mcp', cookie, Buffer.from('x'))).head).toStartWith('HTTP/1.1 404')
  })

  test('WebSocket upgrade is piped both ways to the visitor\'s instance', async () => {
    const v = visitor()
    await warm(g)
    expect((await startVisit(g, v)).status).toBe(303)
    const cookie = [...v.cookies].map(([k, x]) => `${k}=${x}`).join('; ')
    const port = Number(new URL(g.base).port)
    const payload = Buffer.from([0x81, 0x85, 1, 2, 3, 4, 0x69, 0x67, 0x6f, 0x68, 0x6e])
    const r = await wsEcho(port, '/ws/events', cookie, payload)
    expect(r.head).toStartWith('HTTP/1.1 101')
    expect(r.head).toMatch(/X-Seen-Cookie: (mycel_locale=en; )?__Host-sid=/)
    expect(r.head).not.toContain('__Host-tdg')
    expect(r.echo.equals(payload)).toBe(true)
    // without a session: no upgrade
    expect((await wsEcho(port, '/ws/events', '', payload)).head).toStartWith('HTTP/1.1 401')
  })

  test('HTML carries Cache-Control no-transform (Cloudflare injects no beacon): gate pages and proxied instance pages', async () => {
    // the gate's own page: no-store kept, no-transform added
    const landing = await get(g, visitor(), '/')
    expect(landing.headers.get('cache-control')).toBe('no-store, no-transform')
    const v = visitor()
    await warm(g)
    expect((await startVisit(g, v)).status).toBe(303)
    // the instance's HTML without a Cache-Control of its own
    const plain = await get(g, v, '/chats/1')
    expect(plain.status).toBe(200)
    expect(plain.headers.get('content-type')).toStartWith('text/html')
    expect(plain.headers.get('cache-control')).toBe('no-transform')
    // the instance's own Cache-Control is merged, not replaced
    const cached = await get(g, v, '/cached')
    expect(await cached.text()).toBe('<p>cached</p>')
    expect(cached.headers.get('cache-control')).toBe('private, max-age=60, no-transform')
    // not HTML: left as the instance sent it
    const api = await get(g, v, '/api/chats')
    expect(api.headers.get('content-type')).toStartWith('application/json')
    expect(api.headers.get('cache-control')).toBeNull()
  })

  test('without a session: other paths go to the landing page, the API says unauthorized', async () => {
    const v = visitor()
    const r = await get(g, v, '/chats/1')
    expect(r.status).toBe(303)
    expect((await get(g, v, '/api/chats')).status).toBe(401)
  })

  test('status for the scripted demo button, CORS for its origin only', async () => {
    await warm(g)
    const r = await fetch(`${g.base}/__demo/status?lang=en`, { headers: { origin: 'https://ax.trina.app' } })
    expect(await r.json()).toEqual({ available: true })
    expect(r.headers.get('access-control-allow-origin')).toBe('https://ax.trina.app')
    const other = await fetch(`${g.base}/__demo/status`, { headers: { origin: 'https://evil.example' } })
    expect(other.headers.get('access-control-allow-origin')).toBeNull()
  })

  test('health is local only (never through the tunnel)', async () => {
    const h = await g.health()
    expect(h).toMatchObject({ ok: true, paused: false, maxLive: 10 })
    expect(typeof h.snapshotAgeMs.en).toBe('number')
    expect(typeof h.dailyTokens).toBe('number')
    expect((await fetch(`${g.base}/__demo/health`, { headers: { 'cf-connecting-ip': '203.0.113.1' } })).status).toBe(404)
  })

  test('the log holds no credential, cookie or path secret', async () => {
    const log = g.log()
    expect(log).not.toContain(FAKE_CREDENTIAL)
    expect(log).not.toContain('__Host-sid')
    expect(log).not.toContain('203.0.113.')
    for (const d of fs.readdirSync(g.instancesDir)) {
      const secret = instanceUpstream(g, d).split('.').pop()!
      expect(log).not.toContain(secret)
    }
  })
})

describe.skipIf(skip)('gate: the six languages', () => {
  let g: Gate
  beforeAll(async () => { g = await startGate({ upstream: upstream.url, turnstile: turnstile.url, locales: ['en', 'ko', 'ja', 'zh', 'es', 'id'] }); await warm(g, 1, 'ja') })
  afterAll(() => g?.stop())

  test('each live language gets its own page, by ?lang= and by the browser', async () => {
    for (const l of ['en', 'ko', 'ja', 'zh', 'es', 'id']) {
      const r = await get(g, visitor(), `/?lang=${l}`, { headers: { 'accept-language': 'en-US' } })
      expect(await r.text(), l).toContain(`<html lang="${l}">`)
    }
    const ja = await (await get(g, visitor(), '/', { headers: { 'accept-language': 'ja-JP,ja;q=0.9' } })).text()
    expect(ja).toContain('<html lang="ja">')
    expect(ja).toContain('質問は8回ほど')
    expect(ja).toContain('name="lang" value="ja"')
    const id = await (await get(g, visitor(), '/?lang=xx', { headers: { 'accept-language': 'id-ID' } })).text()
    expect(id).toContain('<html lang="id">')
  })
})

describe.skipIf(skip)('gate: model upstream', () => {
  let g: Gate
  let a: string, b: string
  beforeAll(async () => {
    g = await startGate({ upstream: upstream.url, turnstile: turnstile.url, locales: ['en'], pool: { warmPerLocale: 2 } })
    await warm(g, 2)
    const ids = fs.readdirSync(g.instancesDir)
    a = instanceUpstream(g, ids[0]!); b = instanceUpstream(g, ids[1]!)
  })
  afterAll(() => g?.stop())

  test('path secret isolation: a wrong or swapped secret gets nothing', async () => {
    upstream.seen.length = 0
    const [, ida, seca] = /\/i\/([0-9a-f]{8})\.(.+)$/.exec(a)!
    const [, , secb] = /\/i\/([0-9a-f]{8})\.(.+)$/.exec(b)!
    expect((await msg(`${g.upstreamBase}/i/${ida}.${secb}`)).status).toBe(404)
    expect((await msg(`${g.upstreamBase}/i/${ida}.${seca!.slice(0, -1)}x`)).status).toBe(404)
    expect((await msg(`${g.upstreamBase}/i/deadbeef.${seca}`)).status).toBe(404)
    expect((await msg(a, { path: '/v1/models' })).status).toBe(404)
    expect((await msg(a, { path: '/v1/messages?x=1' })).status).toBe(404)
    expect(upstream.seen.length).toBe(0)
  })

  test('the real credential replaces the dummy (subscription: Bearer + oauth beta)', async () => {
    upstream.seen.length = 0
    upstream.set(() => Response.json({ type: 'message', usage: { input_tokens: 1, output_tokens: 1 } }))
    const r = await msg(a, { path: '/v1/messages/count_tokens?beta=true' })
    expect(r.status).toBe(200)
    const s = upstream.seen[0]!
    expect(s.path).toBe('/v1/messages/count_tokens?beta=true')
    expect(s.headers.authorization).toBe(`Bearer ${FAKE_CREDENTIAL}`)
    expect(s.headers['x-api-key']).toBeUndefined()
    expect(s.headers['anthropic-beta']).toBe('prompt-caching-2024-07-31,oauth-2025-04-20')
    expect(JSON.stringify(s.headers)).not.toContain(DUMMY_CREDENTIAL)
  })

  test('response headers: allowlist only', async () => {
    upstream.set(() => SSE([{ type: 'message_start', message: { usage: { input_tokens: 1 } } }, { type: 'message_stop' }], {
      'request-id': 'req_123', 'anthropic-organization-id': 'org-1', 'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': '0.2', 'cf-ray': 'abc', 'set-cookie': 'x=y', 'x-custom': '1',
    }))
    const r = await msg(a)
    expect(r.status).toBe(200)
    const names: string[] = []
    r.headers.forEach((_v, k) => names.push(k))
    expect(names.filter((k) => !['content-type', 'date', 'connection', 'keep-alive', 'transfer-encoding'].includes(k))).toEqual([])
    await r.text()
  })

  test('the unified limit headers reach health and the usage log line, never the visitor', async () => {
    upstream.set(() => SSE([{ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } }, { type: 'message_delta', usage: { output_tokens: 20 } }, { type: 'message_stop' }], {
      'request-id': 'req_lim', 'anthropic-organization-id': 'org-lim', 'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-reset': '1795000000', 'anthropic-ratelimit-unified-5h-utilization': '0.31',
      'anthropic-ratelimit-unified-7d-utilization': '0.05', 'anthropic-ratelimit-unified-7d-status': 'allowed',
    }))
    const r = await msg(a)
    expect(r.status).toBe(200)
    r.headers.forEach((_v, k) => expect(k.startsWith('anthropic-')).toBe(false))
    expect(r.headers.get('request-id')).toBeNull()
    await r.text()
    const ida = /\/i\/([0-9a-f]{8})\./.exec(a)![1]!
    const lim = (await until(async () => { const h = await g.health(); return h.upstream.limits.utilization5h === 0.31 ? h : null }, 3000, 'limits')).upstream.limits
    expect(lim).toMatchObject({ utilization5h: 0.31, utilization7d: 0.05, status: 'allowed', resetAt: new Date(1795000000 * 1000).toISOString() })
    expect(Number.isFinite(Date.parse(lim.seenAt))).toBe(true)
    const line = await until(async () => g.log().split('\n').find((l) => l.includes('"upstream usage"') && l.includes(ida) && l.includes('"u5h":0.31')) ?? null, 3000, 'usage line')
    expect(JSON.parse(line)).toMatchObject({ ev: 'upstream usage', instance: ida, tokens: 30, u5h: 0.31, u7d: 0.05 })
    for (const bad of ['req_lim', 'org-lim', 'ratelimit']) expect(g.log()).not.toContain(bad)
  })

  test('error rewrite: 401/403/402/400/404/500/502/529 all become the neutral 503', async () => {
    for (const status of [401, 403, 402, 400, 404, 500, 502, 529]) {
      upstream.set(() => Response.json({ type: 'error', error: { type: status === 401 ? 'authentication_error' : 'overloaded_error', message: 'OAuth token has been revoked, organization disabled' } }, { status, headers: { 'request-id': 'req_9', 'retry-after': '9999' } }))
      const r = await msg(a)
      expect({ status, got: r.status }).toEqual({ status, got: 503 })
      expect(r.headers.get('request-id')).toBeNull()
      expect(r.headers.get('retry-after')).toBeNull()
      expect(r.headers.get('x-should-retry')).toBe('false')
      expect(await r.json()).toEqual({ type: 'error', error: { type: 'api_error', message: BUSY } })
    }
  })

  test('prompt too long passes through (the engine compacts on it), without request-id', async () => {
    const body = { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 210000 tokens > 200000 maximum' } }
    upstream.set(() => Response.json(body, { status: 400, headers: { 'request-id': 'req_1' } }))
    const r = await msg(a)
    expect(r.status).toBe(400)
    expect(r.headers.get('request-id')).toBeNull()
    expect(await r.json()).toEqual(body)
  })

  test('an error event inside the stream is rewritten', async () => {
    upstream.set(() => SSE([{ type: 'message_start', message: { usage: { input_tokens: 5 } } }, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]))
    const r = await msg(a)
    expect(r.status).toBe(200)
    const t = await r.text()
    expect(t).not.toContain('overloaded')
    expect(t).toContain(BUSY)
  })

  test('weighted tokens per instance from message_start / message_delta', async () => {
    const before = (await g.health()).dailyTokens
    upstream.set(() => SSE([
      { type: 'message_start', message: { usage: { input_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 1000, output_tokens: 1 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } },
      { type: 'message_delta', usage: { output_tokens: 200 } },
      { type: 'message_stop' },
    ]))
    const r = await msg(b)
    const text = await r.text()
    expect(text).toContain('hello')
    const h = await until(async () => { const x = await g.health(); return x.dailyTokens >= before + 450 ? x : null }, 3000, 'counted')
    expect(h.dailyTokens).toBe(before + 450)
    const idb = /\/i\/([0-9a-f]{8})\./.exec(b)![1]
    // the instance counts as its demo limit does: the cache write at 0.1 (100 + 5 + 200 + 100); the day counts it fully
    expect(h.instances.find((i: { id: string }) => i.id === idb).tokens).toBe(405)
    // the log line says both, with the usage fields (counts only)
    expect(g.log()).toMatch(/"upstream usage".*"tokens":450,"visitor":405.*"in":100,"cw":50,"cr":1000,"out":200/)
    // count_tokens is not counted
    upstream.set(() => Response.json({ input_tokens: 5000 }))
    await (await msg(b, { path: '/v1/messages/count_tokens' })).text()
    expect((await g.health()).dailyTokens).toBe(before + 450)
  })

  test('the model pin: Sonnet and the small Haiku pass, any other model is sent as the default Sonnet', async () => {
    upstream.set(() => Response.json({ type: 'message', usage: {} }))
    const sent = async (model: unknown, p?: string) => {
      upstream.seen.length = 0
      const r = await msg(a, { body: { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 }, path: p })
      expect(r.status).toBe(200)
      await r.text()
      return (JSON.parse(upstream.seen[0]!.body) as { model: unknown }).model
    }
    expect(await sent('claude-sonnet-5-5')).toBe('claude-sonnet-5-5')
    expect(await sent('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5-20250929')
    expect(await sent('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001')
    expect(await sent('claude-opus-4-8')).toBe('claude-sonnet-5-5')
    expect(await sent('claude-opus-5-5', '/v1/messages/count_tokens')).toBe('claude-sonnet-5-5')
    expect(await sent('claude-sonnet-5-5-evil')).toBe('claude-sonnet-5-5')
    expect(await sent(undefined)).toBe('claude-sonnet-5-5')
    expect(g.log()).toContain('"model request: model pinned","instance"')
  })

  test('429 (and a rejected unified window) answer neutrally and pause calls for a while', async () => {
    upstream.set(() => new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'limit' } }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '5' } }))
    const r = await msg(a)
    expect(r.status).toBe(503)
    expect(await r.json()).toEqual({ type: 'error', error: { type: 'api_error', message: BUSY } })
    upstream.seen.length = 0
    upstream.set(() => Response.json({ type: 'message', usage: {} }))
    expect((await msg(a)).status).toBe(503)
    expect(upstream.seen.length).toBe(0)
    expect((await g.health()).upstream.cooldownUntil).not.toBeNull()
  })
})

describe.skipIf(skip)('gate: per-instance limits', () => {
  test('the gate\'s own cap per instance: the instance\'s demo limit × 1.2, then budget_exceeded', async () => {
    // the fake instance's GET /api/demo says cap = limitTokens
    const g = await startGate({ upstream: upstream.url, turnstile: turnstile.url, locales: ['en'], demo: { limitTokens: 1000 } })
    try {
      await warm(g)
      const u = instanceUpstream(g, fs.readdirSync(g.instancesDir)[0]!)
      upstream.set(() => Response.json({ type: 'message', usage: { input_tokens: 700, output_tokens: 0 } }))
      expect((await msg(u)).status).toBe(200)
      expect((await msg(u)).status).toBe(200) // 1400 >= 1200 after this one
      const r = await msg(u)
      expect(r.status).toBe(403)
      expect(r.headers.get('request-id')).toBeNull()
      expect(await r.json()).toEqual({ type: 'error', error: { type: 'permission_error', message: 'budget_exceeded' } })
      // the global day is not used up: it is this instance's cap
      expect((await g.health()).dailyTokens).toBe(1400)
      expect(g.log()).toContain('"model request stopped: instance cap"')
    } finally { await g.stop() }
  })

  test('the per-instance cap counts a cache write at 0.1, as the instance does; the day counts it fully', async () => {
    const g = await startGate({ upstream: upstream.url, turnstile: turnstile.url, locales: ['en'], demo: { limitTokens: 1000 } })
    try {
      await warm(g)
      const u = instanceUpstream(g, fs.readdirSync(g.instancesDir)[0]!)
      // a fresh copy's first request: the system prompt and the tools written to the cache
      upstream.set(() => Response.json({ type: 'message', usage: { input_tokens: 10, cache_creation_input_tokens: 5000, output_tokens: 90 } }))
      expect((await msg(u)).status).toBe(200)
      // each: 600 for the visitor (10 + 500 + 90), 5100 for the day; with the write counted fully the second was refused
      expect((await msg(u)).status).toBe(200)
      expect((await g.health()).dailyTokens).toBe(10_200)
      expect((await g.health()).instances[0].tokens).toBe(1200)
      // now at 1200: stopped
      expect((await msg(u)).status).toBe(403)
    } finally { await g.stop() }
  })

  test('one instance gets at most streamsPerInstance streams; another instance is still served', async () => {
    const g = await startGate({ upstream: upstream.url, turnstile: turnstile.url, locales: ['en'], pool: { warmPerLocale: 2 }, limits: { maxStreams: 4, streamsPerInstance: 1, streamWaitMs: 300 } })
    try {
      await warm(g, 2)
      const [ia, ib] = fs.readdirSync(g.instancesDir)
      const a = instanceUpstream(g, ia!), b = instanceUpstream(g, ib!)
      let release!: () => void
      const held = new Promise<void>((ok) => { release = ok })
      upstream.set(async () => { await held; return Response.json({ type: 'message', usage: {} }) })
      const first = msg(a)
      await Bun.sleep(100)
      const t0 = Date.now()
      const second = await msg(a)
      expect(second.status).toBe(503)
      expect(Date.now() - t0).toBeGreaterThanOrEqual(250)
      const other = msg(b)
      await Bun.sleep(100)
      expect((await g.health()).streams).toBe(2)
      release()
      expect((await first).status).toBe(200)
      expect((await other).status).toBe(200)
      expect(g.log()).toContain('"model request: instance stream limit"')
    } finally { await g.stop() }
  })

  test('an instance over its disk cap ends; its visitor sees "session ended"', async () => {
    const g = await startGate({ upstream: upstream.url, turnstile: turnstile.url, locales: ['en'], pool: { diskCapMB: 1 } })
    try {
      await warm(g)
      const v = visitor()
      expect((await startVisit(g, v)).status).toBe(303)
      const e = await (await get(g, v, '/echo')).json() as { dir: string }
      await Bun.sleep(700)
      expect(fs.existsSync(e.dir)).toBe(true) // under the cap: it stays
      fs.writeFileSync(path.join(e.dir, 'big.bin'), Buffer.alloc(3 * 1024 * 1024, 1))
      await until(() => !fs.existsSync(e.dir), 8000, 'instance removed')
      expect(g.log()).toContain('"instance over its disk cap"')
      const html = await (await get(g, v, '/')).text()
      expect(html).toContain('Start again')
    } finally { await g.stop() }
  })
})

describe.skipIf(skip)('gate: the instance user and the fence check', () => {
  test('refuses to start when instances would run as the gate\'s own user', async () => {
    await expect(startGate({ upstream: upstream.url, turnstile: turnstile.url, locales: ['en'], pool: { allowSameUser: false } })).rejects.toThrow(/pool\.runAs/)
    const uid = process.getuid!()
    await expect(startGate({ upstream: upstream.url, turnstile: turnstile.url, locales: ['en'], pool: { allowSameUser: false, runAs: { uid, gid: process.getgid!() } } })).rejects.toThrow(/gate's own user/)
  })

  for (const [what, demo] of [['a builder demo', { builder: true }], ['a scripted demo', { kind: 'scripted' }]] as const) {
    test(`${what} never gets warm; its snapshot is marked bad`, async () => {
      const g = await startGate({ upstream: upstream.url, turnstile: turnstile.url, locales: ['en'], demo })
      try {
        await until(() => g.log().includes('snapshot refused: not a fenced free-roam demo'), 8000, 'refused')
        await Bun.sleep(500)
        const h = await g.health()
        expect(h.pool.warm).toBe(0)
        expect(h.snapshotAgeMs.en).toBeNull()
        expect(fs.readdirSync(g.instancesDir)).toEqual([])
        expect(await (await fetch(`${g.base}/__demo/status`)).json()).toEqual({ available: false })
      } finally { await g.stop() }
    })
  }

  test('a snapshot without manifest.demoFile is not used', async () => {
    const g = await startGate({
      upstream: upstream.url, turnstile: turnstile.url, locales: ['en'],
      before: ({ snapshotsDir }) => {
        const m = path.join(snapshotsDir, 'en', 'snap-1', 'manifest.json')
        const j = JSON.parse(fs.readFileSync(m, 'utf8'))
        delete j.demoFile
        fs.writeFileSync(m, JSON.stringify(j))
      },
    })
    try {
      await Bun.sleep(800)
      const h = await g.health()
      expect(h.pool.warm + h.pool.starting).toBe(0)
      expect(h.snapshotAgeMs.en).toBeNull()
    } finally { await g.stop() }
  })
})

describe.skipIf(skip)('gate: process groups', () => {
  const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
  const pids = (dir: string) => until(() => {
    const c = Number(fs.readFileSync(path.join(dir, 'child-pid'), 'utf8')), l = Number(fs.readFileSync(path.join(dir, 'leader-pid'), 'utf8'))
    return c > 1 && l > 1 ? { child: c, leader: l } : null
  }, 5000, 'pid files')

  test('an instance whose leader dies is ended with its whole group', async () => {
    const g = await startGate({ upstream: upstream.url, turnstile: turnstile.url, locales: ['en'], files: { 'spawn-child': '' } })
    try {
      await warm(g)
      const dir = path.join(g.instancesDir, fs.readdirSync(g.instancesDir)[0]!)
      const p = await pids(dir)
      expect(alive(p.child)).toBe(true)
      process.kill(p.leader, 'SIGKILL')
      await until(() => !alive(p.child), 10_000, 'child ended')
      await until(() => !fs.existsSync(dir), 5000, 'folder removed')
    } finally { await g.stop() }
  })

  test('after a gate crash, the next gate ends the orphan\'s group even when its leader is gone', async () => {
    const g1 = await startGate({ upstream: upstream.url, turnstile: turnstile.url, locales: ['en'], files: { 'spawn-child': '' } })
    await warm(g1)
    const dir = path.join(g1.instancesDir, fs.readdirSync(g1.instancesDir)[0]!)
    const p = await pids(dir)
    await g1.crash()
    process.kill(p.leader, 'SIGKILL')
    await Bun.sleep(200)
    expect(alive(p.child)).toBe(true)
    const g2 = await startGate({ upstream: upstream.url, turnstile: turnstile.url, locales: ['en'], root: g1.root })
    try {
      await until(() => !alive(p.child), 10_000, 'orphan child ended')
      await until(() => !fs.existsSync(dir), 5000, 'orphan folder removed')
      expect(g2.log()).toContain('"orphan removed"')
    } finally {
      try { process.kill(p.child, 'SIGKILL') } catch {}
      await g2.stop()
    }
  })
})

describe.skipIf(skip)('gate: API key mode', () => {
  let g: Gate
  beforeAll(async () => { g = await startGate({ upstream: upstream.url, turnstile: turnstile.url, locales: ['en'], ai: { mode: 'anthropic-api-key' } }); await warm(g) })
  afterAll(() => g?.stop())
  test('x-api-key, no Bearer, no oauth beta', async () => {
    upstream.seen.length = 0
    upstream.set(() => Response.json({ type: 'message', usage: {} }))
    const u = instanceUpstream(g, fs.readdirSync(g.instancesDir)[0]!)
    await (await msg(u, { headers: { 'anthropic-beta': 'oauth-2025-04-20,prompt-caching-2024-07-31' } })).text()
    const s = upstream.seen[0]!
    expect(s.headers['x-api-key']).toBe(FAKE_CREDENTIAL)
    expect(s.headers.authorization).toBeUndefined()
    expect(s.headers['anthropic-beta']).toBe('prompt-caching-2024-07-31')
  })
})

describe.skipIf(skip)('gate: daily cap, PAUSE and the stream limit', () => {
  let g: Gate
  let u: string
  beforeAll(async () => {
    g = await startGate({ upstream: upstream.url, turnstile: turnstile.url, locales: ['en'], limits: { dailyWeightedTokens: 500, maxStreams: 1, streamWaitMs: 300 } })
    await warm(g)
    u = instanceUpstream(g, fs.readdirSync(g.instancesDir)[0]!)
  })
  afterAll(() => g?.stop())

  test('one stream at a time: the next waits, then gets the neutral answer', async () => {
    let release!: () => void
    const held = new Promise<void>((ok) => { release = ok })
    upstream.set(async () => { await held; return Response.json({ type: 'message', usage: {} }) })
    const first = msg(u)
    await Bun.sleep(100)
    const t0 = Date.now()
    const second = await msg(u)
    expect(second.status).toBe(503)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250)
    release()
    expect((await first).status).toBe(200)
  })

  test('the global daily cap answers 403 budget_exceeded', async () => {
    upstream.set(() => Response.json({ type: 'message', usage: { input_tokens: 300, output_tokens: 0 } }))
    expect((await msg(u)).status).toBe(200)
    expect((await msg(u)).status).toBe(200) // 600 >= 500 after this one
    const r = await msg(u)
    expect(r.status).toBe(403)
    expect(r.headers.get('request-id')).toBeNull()
    expect(await r.json()).toEqual({ type: 'error', error: { type: 'permission_error', message: 'budget_exceeded' } })
  })

  test('PAUSE: no start, busy page, model requests stopped', async () => {
    fs.writeFileSync(g.pauseFile, '')
    await Bun.sleep(1100)
    const v = visitor()
    const landing = await get(g, v, '/')
    expect(await landing.text()).toContain('https://ax.trina.app/demo')
    expect((await startVisit(g, v)).status).toBe(503)
    expect((await (await fetch(`${g.base}/__demo/status`)).json())).toEqual({ available: false })
    expect((await g.health()).paused).toBe(true)
    fs.rmSync(g.pauseFile)
  })
})

describe.skipIf(skip)('gate: pool', () => {
  test('pool full: the next visitor gets the busy page', async () => {
    const g = await startGate({ upstream: upstream.url, turnstile: turnstile.url, locales: ['en'], pool: { maxLive: 1 } })
    try {
      await warm(g)
      expect((await startVisit(g, visitor('198.51.100.1'))).status).toBe(303)
      const v2 = visitor('198.51.100.2')
      const r = await startVisit(g, v2)
      expect(r.status).toBe(503)
      expect(r.headers.get('clear-site-data')).toBeNull()
      const html = await r.text()
      expect(html).toContain('https://ax.trina.app/demo')
      expect(html).toContain('https://ax.trina.app/pricing')
      expect(html).toContain('<a class="secondary" href="/">Try again</a>')
      const landing = await get(g, v2, '/')
      expect(await landing.text()).not.toContain('cf-turnstile')
    } finally { await g.stop() }
  })

  test('expiry: the instance goes, the visitor sees "session ended" with Start again', async () => {
    const g = await startGate({ upstream: upstream.url, turnstile: turnstile.url, locales: ['en'], pool: { ttlHours: 2 / 3600 } })
    try {
      await warm(g)
      const v = visitor()
      expect((await startVisit(g, v)).status).toBe(303)
      const e = await (await get(g, v, '/echo')).json() as { dir: string }
      await until(() => !fs.existsSync(e.dir), 8000, 'instance removed')
      const r = await get(g, v, '/')
      const html = await r.text()
      expect(html).toContain('action="/__demo/start"')
      expect(html).toContain('Start again')
      expect(v.cookies.has('__Host-tdg')).toBe(false)
    } finally { await g.stop() }
  })

  test('IP limits: 2 live per address, 3 starts per hour', async () => {
    const g = await startGate({ upstream: upstream.url, turnstile: turnstile.url, locales: ['en'], pool: { warmPerLocale: 3 }, limits: { startsPerHour: 3, startsPerDay: 6, livePerIp: 2 } })
    try {
      await warm(g, 3)
      const ip = '192.0.2.10'
      expect((await startVisit(g, visitor(ip))).status).toBe(303)
      expect((await startVisit(g, visitor(ip))).status).toBe(303)
      const third = await startVisit(g, visitor(ip))
      expect(third.status).toBe(429) // two live already
      expect(third.headers.get('clear-site-data')).toBeNull()
      const thirdHtml = await third.text()
      expect(thirdHtml).toContain('a few times')
      // copies live 24 hours: never "about an hour" for this one
      expect(thirdHtml).toContain('You can start again tomorrow.')
      expect(thirdHtml).not.toContain('about an hour')
      // another address is not held back by the first one's live copies
      const other = '192.0.2.11'
      for (let i = 0; i < 2; i++) { await warm(g, 1); expect((await startVisit(g, visitor(other))).status).toBe(303) }
      const s = (await g.health()).instances.filter((x: { state: string }) => x.state === 'live')
      expect(s.length).toBe(4)
    } finally { await g.stop() }
  })

  test('an exempt address (limits.exemptIpHashes) skips the start limits and gets exemptLivePerIp live copies', async () => {
    const office = '192.0.2.40', other = '192.0.2.41'
    // the gate's address key made beforehand, so the test knows the hash it stores
    const key = crypto.randomBytes(32)
    const hash = crypto.createHmac('sha256', key).update(office).digest('hex').slice(0, 32)
    const g = await startGate({
      upstream: upstream.url, turnstile: turnstile.url, locales: ['en'], pool: { warmPerLocale: 3 },
      limits: { startsPerHour: 1, startsPerDay: 1, livePerIp: 1, exemptIpHashes: [hash.slice(0, 10)], exemptLivePerIp: 3 },
      before: ({ instancesDir }) => {
        const stateDir = path.join(path.dirname(instancesDir), 'state')
        fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
        fs.writeFileSync(path.join(stateDir, 'ip-key'), key, { mode: 0o600 })
      },
    })
    try {
      await warm(g, 3)
      for (let i = 0; i < 3; i++) { await warm(g, 1); expect((await startVisit(g, visitor(office))).status).toBe(303) }
      await warm(g, 1)
      const fourth = await startVisit(g, visitor(office))
      expect(fourth.status).toBe(429) // exemptLivePerIp: 3 live already
      expect(await fourth.text()).toContain('You can start again tomorrow.')
      // an address that is not listed keeps the limits
      expect((await startVisit(g, visitor(other))).status).toBe(303)
      await warm(g, 1)
      expect((await startVisit(g, visitor(other))).status).toBe(429)
      // its starts are still counted under the listed hash (the gate saves state.json half a second later)
      await until(() => { try { return JSON.parse(fs.readFileSync(path.join(g.root, 'state', 'state.json'), 'utf8')).starts[hash]?.length === 3 || null } catch { return null } }, 5_000, 'state.json')
    } finally { await g.stop() }
  })

  test('starts per hour', async () => {
    const g = await startGate({ upstream: upstream.url, turnstile: turnstile.url, locales: ['en'], pool: { warmPerLocale: 2 }, limits: { startsPerHour: 3, livePerIp: 10 } })
    try {
      await warm(g, 2)
      const ip = '192.0.2.20'
      for (let i = 0; i < 3; i++) { await warm(g, 1); expect((await startVisit(g, visitor(ip))).status).toBe(303) }
      const r = await startVisit(g, visitor(ip))
      expect(r.status).toBe(429)
      expect(r.headers.get('clear-site-data')).toBeNull()
      expect(await r.text()).toContain('You can start again in about an hour.')
    } finally { await g.stop() }
  })

  test('starts per day: the limit page says tomorrow', async () => {
    const g = await startGate({ upstream: upstream.url, turnstile: turnstile.url, locales: ['en'], pool: { warmPerLocale: 2 }, limits: { startsPerHour: 10, startsPerDay: 2, livePerIp: 10 } })
    try {
      await warm(g, 2)
      const ip = '192.0.2.30'
      for (let i = 0; i < 2; i++) { await warm(g, 1); expect((await startVisit(g, visitor(ip))).status).toBe(303) }
      const r = await startVisit(g, visitor(ip))
      expect(r.status).toBe(429)
      const html = await r.text()
      expect(html).toContain('You can start again tomorrow.')
      expect(html).not.toContain('about an hour')
    } finally { await g.stop() }
  })

  test('a failed persona sign-in ends that instance and shows an error page', async () => {
    const g = await startGate({ upstream: upstream.url, turnstile: turnstile.url, locales: ['en'] })
    try {
      await warm(g)
      const id = fs.readdirSync(g.instancesDir)[0]!
      fs.writeFileSync(path.join(g.instancesDir, id, 'persona-fails'), '')
      const v = visitor()
      const r = await startVisit(g, v)
      expect(r.status).toBe(502)
      expect(v.cookies.has('__Host-tdg')).toBe(false)
      expect(r.headers.get('clear-site-data')).toBeNull()
      expect(await r.text()).toContain('<a class="secondary" href="/">Try again</a>')
      await until(() => !fs.existsSync(path.join(g.instancesDir, id)), 8000, 'removed')
    } finally { await g.stop() }
  })

  test('each instance has its own sign-in key: only its hash on the instance, nothing without the key', async () => {
    const g = await startGate({ upstream: upstream.url, turnstile: turnstile.url, locales: ['en'], pool: { warmPerLocale: 2 } })
    try {
      await until(async () => (await g.health()).pool.warm === 2, 8000, 'two warm')
      const h = await g.health()
      const [a, b] = h.instances.map((i: { id: string }) => i.id) as [string, string]
      const hashOf = (id: string) => (JSON.parse(fs.readFileSync(path.join(g.instancesDir, id, 'demo.json'), 'utf8')) as { gateKeySha256: string }).gateKeySha256
      expect(hashOf(a)).toMatch(/^[0-9a-f]{64}$/)
      expect(hashOf(a)).not.toBe(hashOf(b))
      // the snapshot itself never holds one
      const snap = fs.readFileSync(path.join(path.dirname(g.instancesDir), 'snap', 'en', 'snap-1', 'base', 'demo.json'), 'utf8')
      expect(snap).not.toContain('gateKeySha256')
      const v = visitor()
      expect((await startVisit(g, v)).status).toBe(303) // the gate's own sign-in has the key
      const e = await (await get(g, v, '/echo')).json() as { dir: string; config: unknown; env: Record<string, string> }
      expect(JSON.stringify(e.config) + JSON.stringify(e.env)).not.toContain('gate-key')
      expect(Object.keys(e.env).filter((k) => /GATE_KEY/.test(k))).toEqual([])
      // a visitor's header never reaches the persona route: the path is refused at the gate
      expect((await get(g, v, '/api/demo/persona', { method: 'POST', headers: { origin: 'https://demo.trina.app', 'content-type': 'application/json', 'x-mycel-demo-gate': 'x' }, body: '{"key":"newHire"}' })).status).toBe(404)
    } finally { await g.stop() }
  })

  test('an instance that signs in without the key is refused, and its snapshot marked bad', async () => {
    const g = await startGate({ upstream: upstream.url, turnstile: turnstile.url, locales: ['en'], files: { 'no-gate-key-check': '' } })
    try {
      await until(() => g.log().includes('snapshot refused: the instance does not check the gate key'), 8000, 'refused')
      expect((await g.health()).pool.warm).toBe(0)
    } finally { await g.stop() }
  })

  test('a sign-in check that answers something else is a failed start, not a bad snapshot', async () => {
    const g = await startGate({ upstream: upstream.url, turnstile: turnstile.url, locales: ['en'], files: { 'gate-key-check-500': '' } })
    try {
      await until(() => g.log().includes('the sign-in check answered 500'), 8000, 'failed start')
      expect(g.log()).not.toContain('snapshot refused')
    } finally { await g.stop() }
  })

  test('a snapshot of another code version is refused', async () => {
    const g = await startGate({ upstream: upstream.url, turnstile: turnstile.url, locales: ['en'], codeVersion: '1.0.0', snapshotVersion: '0.9.0' })
    try {
      await Bun.sleep(800)
      const h = await g.health()
      expect(h.pool.warm + h.pool.starting).toBe(0)
      expect(h.snapshotAgeMs.en).toBeNull()
      expect(g.log()).toContain('snapshot refused: other code version')
      expect(await (await get(g, visitor(), '/')).text()).toContain('https://ax.trina.app/demo')
    } finally { await g.stop() }
  })

  test('the sweeper removes orphan folders and old snapshots', async () => {
    const g = await startGate({
      upstream: upstream.url, turnstile: turnstile.url, locales: ['en'],
      before: ({ instancesDir, snapshotsDir }) => {
        fs.mkdirSync(path.join(instancesDir, 'abcdef12', 'data'), { recursive: true })
        fs.writeFileSync(path.join(instancesDir, 'abcdef12', '.gate-pid'), '999999')
        const old = path.join(snapshotsDir, 'en', 'snap-0')
        fs.mkdirSync(path.join(old, 'base'), { recursive: true })
        fs.writeFileSync(path.join(old, 'manifest.json'), JSON.stringify({ codeVersion: '9.9.9', locale: 'en', createdAt: new Date(Date.now() - 2 * 86400_000).toISOString(), demoFile: 'demo.json' }))
        const t = new Date(Date.now() - 2 * 3600_000)
        fs.utimesSync(old, t, t)
      },
    })
    try {
      await until(() => !fs.existsSync(path.join(g.instancesDir, 'abcdef12')), 5000, 'orphan removed')
      await until(() => !fs.existsSync(path.join(g.root, 'snap', 'en', 'snap-0')), 5000, 'old snapshot removed')
      expect(fs.existsSync(path.join(g.root, 'snap', 'en', 'snap-1'))).toBe(true)
    } finally { await g.stop() }
  })
})

describe.skipIf(skip)('gate: a bad newest snapshot', () => {
  const setup = (older: string) => ({ snapshotsDir }: { snapshotsDir: string }) => {
    const manifest = (name: string) => path.join(snapshotsDir, 'en', name, 'manifest.json')
    writeSnapshot(snapshotsDir, 'en', '9.9.9', 'snap-new', new Date(Date.now() + 60_000).toISOString(), { demo: { kind: 'scripted' } })
    for (const [name, git] of [['snap-new', 'b'.repeat(40)], ['snap-1', older]] as const) fs.writeFileSync(manifest(name), JSON.stringify({ ...JSON.parse(fs.readFileSync(manifest(name), 'utf8')), git }))
  }
  test('never falls back to a snapshot of the same version from another commit', async () => {
    const g = await startGate({ upstream: upstream.url, turnstile: turnstile.url, locales: ['en'], before: setup('a'.repeat(40)) })
    try {
      await until(() => g.log().includes('the newest is bad and this one is from another commit'), 8000, 'refused')
      await Bun.sleep(500)
      expect((await g.health()).pool.warm).toBe(0)
      expect(fs.readdirSync(g.instancesDir)).toEqual([])
      expect(fs.existsSync(path.join(g.root, 'snap', 'en', 'snap-1'))).toBe(true)
    } finally { await g.stop() }
  })
})

describe.skipIf(skip)('gate: snapshots of another version', () => {
  test('the sweeper keeps them, older or newer, for a fast rollback; an older one of its own version goes', async () => {
    const put = (dir: string, name: string, codeVersion: string, ageMs: number) => {
      const d = path.join(dir, 'en', name)
      fs.mkdirSync(path.join(d, 'base'), { recursive: true })
      fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ codeVersion, locale: 'en', createdAt: new Date(Date.now() + ageMs * -1).toISOString(), demoFile: 'demo.json' }))
      const t = new Date(Date.now() - 2 * 3600_000)
      fs.utimesSync(d, t, t)
    }
    const g = await startGate({
      upstream: upstream.url, turnstile: turnstile.url, locales: ['en'],
      before: ({ snapshotsDir }) => {
        put(snapshotsDir, 'own-older', '9.9.9', 2 * 86400_000)
        put(snapshotsDir, 'other-older', '9.9.8', 2 * 86400_000)
        put(snapshotsDir, 'other-newer', '10.0.0', -3600_000)
      },
    })
    try {
      await until(() => !fs.existsSync(path.join(g.root, 'snap', 'en', 'own-older')), 5000, 'own older snapshot removed')
      await Bun.sleep(800) // more sweeps
      expect(fs.existsSync(path.join(g.root, 'snap', 'en', 'other-older'))).toBe(true)
      expect(fs.existsSync(path.join(g.root, 'snap', 'en', 'other-newer'))).toBe(true)
      expect(fs.existsSync(path.join(g.root, 'snap', 'en', 'snap-1'))).toBe(true)
    } finally { await g.stop() }
  })
})

describe.skipIf(skip)('gate: daily stats', () => {
  const today = () => new Date().toISOString().slice(0, 10)
  const stats = async (g: Gate) => (await (await fetch(`${g.base}/__demo/stats`)).json()) as { days: Record<string, Record<string, Record<string, number>>>; distinctStarters24h: number }
  const en = async (g: Gate) => (await stats(g)).days[today()]?.en ?? {}

  test('a landing, start, question, Start free, the demo limit, refusals; local only; no address or hash in stats.json', async () => {
    const g = await startGate({ upstream: upstream.url, turnstile: turnstile.url, locales: ['en'], pool: { maxLive: 1 }, demo: { limitTokens: 1000 } })
    try {
      await warm(g)
      // local operators only, as health
      expect((await fetch(`${g.base}/__demo/stats`)).status).toBe(200)
      expect((await fetch(`${g.base}/__demo/stats`, { headers: { 'cf-connecting-ip': '203.0.113.1' } })).status).toBe(404)
      expect((await stats(g)).days).toEqual({})

      const v = visitor('203.0.113.40')
      expect((await get(g, v, '/?lang=en')).status).toBe(200)
      expect((await startVisit(g, v, { token: 'bad' })).status).toBe(400)
      expect((await startVisit(g, v)).status).toBe(303)
      // a question: a chat message the instance takes (2xx); reading the messages is not one
      expect((await get(g, v, '/api/chats/c1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(200)
      expect((await get(g, v, '/api/chats/c1/messages')).status).toBe(200)
      // "Start free" in the app: counted with the visitor's locale, then on to the plans
      const sf = await get(g, v, '/__demo/go/start-free')
      expect(sf.status).toBe(302)
      expect(sf.headers.get('location')).toBe('https://ax.trina.app/pricing')
      // and with no session at all (counted as '-')
      expect((await get(g, visitor(), '/__demo/go/start-free')).status).toBe(302)

      // the instance's demo limit (1000; the gate's cap is 1200): crossed once, counted once
      const live = await liveInstance(g)
      const u = instanceUpstream(g, live.id)
      upstream.set(() => Response.json({ type: 'message', usage: { input_tokens: 600, output_tokens: 0 } }))
      expect((await msg(u)).status).toBe(200)
      expect((await msg(u)).status).toBe(200) // 1200: over the demo limit, at the gate's cap
      expect((await msg(u)).status).toBe(403)

      // the pool is full (maxLive 1): the next visitor sees busy, a start is refused as full
      const v2 = visitor('203.0.113.41')
      expect(await (await get(g, v2, '/')).text()).not.toContain('cf-turnstile')
      expect((await startVisit(g, v2)).status).toBe(503)
      // PAUSE: a start refused as paused
      fs.writeFileSync(g.pauseFile, '')
      await Bun.sleep(1100)
      expect((await startVisit(g, v2)).status).toBe(503)
      fs.rmSync(g.pauseFile)

      const c = await en(g)
      expect(c).toMatchObject({ landing: 1, turnstileFail: 1, turnstilePass: 1, starts: 1, questions: 1, startFree: 1, hitLimit: 1, tokens: 1200, busyShown: 1, refusedFull: 1, refusedPaused: 1 })
      expect((await stats(g)).days[today()]!['-']).toEqual({ startFree: 1 })
      expect((await stats(g)).distinctStarters24h).toBe(1)

      // stats.json: counters only, never an address or the start limits' hashes
      const file = path.join(g.root, 'state', 'stats.json')
      await until(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('refusedPaused'), 3000, 'stats saved')
      const saved = fs.readFileSync(file, 'utf8')
      expect(saved).not.toContain('203.0.113.')
      const hashes = Object.keys(JSON.parse(fs.readFileSync(path.join(g.root, 'state', 'state.json'), 'utf8')).starts)
      expect(hashes.length).toBe(1)
      for (const h of hashes) expect(saved).not.toContain(h)
    } finally { await g.stop() }
  })

  test('an ended instance records one time-active bucket', async () => {
    const g = await startGate({ upstream: upstream.url, turnstile: turnstile.url, locales: ['en'], pool: { ttlHours: 2 / 3600 } })
    try {
      await warm(g)
      const v = visitor()
      expect((await startVisit(g, v)).status).toBe(303)
      const e = await (await get(g, v, '/echo')).json() as { dir: string }
      await until(() => !fs.existsSync(e.dir), 8000, 'instance removed')
      const c = await en(g)
      expect(c['dur.lt2m']).toBe(1)
      expect(Object.keys(c).filter((k) => k.startsWith('dur.'))).toEqual(['dur.lt2m'])
    } finally { await g.stop() }
  })
})
