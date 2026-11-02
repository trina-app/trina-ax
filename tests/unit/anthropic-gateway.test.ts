// The Anthropic-compatible gateway (server.json engine.anthropicGateway, docs/DECISIONS.md "Anthropic-compatible
// gateway"): the config and its conflicts, the gateway's key format and key check, no Claude subscription token (and
// no Anthropic key) ever sent to the gateway, the proxy's model allow-list (count_tokens 404 included), the engine's
// model environment, the admin model list and the cost of a gateway request. Fake upstreams only.
import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { allowedCredentialKinds, ConfigError, loadAppConfig, modelUpstreams, type AnthropicGatewayConf } from '../../server/src/app-config'
import { setSetting } from '../../server/src/admin/settings'
import { checkEngine, claudeModels, CLAUDE_MODELS, type EngineEnv } from '../../server/src/admin/engines'
import { createBroker } from '../../server/src/credentials/broker'
import { SHARED_SUBSCRIPTIONS_KEY } from '../../server/src/credentials/policy'
import { CLAUDE_MAX, costOf, setUnknownPriceHook } from '../../server/src/credentials/prices'
import { resolveCredential } from '../../server/src/credentials/resolve'
import { checkCredential, createCredential, replaceSecret } from '../../server/src/credentials/service'
import { getRow, metaOf, toCredential } from '../../server/src/credentials/store'
import { formatProblem } from '../../server/src/credentials/validate'
import { buildClaudeLaunch } from '../../server/src/engine/claude'
import { checkProxyRequest, issueProxyToken, startModelProxy } from '../../server/src/proxy/model-proxy'
import { addCred, testCredCtx } from '../lib/credentials'
import { makeEnv, WORK } from '../lib/env'

const PRO = 'deepseek/deepseek-v4-pro', FLASH = 'deepseek/deepseek-v4-flash'
const OR_KEY = 'sk-or-v1-' + 'a'.repeat(64), OR_KEY2 = 'sk-or-v1-' + 'c'.repeat(64)
const ANTHROPIC_KEY = 'sk-ant-api03-' + 'K'.repeat(40)
const OAUTH = 'sk-ant-oat01-' + 'T'.repeat(60)

describe('server.json engine.anthropicGateway', () => {
  const dir = path.join(WORK, 'anthropic-gateway-config')
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true })
  const load = (engine: object) => {
    const f = path.join(dir, `server-${Math.random().toString(36).slice(2)}.json`)
    fs.writeFileSync(f, JSON.stringify({ mode: 'prod', engine: { authMode: 'managed', ...engine } }))
    return loadAppConfig({ argv: ['--config', f], env: {} })
  }
  const gw = (o: object = {}) => ({ baseUrl: 'https://openrouter.ai/api', models: { default: PRO, haiku: FLASH }, ...o })

  test('valid: Claude requests go to the gateway; subscription connections are off whatever credentialKinds says', () => {
    const c = load({ anthropicGateway: gw({ baseUrl: 'https://openrouter.ai/api/', label: 'OpenRouter', prices: { [PRO]: { input: 1.6, output: 3.2 } } }), credentialKinds: ['anthropic-oauth', 'anthropic-api-key', 'chatgpt'] })
    expect(c.engine.anthropicGateway).toMatchObject({ label: 'OpenRouter', models: { default: PRO, haiku: FLASH }, prices: { [PRO]: { input: 1.6, output: 3.2 } } })
    expect(modelUpstreams(c).anthropic).toBe('https://openrouter.ai/api')
    const k = allowedCredentialKinds(c)
    expect([...k].sort()).toEqual(['anthropic-api-key', 'chatgpt'])
    expect(k.gateway).toBe('openrouter.ai')
    // without it: unchanged
    const plain = load({})
    expect(modelUpstreams(plain).anthropic).toBe('https://api.anthropic.com')
    expect(allowedCredentialKinds(plain).has('anthropic-oauth')).toBe(true)
    expect(allowedCredentialKinds(plain).gateway).toBeNull()
  })
  test('refused at start: no default model, both gateway and modelUpstreams.anthropic, plain http, /v1, claude-* ids, local-login', () => {
    expect(() => load({ anthropicGateway: { baseUrl: 'https://openrouter.ai/api', models: { haiku: FLASH } } })).toThrow(/anthropicGateway\.models\.default/)
    expect(() => load({ anthropicGateway: gw(), modelUpstreams: { anthropic: 'https://api.anthropic.com' } })).toThrow(/cannot both be set/)
    expect(() => load({ anthropicGateway: gw(), modelUpstream: 'https://api.anthropic.com' })).toThrow(/cannot both be set/)
    expect(() => load({ anthropicGateway: gw({ baseUrl: 'http://gateway.example.com/api' }) })).toThrow(/must be https/)
    expect(() => load({ anthropicGateway: gw({ baseUrl: 'https://user:pw@openrouter.ai/api' }) })).toThrow(/must be https/)
    expect(() => load({ anthropicGateway: gw({ baseUrl: 'https://openrouter.ai/api/v1' }) })).toThrow(/no \/v1/)
    expect(() => load({ anthropicGateway: gw({ models: { default: 'claude-sonnet-5-5' } }) })).toThrow(/billed by Anthropic/)
    expect(() => load({ anthropicGateway: gw({ models: { default: PRO, opus: '--dangerous' } }) })).toThrow(ConfigError)
    expect(() => load({ authMode: 'local-login', anthropicGateway: gw() })).toThrow(/needs engine.authMode "managed"/)
    // a fake gateway on this machine (tests) is fine, like modelUpstreams
    expect(modelUpstreams(load({ anthropicGateway: gw({ baseUrl: 'http://127.0.0.1:9/api' }) })).anthropic).toBe('http://127.0.0.1:9/api')
  })
})

