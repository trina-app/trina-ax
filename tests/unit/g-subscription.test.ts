// Production managed mode end to end with a Claude subscription connection, as the current user ("same user"
// rehearsal; the role-account run is tests/install/g-macos-install.ts with sudo): engine.authMode "managed" -> the real
// engine core starts the model proxy on engine.proxyPort and the launcher under the production sandbox profile
// (LOCAL_LOGIN=0, only the proxy port reachable); every Claude turn gets a per-turn token on fd 3, bound to the team's
// AI connection; the proxy swaps in the connection's token. The connection comes from the owner's token file
// <install>/secrets/claude-oauth-token (root/set-claude-token), imported like at start (credentials/migrate.ts). A fake
// upstream checks that the real token arrives and the per-turn one never leaves. The engine is the scripted fake
// (tests/lib/b-fake-engine.ts) with its own copy of bun in one folder, so it runs inside the sandbox like the real
// Claude Code binary; it calls the model the way Claude Code does.
import { setSetting } from '../../server/src/admin/settings'
import { SHARED_SUBSCRIPTIONS_KEY } from '../../server/src/credentials/policy'
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { ask, FAKE_ENGINE_TS, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { WORK } from '../lib/env'
import { waitFor } from '../lib/wait'
import { LocalEngines } from '../../server/src/chat/engines'
import { issueProxyToken } from '../../server/src/proxy/model-proxy'
import { tokenFile } from '../../server/src/proxy/subscription'
import { importTokenFile } from '../../server/src/credentials/migrate'
import { credentialsOf, getRow, listRows } from '../../server/src/credentials/store'
import { resolveLayout } from '../../server/src/system/layout'
import { OpsService } from '../../server/src/system/ops'
import { checkEngine, engineEnv } from '../../server/src/admin/engines'

setDefaultTimeout(60_000)
const mac = process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec')
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const REAL = 'sk-ant-oat01-' + 'S'.repeat(60)
const ENGINE_DIR = path.join(WORK, 'g-subscription-engine')

/** a free TCP port on 127.0.0.1 (the proxy port has to be in the config before the server starts) */
async function freePort(): Promise<number> {
  return new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)) }) })
}

// ---------------- fake model service ----------------
const leaks: string[] = []
const auths: string[] = []
let slowCancelled = false
let releaseSlow: (() => void) | null = null
const enc = new TextEncoder()
const ev = (o: unknown) => enc.encode(`event: e\ndata: ${JSON.stringify(o)}\n\n`)
function answer(text: string, usage: { input_tokens: number; output_tokens: number }, hold = false) {
  return new Response(new ReadableStream<Uint8Array>({
    async start(ctl) {
      ctl.enqueue(ev({ type: 'message_start', message: { model: 'claude-sonnet-4-5', usage: { input_tokens: usage.input_tokens, output_tokens: 1 } } }))
      ctl.enqueue(ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
      if (hold) await new Promise<void>((r) => (releaseSlow = r))
      try {
        for (const part of text.match(/.{1,6}/g) ?? []) ctl.enqueue(ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part } }))
        ctl.enqueue(ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: usage.output_tokens } }))
        ctl.enqueue(ev({ type: 'message_stop' }))
        ctl.close()
      } catch {}
    },
    cancel() { slowCancelled = true },
  }), { headers: { 'content-type': 'text/event-stream' } })
}
let upstream: ReturnType<typeof Bun.serve>
let h: Harness
let alice: TestSocket
let carol: TestSocket

