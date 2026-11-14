// Security regression TC-359 (office mode with the Mac user's own Claude login). Office Claude turns reached
// api.anthropic.com through a CONNECT tunnel that stays TLS end to end, so the model proxy never saw a request body:
// mcp_servers, code execution, web_fetch or a URL image (Anthropic fetching or connecting to an address for a taken-over
// engine) went through unchecked, and so did the tool lockdown and the budget. Now the office proxy has the Claude HTTP
// path too (`ownLogin`): the engine sends its model requests in plain HTTP to the proxy with its own login and the
// turn's proxy token in a header; the proxy runs the same checks as managed mode (Linux) and forwards to the fixed
// upstream with the engine's login, never with the turn token. CONNECT keeps only the login refresh host
// (r4b-office-engine-network.test.ts), and since that host answers the Messages API too, its tunnel ends at a local
// TLS listener (the refresh terminator) that passes POST /v1/oauth/token with a refresh_token grant and nothing else.
// This file drives the proxy directly (no sandbox: runs in CI too).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import tls from 'node:tls'
import { execFileSync } from 'node:child_process'
import { refreshCertificates, startRefreshTerminator, REFRESH_HOST, type RefreshTerminator } from '../../server/src/proxy/refresh-terminator'
import { makeEnv } from '../lib/env'
import { issueProxyToken, OWN_LOGIN_TURN_HEADER, OWN_LOGIN_UPSTREAM, startModelProxy, type ProxyTurnEvent } from '../../server/src/proxy/model-proxy'
import { CLAUDE_CONNECT_HOSTS } from '../../server/src/proxy/connect'
import { ownLoginEnv } from '../../server/src/engine/claude'

const env = makeEnv('r4b-office-body-check')
const db = env.db
db.query("INSERT INTO turns (id, chat_id, user_id, engine, status) VALUES ('t1', 'c', 'alice', 'claude-code', 'running')").run()
const LOGIN = 'sk-ant-oat01-stand-in-mac-login'

const seen: { path: string; headers: Record<string, string>; body: any }[] = []
let upstreamStatus = 200
const upstream = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  async fetch(req) {
    seen.push({ path: new URL(req.url).pathname + new URL(req.url).search, headers: Object.fromEntries(req.headers), body: await req.json().catch(() => null) })
    if (upstreamStatus !== 200) return new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'expired' } }), { status: upstreamStatus, headers: { 'content-type': 'application/json' } })
    return Response.json({ id: 'm', type: 'message', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } })
  },
})
let peerOk = true
const events: ProxyTurnEvent[] = []
let office: Awaited<ReturnType<typeof startModelProxy>>
let plain: Awaited<ReturnType<typeof startModelProxy>>
beforeAll(async () => {
  const common = { db, broker: null, peerCheck: async () => peerOk, onTurnEvent: (_t: string, ev: ProxyTurnEvent) => { events.push(ev) } }
  office = await startModelProxy({ ...common, ownLogin: { upstream: `http://127.0.0.1:${upstream.port}` } })
  plain = await startModelProxy(common)
})
afterAll(async () => { await office?.stop(); await plain?.stop(); upstream.stop(true) })

const tokenFor = (tools = { agent: false, webSearch: true, team: ['read'] }) => issueProxyToken(db, 't1', 'alice', { family: 'anthropic', tools })
async function send(port: number, body: Record<string, unknown>, headers: Record<string, string>) {
  const r = await fetch(`http://127.0.0.1:${port}/v1/messages?beta=true`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...headers },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }], ...body }),
  })
  return { status: r.status, text: await r.text() }
}

