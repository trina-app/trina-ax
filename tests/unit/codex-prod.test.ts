// Codex CLI in production (engine account, "agent-own"): one login folder (<agent root>/codex-auth) the launcher
// copies into each turn and writes back after a refresh, the locked catalog next to the engine, the model proxy's
// CONNECT tunnel (the only network path of the engine account), the codex-login / -status / -logout commands, and
// the beta gating. Everything here runs without root: the launcher runs as the current user; the role-account,
// sandbox and pf parts are covered by tests/install/g-macos-install.ts (sudo).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { API, ApiError } from '@mycel/shared/api'
import { ask, FAKE_CODEX_AUTH, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { makeEnv, WORK } from '../lib/env'
import { catalogModels, CODEX_CATALOG_FILE, codexAuthDir, codexCatalogFor, writeLockedCatalog } from '../../server/src/engine/codex'
import { lockCatalog } from '../../scripts/macos/codex-catalog.mjs'
import { issueProxyToken, startModelProxy } from '../../server/src/proxy/model-proxy'
import { CODEX_LOGIN_BOUND, CODEX_LOGIN_PENDING } from '../../server/src/proxy/connect'
import { codexDeviceLogin, codexLoginState, codexLogout, SocketLauncher, startLauncher } from '../../server/src/native'
import { codexCommand, parseDeviceLogin } from '../../server/src/system/codex-login'
import { nativeBinDir } from '../../server/src/config'
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
    proxy = await startModelProxy({ db, upstream: null, connect: { dial, turnSession: (t) => sessions[t] ?? null, peerSession: async () => peer, loginBindWaitMs: 400 } })
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
  test('the Claude path of a proxy without a Claude credential answers 503, never forwards', async () => {
    const r = await fetch(proxy.url + '/v1/messages', { method: 'POST', headers: { 'x-api-key': issueProxyToken(db, 'cl1', 'alice'), 'content-type': 'application/json' }, body: '{}' })
    expect(r.status).toBe(503)
  })
  test('a proxy without tunnels refuses CONNECT', async () => {
    const p = await startModelProxy({ db, upstream: null })
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
    proxy = await startModelProxy({ db: env.db, upstream: null, connect: { dial, peerSession: async (cp, sp) => (await l.tcpPeer(cp, sp))?.sid ?? null } })
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
describe('Codex turns of the engine account (fake Codex through the real launcher and proxy)', () => {
  let h: Harness
  let alice: TestSocket
  let dana: TestSocket
  beforeAll(async () => {
    h = await startHarness({ name: 'codex-prod', askUserTimeoutMs: 3000, turnTimeoutMs: 60_000, proxyDial: dial })
    alice = await h.ws('alice', { windowId: 'win-alice-cx' }); await alice.next('hello')
    dana = await h.ws('dana', { windowId: 'win-dana-cx' }); await dana.next('hello')
  })
  afterAll(async () => { alice?.close(); dana?.close(); await h?.close() })
  const authFile = () => path.join(codexAuthDir(h.ctx.engineConfig.agentRoot), 'auth.json')
  const auth = () => JSON.parse(fs.readFileSync(authFile(), 'utf8'))
  const newChat = (user = 'alice') => h.api(user).call(API.createChat, { body: { engine: 'codex' } })

  test('the turn gets a copy of the engine account\'s login, an empty HOME, the proxy and the file credential store; nothing stays behind', async () => {
    const chat = await newChat()
    const r = await ask(h, alice, 'alice', chat.id, fake({ echo: 'codexEnv' }))
    const e = JSON.parse(r.done.content)
    expect(e).toMatchObject({ codexHome: '.codex', account: 'acc-team', homeEmpty: true, proxyUser: 'turn', sslCertFile: '/etc/ssl/cert.pem', credStore: true })
    expect(e.proxyHost).toBe(`127.0.0.1:${(await h.ctx.core()).proxy!.port}`)
    const chatDir = path.join(h.ctx.engineConfig.agentRoot, chat.id)
    expect(fs.existsSync(path.join(chatDir, '.codex'))).toBe(false)
    expect(fs.existsSync(path.join(chatDir, '.home'))).toBe(false)
    // the turn's proxy token is revoked with the turn
    const live = h.ctx.db.query('SELECT COUNT(*) n FROM proxy_tokens WHERE turn_id = ? AND revoked_at IS NULL').get(r.started.turnId) as { n: number }
    expect(live.n).toBe(0)
  })
  test('a tunnel to chatgpt.com works during the turn; other hosts are refused', async () => {
    const chat = await newChat()
    const r = await ask(h, alice, 'alice', chat.id, fake({ connect: 'chatgpt.com:443' }, { say: ' | ' }, { connect: 'example.com:443' }))
    expect(r.done.content).toBe('HTTP/1.1 200 Connection Established | HTTP/1.1 403 Forbidden')
  })
  test('a refreshed login of the same account is written back', async () => {
    const chat = await newChat()
    const before = auth().tokens.refresh_token
    await ask(h, alice, 'alice', chat.id, fake({ refreshAuth: 'acc-team' }))
    const after = auth()
    expect(after.tokens.account_id).toBe('acc-team')
    expect(after.tokens.refresh_token).not.toBe(before)
    expect(after.tokens.refresh_token.startsWith('rt-')).toBe(true)
  })
  test('a login of another account, or a link, is not written back and is audited', async () => {
    const chat = await newChat()
    const before = fs.readFileSync(authFile(), 'utf8')
    await ask(h, alice, 'alice', chat.id, fake({ refreshAuth: 'acc-attacker' }))
    expect(fs.readFileSync(authFile(), 'utf8')).toBe(before)
    const victim = path.join(os.tmpdir(), `mycel-cx-victim-${process.pid}.json`); fs.writeFileSync(victim, JSON.stringify({ tokens: { account_id: 'acc-team', refresh_token: 'stolen' } }))
    await ask(h, alice, 'alice', chat.id, fake({ linkAuth: victim }))
    expect(fs.readFileSync(authFile(), 'utf8')).toBe(before)
    expect(fs.lstatSync(authFile()).isFile()).toBe(true)
    fs.rmSync(victim)
    const notes = (h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'engine.codex_auth'").all() as { detail: string }[]).map((r) => JSON.parse(r.detail).note)
    expect(notes.some((n) => /another ChatGPT account/.test(n))).toBe(true)
    expect(notes.some((n) => /not a plain file|symbolic|too many levels|loop/i.test(n))).toBe(true)
  })
  test('without a login the answer says the AI connection needs the admin (no crash, no retry loop)', async () => {
    const saved = fs.readFileSync(authFile())
    fs.rmSync(authFile())
    try {
      const chat = await newChat()
      const r = await ask(h, alice, 'alice', chat.id, fake({ say: 'never' }))
      expect(r.done.status).toBe('error')
      expect(r.done.error?.code).toBe('engine_unavailable')
      expect(r.done.content).toBe('')
    } finally { fs.writeFileSync(authFile(), saved, { mode: 0o600 }) }
  })
  test('production: Codex is beta — owner only (plus settings.codexUsers), never the team default', async () => {
    const cfg = h.ctx.config as { mode: 'dev' | 'prod' }
    cfg.mode = 'prod'
    try {
      const a = await ask(h, alice, 'alice', (await newChat()).id, fake({ say: 'hi' }))
      expect(a.done.status).toBe('error')
      expect(a.done.error?.code).toBe('forbidden')
      expect(a.done.error?.message).toMatch(/beta/i)
      const d = await ask(h, dana, 'dana', (await newChat('dana')).id, fake({ say: 'owner ok' }))
      expect(d.done.content).toBe('owner ok')
      h.ctx.db.query("INSERT OR REPLACE INTO settings (key, value) VALUES ('codexUsers', ?)").run(JSON.stringify(['alice']))
      const a2 = await ask(h, alice, 'alice', (await newChat()).id, fake({ say: 'picked' }))
      expect(a2.done.content).toBe('picked')
      h.ctx.db.query("DELETE FROM settings WHERE key = 'codexUsers'").run()
      let err: unknown = null
      try { await h.api('dana').call(API.updateEngines, { body: { defaultEngine: 'codex' } }) } catch (e) { err = e }
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).status).toBe(409)
    } finally { cfg.mode = 'dev' }
  })
  test('the fake login stays the harness\'s (sanity)', () => { expect(auth().tokens.account_id).toBe(FAKE_CODEX_AUTH.tokens.account_id) })
})

// ---------------------------------------------------------------------------------------------------------------
describe('production engine core: connects to the launcher daemon and opens the model proxy on the configured port', () => {
  test('startLocalCore (prod) starts the gate and the proxy (CONNECT answered), with no Claude credential', async () => {
    const env = makeEnv('codex-prod-core')
    env.db.close()
    const R = fs.mkdtempSync('/tmp/mycel-cc-')
    const sock = path.join(R, 'l.sock')
    const launcher = await startLauncher(nativeBinDir(), { listen: sock, agentRoot: path.join(R, 'agent'), toolsSock: path.join(R, 'run', 'tools.sock'), allowCmds: ['/bin/sh'], codexAuthDir: path.join(R, 'agent', 'codex-auth') })
    const port = 19730
    const config = {
      mode: 'prod', configFile: null, listen: { host: '127.0.0.1', port: 0 }, tls: null, publicOrigins: [], teamRoot: env.fx.team, dataDir: env.fx.data, logDir: null, logLevel: 'error',
      engine: { authMode: 'proxy', runDir: path.join(R, 'run'), agentRoot: path.join(R, 'agent'), launcherSock: sock, proxyPort: port },
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