describe('key format', () => {
  test('without the gateway: unchanged (Anthropic keys only)', () => {
    expect(formatProblem('anthropic-api-key', ANTHROPIC_KEY)).toBeNull()
    expect(formatProblem('anthropic-api-key', OR_KEY)).toBe('badAnthropicKey')
  })
  test('with the gateway: any key of 20-300 safe characters, never an Anthropic key or token', () => {
    for (const k of [OR_KEY, 'sk-' + 'b'.repeat(32), 'abcdef0123456789.ZYXWVUTsecret_part-2', 'x'.repeat(20), 'y'.repeat(300)]) expect(formatProblem('anthropic-api-key', k, true), k).toBeNull()
    for (const k of ['x'.repeat(19), 'y'.repeat(301), 'sk-or-v1-' + 'a'.repeat(20) + ' ', 'key/with/slash' + 'z'.repeat(20), 'key+plus' + 'z'.repeat(20), ANTHROPIC_KEY, OAUTH, 'SK-ANT-api03-' + 'K'.repeat(40)])
      expect(formatProblem('anthropic-api-key', k, true), k).toBe('badGatewayKey')
    // the other kinds keep their own rules
    expect(formatProblem('anthropic-oauth', OAUTH, true)).toBeNull()
    expect(formatProblem('openai-api-key', OR_KEY, true)).toBeNull()
  })
})