describe('TC-359: the office proxy checks every model request body', () => {
  test('a normal request goes on with the engine\'s own login; the turn token is not sent upstream', async () => {
    seen.length = 0
    const tok = tokenFor()
    const r = await send(office.port, { tools: [{ name: 'mcp__team__read', input_schema: { type: 'object' } }, { type: 'web_search_20250305', name: 'web_search' }] },
      { authorization: `Bearer ${LOGIN}`, [OWN_LOGIN_TURN_HEADER]: tok, 'anthropic-beta': 'oauth-2025-04-20' })
    expect(r.status).toBe(200)
    expect(seen.length).toBe(1)
    expect(seen[0]!.path).toBe('/v1/messages?beta=true')
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${LOGIN}`)
    expect(seen[0]!.headers[OWN_LOGIN_TURN_HEADER]).toBeUndefined()
    expect(JSON.stringify(seen[0]!.headers)).not.toContain(tok)
    expect(seen[0]!.headers['anthropic-beta']).toBe('oauth-2025-04-20')
  })

  test('an API key login goes on as x-api-key (and only that)', async () => {
    seen.length = 0
    const r = await send(office.port, {}, { 'x-api-key': 'sk-ant-api03-stand-in', [OWN_LOGIN_TURN_HEADER]: tokenFor() })
    expect(r.status).toBe(200)
    expect(seen[0]!.headers['x-api-key']).toBe('sk-ant-api03-stand-in')
    expect(seen[0]!.headers.authorization).toBeUndefined()
  })

  test('mcp_servers, code execution, server tools that fetch, URL sources: refused before anything leaves', async () => {
    seen.length = 0
    const bad: Record<string, unknown>[] = [
      { mcp_servers: [{ type: 'url', url: 'http://10.0.0.5/mcp', name: 'lan' }] },
      { container: 'c1' },
      { tools: [{ type: 'web_fetch_20250910', name: 'web_fetch' }] },
      { tools: [{ type: 'code_execution_20250825', name: 'code_execution' }] },
      { tools: [{ type: 'mcp_toolset', mcp_server_name: 'lan' }] },
      { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'http://192.168.1.10/a.png' } }] }] },
      { messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'url', url: 'http://nas.local/x.pdf' } }] }] },
      { messages: [{ role: 'assistant', content: [{ type: 'server_tool_use', id: 's', name: 'web_fetch', input: { url: 'http://10.0.0.5' } }] }] },
    ]
    for (const b of bad) {
      const r = await send(office.port, b, { authorization: `Bearer ${LOGIN}`, [OWN_LOGIN_TURN_HEADER]: tokenFor() })
      expect([Object.keys(b)[0], r.status, r.text.includes('refused by the team server')]).toEqual([Object.keys(b)[0], 403, true])
    }
    // only the Messages API paths
    const other = await fetch(`http://127.0.0.1:${office.port}/v1/files`, { method: 'POST', headers: { authorization: `Bearer ${LOGIN}`, [OWN_LOGIN_TURN_HEADER]: tokenFor() }, body: '{}' })
    expect(other.status).toBe(403)
    expect(seen).toEqual([])
  })

  test('the tool lockdown holds: a tool outside the turn\'s list stops the answer', async () => {
    seen.length = 0; events.length = 0
    const r = await send(office.port, { tools: [{ name: 'Bash', input_schema: { type: 'object' } }] }, { authorization: `Bearer ${LOGIN}`, [OWN_LOGIN_TURN_HEADER]: tokenFor() })
    expect(r.status).toBe(403)
    expect(events.some((e) => e.type === 'lockdown')).toBe(true)
    expect(seen).toEqual([])
  })

  test('the turn token comes only from its header: the login header is never taken as one; another process is refused', async () => {
    seen.length = 0
    const tok = tokenFor()
    // a valid turn token in Authorization (where managed mode reads it) is not accepted here
    expect((await send(office.port, {}, { authorization: `Bearer ${tok}` })).status).toBe(401)
    expect((await send(office.port, {}, { authorization: `Bearer ${LOGIN}`, [OWN_LOGIN_TURN_HEADER]: 'mpx_wrong' })).status).toBe(401)
    // no login at all, or two kinds at once
    expect((await send(office.port, {}, { [OWN_LOGIN_TURN_HEADER]: tok })).status).toBe(401)
    expect((await send(office.port, {}, { authorization: `Bearer ${LOGIN}`, 'x-api-key': 'k', [OWN_LOGIN_TURN_HEADER]: tok })).status).toBe(401)
    peerOk = false // a process outside the turn's engine session that read the token from the turn's environment
    expect((await send(office.port, {}, { authorization: `Bearer ${LOGIN}`, [OWN_LOGIN_TURN_HEADER]: tok })).status).toBe(403)
    peerOk = true
    expect(seen).toEqual([])
  })

  test('an expired login comes back as it came (Claude Code refreshes by itself); no connection event', async () => {
    events.length = 0; upstreamStatus = 401
    try {
      expect((await send(office.port, {}, { authorization: `Bearer ${LOGIN}`, [OWN_LOGIN_TURN_HEADER]: tokenFor() })).status).toBe(401)
    } finally { upstreamStatus = 200 }
    expect(events.filter((e) => e.type === 'credential')).toEqual([])
  })

  test('without ownLogin a proxy with no AI connection still has no Claude path (503)', async () => {
    expect((await send(plain.port, {}, { authorization: `Bearer ${tokenFor()}` })).status).toBe(503)
  })

  test('the office settings: real upstream, only the refresh host tunnels, the engine is pointed at the proxy', () => {
    expect(OWN_LOGIN_UPSTREAM).toBe('https://api.anthropic.com')
    expect(CLAUDE_CONNECT_HOSTS).toEqual(['platform.claude.com:443'])
    expect(ownLoginEnv({ port: 47831, token: 'mpx_t' })).toEqual({
      HTTPS_PROXY: 'http://turn:mpx_t@127.0.0.1:47831', NO_PROXY: '127.0.0.1,localhost',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:47831', ANTHROPIC_CUSTOM_HEADERS: `${OWN_LOGIN_TURN_HEADER}: mpx_t`,
    })
  })
})