beforeAll(async () => {
  if (!mac) return
  upstream = Bun.serve({
    port: 0, hostname: '127.0.0.1', idleTimeout: 0,
    async fetch(req) {
      const raw = await req.text()
      const all = JSON.stringify([...req.headers]) + raw
      if (/mpx_/.test(all)) leaks.push(all.slice(0, 300))
      auths.push(req.headers.get('authorization') ?? '')
      if (req.headers.get('authorization') !== 'Bearer ' + REAL) return Response.json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, { status: 401 })
      const prompt = String(JSON.parse(raw).messages?.[0]?.content ?? '')
      if (prompt === 'revoked') return Response.json({ type: 'error', error: { type: 'authentication_error', message: 'OAuth token has been revoked' } }, { status: 401 })
      if (prompt === 'slow') return answer('never sent', { input_tokens: 10, output_tokens: 1 }, true)
      if (prompt === 'big') return answer('big answer', { input_tokens: 5000, output_tokens: 1000 })
      return answer(`Hello from the model (${prompt})`, { input_tokens: 120, output_tokens: 30 })
    },
  })
  // the engine: bun + the fake script in one folder (the sandbox lets the engine run and read ENGINE_DIR only). Not
  // `bun build --compile`: Bun 1.3.12 writes an executable macOS kills at exec and codesign cannot repair.
  fs.rmSync(ENGINE_DIR, { recursive: true, force: true })
  fs.mkdirSync(ENGINE_DIR, { recursive: true })
  fs.copyFileSync(process.execPath, path.join(ENGINE_DIR, 'bun'))
  fs.chmodSync(path.join(ENGINE_DIR, 'bun'), 0o755)
  fs.copyFileSync(FAKE_ENGINE_TS, path.join(ENGINE_DIR, 'fake-engine.ts'))
  fs.writeFileSync(path.join(ENGINE_DIR, 'claude'), `#!${path.join(ENGINE_DIR, 'bun')}\nimport './fake-engine.ts'\n`, { mode: 0o755 })
  const proxyPort = await freePort()
  h = await startHarness({
    name: 'g-subscription', turnTimeoutMs: 60_000,
    realCore: { engine: { authMode: 'managed', claudeBin: path.join(ENGINE_DIR, 'claude'), codexBin: '/nonexistent/codex', proxyPort, modelUpstream: `http://127.0.0.1:${upstream.port}` } },
    credentials: [],
  })
  // the owner stores the setup-token (root/set-claude-token in production); the server imports it as an AI connection
  const secrets = resolveLayout(h.ctx.config).secretsDir
  fs.mkdirSync(secrets, { recursive: true, mode: 0o700 })
  fs.writeFileSync(tokenFile(secrets), REAL + '\n', { mode: 0o600 })
  expect(importTokenFile(credentialsOf(h.ctx), secrets)).toBe('imported')
  setSetting(h.ctx.db, SHARED_SUBSCRIPTIONS_KEY, true) // importing alone is not consent; this fixture opts in
  alice = await h.ws('alice', { windowId: 'win-alice' })
  carol = await h.ws('carol', { windowId: 'win-carol' })
  await alice.next('hello'); await carol.next('hello')
})
afterAll(async () => { alice?.close(); carol?.close(); await h?.close(); upstream?.stop(true) })

const newChat = () => h.api('alice').call(API.createChat, { body: {} })

