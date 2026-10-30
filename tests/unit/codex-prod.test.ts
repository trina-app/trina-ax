// Codex CLI in production. Managed (docs/DECISIONS.md "AI 연결" D9): each turn gets a placeholder login holding only
// its proxy token, the provider "teamax" points at the model proxy, which puts the turn's AI connection's real
// credential on the request; no CONNECT tunnel for Codex turns. Also: the locked catalog next to the engine, the
// CONNECT handler (the ChatGPT sign-in, and the older agent-own tunnels kept for the F1 fallback), and the older
// codex-login / -status / -logout commands of the engine account. Everything here runs without root: the launcher runs
// as the current user; the role-account, sandbox and pf parts are covered by tests/install/g-macos-install.ts (sudo).
import { setSetting } from '../../server/src/admin/settings'
import { SHARED_SUBSCRIPTIONS_KEY } from '../../server/src/credentials/policy'
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { API, ApiError } from '@mycel/shared/api'
import { ask, HARNESS_KEYS, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { credentialsOf, getRow } from '../../server/src/credentials/store'
import { addCred, chatgptSecret } from '../lib/credentials'
import { makeEnv, WORK } from '../lib/env'
import { catalogModels, CODEX_CATALOG_FILE, codexAuthDir, codexCatalogFor, writeLockedCatalog } from '../../server/src/engine/codex'
import { lockCatalog } from '../../scripts/macos/codex-catalog.mjs'
import { issueProxyToken, startModelProxy } from '../../server/src/proxy/model-proxy'
import { CODEX_LOGIN_BOUND, CODEX_LOGIN_PENDING } from '../../server/src/proxy/connect'
import { codexDeviceLogin, codexLoginState, codexLogout, SocketLauncher, startLauncher } from '../../server/src/native'
import { codexCommand, parseDeviceLogin } from '../../server/src/system/codex-login'
import { nativeBinDir } from '../../server/src/config'
import { CODEX_PROD_BETA } from '../../server/src/chat/engines'
import type { AppConfig } from '../../server/src/app-config'

setDefaultTimeout(30_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')

// a local "internet": the proxy's tunnels are dialled here instead of chatgpt.com
const echo = net.createServer((c) => c.on('data', (d) => c.write(d)).on('error', () => {}))
await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()))
const echoPort = (echo.address() as net.AddressInfo).port
const dialed: string[] = []
const dial = (host: string, port: number) => { dialed.push(`${host}:${port}`); return net.connect(echoPort, '127.0.0.1') }
afterAll(() => { echo.close() })

/** raw CONNECT; returns the status line */
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
describe('locked catalog', () => {
  const W = path.join(WORK, 'codex-prod-catalog')
  fs.rmSync(W, { recursive: true, force: true }); fs.mkdirSync(W, { recursive: true })
  const cache = { fetched_at: 'x', models: [
    { slug: 'gpt-x', display_name: 'X', shell_type: 'unified_exec', tool_mode: 'code_mode_only', apply_patch_tool_type: 'freeform', experimental_supported_tools: ['js'], multi_agent_version: 'v2', node_repl_disabled: false, supports_search_tool: true, include_skills_usage_instructions: true },
    { slug: 'gpt-y', display_name: 'Y', shell_type: 'shell', tool_mode: 'direct', visibility: 'hide' },
  ] }
  test('the installer\'s script and the server lock the same way: no shell, direct tools, no apply_patch', () => {
    const src = path.join(W, 'models_cache.json'); fs.writeFileSync(src, JSON.stringify(cache))
    const dst = path.join(W, CODEX_CATALOG_FILE)
    expect(writeLockedCatalog(src, dst)).toEqual(['gpt-x', 'gpt-y'])
    expect(lockCatalog(JSON.parse(JSON.stringify(cache)))).toEqual(JSON.parse(fs.readFileSync(dst, 'utf8')))
    expect(catalogModels(dst)).toEqual(['gpt-x', 'gpt-y'])
    for (const m of JSON.parse(fs.readFileSync(dst, 'utf8')).models) expect(m).toMatchObject({ shell_type: 'disabled', tool_mode: 'direct', apply_patch_tool_type: null, experimental_supported_tools: [], node_repl_disabled: true })
  })
  test('a catalog that would give a model a shell is refused (production reads it, never writes it)', () => {
    const bad = path.join(W, 'bad.json'); fs.writeFileSync(bad, JSON.stringify(cache))
    expect(() => catalogModels(bad)).toThrow(/not locked/)
    expect(() => lockCatalog({ models: [] })).toThrow()
    expect(() => lockCatalog({ models: [{ slug: '--model' }] })).toThrow(/bad model/)
  })
  test('the installer script writes the catalog and refuses to overwrite', () => {
    const out = path.join(W, 'via-script.json')
    const r = Bun.spawnSync([process.execPath, path.resolve(import.meta.dir, '../../scripts/macos/codex-catalog.mjs'), path.join(W, 'models_cache.json'), out])
    expect(r.exitCode).toBe(0)
    expect(JSON.parse(r.stdout.toString())).toEqual(['gpt-x', 'gpt-y'])
    expect((fs.statSync(out).mode & 0o777).toString(8)).toBe('600')
    expect(Bun.spawnSync([process.execPath, path.resolve(import.meta.dir, '../../scripts/macos/codex-catalog.mjs'), path.join(W, 'models_cache.json'), out]).exitCode).not.toBe(0)
  })
  test('the catalog of an installed engine is next to the real file (app/engines/codex/current -> <sha>)', () => {
    const v = path.join(W, 'engines', 'codex', 'abc123'); fs.mkdirSync(v, { recursive: true })
    fs.writeFileSync(path.join(v, 'codex'), '')
    fs.symlinkSync('abc123', path.join(W, 'engines', 'codex', 'current'))
    expect(codexCatalogFor(path.join(W, 'engines', 'codex', 'current', 'codex'))).toBe(path.join(fs.realpathSync(v), CODEX_CATALOG_FILE))
  })
  test('device-auth output: URL and one-time code (ANSI colours removed)', () => {
    const text = "\nWelcome to Codex [v\x1b[90m0.163.0\x1b[0m]\n1. Open this link in your browser and sign in to your account\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94mABCD-EF123\x1b[0m\n"
    expect(parseDeviceLogin(text)).toEqual({ url: 'https://auth.openai.com/codex/device', code: 'ABCD-EF123' })
    expect(parseDeviceLogin('Welcome to Codex [v0.163.0]')).toEqual({ url: null, code: null })
  })
})