// a fake gateway: /v1/messages (stream or not), count_tokens 404 (as OpenRouter), a model list that wants the key
const env = makeEnv('anthropic-gateway')
setSetting(env.db, SHARED_SUBSCRIPTIONS_KEY, true) // so a subscription connection is skipped for the gateway, not for sharing
const seen: { path: string; key: string | null; auth: string | null; model?: string }[] = []
let publicList = false
const VALID = new Set([OR_KEY, OR_KEY2])
const upstream = Bun.serve({
  port: 0, hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url)
    const key = req.headers.get('x-api-key'), auth = req.headers.get('authorization')
    if (req.method === 'GET') {
      seen.push({ path: url.pathname, key, auth })
      if (url.pathname !== '/api/v1/models') return new Response('no', { status: 404 })
      return publicList || VALID.has(key ?? '') ? Response.json({ data: [{ id: PRO }] }) : Response.json({ error: { type: 'authentication_error' } }, { status: 401 })
    }
    const body = await req.json() as { model: string; stream?: boolean }
    seen.push({ path: url.pathname, key, auth, model: body.model })
    if (url.pathname === '/api/v1/messages/count_tokens') return Response.json({ error: { type: 'not_found_error', message: 'Not Found' } }, { status: 404 })
    if (!VALID.has(key ?? '')) return Response.json({ type: 'error', error: { type: 'authentication_error', message: 'bad key' } }, { status: 401 })
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: null }
    if (body.stream) {
      // the answer names the model its own way (a provider suffix): the price is still the one asked for
      const sse = [`data: ${JSON.stringify({ type: 'message_start', message: { model: `${body.model}-20261015`, usage: { input_tokens: 0, output_tokens: 0 } } })}`, '',
        `data: ${JSON.stringify({ type: 'message_delta', usage })}`, '', 'data: {"type":"message_stop"}', '', ''].join('\n')
      return new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
    }
    return Response.json({ id: 'm', model: `${body.model}-20261015`, content: [{ type: 'text', text: 'ok' }], usage })
  },
})
const BASE = `http://127.0.0.1:${upstream.port}/api`
const GW: AnthropicGatewayConf = { baseUrl: BASE, label: 'Fake gateway', models: { default: PRO, haiku: FLASH }, prices: { [PRO]: { input: 1.6, output: 3.2 } } }
const HOST = `127.0.0.1:${upstream.port}`
for (const id of ['g1', 'g2', 'g3', 'g4']) env.db.query("INSERT INTO turns (id, chat_id, user_id, engine, status) VALUES (?, 'c', 'alice', 'claude-code', 'running')").run(id)
const t = testCredCtx(env.db, path.join(env.fx.data, 'secrets'), { gateway: GW, upstreams: {} })
const warns: { msg: string; f?: Record<string, unknown> }[] = []
t.cc.log = { ...t.cc.log, warn: (msg: string, f?: Record<string, unknown>) => { warns.push({ msg, f }) } }
// connections made before the gateway was switched on: a Claude subscription and an Anthropic key
const OLD_OAUTH = addCred(t.cc, 'anthropic-oauth', OAUTH, { label: 'subscription', priority: 1 })
const OLD_KEY = addCred(t.cc, 'anthropic-api-key', ANTHROPIC_KEY, { label: 'anthropic', priority: 2 })
const broker = createBroker(t.cc)
const proxyLog: string[] = []
const proxy = await startModelProxy({ db: env.db, broker, log: { warn: (m) => { proxyLog.push(m) }, debug: () => {} } })
afterAll(async () => { await proxy.stop(); upstream.stop(true); setUnknownPriceHook(null) })
const tok = (turn: string, cred: string) => issueProxyToken(env.db, turn, 'alice', { credentialId: cred, family: 'anthropic' })
const call = (token: string, model: string, o: { path?: string; stream?: boolean } = {}) => fetch(proxy.url + (o.path ?? '/v1/messages'), {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': token, 'anthropic-version': '2023-06-01' },
  body: JSON.stringify({ model, max_tokens: 5, messages: [{ role: 'user', content: 'hi' }], ...(o.stream ? { stream: true } : {}) }),
})
const sent = (s: string) => seen.some((x) => x.key === s || x.auth?.includes(s))
const createKey = (secret: string) => createCredential(t.cc, { kind: 'anthropic-api-key', label: 'gateway', secret, assignments: [], priority: 10, ownerUserId: null, actor: 'dana' }, 'en')

describe('Claude subscription tokens and Anthropic keys never reach the gateway', () => {
  test('a subscription connection cannot be added, and nothing is checked', async () => {
    seen.length = 0
    await expect(createCredential(t.cc, { kind: 'anthropic-oauth', label: 'new', secret: 'sk-ant-oat01-' + 'N'.repeat(60), assignments: [], priority: 100, ownerUserId: null, actor: 'dana', acknowledgedPlanNotice: true }, 'en'))
      .rejects.toThrow('This kind of connection cannot be added on this server.')
    await expect(createKey(ANTHROPIC_KEY.replace('K', 'L'))).rejects.toThrow(/AI gateway/)
    expect(seen).toEqual([])
  })
  test('existing ones show as off, are skipped for a turn, are not checked, and the proxy does not forward them', async () => {
    const now = new Date()
    expect(toCredential(t.cc, getRow(env.db, OLD_OAUTH)!, 'en')).toMatchObject({ state: 'kind_off' })
    expect(toCredential(t.cc, getRow(env.db, OLD_KEY)!, 'en')).toMatchObject({ state: 'kind_off', detail: expect.stringContaining('engine.anthropicGateway') })
    expect(resolveCredential(env.db, { userId: 'alice', engine: 'claude-code', allowedKinds: t.cc.allowedKinds, now })).toMatchObject({ ok: false, reason: 'none' })
    seen.length = 0
    await checkCredential(t.cc, OLD_OAUTH, 'dana', 'en')
    await checkCredential(t.cc, OLD_KEY, 'dana', 'en')
    for (const id of [OLD_OAUTH, OLD_KEY]) {
      const r = await call(tok('g1', id), PRO)
      expect(r.status).toBe(403)
      expect((await r.json()).error.message).toBe('credential_gone')
    }
    expect(seen).toEqual([])
    expect(sent(OAUTH) || sent(ANTHROPIC_KEY)).toBe(false)
  })
})

