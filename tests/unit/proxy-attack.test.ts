// Adversarial checks of the subscription model proxy (review of fix/prod-proxy): the owner's token may only ever go to
// the configured upstream, on the allowed paths, with the body the request filter actually checked; a turn token
// stops working when its turn ends; a refused or never-issued token gets nothing.
import { afterAll, describe, expect, test } from 'bun:test'
import { makeEnv } from '../lib/env'
import { issueProxyToken, revokeProxyTokens, startModelProxy } from '../../server/src/proxy/model-proxy'
import { AppConfigFile } from '../../server/src/app-config'

const env = makeEnv('unit-proxy-attack')
const REAL = 'sk-ant-oat01-' + 'A'.repeat(40)
const KEY = 'sk-ant-api03-' + 'K'.repeat(40)

// a second server that must never be reached: anything it gets is a leak
const stolen: { path: string; headers: Record<string, string>; body: string }[] = []
const other = Bun.serve({
  port: 0, hostname: '127.0.0.1',
  async fetch(req) { stolen.push({ path: new URL(req.url).pathname, headers: Object.fromEntries(req.headers), body: await req.text() }); return Response.json({ ok: true }) },
})
const seen: { path: string; headers: Record<string, string>; body: string }[] = []
let redirectTo: string | null = null
const upstream = Bun.serve({
  port: 0, hostname: '127.0.0.1',
  async fetch(req) {
    const u = new URL(req.url)
    seen.push({ path: u.pathname + u.search, headers: Object.fromEntries(req.headers), body: await req.text() })
    if (u.pathname !== '/v1/messages' && u.pathname !== '/v1/messages/count_tokens') return Response.json({ leaked: true }, { status: 200 })
    if (redirectTo) return new Response(null, { status: 307, headers: { location: redirectTo } })
    return Response.json({ id: 'm', model: 'claude-x', content: [], usage: { input_tokens: 1, output_tokens: 1 } })
  },
})
const turnId = 'atk1'
env.db.query("INSERT INTO turns (id, chat_id, user_id, engine) VALUES (?, 'c', 'alice', 'claude-code')").run(turnId)
const oauth = await startModelProxy({ db: env.db, upstream: { baseUrl: `http://127.0.0.1:${upstream.port}`, kind: 'oauth', secret: () => REAL } })
const apiKey = await startModelProxy({ db: env.db, upstream: { baseUrl: `http://127.0.0.1:${upstream.port}`, kind: 'api-key', secret: KEY } })
afterAll(() => { oauth.stop(); apiKey.stop(); upstream.stop(true); other.stop(true) })

const body = (o: Record<string, unknown> = {}) => JSON.stringify({ model: 'claude-sonnet-x', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }], ...o })
const send = (base: string, tok: string, p = '/v1/messages', b: string = body(), method = 'POST') =>
  fetch(base + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok }, ...(method === 'GET' || method === 'HEAD' ? {} : { body: b }) })