// ---------------------------------------------------------------------------------------------------------------
describe('model proxy CONNECT (Codex tunnels)', () => {
  const env = makeEnv('codex-prod-proxy')
  const db = env.db
  db.query("INSERT INTO turns (id, chat_id, user_id, engine, status) VALUES ('cx1', 'c', 'alice', 'codex', 'running')").run()
  db.query("INSERT INTO turns (id, chat_id, user_id, engine, status) VALUES ('cl1', 'c', 'alice', 'claude-code', 'running')").run()
  db.query("INSERT INTO turns (id, chat_id, user_id, engine, status) VALUES ('cx2', 'c', 'alice', 'codex', 'done')").run()
  const sessions: Record<string, number> = { cx1: 4242 }
  let peer: number | null = 4242
  let proxy: Awaited<ReturnType<typeof startModelProxy>>
  beforeAll(async () => {
    // codexTurns: the older agent-own tunnels (F1 fallback); managed Codex turns never tunnel (tested below)
    proxy = await startModelProxy({ db, broker: null, connect: { dial, codexTurns: true, turnSession: (t) => sessions[t] ?? null, peerSession: async () => peer, loginBindWaitMs: 400 } })
  })
  afterAll(async () => { await proxy.stop() })
  const refusals = () => (db.query("SELECT COUNT(*) n FROM audit_log WHERE action = 'proxy.connect_refused'").get() as { n: number }).n

  test('a running Codex turn\'s token tunnels to the allowed hosts; bytes flow both ways', async () => {
    const tok = issueProxyToken(db, 'cx1', 'alice')
    expect(await connect(proxy.port, 'chatgpt.com:443', `turn:${tok}`)).toBe('HTTP/1.1 200 Connection Established')
    expect(await connect(proxy.port, 'auth.openai.com:443', `turn:${tok}`)).toBe('HTTP/1.1 200 Connection Established')
    expect(dialed.slice(-2)).toEqual(['chatgpt.com:443', 'auth.openai.com:443'])
    const got = await new Promise<string>((res) => {
      const c = net.connect(proxy.port, '127.0.0.1')
      let b = ''
      c.on('connect', () => c.write(`CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\nProxy-Authorization: Basic ${Buffer.from(`turn:${tok}`).toString('base64')}\r\n\r\n`))
      c.on('data', (x) => { b += x.toString(); if (b.includes('\r\n\r\n') && !b.includes('ping')) c.write('ping'); if (b.endsWith('ping')) { c.destroy(); res(b) } })
      c.on('error', () => res(b))
      setTimeout(() => { c.destroy(); res(b) }, 5000)
    })
    expect(got.endsWith('\r\n\r\nping')).toBe(true)
  })
  test('refused: no token (407), unknown token (407), revoked token, Claude turn, finished turn, other hosts, other process', async () => {
    const before = refusals()
    expect(await connect(proxy.port, 'chatgpt.com:443', null)).toMatch(/^HTTP\/1\.1 407/)
    expect(await connect(proxy.port, 'chatgpt.com:443', 'turn:mpx_guess_guess_guess')).toMatch(/^HTTP\/1\.1 407/)
    const revoked = issueProxyToken(db, 'cx1', 'alice')
    db.query('UPDATE proxy_tokens SET revoked_at = ? WHERE token_hash = (SELECT token_hash FROM proxy_tokens ORDER BY rowid DESC LIMIT 1)').run(new Date().toISOString())
    expect(await connect(proxy.port, 'chatgpt.com:443', `turn:${revoked}`)).toMatch(/^HTTP\/1\.1 407/)
    expect(await connect(proxy.port, 'chatgpt.com:443', `turn:${issueProxyToken(db, 'cl1', 'alice')}`)).toMatch(/^HTTP\/1\.1 403/)
    expect(await connect(proxy.port, 'chatgpt.com:443', `turn:${issueProxyToken(db, 'cx2', 'alice')}`)).toMatch(/^HTTP\/1\.1 403/)
    const tok = issueProxyToken(db, 'cx1', 'alice')
    for (const h of ['example.com:443', 'chatgpt.com:80', 'api.openai.com:443', '127.0.0.1:19100', 'chatgpt.com:443.evil', 'CHATGPT.COM:443']) expect(await connect(proxy.port, h, `turn:${tok}`)).toMatch(/^HTTP\/1\.1 403/)
    peer = 9999
    expect(await connect(proxy.port, 'chatgpt.com:443', `turn:${tok}`)).toMatch(/^HTTP\/1\.1 403/)
    peer = null
    expect(await connect(proxy.port, 'chatgpt.com:443', `turn:${tok}`)).toMatch(/^HTTP\/1\.1 403/)
    peer = 4242
    expect(refusals() - before).toBe(13)
    const last = db.query("SELECT target, detail FROM audit_log WHERE action = 'proxy.connect_refused' ORDER BY id DESC LIMIT 1").get() as { target: string; detail: string }
    expect(last.target).toBe('cx1'); expect(JSON.parse(last.detail).reason).toMatch(/not part of this turn/)
  })
  test('the engine account\'s login token: accepted only once bound to the login process, from that process', async () => {
    const pending = CODEX_LOGIN_PENDING + 'abc'
    const tok = issueProxyToken(db, pending, 'codex-login-cli')
    expect(await connect(proxy.port, 'auth.openai.com:443', `turn:${tok}`)).toMatch(/^HTTP\/1\.1 403/) // never bound
    const late = connect(proxy.port, 'auth.openai.com:443', `turn:${tok}`)
    await Bun.sleep(100)
    db.query('UPDATE proxy_tokens SET turn_id = ? WHERE turn_id = ?').run(CODEX_LOGIN_BOUND + '4242', pending) // the CLI saw "started"
    expect(await late).toBe('HTTP/1.1 200 Connection Established')
    peer = 7
    expect(await connect(proxy.port, 'auth.openai.com:443', `turn:${tok}`)).toMatch(/^HTTP\/1\.1 403/)
    peer = 4242
  })
  test('the Claude path of a proxy without AI connections answers 503, never forwards', async () => {
    const r = await fetch(proxy.url + '/v1/messages', { method: 'POST', headers: { 'x-api-key': issueProxyToken(db, 'cl1', 'alice', { family: 'anthropic' }), 'content-type': 'application/json' }, body: '{}' })
    expect(r.status).toBe(503)
  })
  test('the Claude path refuses a Codex turn\'s token and the sign-in token; the Codex path a Claude turn\'s token (S-16)', async () => {
    const p = await startModelProxy({ db, broker: null })
    try {
      for (const tok of [issueProxyToken(db, 'cx1', 'alice', { family: 'openai' }), issueProxyToken(db, CODEX_LOGIN_BOUND + '4242', 'codex-login-cli')]) {
        const r = await fetch(p.url + '/v1/messages', { method: 'POST', headers: { 'x-api-key': tok, 'content-type': 'application/json' }, body: '{}' })
        expect(r.status).toBe(403)
      }
      const last = db.query("SELECT detail FROM audit_log WHERE action = 'proxy.refused' ORDER BY id DESC LIMIT 1").get() as { detail: string }
      expect(JSON.parse(last.detail).reason).toBe('not a Claude turn')
      const r = await fetch(p.url + '/codex/chatgpt/responses', { method: 'POST', headers: { authorization: 'Bearer ' + issueProxyToken(db, 'cl1', 'alice', { family: 'anthropic' }), 'content-type': 'application/json' }, body: '{}' })
      expect(r.status).toBe(403)
    } finally { await p.stop() }
  })
  test('managed (no codexTurns): a Codex turn\'s token opens no tunnel at all (S-16); the sign-in token only to auth.openai.com', async () => {
    const p = await startModelProxy({ db, broker: null, connect: { dial, turnSession: (t) => sessions[t] ?? null, peerSession: async () => 4242, loginBindWaitMs: 400 } })
    try {
      const tok = issueProxyToken(db, 'cx1', 'alice', { family: 'openai' })
      for (const h of ['chatgpt.com:443', 'auth.openai.com:443', 'api.openai.com:443']) expect(await connect(p.port, h, `turn:${tok}`)).toMatch(/^HTTP\/1\.1 403/)
      const login = issueProxyToken(db, CODEX_LOGIN_BOUND + '4242', 'codex-login-cli')
      expect(await connect(p.port, 'chatgpt.com:443', `turn:${login}`)).toMatch(/^HTTP\/1\.1 403/)
      expect(await connect(p.port, 'auth.openai.com:443', `turn:${login}`)).toBe('HTTP/1.1 200 Connection Established')
    } finally { await p.stop() }
  })
  test('open tunnels are closed once the token is revoked, the turn stops running, or the proxy stops', async () => {
    db.query("INSERT OR REPLACE INTO turns (id, chat_id, user_id, engine, status) VALUES ('cx3', 'c', 'alice', 'codex', 'running')").run()
    sessions.cx3 = 4242
    const p = await startModelProxy({ db, broker: null, connect: { dial, codexTurns: true, turnSession: (t) => sessions[t] ?? null, peerSession: async () => 4242, sweepMs: 50 } })
    /** an open tunnel; resolves `closed` when the proxy closes it */
    const tunnel = (tok: string) => new Promise<{ status: string; closed: Promise<void> }>((res) => {
      const c = net.connect(p.port, '127.0.0.1')
      let b = ''
      const closed = new Promise<void>((ok) => c.on('close', () => ok()))
      c.on('connect', () => c.write(`CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\nProxy-Authorization: Basic ${Buffer.from(`turn:${tok}`).toString('base64')}\r\n\r\n`))
      c.on('data', (x) => { b += x.toString(); if (b.includes('\r\n\r\n')) res({ status: b.split('\r\n')[0]!, closed }) })
      c.on('error', () => {})
    })
    const within = (pr: Promise<void>, ms: number) => Promise.race([pr.then(() => true), Bun.sleep(ms).then(() => false)])
    try {
      // the turn's token is revoked (turn over): the tunnel goes
      const t1 = issueProxyToken(db, 'cx3', 'alice')
      const a = await tunnel(t1)
      expect(a.status).toBe('HTTP/1.1 200 Connection Established')
      expect(await within(a.closed, 300)).toBe(false) // stays open while the turn runs
      db.query('UPDATE proxy_tokens SET revoked_at = ? WHERE turn_id = ?').run(new Date().toISOString(), 'cx3')
      expect(await within(a.closed, 2000)).toBe(true)
      // the turn is no longer running (token still valid)
      const b = await tunnel(issueProxyToken(db, 'cx3', 'alice'))
      expect(b.status).toBe('HTTP/1.1 200 Connection Established')
      db.query("UPDATE turns SET status = 'done' WHERE id = 'cx3'").run()
      expect(await within(b.closed, 2000)).toBe(true)
      // the proxy stops
      db.query("UPDATE turns SET status = 'running' WHERE id = 'cx3'").run()
      const c = await tunnel(issueProxyToken(db, 'cx3', 'alice'))
      expect(c.status).toBe('HTTP/1.1 200 Connection Established')
      await p.stop()
      expect(await within(c.closed, 2000)).toBe(true)
    } finally { await p.stop().catch(() => {}); db.query("UPDATE turns SET status = 'done' WHERE id = 'cx3'").run() }
  })
  test('a proxy without tunnels refuses CONNECT', async () => {
    const p = await startModelProxy({ db, broker: null })
    expect(await connect(p.port, 'chatgpt.com:443', `turn:${issueProxyToken(db, 'cx1', 'alice')}`)).toMatch(/^HTTP\/1\.1 403/)
    await p.stop()
  })
})

