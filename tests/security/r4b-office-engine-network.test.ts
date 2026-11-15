// Security regression, round 4b (finding 1, medium, and the way out of the high finding 8): office engines run with
// the Mac user's own Claude login (engine.sb LOCAL_LOGIN=1), and the profile let them reach ANY address on tcp/443 and
// udp/53: the internet, the office LAN's chart server or NAS, DNS names as a channel. Fixed: office mode starts the
// local proxy (CONNECT only, no Claude credential in it), every Claude turn gets HTTPS_PROXY with a per-turn token,
// and with PROXY_PORT set the profile allows no network but that port (no :443, no DNS, no mDNSResponder / trustd).
// The proxy opens tunnels for a running Claude turn's own processes to platform.claude.com:443 only (the OAuth refresh
// of Claude Code; WebSearch runs at Anthropic). Since TC-359 api.anthropic.com is not tunnelled: model requests go to the
// proxy's HTTP path, which checks every body (r4b-office-body-check.test.ts). Dev (no proxy) unchanged.
// Part 3 drives the real office engine core (startLocalCore: sandboxed launcher + proxy) with the scripted engine on a
// fake HOME (the after-turn ~/.claude.json cleanup runs on it, never on the real one).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { makeEnv, WORK } from '../lib/env'
import { localLoginBox, sbAvailable, type LocalLoginBox } from '../lib/sb-local-login'
import { issueProxyToken, startModelProxy } from '../../server/src/proxy/model-proxy'
import { CLAUDE_CONNECT_HOSTS } from '../../server/src/proxy/connect'
import { ask, FAKE_ENGINE_TS, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { officeLoginProxy } from '../../server/src/context'
import { resolveLayout } from '../../server/src/system/layout'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')

/** raw CONNECT through the proxy; returns the status line */
function connect(port: number, target: string, auth: string | null): Promise<string> {
  return new Promise((res) => {
    const c = net.connect(port, '127.0.0.1')
    let b = ''
    c.on('connect', () => c.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth ? `Proxy-Authorization: Basic ${Buffer.from(auth).toString('base64')}\r\n` : ''}\r\n`))
    c.on('data', (x) => { b += x.toString(); if (b.includes('\r\n\r\n')) { c.destroy(); res(b.split('\r\n')[0]!) } })
    c.on('error', (e) => res('error ' + e.message))
    c.on('close', () => res(b.split('\r\n')[0] || 'closed'))
  })
}

// ---------------------------------------------------------------------------------------------------------------
describe.skipIf(!sbAvailable)('1. engine.sb LOCAL_LOGIN=1 with the proxy port: no network but the proxy', () => {
  let box: LocalLoginBox
  beforeAll(() => { box = localLoginBox('mycel-r4b-net-') })
  afterAll(() => box?.close())
  const PORT = 47999
  test('office (PROXY_PORT set): no tcp :443 to any address, no DNS; the proxy port is open', () => {
    // exit 1 = EPERM from the sandbox; 0 = the connect reached the network stack (nothing listens here: refused)
    expect(box.run('c_me', { proxyPort: PORT }, 'net', '127.0.0.1', '443')).toBe(1) // was 0
    expect(box.run('c_me', { proxyPort: PORT }, 'net', '127.0.0.2', '443')).toBe(1) // was 0 (any address)
    expect(box.run('c_me', { proxyPort: PORT }, 'udp', '127.0.0.1', '53')).toBe(1) // was 0
    expect(box.run('c_me', { proxyPort: PORT }, 'unix', '/private/var/run/mDNSResponder')).not.toBe(0) // was 0
    expect(box.run('c_me', { proxyPort: PORT }, 'net', '127.0.0.1', String(PORT))).toBe(0)
    expect(box.run('c_me', { proxyPort: PORT }, 'net', '127.0.0.1', String(PORT + 1))).toBe(1)
  })
  test('dev (PROXY_PORT=0, the owner\'s own machine): direct HTTPS as before', () => {
    expect(box.run('c_me', {}, 'net', '127.0.0.1', '443')).toBe(0)
    expect(box.run('c_me', {}, 'udp', '127.0.0.1', '53')).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------------------------
describe('2. the proxy\'s CONNECT for Claude turns: the Claude hosts only', () => {
  const env = makeEnv('r4b-connect')
  const db = env.db
  db.query("INSERT INTO turns (id, chat_id, user_id, engine, status) VALUES ('cl1', 'c', 'alice', 'claude-code', 'running')").run()
  db.query("INSERT INTO turns (id, chat_id, user_id, engine, status) VALUES ('cl2', 'c', 'alice', 'claude-code', 'done')").run()
  db.query("INSERT INTO turns (id, chat_id, user_id, engine, status) VALUES ('cx1', 'c', 'alice', 'codex', 'running')").run()
  const sessions: Record<string, number> = { cl1: 4242, cx1: 4343 }
  let peer: number | null = 4242
  const echo = net.createServer((c) => c.on('data', (d) => c.write(d)).on('error', () => {}))
  const dialed: string[] = []
  let office: Awaited<ReturnType<typeof startModelProxy>>
  let prod: Awaited<ReturnType<typeof startModelProxy>>
  beforeAll(async () => {
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()))
    const dial = (host: string, port: number) => { dialed.push(`${host}:${port}`); return net.connect((echo.address() as net.AddressInfo).port, '127.0.0.1') }
    const base = { dial, turnSession: (t: string) => sessions[t] ?? null, peerSession: async () => peer }
    office = await startModelProxy({ db, broker: null, connect: { ...base, claudeHosts: CLAUDE_CONNECT_HOSTS } })
    prod = await startModelProxy({ db, broker: null, connect: base })
  })
  afterAll(async () => { await office?.stop(); await prod?.stop(); echo.close() })

  test('a running Claude turn reaches platform.claude.com:443 (the login refresh) and no longer api.anthropic.com', async () => {
    const tok = issueProxyToken(db, 'cl1', 'alice')
    expect(CLAUDE_CONNECT_HOSTS).toEqual(['platform.claude.com:443'])
    expect(await connect(office.port, 'platform.claude.com:443', `turn:${tok}`)).toBe('HTTP/1.1 200 Connection Established')
    // TC-359: a tunnel to the API stays TLS end to end and would skip the body check
    expect(await connect(office.port, 'api.anthropic.com:443', `turn:${tok}`)).toBe('HTTP/1.1 403 Forbidden') // was 200
    expect(dialed).toEqual(['platform.claude.com:443'])
  })

  test('nothing else: other hosts, ports, the office LAN, Codex hosts, a finished turn, another process', async () => {
    const tok = issueProxyToken(db, 'cl1', 'alice')
    for (const h of ['evil.example:443', 'api.anthropic.com:80', '10.0.0.5:443', '192.168.1.10:443', '127.0.0.1:47830', 'chatgpt.com:443', 'claude.ai:443', 'API.ANTHROPIC.COM:443', 'api.anthropic.com:443.evil'])
      expect([h, await connect(office.port, h, `turn:${tok}`)]).toEqual([h, 'HTTP/1.1 403 Forbidden'])
    expect(await connect(office.port, 'platform.claude.com:443', `turn:${issueProxyToken(db, 'cl2', 'alice')}`)).toBe('HTTP/1.1 403 Forbidden')
    expect(await connect(office.port, 'platform.claude.com:443', null)).toMatch(/^HTTP\/1\.1 407/)
    peer = 9999 // a process outside the turn's engine session that read the token from the turn's environment
    expect(await connect(office.port, 'platform.claude.com:443', `turn:${tok}`)).toBe('HTTP/1.1 403 Forbidden')
    peer = 4343
    // a Codex turn keeps its own list (not the Claude hosts)
    expect(await connect(office.port, 'platform.claude.com:443', `turn:${issueProxyToken(db, 'cx1', 'alice')}`)).toBe('HTTP/1.1 403 Forbidden')
    peer = 4242
    expect(dialed).toEqual(['platform.claude.com:443'])
  })

  test('the turn\'s own refused API lookups leave no Activity line; anyone else\'s do', async () => {
    const tok = issueProxyToken(db, 'cl1', 'alice')
    const n = () => (db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'proxy.connect_refused' AND detail LIKE '%api.anthropic.com:443%'").get() as { n: number }).n
    const before = n()
    expect(await connect(office.port, 'api.anthropic.com:443', `turn:${tok}`)).toBe('HTTP/1.1 403 Forbidden')
    expect(n()).toBe(before)
    peer = 9999
    expect(await connect(office.port, 'api.anthropic.com:443', `turn:${tok}`)).toBe('HTTP/1.1 403 Forbidden')
    peer = 4242
    expect(n()).toBe(before + 1)
    // other hosts are always recorded
    const m = (db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'proxy.connect_refused' AND detail LIKE '%evil.example%'").get() as { n: number }).n
    expect(await connect(office.port, 'evil.example:443', `turn:${tok}`)).toBe('HTTP/1.1 403 Forbidden')
    expect((db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'proxy.connect_refused' AND detail LIKE '%evil.example%'").get() as { n: number }).n).toBe(m + 1)
  })

  test('production (no claudeHosts): Claude turns get no tunnel, as before', async () => {
    expect(await connect(prod.port, 'platform.claude.com:443', `turn:${issueProxyToken(db, 'cl1', 'alice')}`)).toBe('HTTP/1.1 403 Forbidden')
  })
})

// ---------------------------------------------------------------------------------------------------------------
describe.skipIf(!sbAvailable)('3. office engine core: model requests through the checked HTTP path, only the refresh tunnels', () => {
  const ENGINE_DIR = path.join(WORK, 'r4b-office-engine')
  const FAKE_HOME = path.join(WORK, 'r4b-office-home')
  const realHome = process.env.HOME
  let h: Harness
  let alice: TestSocket
  let upstream: net.Server
  let connectSpy: ReturnType<typeof spyOn>
  let fetchSpy: ReturnType<typeof spyOn>
  const dialed: string[] = []
  /** what reached the stand-in for api.anthropic.com through the proxy's HTTP path */
  const upstreamSeen: { url: string; auth: string | null; turnHeader: string | null; body: any }[] = []
  async function freePort(): Promise<number> {
    return new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)) }) })
  }
  beforeAll(async () => {
    // Keep the actual allow-list and peer checks, but terminate accepted tunnels at a local stand-in.
    // No test may reach api.anthropic.com, even on an internet-connected developer machine.
    upstream = net.createServer(c => { c.on('error', () => {}); c.end() })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const localPort = (upstream.address() as net.AddressInfo).port
    const connectOriginal = net.connect.bind(net)
    connectSpy = spyOn(net, 'connect').mockImplementation(((...args: any[]) => {
      if (args[0] === 443 && (args[1] === 'api.anthropic.com' || args[1] === 'platform.claude.com')) {
        dialed.push(`${args[1]}:443`)
        return connectOriginal(localPort, '127.0.0.1')
      }
      return (connectOriginal as (...args: any[]) => net.Socket)(...args)
    }) as typeof net.connect)
    // the proxy's HTTP path forwards to https://api.anthropic.com: answered here, never the real one
    const fetchOriginal = globalThis.fetch
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: any, init?: any) => {
      const url = String(input instanceof Request ? input.url : input)
      if (!url.startsWith('https://api.anthropic.com/')) return fetchOriginal(input, init)
      const hd = new Headers(init?.headers)
      upstreamSeen.push({ url, auth: hd.get('authorization'), turnHeader: hd.get('x-mycel-turn'), body: JSON.parse(String(init?.body)) })
      const sse = ['event: message_start', 'data: {"type":"message_start","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":3}}}', '',
        'event: content_block_delta', 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"checked hello"}}', '',
        'event: message_stop', 'data: {"type":"message_stop"}', '', ''].join('\n')
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch)
    // a fake HOME for the server side of the turn (session folder, the after-turn ~/.claude.json cleanup)
    fs.rmSync(FAKE_HOME, { recursive: true, force: true })
    fs.mkdirSync(path.join(FAKE_HOME, '.claude', 'projects'), { recursive: true })
    fs.writeFileSync(path.join(FAKE_HOME, '.claude.json'), '{}')
    process.env.HOME = FAKE_HOME
    fs.rmSync(ENGINE_DIR, { recursive: true, force: true })
    fs.mkdirSync(ENGINE_DIR, { recursive: true })
    fs.copyFileSync(process.execPath, path.join(ENGINE_DIR, 'bun'))
    fs.chmodSync(path.join(ENGINE_DIR, 'bun'), 0o755)
    fs.copyFileSync(FAKE_ENGINE_TS, path.join(ENGINE_DIR, 'fake-engine.ts'))
    fs.writeFileSync(path.join(ENGINE_DIR, 'claude'), `#!${path.join(ENGINE_DIR, 'bun')}\nimport './fake-engine.ts'\n`, { mode: 0o755 })
    h = await startHarness({
      name: 'r4b-office-net', stallTimeoutMs: 60_000,
      realCore: { office: true, engine: { authMode: 'local-login', claudeBin: path.join(ENGINE_DIR, 'claude'), codexBin: '/nonexistent/codex', proxyPort: await freePort() } },
    })
    alice = await h.ws('alice', { windowId: 'win-r4b-net' })
    await alice.next('hello')
  })
  afterAll(async () => {
    alice?.close(); await h?.close(); connectSpy?.mockRestore(); fetchSpy?.mockRestore(); upstream?.close(); process.env.HOME = realHome
  })

  test('office local-login starts the CONNECT proxy; other modes do not', async () => {
    const core = await h.ctx.core()
    expect(core.proxy?.ready).toBe(true)
    expect(officeLoginProxy(h.ctx)?.connect.claudeHosts).toEqual(CLAUDE_CONNECT_HOSTS)
    expect(officeLoginProxy({ ...h.ctx, config: { ...h.ctx.config, office: false } })).toBeNull()
  })

  test('the turn tunnels through the proxy: a host outside the list is refused, a Claude host passes the list', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const r = await ask(h, alice, 'alice', chat.id, fake({ connect: 'evil.example:443' }), { ms: 30_000 })
    expect(r.done.content).toBe('HTTP/1.1 403 Forbidden') // was "error ...": no HTTPS_PROXY, no proxy
    const chat2 = await h.api('alice').call(API.createChat, { body: {} })
    const r2 = await ask(h, alice, 'alice', chat2.id, fake({ connect: '10.0.0.5:443' }), { ms: 30_000 })
    expect(r2.done.content).toBe('HTTP/1.1 403 Forbidden')
    // TC-359: the API host is no longer tunnelled (TLS end to end = no body check)
    const chat3 = await h.api('alice').call(API.createChat, { body: {} })
    const r3 = await ask(h, alice, 'alice', chat3.id, fake({ connect: 'api.anthropic.com:443' }), { ms: 30_000 })
    expect(String(r3.done.content)).toBe('HTTP/1.1 403 Forbidden') // was 200
    // the login refresh host passes the list, and its tunnel ends at the proxy's refresh terminator: nothing is dialled
    // out (the host also answers the Messages API, TC-359)
    const chat4 = await h.api('alice').call(API.createChat, { body: {} })
    const r4 = await ask(h, alice, 'alice', chat4.id, fake({ connect: 'platform.claude.com:443' }), { ms: 30_000 })
    expect(String(r4.done.content)).toBe('HTTP/1.1 200 Connection Established')
    expect(dialed).toEqual([])
    // the turn's token died with the turn
    const toks = h.ctx.db.query('SELECT revoked_at FROM proxy_tokens WHERE turn_id = ?').all(r.started.turnId) as { revoked_at: string | null }[]
    expect(toks.length).toBe(1); expect(toks[0]!.revoked_at).not.toBeNull()
  })

  test('TC-359: a normal model request passes the body check with the engine\'s own login; the proxy token stays here', async () => {
    upstreamSeen.length = 0
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const r = await ask(h, alice, 'alice', chat.id, fake({ model: 'hi' }), { ms: 30_000 })
    expect(String(r.done.content)).toBe('checked hello')
    expect(upstreamSeen.length).toBe(1)
    expect(upstreamSeen[0]!.url).toBe('https://api.anthropic.com/v1/messages?beta=true')
    expect(upstreamSeen[0]!.auth).toBe('Bearer sk-ant-oat01-fake-mac-login') // the engine's login, unchanged
    expect(upstreamSeen[0]!.turnHeader).toBeNull() // the turn's proxy token is not sent on
  })

  test('TC-359: what a taken-over engine asks Anthropic to fetch, run or connect to is refused before it leaves', async () => {
    upstreamSeen.length = 0
    const refused: [string, unknown][] = [
      ['mcp_servers', { mcp_servers: [{ type: 'url', url: 'http://10.0.0.5/mcp', name: 'lan' }] }],
      ['container', { container: 'c1' }],
      ['web_fetch', { tools: [{ type: 'web_fetch_20250910', name: 'web_fetch' }] }],
      ['code execution', { tools: [{ type: 'code_execution_20250825', name: 'code_execution' }] }],
      ['url image', { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'http://192.168.1.10/x.png' } }] }] }],
    ]
    for (const [what, extra] of refused) {
      const chat = await h.api('alice').call(API.createChat, { body: {} })
      const r = await ask(h, alice, 'alice', chat.id, fake({ model: 'hi', modelExtra: extra }), { ms: 30_000 })
      expect([what, r.done.status, r.done.content]).toEqual([what, 'error', ''])
    }
    expect(upstreamSeen).toEqual([]) // nothing reached Anthropic
    // each one refused by the body check, recorded with its reason (was: a TLS tunnel nobody could read)
    const reasons = (h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'proxy.refused' ORDER BY id").all() as { detail: string }[]).map((r) => JSON.parse(r.detail).reason as string)
    expect(reasons).toEqual(['mcp_servers is not allowed', 'container is not allowed', 'tool type web_fetch_20250910 is not allowed',
      'tool type code_execution_20250825 is not allowed', 'image blocks must carry their data inline (no url / file sources)'])
  })

  test('TC-359: the turn trusts the refresh terminator\'s CA from its own folder; the certificate key stays out of reach', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const r = await ask(h, alice, 'alice', chat.id, fake({ exists: '.turn/refresh-ca.pem' }), { ms: 30_000 })
    expect(String(r.done.content)).toContain('true')
    const key = path.join(resolveLayout(h.ctx.config).secretsDir, 'claude-refresh-ca', 'leaf.key')
    expect(fs.existsSync(key)).toBe(true)
    expect(fs.statSync(key).mode & 0o077).toBe(0)
    const chat2 = await h.api('alice').call(API.createChat, { body: {} })
    const r2 = await ask(h, alice, 'alice', chat2.id, fake({ readAbs: key }), { ms: 30_000 })
    expect(String(r2.done.content)).toBe('read=blocked')
  })
})