describe.skipIf(!mac)('managed mode (same user): engine -> fd token -> model proxy -> the team\'s Claude subscription connection', () => {
  test('a turn streams the model answer; the upstream saw only the real token; usage counted by the proxy', async () => {
    const chat = await newChat()
    const { started, done } = await ask(h, alice, 'alice', chat.id, fake({ model: 'hi' }), { ms: 30_000 })
    expect(done.status).toBe('done')
    expect(done.content).toBe('Hello from the model (hi)')
    expect(auths.length).toBeGreaterThan(0)
    expect(auths.every((a) => a === 'Bearer ' + REAL)).toBe(true)
    expect(leaks).toEqual([])
    const t = h.ctx.db.query('SELECT input_tokens, output_tokens, cost_usd, usage_source FROM turns WHERE id = ?').get(started.turnId)
    expect(t).toEqual({ input_tokens: 120, output_tokens: 30, cost_usd: 0, usage_source: 'proxy' })
    // the turn's proxy token died with the turn
    const tok = h.ctx.db.query('SELECT revoked_at FROM proxy_tokens WHERE turn_id = ?').all(started.turnId) as { revoked_at: string | null }[]
    expect(tok.length).toBe(1); expect(tok[0]!.revoked_at).not.toBeNull()
  })

  test('the engine sees no credential in its environment or argv, only the fd variable and the proxy address', async () => {
    const chat = await newChat()
    const { done } = await ask(h, alice, 'alice', chat.id, fake({ echo: 'secrets' }), { ms: 30_000 })
    const core = await h.ctx.core()
    expect(done.content).toBe(`envSecrets=none argvSecrets=none fdVar=3 base=http://127.0.0.1:${core.proxy!.port}`)
  })

  // staging 2026-10-22: with the fd token Claude Code starts on Sonnet (it cannot tell the plan); every turn was Sonnet
  test('no model chosen: the turn asks for Opus; a chosen model still wins', async () => {
    const a = await ask(h, alice, 'alice', (await newChat()).id, fake({ echo: 'model' }), { ms: 30_000 })
    expect(a.done.content).toBe('model=opus')
    const chat = await h.api('alice').call(API.createChat, { body: { model: 'sonnet' } })
    const b = await ask(h, alice, 'alice', chat.id, fake({ echo: 'model' }), { ms: 30_000 })
    expect(b.done.content).toBe('model=sonnet')
  })

  test('the sandbox lets the engine reach the proxy only (not the model service directly)', async () => {
    const chat = await newChat()
    const { done } = await ask(h, alice, 'alice', chat.id, fake({ direct: `http://127.0.0.1:${upstream.port}/` }, { model: 'after' }), { ms: 30_000 })
    expect(done.content).toBe('direct=blockedHello from the model (after)')
  })

  test('a caller outside the turn cannot use a turn token (peer check through the launcher)', async () => {
    const chat = await newChat()
    const r = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: fake({ model: 'slow' }), clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
    expect(await waitFor(() => releaseSlow !== null, { timeoutMs: 20_000 })).toBe(true)
    const core = await h.ctx.core()
    const stolen = issueProxyToken(h.ctx.db, r.turnId, 'alice', { credentialId: listRows(h.ctx.db)[0]!.id, family: 'anthropic' })
    const res = await fetch(`${core.proxy!.baseUrl}/v1/messages`, { method: 'POST', headers: { authorization: 'Bearer ' + stolen, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 5, messages: [{ role: 'user', content: 'x' }] }) })
    expect(res.status).toBe(403)
    expect((await res.json()).error.message).toBe('caller is not part of this turn')

    // stop: the engine dies, its connection closes, the proxy cancels the upstream request
    slowCancelled = false
    await h.api('alice').call(API.stop, { params: { id: chat.id } })
    const done = await alice.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 20_000)
    expect(done.data.status).toBe('stopped')
    expect(await waitFor(() => slowCancelled, { timeoutMs: 10_000 })).toBe(true)
    releaseSlow?.(); releaseSlow = null
  })

  test('a block budget used up during the turn: the next model request gets 403 budget_exceeded and the turn ends', async () => {
    h.ctx.db.query("INSERT INTO budgets (id, subject_type, subject_id, period, limit_usd, limit_tokens, action) VALUES ('b-sub', 'user', 'alice', 'day', 0, ?, 'block')")
      .run((h.ctx.db.query("SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS n FROM turns WHERE user_id = 'alice'").get() as { n: number }).n + 3000)
    try {
      const chat = await newChat()
      const before = auths.length
      const { done } = await ask(h, alice, 'alice', chat.id, fake({ model: 'big' }, { model: 'second' }), { ms: 30_000 })
      expect(done.status).toBe('error')
      expect(done.error?.code).toBe('budget_exceeded')
      expect(done.content).toBe('big answer')
      expect(auths.length - before).toBe(1) // the second request never left
    } finally { h.ctx.db.query("DELETE FROM budgets WHERE id = 'b-sub'").run() }
  })

  test('upstream 401 (revoked token): the connection is marked refused, the turn ends, admins are told, diagnostics say so', async () => {
    const chat = await newChat()
    const { done } = await ask(h, alice, 'alice', chat.id, fake({ model: 'revoked' }), { ms: 30_000 })
    expect(done.status).toBe('error')
    expect(done.error?.code).toBe('engine_unavailable')
    expect(done.error?.message).toContain('AI connection')
    await carol.next('notice', (f) => f.data.code === 'credential_rejected', 5000)
    const cred = listRows(h.ctx.db)[0]!
    expect(cred.status).toBe('invalid')
    const ops = new OpsService(h.ctx)
    const login = (await ops.engines()).find((e) => e.engine === 'claude-code')!
    expect(login).toMatchObject({ loggedIn: false, reason: 'credential_unusable' })
    const diag = await ops.diagnostics('en')
    expect(diag.checks.find((c) => c.id === 'engine.claude-code')).toMatchObject({ status: 'fail' })
    expect(diag.checks.find((c) => c.id === 'model_proxy')).toMatchObject({ status: 'ok' })
    expect(diag.checks.find((c) => c.id === 'credentials_key')).toMatchObject({ status: 'ok' })
    const admin = await checkEngine('claude-code', engineEnv(h.ctx), true, 'en')
    expect(admin.status).toBe('not_logged_in')
    // a new token in the file (the owner runs set-claude-token again) replaces the same connection's, no restart
    const secrets = resolveLayout(h.ctx.config).secretsDir
    const NEW = 'sk-ant-oat01-' + 'T'.repeat(60)
    fs.writeFileSync(tokenFile(secrets), NEW + '\n', { mode: 0o600 })
    expect(importTokenFile(credentialsOf(h.ctx), secrets)).toBe('updated')
    expect(getRow(h.ctx.db, cred.id)!.status).toBe('ok')
    const n = auths.length
    const again = await ask(h, alice, 'alice', chat.id, fake({ model: 'x' }), { ms: 30_000 })
    expect(auths.slice(n)).toEqual(['Bearer ' + NEW]) // the fake upstream refuses it (it only knows REAL): proves the swap
    expect(again.done.status).toBe('error')
    fs.writeFileSync(tokenFile(secrets), REAL + '\n', { mode: 0o600 })
    expect(importTokenFile(credentialsOf(h.ctx), secrets)).toBe('updated')
  })

  test('no usable connection: the Claude turn is refused before the engine starts, with a clear message', async () => {
    h.ctx.db.query('UPDATE engine_credentials SET disabled = 1').run()
    try {
      const e = new LocalEngines(h.ctx).get()
      expect(e.claude?.authMode).toBe('managed')
      const n = auths.length
      const r = await ask(h, alice, 'alice', (await newChat()).id, fake({ model: 'x' }), { ms: 30_000 })
      expect(r.done.error?.code).toBe('engine_unavailable')
      expect(r.done.error?.message).toMatch(/no AI connection/i)
      expect(auths.length).toBe(n)
    } finally { h.ctx.db.query('UPDATE engine_credentials SET disabled = 0').run() }
  })
})