// ---------------------------------------------------------------------------------------------------------------
describe('launcher: codex-status / codex-logout / codex-login, and the admin CLI', () => {
  // short socket paths (macOS: 104 bytes)
  const R = fs.mkdtempSync('/tmp/mycel-cx-')
  const agent = path.join(R, 'agent')
  const authDir = codexAuthDir(agent)
  const bin = path.join(R, 'bin', 'codex')
  const sock = path.join(R, 'l.sock')
  const env = makeEnv('codex-prod-cli')
  let launcher: Awaited<ReturnType<typeof startLauncher>>
  let proxy: Awaited<ReturnType<typeof startModelProxy>>
  let cfg: AppConfig
  beforeAll(async () => {
    fs.mkdirSync(authDir, { recursive: true, mode: 0o700 })
    fs.mkdirSync(path.dirname(bin), { recursive: true })
    fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${path.resolve(import.meta.dir, '../lib/fake-codex-login.ts')}" "$@"\n`, { mode: 0o755 })
    // the proxy first (its port goes to the launcher, which accepts only logins through it)
    const l = new SocketLauncher(sock)
    proxy = await startModelProxy({ db: env.db, broker: null, connect: { dial, peerSession: async (cp, sp) => (await l.tcpPeer(cp, sp))?.sid ?? null } })
    launcher = await startLauncher(nativeBinDir(), { listen: sock, agentRoot: agent, toolsSock: path.join(R, 't.sock'), allowCmds: [bin], codexAuthDir: authDir, proxyPort: proxy.port })
    cfg = { mode: 'prod', dataDir: env.fx.data, engine: { authMode: 'local-login', launcherSock: sock, codexBin: bin, proxyPort: proxy.port } } as unknown as AppConfig
  })
  afterAll(async () => { launcher?.kill(); await proxy?.stop(); fs.rmSync(R, { recursive: true, force: true }) })
  const io = () => { const o = { out: [] as string[], err: [] as string[] }; return { o, io: { out: (l: string) => o.out.push(l), err: (l: string) => o.err.push(l) } } }

  test('status before any login: not signed in; the CLI says so with exit 3', async () => {
    expect(await codexLoginState(sock)).toEqual({ loggedIn: false })
    const { o, io: w } = io()
    expect(await codexCommand('codex-status', cfg, w)).toBe(3)
    expect(JSON.parse(o.out[0]!)).toEqual({ loggedIn: false })
  })
  test('codex-login: prints the URL and the code, the fake CLI tunnels through the proxy as the login process, the login lands in codex-auth', async () => {
    const { o, io: w } = io()
    const code = await codexCommand('codex-login', cfg, w)
    expect(o.err).toEqual([])
    expect(code).toBe(0)
    const text = o.out.join('\n')
    expect(text).toContain('Open https://auth.openai.com/codex/device')
    expect(text).toContain('Enter this one-time code: WXYZ-12AB3')
    expect(text).toContain('Codex is signed in for the engine account.')
    expect(text).not.toMatch(/r-login|access_token|refresh/)
    const st = await codexLoginState(sock)
    expect(st).toMatchObject({ loggedIn: true, accountId: 'acc-login' })
    expect((fs.statSync(path.join(authDir, 'auth.json')).mode & 0o777).toString(8)).toBe('600')
    // the one-time proxy token was bound to the login pid and is revoked now
    const rows = env.db.query("SELECT turn_id, revoked_at FROM proxy_tokens WHERE turn_id LIKE 'codex-login:%'").all() as { turn_id: string; revoked_at: string | null }[]
    expect(rows.length).toBe(1)
    expect(rows[0]!.turn_id.startsWith(CODEX_LOGIN_BOUND)).toBe(true)
    expect(rows[0]!.revoked_at).not.toBeNull()
    expect(dialed.at(-1)).toBe('auth.openai.com:443')
    expect((env.db.query("SELECT detail FROM audit_log WHERE action = 'engine.codex_login'").get() as { detail: string }).detail).toContain('"ok":true')
  })
  test('the launcher refuses a login that does not go through its model proxy, or another program', async () => {
    const bad = await codexDeviceLogin(sock, { cmd: bin, proxy: 'http://turn:abcdefghijklmnopqrst@127.0.0.1:1' }, {})
    expect(bad.message).toMatch(/bad proxy/)
    const other = await codexDeviceLogin(sock, { cmd: '/bin/sh', proxy: `http://turn:abcdefghijklmnopqrst@127.0.0.1:${proxy.port}` }, {})
    expect(other.message).toMatch(/not allowed/)
    // a proxy token nobody bound: the fake CLI is refused by the proxy and the login fails
    const unbound = await codexDeviceLogin(sock, { cmd: bin, proxy: `http://turn:${issueProxyToken(env.db, CODEX_LOGIN_PENDING + 'x', 'cli')}@127.0.0.1:${proxy.port}` }, {})
    expect(unbound.code).toBe(1)
  })
  test('the login folder is never a chat folder', async () => {
    const l = new SocketLauncher(sock)
    const h = l.launch({ op: 'run', turnId: 't1', chatDir: authDir, cmd: bin, args: [], env: {}, token: 'x'.repeat(30), systemPrompt: '', stdin: '', timeoutMs: 5000 })
    let err = ''
    for await (const e of h.events) if (e.ev === 'error') err = e.message
    expect(err).toMatch(/not a chat folder/)
  })
  test('codex-logout removes the login (a link in its place is removed, not followed)', async () => {
    const { o, io: w } = io()
    expect(await codexCommand('codex-logout', cfg, w)).toBe(0)
    expect(JSON.parse(o.out[0]!)).toEqual({ ok: true })
    expect(fs.existsSync(path.join(authDir, 'auth.json'))).toBe(false)
    const victim = path.join(R, 'victim.json'); fs.writeFileSync(victim, '{}')
    fs.symlinkSync(victim, path.join(authDir, 'auth.json'))
    expect(await codexLoginState(sock)).toMatchObject({ loggedIn: false })
    expect((await codexLogout(sock)).ok).toBe(true)
    expect(fs.existsSync(victim)).toBe(true)
    expect(fs.existsSync(path.join(authDir, 'auth.json'))).toBe(false)
  })
  test('the CLI refuses dev mode (the engine uses the owner\'s own login there)', async () => {
    const { o, io: w } = io()
    expect(await codexCommand('codex-login', { ...cfg, mode: 'dev' } as AppConfig, w)).toBe(2)
    expect(o.err[0]).toMatch(/installed server/)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// a fake chatgpt.com / api.openai.com Responses endpoint: records what reached it, answers with SSE
const codexSeen: { path: string; headers: Record<string, string>; body: any }[] = []
const respond = (text: string) => {
  const ev = (o: unknown) => `event: x\ndata: ${JSON.stringify(o)}\n\n`
  return new Response(ev({ type: 'response.created', response: { id: 'r1' } }) + ev({ type: 'response.output_text.delta', delta: text })
    + ev({ type: 'response.completed', response: { id: 'r1', model: 'gpt-5.4', output: [{ type: 'message' }, { type: 'web_search_call' }], usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 200 }, output_tokens: 50 } } }),
  { headers: { 'content-type': 'text/event-stream', 'x-codex-primary-used-percent': '12' } })
}
const codexUp = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
  const u = new URL(req.url)
  let body: any = null
  try { body = await req.json() } catch {}
  codexSeen.push({ path: u.pathname, headers: Object.fromEntries(req.headers), body })
  // Codex's standalone web search: one JSON object whose `output` the model gets
  // (a query "refused-401": the search endpoint refuses the connection's credential, as a restricted API key would)
  if (u.pathname.endsWith('/alpha/search') && body?.commands?.search_query?.[0]?.q === 'refused-401') return Response.json({ error: { message: 'missing scope' } }, { status: 401 })
  if (u.pathname.endsWith('/alpha/search')) return Response.json({ output: `results(${body?.commands?.search_query?.[0]?.q ?? ''})` })
  const prompt = body?.input?.[0]?.content?.[0]?.text ?? ''
  return respond(`answer(${prompt})`)
} })
afterAll(() => { codexUp.stop(true) })

