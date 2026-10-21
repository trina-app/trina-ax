// Security regression, round 4b (finding 1, medium, and the way out of the high finding 8): office engines run with
// the Mac user's own Claude login (engine.sb LOCAL_LOGIN=1), and the profile let them reach ANY address on tcp/443 and
// udp/53: the internet, the office LAN's chart server or NAS, DNS names as a channel. Fixed: office mode starts the
// local proxy (CONNECT only, no Claude credential in it), every Claude turn gets HTTPS_PROXY with a per-turn token,
// and with PROXY_PORT set the profile allows no network but that port (no :443, no DNS, no mDNSResponder / trustd).
// The proxy opens tunnels for a running Claude turn's own processes to api.anthropic.com:443 and platform.claude.com:443
// only (the API and the OAuth refresh of Claude Code 2.1.306; WebSearch runs at Anthropic). Dev (no proxy) unchanged.
// Part 3 drives the real office engine core (startLocalCore: sandboxed launcher + proxy) with the scripted engine on a
// fake HOME (the after-turn ~/.claude.json cleanup runs on it, never on the real one).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
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
    office = await startModelProxy({ db, upstream: null, connect: { ...base, claudeHosts: CLAUDE_CONNECT_HOSTS } })
    prod = await startModelProxy({ db, upstream: null, connect: base })
  })
  afterAll(async () => { await office?.stop(); await prod?.stop(); echo.close() })

  test('a running Claude turn reaches api.anthropic.com:443 and platform.claude.com:443', async () => {
    const tok = issueProxyToken(db, 'cl1', 'alice')
    expect(CLAUDE_CONNECT_HOSTS).toEqual(['api.anthropic.com:443', 'platform.claude.com:443'])
    expect(await connect(office.port, 'api.anthropic.com:443', `turn:${tok}`)).toBe('HTTP/1.1 200 Connection Established') // was 403
    expect(await connect(office.port, 'platform.claude.com:443', `turn:${tok}`)).toBe('HTTP/1.1 200 Connection Established')
    expect(dialed).toEqual(['api.anthropic.com:443', 'platform.claude.com:443'])
  })

  test('nothing else: other hosts, ports, the office LAN, Codex hosts, a finished turn, another process', async () => {
    const tok = issueProxyToken(db, 'cl1', 'alice')
    for (const h of ['evil.example:443', 'api.anthropic.com:80', '10.0.0.5:443', '192.168.1.10:443', '127.0.0.1:47830', 'chatgpt.com:443', 'claude.ai:443', 'API.ANTHROPIC.COM:443', 'api.anthropic.com:443.evil'])
      expect([h, await connect(office.port, h, `turn:${tok}`)]).toEqual([h, 'HTTP/1.1 403 Forbidden'])
    expect(await connect(office.port, 'api.anthropic.com:443', `turn:${issueProxyToken(db, 'cl2', 'alice')}`)).toBe('HTTP/1.1 403 Forbidden')
    expect(await connect(office.port, 'api.anthropic.com:443', null)).toMatch(/^HTTP\/1\.1 407/)
    peer = 9999 // a process outside the turn's engine session that read the token from the turn's environment
    expect(await connect(office.port, 'api.anthropic.com:443', `turn:${tok}`)).toBe('HTTP/1.1 403 Forbidden')
    peer = 4343
    // a Codex turn keeps its own list (not the Claude hosts)
    expect(await connect(office.port, 'api.anthropic.com:443', `turn:${issueProxyToken(db, 'cx1', 'alice')}`)).toBe('HTTP/1.1 403 Forbidden')
    peer = 4242
    expect(dialed).toEqual(['api.anthropic.com:443', 'platform.claude.com:443'])
  })

  test('production (no claudeHosts): Claude turns get no tunnel, as before', async () => {
    expect(await connect(prod.port, 'api.anthropic.com:443', `turn:${issueProxyToken(db, 'cl1', 'alice')}`)).toBe('HTTP/1.1 403 Forbidden')
  })
})

// ---------------------------------------------------------------------------------------------------------------
describe.skipIf(!sbAvailable)('3. office engine core: a Claude turn gets HTTPS_PROXY and only the Claude hosts', () => {
  const ENGINE_DIR = path.join(WORK, 'r4b-office-engine')
  const FAKE_HOME = path.join(WORK, 'r4b-office-home')
  const realHome = process.env.HOME
  let h: Harness
  let alice: TestSocket
  async function freePort(): Promise<number> {
    return new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)) }) })
  }
  beforeAll(async () => {
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
      name: 'r4b-office-net', turnTimeoutMs: 60_000,
      realCore: { office: true, engine: { authMode: 'local-login', claudeBin: path.join(ENGINE_DIR, 'claude'), codexBin: '/nonexistent/codex', proxyPort: await freePort() } },
    })
    alice = await h.ws('alice', { windowId: 'win-r4b-net' })
    await alice.next('hello')
  })
  afterAll(async () => { alice?.close(); await h?.close(); process.env.HOME = realHome })

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
    // the allow-list passes (200 with a network, 502 without one): not refused
    const chat3 = await h.api('alice').call(API.createChat, { body: {} })
    const r3 = await ask(h, alice, 'alice', chat3.id, fake({ connect: 'api.anthropic.com:443' }), { ms: 30_000 })
    expect(String(r3.done.content)).toMatch(/^HTTP\/1\.1 (200|502) /)
    // the turn's token died with the turn
    const toks = h.ctx.db.query('SELECT revoked_at FROM proxy_tokens WHERE turn_id = ?').all(r.started.turnId) as { revoked_at: string | null }[]
    expect(toks.length).toBe(1); expect(toks[0]!.revoked_at).not.toBeNull()
  })
})
