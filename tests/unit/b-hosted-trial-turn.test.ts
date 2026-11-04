// A Claude turn on the hosting service's trial AI credit (docs/DECISIONS.md "B — Hosted trial AI credit"): with no AI
// connection it answers through the same path as an Anthropic API key connection, held to the trial model, with the
// credit that is left as the attempt's budget; a connection the team adds takes over; a used or ended credit gives its
// own error before any engine runs, and one used up during the turn stops it there. Admin › AI connections reads it from
// GET /api/admin/trial-credit. Real launcher, fake engine, fake model service.
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API } from '@mycel/shared/api'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { addCred } from '../lib/credentials'
import { setSetting } from '../../server/src/admin/settings'
import { LIMIT_FALLBACK_KEY } from '../../server/src/admin/engine-choice'
import { credentialsOf } from '../../server/src/credentials/store'
import { chargeHostedChat, HOSTED_CHAT_ID, HOSTED_CHAT_KEY_SETTING, HOSTED_CHAT_MODEL, HOSTED_CHAT_USAGE_SETTING, hostedChatUsedUsd, writeHostedChatKey } from '../../server/src/credentials/hosted-chat'
import { claudeCost } from '../../server/src/credentials/prices'
import type { LaunchRequest } from '../../shared/src/engine'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const KEY = 'sk-ant-api03-TRIAL-TURN-' + 'k'.repeat(30)
const TEAM_KEY = 'sk-ant-api03-TEAM-TURN-' + 't'.repeat(30)
const LIMITED_KEY = 'sk-ant-api03-LIMITED-TURN-' + 'l'.repeat(30)
const OKEY = 'sk-proj-' + 'O'.repeat(40)
const USAGE = { input_tokens: 10_000, output_tokens: 2_000 }
const EACH = claudeCost(HOSTED_CHAT_MODEL, USAGE)
const seen: { key: string | null; model: string }[] = []
/** runs when the fake receives a trial request, before it answers; returning a status answers with it instead */
let onTrial: (() => number | void) | null = null
const enc = new TextEncoder()
const ev = (o: unknown) => enc.encode(`event: e\ndata: ${JSON.stringify(o)}\n\n`)
const up = Bun.serve({
  port: 0, hostname: '127.0.0.1', idleTimeout: 0,
  async fetch(req) {
    if (new URL(req.url).pathname.endsWith('/responses')) {
      await req.text()
      seen.push({ key: 'openai', model: '' })
      return new Response(`event: x\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'codex answered' })}\n\nevent: x\ndata: ${JSON.stringify({ type: 'response.completed', response: { model: 'gpt-5.4', output: [], usage: { input_tokens: 5, output_tokens: 2 } } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    }
    const body = await req.json() as { model: string }
    const key = req.headers.get('x-api-key')
    seen.push({ key, model: body.model })
    if (key === LIMITED_KEY) return Response.json({ type: 'error', error: { type: 'rate_limit_error', message: 'limit' } }, { status: 429, headers: { 'retry-after': '3600' } })
    const st = key === KEY ? onTrial?.() : undefined
    if (st) return Response.json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, { status: st })
    return new Response(new ReadableStream<Uint8Array>({ start(c) {
      c.enqueue(ev({ type: 'message_start', message: { model: body.model, usage: { input_tokens: USAGE.input_tokens, output_tokens: 1 } } }))
      c.enqueue(ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: key === KEY ? 'trial answered ' : 'team answered ' } }))
      c.enqueue(ev({ type: 'message_delta', usage: { output_tokens: USAGE.output_tokens } }))
      c.close()
    } }), { headers: { 'content-type': 'text/event-stream' } })
  },
})
let h: Harness
let alice: TestSocket
beforeAll(async () => {
  const u = `http://127.0.0.1:${up.port}`
  h = await startHarness({ name: 'b-hosted-trial', turnTimeoutMs: 60_000, upstreams: { anthropic: u, openai: u + '/v1' }, credentials: [] })
  alice = await h.ws('alice', { windowId: 'win-alice-trial' }); await alice.next('hello')
})
afterAll(async () => { alice?.close(); await h?.close(); up.stop(true) })
const grant = (o: Partial<{ capUsd: number; endsAt: string; enabled: boolean }> = {}) =>
  writeHostedChatKey(credentialsOf(h.ctx), { key: KEY, capUsd: 1, endsAt: new Date(Date.now() + 14 * 86400_000).toISOString(), enabled: true, ...o })
const newChat = () => h.api('alice').call(API.createChat, { body: { engine: 'claude-code' } })
/** every launch request of the turns from here on (env, args, files), as JSON */
const launches: string[] = []
beforeAll(async () => {
  const launcher = (await h.ctx.core()).launcher!
  const orig = launcher.launch.bind(launcher)
  launcher.launch = (req: LaunchRequest) => { launches.push(JSON.stringify(req)); return orig(req) }
})
beforeEach(() => {
  seen.length = 0; launches.length = 0; onTrial = null
  h.ctx.db.query('DELETE FROM engine_credentials').run()
  h.ctx.db.query('DELETE FROM settings WHERE key IN (?, ?)').run(HOSTED_CHAT_KEY_SETTING, HOSTED_CHAT_USAGE_SETTING)
})

describe('a turn on the trial credit', () => {
  test('nothing connected: the trial key answers on the trial model, its cost counted, the rest of the credit as the budget', async () => {
    grant()
    const { started, done } = await ask(h, alice, 'alice', (await newChat()).id, fake({ modelAny: 'hi' }), { ms: 30_000 })
    expect(done.status).toBe('done')
    expect(done.content).toContain('trial answered')
    // the engine named the trial model (--model and its aliases): the proxy forwards no other; the answer says so
    expect(seen).toEqual([{ key: KEY, model: HOSTED_CHAT_MODEL }])
    expect(done.model).toBe(HOSTED_CHAT_MODEL)
    expect((h.ctx.db.query('SELECT model FROM turns WHERE id = ?').get(started.turnId) as { model: string }).model).toBe(HOSTED_CHAT_MODEL)
    const turn = h.ctx.db.query('SELECT credential_id, cost_usd FROM turns WHERE id = ?').get(started.turnId) as { credential_id: string; cost_usd: number }
    expect(turn.credential_id).toBe(HOSTED_CHAT_ID)
    expect(turn.cost_usd).toBeCloseTo(EACH, 9)
    expect(hostedChatUsedUsd(h.ctx.db)).toBeCloseTo(EACH, 9)
    const tok = h.ctx.db.query('SELECT budget_usd FROM proxy_tokens WHERE turn_id = ?').get(started.turnId) as { budget_usd: number }
    expect(tok.budget_usd).toBeCloseTo(1, 9)
  })
  test('a connection the team adds answers instead; the credit is not touched', async () => {
    grant()
    addCred(credentialsOf(h.ctx), 'anthropic-api-key', TEAM_KEY, { label: 'team' })
    const { done } = await ask(h, alice, 'alice', (await newChat()).id, fake({ modelAny: 'hi' }), { ms: 30_000 })
    expect(done.content).toContain('team answered')
    expect(seen.map((s) => s.key)).toEqual([TEAM_KEY])
    expect(hostedChatUsedUsd(h.ctx.db)).toBe(0)
  })
  test('a subscription at its limit with the admin\'s Codex fallback on: the team\'s Codex answers, not the credit', async () => {
    grant()
    const cc = credentialsOf(h.ctx)
    addCred(cc, 'anthropic-api-key', LIMITED_KEY, { label: 'limited' })
    addCred(cc, 'openai-api-key', OKEY, { label: 'codex' })
    setSetting(h.ctx.db, LIMIT_FALLBACK_KEY, true)
    try {
      const { done } = await ask(h, alice, 'alice', (await newChat()).id, fake({ modelAny: 'hi' }), { ms: 30_000 })
      expect(done.content).toContain('codex answered')
      expect(seen.map((s) => s.key)).toEqual([LIMITED_KEY, 'openai'])
      expect(hostedChatUsedUsd(h.ctx.db)).toBe(0)
      // the next turn starts with the subscription still at its limit: Codex again, the credit untouched
      seen.length = 0
      const next = await ask(h, alice, 'alice', (await newChat()).id, fake({ modelAny: 'hi' }), { ms: 30_000 })
      expect(next.done.content).toContain('codex answered')
      expect(seen.map((s) => s.key)).toEqual(['openai'])
    } finally { setSetting(h.ctx.db, LIMIT_FALLBACK_KEY, false) }
    // without the fallback the credit answers while the subscription waits
    seen.length = 0
    const r = await ask(h, alice, 'alice', (await newChat()).id, fake({ modelAny: 'hi' }), { ms: 30_000 })
    expect(r.done.content).toContain('trial answered')
    expect(seen.map((s) => s.key)).toEqual([KEY])
  })
  test('used up or ended: its own error before any engine runs', async () => {
    grant({ capUsd: 0.5 })
    chargeHostedChat(h.ctx.db, 0.5)
    const used = await ask(h, alice, 'alice', (await newChat()).id, fake({ modelAny: 'hi' }), { ms: 30_000 })
    expect(used.done.status).toBe('error')
    expect(used.done.error).toMatchObject({ code: 'engine_unavailable', params: { reason: 'trial_credit_used' } })
    grant({ enabled: false })
    const ended = await ask(h, alice, 'alice', (await newChat()).id, fake({ modelAny: 'hi' }), { ms: 30_000 })
    expect(ended.done.error).toMatchObject({ code: 'engine_unavailable', params: { reason: 'trial_ended' } })
    expect(seen).toEqual([])
  })
  test('used up during the turn: the request past the credit is not sent and the answer stops with "used"', async () => {
    grant({ capUsd: EACH * 1.5 })
    const { done } = await ask(h, alice, 'alice', (await newChat()).id, fake({ modelAny: 'one' }, { modelAny: 'two' }, { modelAny: 'three' }), { ms: 30_000 })
    expect(done.status).toBe('error')
    expect(done.error).toMatchObject({ params: { reason: 'trial_credit_used' } })
    // the second request went while some credit was left; the third was refused before it was sent
    expect(seen.length).toBe(2)
  })
})

describe('a trial turn, more closely', () => {
  test('the launch (environment, arguments, files) never holds the key; the engine sees no credential', async () => {
    grant()
    const { done } = await ask(h, alice, 'alice', (await newChat()).id, fake({ echo: 'secrets' }, { modelAny: 'hi' }), { ms: 30_000 })
    expect(done.status).toBe('done')
    expect(done.content).toContain('envSecrets=none argvSecrets=none')
    expect(launches.length).toBeGreaterThan(0)
    for (const l of launches) expect(l).not.toContain('TRIAL-TURN')
    // what it does hold: the trial model, as --model and every alias
    const lr = JSON.parse(launches[0]!) as LaunchRequest & { env: Record<string, string>; args: string[] }
    expect(lr.args[lr.args.indexOf('--model') + 1]).toBe(HOSTED_CHAT_MODEL)
    expect(lr.env).toMatchObject({ ANTHROPIC_DEFAULT_OPUS_MODEL: HOSTED_CHAT_MODEL, ANTHROPIC_DEFAULT_SONNET_MODEL: HOSTED_CHAT_MODEL, ANTHROPIC_DEFAULT_HAIKU_MODEL: HOSTED_CHAT_MODEL, ANTHROPIC_SMALL_FAST_MODEL: HOSTED_CHAT_MODEL })
  })
  test('the credit switched off while a turn runs: its next request is refused and the answer stops', async () => {
    grant()
    onTrial = () => { onTrial = null; grant({ enabled: false }) }
    const { done } = await ask(h, alice, 'alice', (await newChat()).id, fake({ modelAny: 'one' }, { modelAny: 'two' }), { ms: 30_000 })
    expect(done.status).toBe('error')
    expect(done.error).toMatchObject({ params: { reason: 'trial_ended' } })
    expect(seen.map((s) => s.key)).toEqual([KEY])
  })
  test('the trial key refused mid-turn and a team connection usable again: the turn goes on there, on the model chosen', async () => {
    grant()
    const team = addCred(credentialsOf(h.ctx), 'anthropic-api-key', TEAM_KEY, { label: 'team' })
    h.ctx.db.query('UPDATE engine_credentials SET limited_until = ? WHERE id = ?').run(new Date(Date.now() + 3600_000).toISOString(), team)
    // the team connection's limit ends while the trial request is out, and Anthropic refuses the trial key
    onTrial = () => { h.ctx.db.query('UPDATE engine_credentials SET limited_until = NULL WHERE id = ?').run(team); return 401 }
    const chat = await h.api('alice').call(API.createChat, { body: { engine: 'claude-code', model: 'opus' } })
    const { started, done } = await ask(h, alice, 'alice', chat.id, fake({ modelAny: 'hi' }), { ms: 30_000 })
    expect(done.status).toBe('done')
    expect(done.content).toContain('team answered')
    expect(seen.map((s) => [s.key, s.model])).toEqual([[KEY, HOSTED_CHAT_MODEL], [TEAM_KEY, 'claude-sonnet-4-5']])
    // the second attempt runs on the choice again (--model opus, no pinned aliases), and the answer says so
    const second = JSON.parse(launches.at(-1)!) as { env: Record<string, string>; args: string[] }
    expect(second.args[second.args.indexOf('--model') + 1]).toBe('opus')
    expect(second.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined()
    expect(done.model).toBe('opus')
    expect((h.ctx.db.query('SELECT model, credential_id FROM turns WHERE id = ?').get(started.turnId) as { model: string; credential_id: string })).toEqual({ model: 'opus', credential_id: team })
  })
})

describe('GET /api/admin/trial-credit', () => {
  test('owner and admins: active, used of the cap, the end; members cannot; null without a credit', async () => {
    const engine = h.ctx.config.engine
    const was = engine.authMode
    engine.authMode = 'managed' // the hosted servers that hold a trial credit answer with AI connections
    try {
      expect(await h.api('dana').call(API.trialCredit)).toEqual({ credit: null })
      const endsAt = new Date(Date.now() + 7 * 86400_000).toISOString()
      grant({ capUsd: 10, endsAt })
      chargeHostedChat(h.ctx.db, 2.5)
      for (const who of ['dana', 'carol']) {
        expect(await h.api(who).call(API.trialCredit)).toEqual({ credit: { active: true, state: 'active', usedUsd: 2.5, capUsd: 10, endsAt, model: HOSTED_CHAT_MODEL } })
      }
      const r = await h.req('alice', '/api/admin/trial-credit')
      expect(r.status).toBe(403)
      expect(await r.text()).not.toContain('TRIAL-TURN')
    } finally { engine.authMode = was }
    // a server whose engines use their own sign-in never uses it
    expect(await h.api('dana').call(API.trialCredit)).toEqual({ credit: null })
  })
})