describe('managed Codex turns (fake Codex through the real launcher and the model proxy)', () => {
  let h: Harness
  let alice: TestSocket
  let dana: TestSocket
  const REAL = chatgptSecret('acc-real-123', { access: 'eyJ.REAL-ACCESS.sig', refresh: 'rt-REAL-REFRESH' })
  let chatgptId = ''
  beforeAll(async () => {
    const up = `http://127.0.0.1:${codexUp.port}`
    h = await startHarness({ name: 'codex-prod', askUserTimeoutMs: 3000, turnTimeoutMs: 60_000, proxyDial: dial, upstreams: { chatgpt: up + '/backend-api/codex', openai: up + '/v1', openaiAuth: up } })
    setSetting(h.ctx.db, SHARED_SUBSCRIPTIONS_KEY, true) // explicit shared-subscription fixture, not the product default
    // the team's ChatGPT plan (a subscription comes before the harness's OpenAI key of the same priority)
    chatgptId = addCred(credentialsOf(h.ctx), 'chatgpt', REAL, { label: 'Team ChatGPT', plan: 'pro' })
    alice = await h.ws('alice', { windowId: 'win-alice-cx' }); await alice.next('hello')
    dana = await h.ws('dana', { windowId: 'win-dana-cx' }); await dana.next('hello')
  })
  afterAll(async () => { alice?.close(); dana?.close(); await h?.close() })
  const newChat = (user = 'alice') => h.api(user).call(API.createChat, { body: { engine: 'codex' } })
  const realStrings = [REAL.accessToken, REAL.refreshToken, REAL.idToken, 'acc-real-123', HARNESS_KEYS.openai]

  test('the turn gets a placeholder login (its own proxy token), an empty HOME and the provider at the proxy; no tunnel, nothing stays behind', async () => {
    const chat = await newChat()
    const r = await ask(h, alice, 'alice', chat.id, fake({ echo: 'codexEnv' }))
    const e = JSON.parse(r.done.content)
    const port = (await h.ctx.core()).proxy!.port
    expect(e).toMatchObject({ codexHome: '.codex', authMode: 'chatgpt', turnToken: true, refresh: 'teamax-no-refresh', homeEmpty: true, credStore: true,
      provider: 'teamax', baseUrl: `http://127.0.0.1:${port}/codex/chatgpt`, chatgptBaseUrl: `http://127.0.0.1:${port}/codex/backend/`,
      refreshOverride: `http://127.0.0.1:${port}/codex/oauth/token`, proxyUser: null, proxyHost: null, apiKeyEnv: null })
    expect(e.account).toMatch(/^teamax-[0-9a-f]{12}$/)
    const chatDir = path.join(h.ctx.engineConfig.agentRoot, chat.id)
    expect(fs.existsSync(path.join(chatDir, '.codex'))).toBe(false)
    expect(fs.existsSync(path.join(chatDir, '.home'))).toBe(false)
    const live = h.ctx.db.query('SELECT COUNT(*) n FROM proxy_tokens WHERE turn_id = ? AND revoked_at IS NULL').get(r.started.turnId) as { n: number }
    expect(live.n).toBe(0)
  })
  test('S-1: nothing in the chat folder during the turn holds a real token, refresh token, account id or key', async () => {
    const chat = await newChat()
    const r = await ask(h, alice, 'alice', chat.id, fake({ dumpHome: true }))
    const dump = Buffer.from(r.done.content, 'base64').toString('utf8')
    expect(dump).toContain('.codex/auth.json')
    for (const x of realStrings) expect(dump).not.toContain(x)
  })
  test('S-2: the answer goes through the proxy with the real access token and account; the turn token never leaves; usage counted', async () => {
    codexSeen.length = 0
    const chat = await newChat()
    const r = await ask(h, alice, 'alice', chat.id, fake({ codexModel: 'hi' }))
    expect(r.done.status).toBe('done')
    expect(r.done.content).toBe('answer(hi)')
    expect(codexSeen.length).toBe(1)
    const s0 = codexSeen[0]!
    expect(s0.path).toBe('/backend-api/codex/responses')
    expect(s0.headers.authorization).toBe('Bearer ' + REAL.accessToken)
    expect(s0.headers['chatgpt-account-id']).toBe('acc-real-123')
    expect(s0.body.store).toBe(false)
    expect(JSON.stringify(s0)).not.toContain('mpx_')
    expect(JSON.stringify(s0)).not.toContain('teamax-')
    const t = h.ctx.db.query('SELECT input_tokens, output_tokens, cost_usd, usage_source, credential_id FROM turns WHERE id = ?').get(r.started.turnId) as any
    expect(t).toMatchObject({ input_tokens: 1000, output_tokens: 50, cost_usd: 0, usage_source: 'proxy', credential_id: chatgptId })
  })
  test('web search (QA 2026-10-30 B2): Codex gets its own search, cached only, through the proxy; never in a confidential chat', async () => {
    codexSeen.length = 0
    const chat = await newChat()
    const r = await ask(h, alice, 'alice', chat.id, fake({ codexSearch: 'debian 13 codename' }))
    expect(r.done.status).toBe('done')
    expect(r.done.content).toBe('search=200:results(debian 13 codename)')
    const s0 = codexSeen[0]!
    expect(s0.path).toBe('/backend-api/codex/alpha/search')
    expect(s0.headers.authorization).toBe('Bearer ' + REAL.accessToken)
    expect(s0.body.settings.external_web_access).toBe(false)
    expect(JSON.stringify(s0)).not.toContain('mpx_')
    // the step names the query once the search is done (Codex starts the item without it)
    const step = r.done.steps.find((x) => x.kind === 'web_search')!
    expect(step).toMatchObject({ status: 'ok', label: 'Web search: debian 13 codename' })
    // a confidential chat (Safe operations 1A worked there): the engine starts without search, nothing goes out
    codexSeen.length = 0
    const locked = await newChat()
    h.ctx.db.query('INSERT INTO safe_ops_chats (chat_id, material) VALUES (?, 1)').run(locked.id)
    const l = await ask(h, alice, 'alice', locked.id, fake({ codexSearch: 'debian 13 codename' }))
    expect(l.done.content).toBe('search=off')
    expect(codexSeen).toEqual([])
    expect(l.done.steps.some((x) => x.kind === 'web_search')).toBe(false)
  })
  test('a search the model service refuses fails by itself: a failed step, the connection keeps working, no refresh', async () => {
    codexSeen.length = 0
    const chat = await newChat()
    const r = await ask(h, alice, 'alice', chat.id, fake({ codexSearch: 'refused-401' }))
    expect(r.done.status).toBe('done')
    expect(r.done.content).toBe('search=403')
    // Codex never finishes a failed search's item: it ends with the turn as failed, not as done
    expect(r.done.steps.find((x) => x.kind === 'web_search')).toMatchObject({ status: 'error' })
    expect(codexSeen.map((s) => s.path)).toEqual(['/backend-api/codex/alpha/search'])
    const row = h.ctx.db.query('SELECT status, status_code, limited_until FROM engine_credentials WHERE id = ?').get(chatgptId) as any
    expect(row).toMatchObject({ status: 'ok', status_code: null, limited_until: null })
    const next = await ask(h, alice, 'alice', chat.id, fake({ codexModel: 'after' }))
    expect(next.done.content).toBe('answer(after)')
  })
  test('S-16: a Codex turn can neither tunnel nor use the Claude path', async () => {
    const chat = await newChat()
    const r = await ask(h, alice, 'alice', chat.id, fake({ connect: 'chatgpt.com:443' }, { say: ' | ' }, { claudeCall: true }))
    expect(r.done.content).toBe('HTTP/1.1 403 Forbidden | 403')
  })
  test('an OpenAI API key connection: placeholder "apikey" login, the real key only on the way out, cost at list price', async () => {
    h.ctx.db.query('UPDATE engine_credentials SET disabled = 1 WHERE id = ?').run(chatgptId)
    try {
      codexSeen.length = 0
      const chat = await newChat()
      const e = JSON.parse((await ask(h, alice, 'alice', chat.id, fake({ echo: 'codexEnv' }))).done.content)
      expect(e).toMatchObject({ authMode: 'apikey', turnToken: true })
      expect(e.baseUrl).toContain('/codex/openai')
      const r = await ask(h, alice, 'alice', chat.id, fake({ codexModel: 'k' }))
      expect(r.done.content).toBe('answer(k)')
      expect(codexSeen[0]!.path).toBe('/v1/responses')
      expect(codexSeen[0]!.headers.authorization).toBe('Bearer ' + HARNESS_KEYS.openai)
      expect(codexSeen[0]!.headers['chatgpt-account-id']).toBeUndefined()
      const t = h.ctx.db.query('SELECT cost_usd FROM turns WHERE id = ?').get(r.started.turnId) as any
      // gpt-5.4: 800 uncached x 2.5 + 200 cached x 0.25 + 50 out x 15, per million, + 1 web search ($10 / 1000)
      expect(t.cost_usd).toBeCloseTo((800 * 2.5 + 200 * 0.25 + 50 * 15) / 1e6 + 0.01, 8)
    } finally { h.ctx.db.query('UPDATE engine_credentials SET disabled = 0 WHERE id = ?').run(chatgptId) }
  })
  test('a Codex folder left in a chat folder (launcher crash) is gone before a turn of another engine starts there', async () => {
    const chat = await newChat()
    await ask(h, alice, 'alice', chat.id, fake({ say: 'codex first' }))
    const chatDir = path.join(h.ctx.engineConfig.agentRoot, chat.id)
    fs.mkdirSync(path.join(chatDir, '.codex'), { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(chatDir, '.codex', 'auth.json'), '{"auth_mode":"chatgpt"}', { mode: 0o600 })
    await h.api('alice').call(API.updateChat, { params: { id: chat.id }, body: { engine: 'claude-code' } })
    const r = await ask(h, alice, 'alice', chat.id, fake({ exists: '.codex/auth.json' }))
    expect(r.done.content).toBe('false')
    expect(fs.existsSync(path.join(chatDir, '.codex'))).toBe(false)
  })
  test('without a Codex connection the answer says there is none (no crash, no engine run)', async () => {
    h.ctx.db.query("UPDATE engine_credentials SET disabled = 1 WHERE kind IN ('chatgpt','openai-api-key')").run()
    try {
      const chat = await newChat()
      const r = await ask(h, alice, 'alice', chat.id, fake({ say: 'never' }))
      expect(r.done.status).toBe('error')
      expect(r.done.error?.code).toBe('engine_unavailable')
      expect(r.done.error?.message).toMatch(/no AI connection/i)
      expect(r.done.content).toBe('')
    } finally { h.ctx.db.query('UPDATE engine_credentials SET disabled = 0').run() }
  })
  test('production: Codex is no longer beta (CODEX_PROD_BETA off): every member may use it and it may be the team default', async () => {
    expect(CODEX_PROD_BETA).toBe(false)
    const cfg = h.ctx.config as { mode: 'dev' | 'prod' }
    cfg.mode = 'prod'
    try {
      const a = await ask(h, alice, 'alice', (await newChat()).id, fake({ say: 'member ok' }))
      expect(a.done.content).toBe('member ok')
      const r = await h.api('dana').call(API.updateEngines, { body: { defaultEngine: 'codex' } })
      expect(r.defaultEngine).toBe('codex')
      await h.api('dana').call(API.updateEngines, { body: { defaultEngine: 'claude-code' } })
    } finally { cfg.mode = 'dev' }
  })
  test('the real ChatGPT login stays only in the database, encrypted (sanity)', () => {
    const row = getRow(h.ctx.db, chatgptId)!
    for (const x of realStrings.slice(0, 3)) expect(row.secret_enc).not.toContain(x)
  })
})

// ---------------------------------------------------------------------------------------------------------------
describe('production engine core: connects to the launcher daemon and opens the model proxy on the configured port', () => {
  test('startLocalCore (prod, managed) starts the gate and the proxy (CONNECT answered), with no AI connection', async () => {
    const env = makeEnv('codex-prod-core')
    env.db.close()
    const R = fs.mkdtempSync('/tmp/mycel-cc-')
    const sock = path.join(R, 'l.sock')
    const launcher = await startLauncher(nativeBinDir(), { listen: sock, agentRoot: path.join(R, 'agent'), toolsSock: path.join(R, 'run', 'tools.sock'), allowCmds: ['/bin/sh'], codexAuthDir: path.join(R, 'agent', 'codex-auth') })
    const port = 19730
    const config = {
      mode: 'prod', configFile: null, listen: { host: '127.0.0.1', port: 0 }, tls: null, publicOrigins: [], teamRoot: env.fx.team, dataDir: env.fx.data, logDir: null, logLevel: 'error',
      engine: { authMode: 'managed', runDir: path.join(R, 'run'), agentRoot: path.join(R, 'agent'), launcherSock: sock, proxyPort: port },
      relay: { url: null, teamName: null }, update: { channel: 'stable', feedUrl: null }, validateResponses: false, setupToken: null,
    } as AppConfig
    const { createContext } = await import('../../server/src/context')
    const { openDb } = await import('../../server/src/db')
    const { silentLogger } = await import('../../server/src/log')
    const ctx = createContext({ config, db: openDb(path.join(env.fx.data, 'app.db')), log: silentLogger })
    try {
      const core = await ctx.core()
      expect(core.proxy?.port).toBe(port)
      expect(await connect(port, 'chatgpt.com:443', null)).toMatch(/^HTTP\/1\.1 407/)
      expect(await codexLoginState(sock)).toEqual({ loggedIn: false })
    } finally {
      await ctx.close()
      launcher.kill()
      fs.rmSync(R, { recursive: true, force: true })
    }
  })
})