describe('model proxy under attack', () => {
  const tok = issueProxyToken(env.db, turnId, 'alice')

  test('an upstream redirect is never followed: the credential and the body stay with the configured upstream', async () => {
    try { for (const [proxy, real] of [[oauth, REAL], [apiKey, KEY]] as const) {
      for (const loc of [`http://127.0.0.1:${other.port}/steal`, '/v1/files']) {
        redirectTo = loc
        stolen.length = 0; seen.length = 0
        const r = await send(proxy.url, tok)
        expect(r.status).toBe(502)
        expect(r.headers.get('location')).toBeNull()
        expect(stolen).toEqual([]) // the other server got nothing (not the key, not the prompt)
        expect(seen.map((s) => s.path)).toEqual(['/v1/messages']) // no follow-up to /v1/files with the real credential
        expect(JSON.stringify([...r.headers]) + await r.text()).not.toContain(real)
      }
    } } finally { redirectTo = null }
  })

  test('what goes upstream is the body the filter checked (duplicate keys cannot smuggle a refused tool)', async () => {
    seen.length = 0
    // JSON.parse keeps the LAST "tools"; a parser that keeps the first would see web_fetch
    const raw = `{"model":"claude-sonnet-x","max_tokens":5,"tools":[{"type":"web_fetch_20250910","name":"web_fetch"}],"mcp_servers":[],"messages":[{"role":"user","content":"hi"}],"tools":[]}`
    // (mcp_servers is refused outright; take it out to test the duplicate on its own)
    const r = await send(oauth.url, tok, '/v1/messages', raw.replace('"mcp_servers":[],', ''))
    expect(r.status).toBe(200)
    const out = seen.at(-1)!.body
    expect(out).not.toContain('web_fetch')
    expect(JSON.parse(out).tools).toEqual([])
  })

  test('nested search_result content is checked too (no URL image hidden in it)', async () => {
    const b = body({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'search_result', source: 'x', title: 't', content: [{ type: 'image', source: { type: 'url', url: `http://127.0.0.1:${other.port}/x.png` } }] }] }] }] })
    const r = await send(oauth.url, tok, '/v1/messages', b)
    expect(r.status).toBe(403)
  })

  test('only POST /v1/messages and count_tokens reach the upstream', async () => {
    seen.length = 0
    const tries: [string, string][] = [
      ['GET', '/v1/messages'], ['POST', '/v1/files'], ['POST', '/v1/messages/batches'], ['POST', '/v1/messages/../files'],
      ['POST', '/v1/messages/%2e%2e/files'], ['POST', '/v1/messages/'], ['POST', '/v1/messages?beta=true&x=1'],
      ['POST', '/v1/messages;x'], ['POST', '/v1/complete'], ['POST', '/api/oauth/profile'], ['DELETE', '/v1/messages'],
    ]
    for (const [m, p] of tries) {
      const r = await send(oauth.url, tok, p, body(), m)
      expect([401, 403, 404]).toContain(r.status)
    }
    expect(seen).toEqual([])
    // the same on a raw socket (no client-side path clean-up before the proxy sees it)
    for (const p of ['/v1/messages/../files', '/v1/messages/%2e%2e/files', '/v1/messages/..%2ffiles', '/v1/files?/v1/messages']) {
      const b = body()
      const status = await new Promise<number>((res) => {
        let got = ''
        Bun.connect({ hostname: '127.0.0.1', port: oauth.port, socket: {
          open(s) { s.write(`POST ${p} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${tok}\r\nContent-Type: application/json\r\nContent-Length: ${b.length}\r\nConnection: close\r\n\r\n${b}`) },
          data(s, d) { got += d.toString(); if (got.includes('\r\n\r\n')) { s.end(); res(Number(got.split(' ')[1]) || 0) } },
          close() { res(Number(got.split(' ')[1]) || 0) },
          error() { res(0) },
        } })
      })
      expect([0, 400, 401, 403, 404]).toContain(status)
    }
    expect(seen).toEqual([])
    expect(stolen).toEqual([])
  })

  test('a turn token stops working when the turn ends; unknown and empty tokens get nothing', async () => {
    const t2 = 'atk2'
    env.db.query("INSERT INTO turns (id, chat_id, user_id, engine) VALUES (?, 'c', 'alice', 'claude-code')").run(t2)
    const k = issueProxyToken(env.db, t2, 'alice')
    expect((await send(oauth.url, k)).status).toBe(200)
    revokeProxyTokens(env.db, t2)
    seen.length = 0
    expect((await send(oauth.url, k)).status).toBe(401)
    expect((await send(oauth.url, 'mpx_' + 'x'.repeat(43))).status).toBe(401)
    expect((await send(oauth.url, REAL)).status).toBe(401) // the real token itself is not a turn token
    expect((await fetch(oauth.url + '/v1/messages', { method: 'POST', body: body() })).status).toBe(401)
    expect(seen).toEqual([])
  })

  test('the model service address must be HTTPS (plain HTTP only on this Mac, for tests)', () => {
    const parse = (u: string) => AppConfigFile.safeParse({ engine: { modelUpstream: u } }).success
    expect(parse('https://api.anthropic.com')).toBe(true)
    expect(parse('http://127.0.0.1:19178')).toBe(true)
    expect(parse('http://localhost:19178')).toBe(true)
    expect(parse('http://api.anthropic.com')).toBe(false)
    expect(parse('http://10.0.0.5:8080')).toBe(false)
    expect(parse('ftp://127.0.0.1')).toBe(false)
    expect(parse('https://user:pw@api.anthropic.com')).toBe(false)
  })
})