let GW_KEY = ''
describe('a gateway connection', () => {
  test('its key is checked on the model list only when the list needs a key; it remembers the gateway', async () => {
    publicList = true
    const unverified = await createKey('sk-or-v1-' + 'p'.repeat(64))
    expect(unverified.state).toBe('unverified') // a list anyone gets says nothing about the key
    publicList = false
    await expect(createKey('sk-or-v1-' + 'r'.repeat(64))).rejects.toThrow('The provider did not accept this key.')
    seen.length = 0
    const c = await createKey(OR_KEY)
    expect(c.state).toBe('ok')
    expect(seen.map((s) => [s.path, s.key])).toEqual([['/api/v1/models', OR_KEY], ['/api/v1/models', null]])
    expect(metaOf(getRow(env.db, c.id)!).gateway).toBe(HOST)
    GW_KEY = c.id
    env.db.query('DELETE FROM engine_credentials WHERE id = ?').run(unverified.id)
    expect(resolveCredential(env.db, { userId: 'alice', engine: 'claude-code', allowedKinds: t.cc.allowedKinds })).toMatchObject({ ok: true, credentialId: GW_KEY })
  })
  test('OpenRouter: the key is checked on GET /api/v1/key (its model list is public)', async () => {
    const calls: { url: string; auth: string | null }[] = []
    const fake = (async (u: string | URL | Request, init?: RequestInit) => {
      const url = String(u), auth = new Headers(init?.headers).get('authorization')
      calls.push({ url, auth })
      if (url !== 'https://openrouter.ai/api/v1/key') return new Response('{}', { status: 404 })
      return auth === `Bearer ${OR_KEY}` ? Response.json({ data: { label: 'k' } }) : Response.json({ error: { code: 401 } }, { status: 401 })
    }) as unknown as typeof fetch
    const o = testCredCtx(env.db, path.join(env.fx.data, 'secrets-or'), { gateway: { baseUrl: 'https://openrouter.ai/api', models: { default: PRO } }, fetch: fake })
    const add = (secret: string) => createCredential(o.cc, { kind: 'anthropic-api-key', label: 'or', secret, assignments: [], priority: 100, ownerUserId: null, actor: 'dana' }, 'en')
    await expect(add('sk-or-v1-' + 'x'.repeat(64))).rejects.toThrow('The provider did not accept this key.')
    const c = await add('sk-or-v1-' + 'd'.repeat(64)).catch(() => null)
    expect(c).toBeNull() // only OR_KEY is a real key here
    expect(calls).toEqual([{ url: 'https://openrouter.ai/api/v1/key', auth: 'Bearer sk-or-v1-' + 'x'.repeat(64) }, { url: 'https://openrouter.ai/api/v1/key', auth: 'Bearer sk-or-v1-' + 'd'.repeat(64) }])
    // OR_KEY is a connection of the fake gateway already (same database): the check runs before that would matter
    calls.length = 0
    // the owner hears where the copy is (credentials/service.ts duplicateConflict), never the key
    await expect(add(OR_KEY)).rejects.toThrow('This token or key is already used by the team connection')
    expect(calls).toEqual([])
  })
  test('the proxy forwards exactly the configured models: another id and any claude-* id are refused before anything goes out', async () => {
    seen.length = 0
    const ok = await call(tok('g2', GW_KEY), PRO)
    expect(ok.status).toBe(200)
    expect(seen).toEqual([{ path: '/api/v1/messages', key: OR_KEY, auth: null, model: PRO }])
    expect((await call(tok('g2', GW_KEY), FLASH)).status).toBe(200)
    seen.length = 0
    for (const m of ['claude-sonnet-5-5', 'claude-opus-5-5', 'deepseek/deepseek-v3', 'opus', `${PRO} `]) {
      const r = await call(tok('g2', GW_KEY), m)
      expect(r.status, m).toBe(403)
      expect((await r.json()).error.message).toBe("refused by the team server: model is not one of this server's gateway models")
    }
    expect(seen).toEqual([])
  })
  test('count_tokens: the gateway\'s 404 comes back as it is, the connection stays fine and the next answer works', async () => {
    seen.length = 0; proxyLog.length = 0
    const r = await call(tok('g3', GW_KEY), PRO, { path: '/v1/messages/count_tokens' })
    expect(r.status).toBe(404)
    expect(seen.map((s) => s.path)).toEqual(['/api/v1/messages/count_tokens'])
    expect(getRow(env.db, GW_KEY)!.status).toBe('ok')
    expect(proxyLog).toEqual([]) // not logged as a failure
    expect((await call(tok('g3', GW_KEY), PRO)).status).toBe(200)
    // a claude-* id on count_tokens is refused like on messages
    expect((await call(tok('g3', GW_KEY), 'claude-haiku-5-5', { path: '/v1/messages/count_tokens' })).status).toBe(403)
  })
  test('cost: the server.json price of the model that was asked for (cache reads at the input price), streamed or not', async () => {
    const cost = (turn: string) => (env.db.query('SELECT cost_usd FROM turns WHERE id = ?').get(turn) as { cost_usd: number }).cost_usd
    await (await call(tok('g4', GW_KEY), PRO, { stream: true })).text()
    // 1M in at 1.6 + 1M cache reads at 1.6 + 1M out at 3.2
    expect(cost('g4')).toBeCloseTo(1.6 + 1.6 + 3.2, 6)
    await (await call(tok('g4', GW_KEY), PRO)).text()
    expect(cost('g4')).toBeCloseTo(2 * (1.6 + 1.6 + 3.2), 6)
    // FLASH has no price: the most expensive Claude price, logged once (its first answer was in the allow-list test)
    const before = cost('g4')
    await (await call(tok('g4', GW_KEY), FLASH)).text()
    await (await call(tok('g4', GW_KEY), FLASH)).text()
    expect(cost('g4') - before).toBeCloseTo(2 * (CLAUDE_MAX.in + CLAUDE_MAX.cr + CLAUDE_MAX.out), 6)
    expect(warns.filter((w) => w.msg.startsWith('a model has no price'))).toEqual([{ msg: expect.any(String), f: { model: FLASH, hint: 'engine.anthropicGateway.prices' } }])
  })
  test('replacing the key of an Anthropic key connection with a gateway key makes it the gateway\'s', async () => {
    await expect(replaceSecret(t.cc, OLD_KEY, ANTHROPIC_KEY.replace('K', 'M'), 'dana', 'en')).rejects.toThrow(/AI gateway/)
    await expect(replaceSecret(t.cc, OLD_KEY, 'sk-or-v1-' + 'b'.repeat(64), 'dana', 'en')).rejects.toThrow('The provider did not accept this key.')
    expect(metaOf(getRow(env.db, OLD_KEY)!).gateway).toBeUndefined()
    const c = await replaceSecret(t.cc, OLD_KEY, OR_KEY2, 'dana', 'en')
    expect(c.state).toBe('ok')
    expect(metaOf(getRow(env.db, OLD_KEY)!).gateway).toBe(HOST)
    seen.length = 0
    expect((await call(tok('g1', OLD_KEY), PRO)).status).toBe(200)
    expect(seen.map((s) => s.key)).toEqual([OR_KEY2])
  })
})