// ---------------------------------------------------------------------------------------------------------------
describe('TC-359: the refresh host\'s tunnel ends at the refresh terminator', () => {
  const refreshSeen: { path: string; body: string }[] = []
  const refreshUp = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    refreshSeen.push({ path: new URL(req.url).pathname, body: await req.text() })
    return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 28800 })
  } })
  const dir = path.join(env.fx.base, 'refresh-ca')
  let term: RefreshTerminator
  let proxy: Awaited<ReturnType<typeof startModelProxy>>
  beforeAll(async () => {
    term = startRefreshTerminator({ db, dir, upstream: `http://127.0.0.1:${refreshUp.port}` })
    proxy = await startModelProxy({ db, broker: null, ownLogin: {}, connect: { claudeHosts: CLAUDE_CONNECT_HOSTS, terminate: { hosts: CLAUDE_CONNECT_HOSTS, dial: term.dial } } })
  })
  afterAll(async () => { await proxy?.stop(); term?.stop(); refreshUp.stop(true) })

  /** CONNECT platform.claude.com:443 as the turn, TLS with the engine's trust (the terminator's CA), one request */
  async function through(method: string, p: string, body: string, ct = 'application/json'): Promise<string> {
    const raw = net.connect(proxy.port, '127.0.0.1')
    await new Promise((r) => raw.once('connect', r))
    raw.write(`CONNECT ${REFRESH_HOST}:443 HTTP/1.1\r\nProxy-Authorization: Basic ${Buffer.from('turn:' + tokenFor()).toString('base64')}\r\n\r\n`)
    const head = await new Promise<string>((r) => raw.once('data', (d) => r(d.toString())))
    expect(head.split('\r\n')[0]).toBe('HTTP/1.1 200 Connection Established')
    const s = tls.connect({ socket: raw, servername: REFRESH_HOST, ca: term.caPem })
    await new Promise((r, j) => { s.once('secureConnect', r); s.once('error', j) })
    s.write(`${method} ${p} HTTP/1.1\r\nHost: ${REFRESH_HOST}\r\nContent-Type: ${ct}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`)
    // the whole answer (headers + Content-Length bytes); Bun 1.3.12 does not close after "Connection: close"
    let b = ''
    await new Promise<void>((r) => {
      const done = () => { const i = b.indexOf('\r\n\r\n'); const n = Number(/content-length: *(\d+)/i.exec(b)?.[1] ?? NaN); return i >= 0 && Buffer.byteLength(b.slice(i + 4)) >= n }
      s.on('data', (d) => { b += d; if (done()) r() })
      s.on('close', () => r())
    })
    s.destroy()
    return b
  }

  test('the refresh goes on to the host and its answer comes back', async () => {
    refreshSeen.length = 0
    const r = await through('POST', '/v1/oauth/token', JSON.stringify({ grant_type: 'refresh_token', refresh_token: 'old', client_id: 'cli' }))
    expect(r.split('\r\n')[0]).toBe('HTTP/1.1 200 OK')
    expect(r).toContain('new-access')
    expect(refreshSeen).toEqual([{ path: '/v1/oauth/token', body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: 'old', client_id: 'cli' }) }])
  })

  test('the Messages API on the same host, other paths and other grants are refused there', async () => {
    refreshSeen.length = 0
    const cases: [string, string, string][] = [
      ['POST', '/v1/messages', JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 5, mcp_servers: [{ type: 'url', url: 'https://evil.example/mcp', name: 'x' }], messages: [] })],
      ['POST', '/v1/messages?beta=true', '{}'],
      ['POST', '/v1/oauth/token', JSON.stringify({ grant_type: 'authorization_code', code: 'c' })],
      ['POST', '/v1/oauth/token?x=1', JSON.stringify({ grant_type: 'refresh_token' })],
      ['GET', '/v1/oauth/token', ''],
      ['GET', '/api/oauth/profile', ''],
    ]
    for (const [m, p, b] of cases) expect([m, p, (await through(m, p, b)).split('\r\n')[0]]).toEqual([m, p, 'HTTP/1.1 403 Forbidden'])
    expect(refreshSeen).toEqual([])
  })

  test('certificates: made on this Mac, owner-only files, no CA key kept, the leaf names only the refresh host', () => {
    const files = fs.readdirSync(dir).sort()
    expect(files).toEqual(['ca.pem', 'leaf.key', 'leaf.pem'])
    for (const f of files) expect([f, fs.statSync(path.join(dir, f)).mode & 0o077]).toEqual([f, 0])
    const leaf = execFileSync('openssl', ['x509', '-in', path.join(dir, 'leaf.pem'), '-noout', '-text'], { encoding: 'utf8' })
    expect(leaf).toContain(`DNS:${REFRESH_HOST}`)
    expect(leaf.match(/DNS:/g)?.length).toBe(1)
    // kept while fresh, made again when old
    const before = fs.readFileSync(path.join(dir, 'ca.pem'), 'utf8')
    expect(refreshCertificates(dir).caPem).toBe(before)
    expect(refreshCertificates(dir, Date.now() + 400 * 24 * 3600_000).caPem).not.toBe(before)
  })
})
