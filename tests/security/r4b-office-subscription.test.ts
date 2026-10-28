// Security regression, round 4b (finding 4 = round 4 #8, high, residual): an office engine whose tool lockdown and
// sandbox both fail can read the Mac's Claude login (keychain item, ~/.claude.json), because office mode ran Claude with
// that login. The only way to close it is subscription mode: the owner's `claude setup-token` token stays with the
// server (config/claude-oauth-token, 600), the engine runs with HOME in its chat folder, LOCAL_LOGIN=0 (no keychain, no
// home files) and talks only to the model proxy with a per-turn token that the proxy swaps for the real one.
// Office mode now offers it: office-install.sh / teamax configure --claude-token-file FILE. Tested here against a fake
// upstream with the production subscription path (the same as tests/unit/g-subscription.test.ts); a real Anthropic
// answer through this path still needs the owner's real setup-token (security audit round 4).
import { setSetting } from '../../server/src/admin/settings'
import { SHARED_SUBSCRIPTIONS_KEY } from '../../server/src/credentials/policy'
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { WORK } from '../lib/env'
import { ask, FAKE_ENGINE_TS, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { configure } from '../../server/src/office/cli'
import { officePaths, parseEnvFile, serverConfig, settingsFrom } from '../../server/src/office/settings'
import { resolveLayout } from '../../server/src/system/layout'
import { subscriptionTokenStatus, tokenFile } from '../../server/src/proxy/subscription'
import { importTokenFile } from '../../server/src/credentials/migrate'
import { credentialsOf } from '../../server/src/credentials/store'
import { loadAppConfig } from '../../server/src/app-config'

setDefaultTimeout(60_000)
const mac = process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec')
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const REAL = 'sk-ant-oat01-' + 'R'.repeat(60)
const BASE = path.join(WORK, 'r4b-office-sub')
const mode = (f: string) => fs.statSync(f).mode & 0o777

beforeAll(() => { fs.rmSync(BASE, { recursive: true, force: true }); fs.mkdirSync(BASE, { recursive: true }) })

describe('office settings: --claude-token-file switches Claude to subscription mode', () => {
  test('the token is checked, stored 600 in config/ (never in office.env), and server.json runs the model proxy', () => {
    const home = path.join(BASE, 'home-a')
    const tf = path.join(BASE, 'setup-token.txt')
    fs.writeFileSync(tf, REAL + '\n')
    const s = configure(home, ['--claude-token-file', tf]) // was: the flag was ignored, nothing stored
    const p = officePaths(home)
    expect(s.claudeAuth).toBe('subscription')
    expect(fs.readFileSync(p.claudeToken, 'utf8').trim()).toBe(REAL)
    expect(mode(p.claudeToken)).toBe(0o600)
    expect(p.claudeToken).toBe(path.join(home, 'config', 'claude-oauth-token'))
    const env = fs.readFileSync(p.env, 'utf8')
    expect(env).toContain('TEAMAX_CLAUDE_AUTH=subscription')
    expect(env).not.toContain('sk-ant-')
    const cfg = serverConfig(settingsFrom(home, parseEnvFile(env)), { dns: ['mini.local'], ips: ['192.168.1.18'] })
    expect(cfg.engine).toMatchObject({ authMode: 'subscription', proxyPort: 47831 })
    // the server finds the token where configure put it: config/ is an office installation's secrets folder
    fs.writeFileSync(p.serverJson, JSON.stringify(cfg))
    const app = loadAppConfig({ argv: ['--config', p.serverJson], env: {} })
    expect(app.office).toBe(true)
    expect(resolveLayout(app).secretsDir).toBe(path.join(home, 'config'))
    expect(tokenFile(resolveLayout(app).secretsDir)).toBe(p.claudeToken)
    expect(subscriptionTokenStatus(resolveLayout(app).secretsDir, null).state).toBe('ok')
  })

  test('refused: a file that is not a setup-token, a link, subscription without any token; local-login switches back', () => {
    const home = path.join(BASE, 'home-b')
    const bad = path.join(BASE, 'bad.txt')
    fs.writeFileSync(bad, 'sk-ant-api03-' + 'K'.repeat(60))
    expect(() => configure(home, ['--claude-token-file', bad])).toThrow(/not a Claude subscription token/)
    const link = path.join(BASE, 'link.txt')
    fs.writeFileSync(path.join(BASE, 'good.txt'), REAL)
    fs.symlinkSync(path.join(BASE, 'good.txt'), link)
    expect(() => configure(home, ['--claude-token-file', link])).toThrow(/not a regular file/)
    expect(() => configure(home, ['--claude-auth', 'subscription'])).toThrow(/needs the owner's token/)
    expect(fs.existsSync(officePaths(home).claudeToken)).toBe(false)
    configure(home, ['--claude-token-file', path.join(BASE, 'good.txt')])
    expect(configure(home, ['--lan-port', '18443']).claudeAuth).toBe('subscription') // kept by later configure runs
    expect(configure(home, ['--claude-auth', 'local-login']).claudeAuth).toBe('local-login')
    expect(() => settingsFrom(home, { TEAMAX_PROXY_PORT: '47830' })).toThrow(/must differ/)
  })
})

describe.skipIf(!mac)('office subscription mode end to end (fake upstream): no Mac login in the engine', () => {
  const ENGINE_DIR = path.join(WORK, 'r4b-office-sub-engine')
  const auths: string[] = []
  const leaks: string[] = []
  let upstream: ReturnType<typeof Bun.serve>
  let h: Harness
  let alice: TestSocket
  const enc = new TextEncoder()
  const ev = (o: unknown) => enc.encode(`event: e\ndata: ${JSON.stringify(o)}\n\n`)
  beforeAll(async () => {
    upstream = Bun.serve({
      port: 0, hostname: '127.0.0.1', idleTimeout: 0,
      async fetch(req) {
        const raw = await req.text()
        if (/mpx_/.test(JSON.stringify([...req.headers]) + raw)) leaks.push(raw.slice(0, 200))
        auths.push(req.headers.get('authorization') ?? '')
        if (req.headers.get('authorization') !== 'Bearer ' + REAL) return Response.json({ type: 'error', error: { type: 'authentication_error', message: 'invalid' } }, { status: 401 })
        const prompt = String(JSON.parse(raw).messages?.[0]?.content ?? '')
        return new Response(new ReadableStream<Uint8Array>({ start(c) {
          c.enqueue(ev({ type: 'message_start', message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 10, output_tokens: 1 } } }))
          c.enqueue(ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `office (${prompt})` } }))
          c.enqueue(ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }))
          c.enqueue(ev({ type: 'message_stop' })); c.close()
        } }), { headers: { 'content-type': 'text/event-stream' } })
      },
    })
    fs.rmSync(ENGINE_DIR, { recursive: true, force: true })
    fs.mkdirSync(ENGINE_DIR, { recursive: true })
    fs.copyFileSync(process.execPath, path.join(ENGINE_DIR, 'bun'))
    fs.chmodSync(path.join(ENGINE_DIR, 'bun'), 0o755)
    fs.copyFileSync(FAKE_ENGINE_TS, path.join(ENGINE_DIR, 'fake-engine.ts'))
    fs.writeFileSync(path.join(ENGINE_DIR, 'claude'), `#!${path.join(ENGINE_DIR, 'bun')}\nimport './fake-engine.ts'\n`, { mode: 0o755 })
    const proxyPort = await new Promise<number>((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)) }) })
    h = await startHarness({
      name: 'r4b-office-sub', turnTimeoutMs: 60_000,
      // the office "subscription" choice is managed mode (server.json keeps the older name this release, D18)
      realCore: { office: true, engine: { authMode: 'managed', claudeBin: path.join(ENGINE_DIR, 'claude'), codexBin: '', proxyPort, modelUpstream: `http://127.0.0.1:${upstream.port}` } },
      credentials: [],
    })
    // what configure --claude-token-file writes: <office home>/config/claude-oauth-token; the server imports it as the
    // team's AI connection (at start and every 5 minutes)
    const secrets = resolveLayout(h.ctx.config).secretsDir
    expect(path.basename(secrets)).toBe('config')
    fs.mkdirSync(secrets, { recursive: true, mode: 0o700 })
    fs.writeFileSync(tokenFile(secrets), REAL + '\n', { mode: 0o600 })
    expect(importTokenFile(credentialsOf(h.ctx), secrets)).toBe('imported')
    setSetting(h.ctx.db, SHARED_SUBSCRIPTIONS_KEY, true) // importing alone is not consent; this fixture opts in
    alice = await h.ws('alice', { windowId: 'win-r4b-sub' })
    await alice.next('hello')
  })
  afterAll(async () => { alice?.close(); await h?.close(); upstream?.stop(true) })

  test('a turn answers through the model proxy with the owner\'s token; the engine had only a per-turn token', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const { done } = await ask(h, alice, 'alice', chat.id, fake({ model: 'hi' }), { ms: 30_000 })
    expect(done.status).toBe('done')
    expect(done.content).toBe('office (hi)')
    expect(auths.length).toBeGreaterThan(0)
    expect(auths.every((a) => a === 'Bearer ' + REAL)).toBe(true)
    expect(leaks).toEqual([])
    const chat2 = await h.api('alice').call(API.createChat, { body: {} })
    const s = await ask(h, alice, 'alice', chat2.id, fake({ echo: 'secrets' }), { ms: 30_000 })
    expect(String(s.done.content)).toMatch(/^envSecrets=none argvSecrets=none fdVar=3 base=http:\/\/127\.0\.0\.1:\d+$/)
  })

  test('the engine cannot read the Mac\'s Claude login: ~/.claude.json, the login keychain, ~/.claude', async () => {
    const home = os.userInfo().homedir
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const r = await ask(h, alice, 'alice', chat.id, fake(
      { readAbs: path.join(home, '.claude.json') }, { readAbs: path.join(home, 'Library', 'Keychains', 'login.keychain-db') },
      { readAbs: path.join(home, '.claude', '.credentials.json') }, { readAbs: path.join(home, '.claude', 'settings.json') },
    ), { ms: 30_000 })
    expect(r.done.content).toBe('read=blockedread=blockedread=blockedread=blocked')
    expect(h.ctx.config.office).toBe(true)
  })
})