describe('pricing', () => {
  const g = { baseUrl: 'https://deepseek.example/anthropic', prices: { [PRO]: { input: 2, output: 4, cacheRead: 0.2, cacheWrite: 2.5 } } }
  const or = { baseUrl: 'https://openrouter.ai/api', prices: { [PRO]: { input: 1, output: 1 } } }
  const u = { input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6 }
  test('configured prices, cache fields when given', () => {
    expect(costOf('anthropic-api-key', PRO, u, g)).toBeCloseTo(2 + 4 + 0.2 + 2.5, 6)
  })
  test('OpenRouter: what it charged (usage.cost) when above 0 and not the team\'s own provider key', () => {
    expect(costOf('anthropic-api-key', PRO, { ...u, cost: 0.0123 }, or)).toBe(0.0123)
    expect(costOf('anthropic-api-key', PRO, { ...u, cost: 0.0123, is_byok: true }, or)).toBeCloseTo(4, 6)
    expect(costOf('anthropic-api-key', PRO, { ...u, cost: 0 }, or)).toBeCloseTo(4, 6)
    // another gateway's `cost` is not read (its unit is not known)
    expect(costOf('anthropic-api-key', PRO, { ...u, cost: 0.0123 }, g)).toBeCloseTo(8.7, 6)
  })
  test('an unpriced gateway model: the most expensive Claude price; without the gateway: unchanged', () => {
    expect(costOf('anthropic-api-key', 'moonshotai/kimi-k3', { input_tokens: 1e6 }, g)).toBe(CLAUDE_MAX.in)
    expect(costOf('anthropic-api-key', 'claude-opus-5-5', { input_tokens: 1e6 })).toBeCloseTo(4, 6)
    expect(costOf('anthropic-api-key', 'claude-opus-5-5', { input_tokens: 1e6 }, null)).toBeCloseTo(4, 6)
    expect(costOf('anthropic-oauth', PRO, u, g)).toBe(0)
  })
})

describe('proxy model rule without the gateway', () => {
  const body = (model: string) => ({ model, max_tokens: 5, messages: [] })
  const url = new URL('http://p/v1/messages')
  test('Claude names only, as before; with the gateway exactly its ids', () => {
    expect(checkProxyRequest('POST', url, body('claude-sonnet-5-5'))).toBeNull()
    expect(checkProxyRequest('POST', url, body(PRO))).toBe('model is not a Claude model name')
    const ids = new Set([PRO, FLASH])
    expect(checkProxyRequest('POST', url, body(PRO), ids)).toBeNull()
    expect(checkProxyRequest('POST', url, body('claude-sonnet-5-5'), ids)).toBe("model is not one of this server's gateway models")
    expect(checkProxyRequest('POST', url, { messages: [] }, ids)).toBe("model is not one of this server's gateway models")
  })
})

describe('engine environment and the admin model list', () => {
  const base = { turnId: 't', chatDir: '/chats/c1', token: 'tok', systemPrompt: 's', message: 'm', sessionId: 'x', resume: false, stash: null, maxTurns: 3, timeoutMs: 1, proxyToken: 'mpx_1', tokenKind: 'api-key' as const }
  const managed = { bin: 'c', authMode: 'managed' as const, agentHome: '/a', modelProxy: { baseUrl: 'http://127.0.0.1:9' } }
  const arg = (a: string[], f: string) => (a.includes(f) ? a[a.indexOf(f) + 1] : undefined)
  test('every alias and the small fast model name a gateway model (missing ones are the default); no choice = the default', () => {
    const r = buildClaudeLaunch(base, { ...managed, gatewayModels: { default: PRO, haiku: FLASH } })
    expect(r.env).toMatchObject({ ANTHROPIC_DEFAULT_OPUS_MODEL: PRO, ANTHROPIC_DEFAULT_SONNET_MODEL: PRO, ANTHROPIC_DEFAULT_HAIKU_MODEL: FLASH, ANTHROPIC_SMALL_FAST_MODEL: FLASH })
    expect(arg(r.args, '--model')).toBe(PRO)
    const all = buildClaudeLaunch({ ...base, model: 'opus' }, { ...managed, gatewayModels: { default: PRO, opus: 'moonshotai/kimi-k3', sonnet: 'z-ai/glm-5.3', haiku: FLASH } })
    expect(all.env).toMatchObject({ ANTHROPIC_DEFAULT_OPUS_MODEL: 'moonshotai/kimi-k3', ANTHROPIC_DEFAULT_SONNET_MODEL: 'z-ai/glm-5.3', ANTHROPIC_DEFAULT_HAIKU_MODEL: FLASH })
    expect(arg(all.args, '--model')).toBe('opus') // a chosen model (an alias here) stays
  })
  test('without the gateway: none of them, and no --model when nobody chose one', () => {
    const r = buildClaudeLaunch(base, managed)
    for (const k of ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL']) expect(r.env[k]).toBeUndefined()
    expect(r.args).not.toContain('--model')
  })
  test('Admin > AI engines lists the gateway models (default first, once each) instead of opus / sonnet / haiku', async () => {
    const engine = (anthropicGateway?: AnthropicGatewayConf) => ({ engine: { authMode: 'managed' as const, ...(anthropicGateway ? { anthropicGateway } : {}) } })
    expect(claudeModels(engine({ baseUrl: 'https://openrouter.ai/api', models: { default: PRO, opus: PRO, haiku: FLASH } }))).toEqual([{ id: PRO, label: PRO }, { id: FLASH, label: FLASH }])
    expect(claudeModels(engine())).toBe(CLAUDE_MODELS)
    const env0: EngineEnv = { mode: 'prod', authMode: 'managed', claudeBin: path.join(WORK, 'no-such-claude'), codexBin: '', dataDir: WORK, secretsDir: WORK, versionsFile: null, codexCatalogs: [] }
    expect((await checkEngine('claude-code', { ...env0, claudeModels: claudeModels(engine(GW)) }, true, 'en')).models.map((m) => m.id)).toEqual([PRO, FLASH])
    expect((await checkEngine('claude-code', env0, true, 'en')).models.map((m) => m.id)).toEqual(['opus', 'sonnet', 'haiku'])
  })
})
