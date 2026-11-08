// The hosting service's trial AI credit (docs/DECISIONS.md "Z — trial credit on the API engine", which replaces the
// Claude Code parts of "B — Hosted trial AI credit"): the tenant command and admin.js (an OpenRouter key, never a direct
// Anthropic one), that no Claude Code launch can ever get the key (the resolver never offers it, the model proxy and
// its broker refuse its id), the meter of the API engine (the key per completion, max_tokens, the cost counted, refused
// before sending once the cap is used, past its end or switched off, holds in flight, a refused key, OpenRouter's own
// limit as a used credit, a broken-off answer), what the owner sees, and its storage (encrypted, rekeyed, dropped off a
// server that is not hosted, left out of the export, kept over a restore). Every provider here is a local fake.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import type { EngineEvent } from '@mycel/shared'
import { tenantCommandProblem, TENANT_COMMANDS } from '@mycel/shared/cloud-protocol'
import { ALL_CREDENTIAL_KINDS, type AppConfig } from '../../server/src/app-config'
import { setEnginesEnabled, setSetting } from '../../server/src/admin/settings'
import { canUseAi, connectionRoute, newMemberAi } from '../../server/src/credentials/access'
import { LIMIT_FALLBACK_KEY } from '../../server/src/admin/engine-choice'
import { createBroker } from '../../server/src/credentials/broker'
import {
  chargeHostedChat, createTrialMeter, dropHostedChatKey, HOSTED_CHAT_ID, HOSTED_CHAT_KEY_SETTING, HOSTED_CHAT_MAX_TOKENS, HOSTED_CHAT_MODEL,
  HOSTED_CHAT_USAGE_SETTING, hostedChatConf, hostedChatHeldUsd, hostedChatLeftUsd, hostedChatState, hostedChatUsedUsd, isOpenRouterLimitError,
  readHostedChatKey, TRIAL_BYTES_PER_TOKEN, trialCredit, trialEstimate, trialEstimateUsd, writeHostedChatKey,
} from '../../server/src/credentials/hosted-chat'
import { claudeCost } from '../../server/src/credentials/prices'
import { rekeyCredentials } from '../../server/src/credentials/rekey'
import { hasCredentialFor, hasCredentialSoonFor, MEMBER_OWN_KEY, resolveCredential } from '../../server/src/credentials/resolve'
import { runApiAgent, type ApiMeter } from '../../server/src/engine/api-agent'
import { issueProxyToken, startModelProxy, type ProxyTurnEvent } from '../../server/src/proxy/model-proxy'
import { keepServerSettings, withoutHostingKey } from '../../server/src/system/backup'
import { setHostedChatKey } from '../../server/src/system/cloud-tenant'
import { openDb } from '../../server/src/db'
import { addCred, testCredCtx } from '../lib/credentials'
import { makeEnv } from '../lib/env'

const KEY = 'sk-or-v1-TRIAL-CANARY-' + 'k'.repeat(40)
const KEY2 = 'sk-or-v1-TRIAL-ROTATED-' + 'r'.repeat(40)
const ANT_KEY = 'sk-ant-api03-TRIAL-ANT-' + 'a'.repeat(30)
const TEAM_KEY = 'sk-ant-api03-TEAM-' + 't'.repeat(30)
const OPENAI_KEY = 'sk-proj-TEAM-' + 'o'.repeat(40)
const ALL = new Set(ALL_CREDENTIAL_KINDS)
const DAY = 86400_000
const future = () => new Date(Date.now() + 14 * DAY).toISOString()

// a fake Anthropic behind the model proxy: anything it receives is recorded (the trial key must never get there)
const anthropicSeen: { key: string | null; auth: string | null }[] = []
const anthropic = Bun.serve({
  port: 0, hostname: '127.0.0.1',
  async fetch(req) {
    await req.text()
    anthropicSeen.push({ key: req.headers.get('x-api-key'), auth: req.headers.get('authorization') })
    return Response.json({ id: 'm', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } })
  },
})

const env = makeEnv('a-hosted-trial')
const secrets = path.join(env.fx.data, 'secrets')
const t = testCredCtx(env.db, secrets, { upstreams: { anthropic: `http://127.0.0.1:${anthropic.port}` } })
const broker = createBroker(t.cc)
const events: { turn: string; ev: ProxyTurnEvent }[] = []
const proxy = await startModelProxy({ db: env.db, broker, onTurnEvent: (turn, ev) => { events.push({ turn, ev }) }, log: { warn: () => {}, debug: () => {} } })
afterAll(async () => { await proxy.stop(); anthropic.stop(true) })

const grant = (o: Partial<{ key: string; capUsd: number; endsAt: string; enabled: boolean }> = {}) =>
  writeHostedChatKey(t.cc, { key: KEY, capUsd: 1, endsAt: future(), enabled: true, ...o })
const resolve = (userId = 'alice', engine: 'claude-code' | 'codex' = 'claude-code', exclude?: Set<string>) =>
  resolveCredential(env.db, { userId, engine, allowedKinds: ALL, ...(exclude ? { exclude } : {}) })

// ---------------- a fake OpenRouter for the API engine (fetch injected) ----------------

interface Sent { auth: string | null; body: { model: string; max_tokens?: number; messages: unknown[] } }
const sent: Sent[] = []
/** what the fake answers each completion with: a stream with usage (cost as OpenRouter reports it), an HTTP refusal,
 * an error inside the stream, a stream without its usage (broken off) */
type Reply = { cost?: number | null; text?: string } | { status: number; body: unknown } | { streamError: unknown } | { cut: true }
let replies: Reply[] = []
const USAGE = { prompt_tokens: 10_000, completion_tokens: 2_000 }
const sse = (lines: unknown[]) => lines.map((l) => `data: ${JSON.stringify(l)}\n\n`).join('') + 'data: [DONE]\n\n'
const fakeOpenRouter = (async (_url: string, init: RequestInit) => {
  sent.push({ auth: new Headers(init.headers).get('authorization'), body: JSON.parse(String(init.body)) })
  const r = replies.shift() ?? {}
  if ('status' in r) return Response.json(r.body, { status: r.status })
  if ('streamError' in r) return new Response(sse([{ choices: [{ delta: { content: 'part' } }] }, { error: r.streamError, choices: [{ finish_reason: 'error' }] }]))
  if ('cut' in r) return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'part' } }] })}\n\n`)
  return new Response(sse([{ id: 'gen-1', choices: [{ delta: { content: r.text ?? 'answer' } }] },
    { choices: [], usage: { ...USAGE, ...(r.cost === null ? {} : { cost: r.cost ?? 0.002 }) } }]))
}) as unknown as typeof fetch
const noTools = async (m: any) => (m.method === 'tools/list' ? { result: { tools: [] } } : { result: { content: [] } })
/** one trial answer of `steps` completions (each but the last calls a tool), metered like chat/turn.ts does */
async function answer(o: { steps?: number; signal?: AbortSignal } = {}) {
  const stops: string[] = []
  const evs: EngineEvent[] = []
  const meter = createTrialMeter(t.cc, (r) => stops.push(r))
  const steps = o.steps ?? 1
  let n = 0
  const rpc = async (m: any) => m.method === 'tools/list'
    ? { result: { tools: [{ name: 'list', description: 'List', inputSchema: { type: 'object' } }] } }
    : { result: { content: [{ type: 'text', text: 'a.md' }] } }
  // a completion that calls a tool until the last one
  const f = (async (u: string, init: RequestInit) => {
    n++
    if (n < steps && !replies.length) {
      sent.push({ auth: new Headers(init.headers).get('authorization'), body: JSON.parse(String(init.body)) })
      return new Response(sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: `c${n}`, function: { name: 'list', arguments: '{}' } }] } }] }, { choices: [], usage: { ...USAGE, cost: 0.002 } }]))
    }
    return fakeOpenRouter(u, init)
  }) as unknown as typeof fetch
  await runApiAgent({ conf: hostedChatConf({ engine: { authMode: 'managed' } }), systemPrompt: 'sys', message: 'hi', rpc: steps > 1 ? rpc : noTools, emit: (e) => evs.push(e), signal: o.signal ?? new AbortController().signal, fetchFn: f, meter, maxTokens: HOSTED_CHAT_MAX_TOKENS })
  return { stops, evs, errors: evs.filter((e) => e.type === 'error') }
}

beforeEach(() => {
  env.db.query('DELETE FROM engine_credentials').run()
  env.db.query('DELETE FROM settings WHERE key IN (?, ?, ?)').run(HOSTED_CHAT_KEY_SETTING, HOSTED_CHAT_USAGE_SETTING, LIMIT_FALLBACK_KEY)
  setSetting(env.db, MEMBER_OWN_KEY, false)
  setEnginesEnabled(env.db, { 'claude-code': true, codex: true })
  anthropicSeen.length = 0; events.length = 0; sent.length = 0; replies = []
})

describe('the tenant command hosted-chat-key-set (mycel-ctl → admin.js hosted-chat-key)', () => {
  test('the gate: an OpenRouter key with cap, end and switch, or { key: null }; a direct Anthropic key is refused', () => {
    expect(Object.keys(TENANT_COMMANDS)).toContain('hosted-chat-key-set')
    const ok = { key: KEY, capUsd: 10, endsAt: '2026-11-18T15:00:00Z', enabled: true }
    expect(tenantCommandProblem('hosted-chat-key-set', {}, ok)).toBeNull()
    expect(tenantCommandProblem('hosted-chat-key-set', {}, { key: null })).toBeNull()
    for (const bad of [
      { ...ok, key: ANT_KEY }, { ...ok, key: 'sk-ant-oat01-' + 'a'.repeat(40) }, { ...ok, key: 'sk-or-short' }, { ...ok, capUsd: -1 }, { ...ok, capUsd: 1001 },
      { ...ok, capUsd: '10' }, { ...ok, endsAt: 'tomorrow' }, { ...ok, enabled: 'yes' }, { ...ok, extra: 1 }, { key: KEY }, { key: null, capUsd: 1 }, null,
    ]) expect(tenantCommandProblem('hosted-chat-key-set', {}, bad), JSON.stringify(bad)).not.toBeNull()
    expect(tenantCommandProblem('hosted-chat-key-set', { key: KEY }, ok)).not.toBeNull() // never an argument
  })
  const o = (deployment: 'hosted' | 'self') => ({ db: env.db, secretsDir: secrets, config: { ...t.cc.config, deployment } as unknown as AppConfig, log: t.cc.log })
  test('hosted: set, paused, rotated and taken away; the answer says what was spent; audited without the key', () => {
    expect(setHostedChatKey(o('hosted'), { key: KEY, capUsd: 10, endsAt: '2026-11-18T15:00:00Z', enabled: true })).toEqual({ ok: true, set: true, usedUsd: 0 })
    expect(readHostedChatKey(t.cc)).toBe(KEY)
    chargeHostedChat(env.db, 1.25)
    // rotation keeps what was spent: the cap is for the whole trial
    expect(setHostedChatKey(o('hosted'), { key: KEY2, capUsd: 10, endsAt: '2026-11-18T15:00:00Z', enabled: false })).toEqual({ ok: true, set: true, usedUsd: 1.25 })
    expect(readHostedChatKey(t.cc)).toBe(KEY2)
    expect(hostedChatState(env.db, new Date('2026-11-10T00:00:00Z'))).toBe('ended') // paused
    expect(setHostedChatKey(o('hosted'), { key: null })).toEqual({ ok: true, set: false, usedUsd: 1.25 })
    expect(readHostedChatKey(t.cc)).toBeNull()
    expect(hostedChatState(env.db, new Date())).toBeNull()
    const rows = (env.db.query("SELECT actor_id, detail FROM audit_log WHERE action = 'ai.hosted_trial_key' ORDER BY rowid DESC LIMIT 3").all() as { actor_id: string | null; detail: string }[]).reverse()
    expect(rows.map((r) => [r.actor_id, JSON.parse(r.detail)])).toEqual([
      [null, { key: 'set', capUsd: 10, endsAt: '2026-11-18T15:00:00Z', enabled: true }],
      [null, { key: 'set', capUsd: 10, endsAt: '2026-11-18T15:00:00Z', enabled: false }],
      [null, { key: 'removed' }],
    ])
    expect(JSON.stringify(rows)).not.toContain('CANARY')
    expect(JSON.stringify(rows)).not.toContain('ROTATED')
  })
  test('refused on a server that is not hosted, and for anything else (a direct Anthropic key too); errors never hold the key', () => {
    expect(() => setHostedChatKey(o('self'), { key: KEY, capUsd: 10, endsAt: future(), enabled: true })).toThrow('hosted servers only')
    for (const bad of [{}, { key: 'sk-or-short' }, { key: KEY }, { key: KEY, capUsd: 1, endsAt: future(), enabled: true, x: 1 }, { key: 7 }, null, [],
      { key: ANT_KEY, capUsd: 1, endsAt: future(), enabled: true }]) {
      let msg = ''
      try { setHostedChatKey(o('hosted'), bad) } catch (e) { msg = (e as Error).message }
      expect(msg).toContain('stdin must be')
      expect(msg).not.toContain('CANARY')
      expect(msg).not.toContain('TRIAL-ANT')
    }
    expect(readHostedChatKey(t.cc)).toBeNull()
  })
  test('a row of the first, never released version (a direct Anthropic key for Claude Code) counts as no credit', () => {
    setSetting(env.db, HOSTED_CHAT_KEY_SETTING, { enc: 'x', keyVersion: 1, capUsd: 10, endsAt: future(), enabled: true, updatedAt: new Date().toISOString(), refusedAt: null })
    expect(hostedChatState(env.db, new Date())).toBeNull()
    expect(trialCredit(env.db, new Date())).toBeNull()
    expect(readHostedChatKey(t.cc)).toBeNull()
  })
})

describe('a Claude Code launch can never get the trial key', () => {
  test('the resolver never offers it: with the credit active and nothing connected, Claude and Codex have no connection', () => {
    grant()
    expect(hostedChatState(env.db, new Date())).toBe('active')
    for (const engine of ['claude-code', 'codex'] as const) {
      for (const who of ['alice', 'bob', 'dana']) {
        const r = resolve(who, engine)
        expect(r).toMatchObject({ ok: false, reason: 'none' })
        expect(JSON.stringify(r)).not.toContain(HOSTED_CHAT_ID)
      }
      expect(hasCredentialFor(env.db, 'alice', engine, ALL)).toBe(false)
      expect(hasCredentialSoonFor(env.db, 'alice', engine, ALL)).toBe(false)
    }
    // connections that cannot answer (refused, switched off, at a limit) fall through to nothing, never to the credit
    const team = addCred(t.cc, 'anthropic-api-key', TEAM_KEY, { label: 'team' })
    for (const set of ["status = 'invalid'", "status = 'ok', disabled = 1", `disabled = 0, limited_until = '${new Date(Date.now() + 3600_000).toISOString()}'`]) {
      env.db.query(`UPDATE engine_credentials SET ${set} WHERE id = ?`).run(team)
      const r = resolve()
      expect(r.ok).toBe(false)
      expect(JSON.stringify(r)).not.toContain(HOSTED_CHAT_ID)
    }
    // excluded connections (an attempt failed on them): still nothing
    env.db.query('UPDATE engine_credentials SET limited_until = NULL WHERE id = ?').run(team)
    expect(resolve('alice', 'claude-code', new Set([team]))).toMatchObject({ ok: false, reason: 'none' })
    expect(resolve()).toMatchObject({ ok: true, credentialId: team })
  })
  test('the model proxy refuses a token bound to the trial id: nothing is sent, the key goes on no request', async () => {
    grant()
    env.db.query("INSERT INTO turns (id, chat_id, user_id, engine, status) VALUES ('t-bound', 'c', 'alice', 'claude-code', 'running')").run()
    const token = issueProxyToken(env.db, 't-bound', 'alice', { credentialId: HOSTED_CHAT_ID, family: 'anthropic' })
    for (const model of ['claude-haiku-5-5', 'claude-sonnet-5-5']) {
      const r = await fetch(proxy.url + '/v1/messages', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': token, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }),
      })
      expect(r.status).toBe(403)
      expect(await r.text()).not.toContain('CANARY')
    }
    expect(anthropicSeen).toEqual([])
    expect(events.every((e) => e.ev.type === 'credential')).toBe(true)
    // and the broker itself never hands it out, for either family
    for (const fam of ['anthropic', 'openai'] as const) {
      const f = await broker.forRequest({ credentialId: HOSTED_CHAT_ID, family: fam, turnId: 't-bound', userId: 'alice' }, fam)
      expect(f.ok).toBe(false)
      expect(JSON.stringify(f)).not.toContain('CANARY')
    }
  })
})

describe('the team\'s own AI comes first, on either engine (connectionRoute, the turn and /api/me/ai-access)', () => {
  const ctx = { db: env.db, config: t.cc.config as unknown as AppConfig }
  const route = (engine: 'claude-code' | 'codex', who = 'alice') => connectionRoute(ctx, { id: who }, engine, { allowed: ALL })
  const limit = (id: string) => env.db.query('UPDATE engine_credentials SET limited_until = ? WHERE id = ?').run(new Date(Date.now() + 4 * 3600_000).toISOString(), id)
  /** "다른 AI로 대신 답하기" (Team settings) */
  const otherAi = (on: boolean) => setSetting(env.db, LIMIT_FALLBACK_KEY, on)
  test('neither "다른 AI로 대신 답하기" nor a trial credit: always the chat\'s own engine', () => {
    addCred(t.cc, 'openai-api-key', OPENAI_KEY, { label: 'codex' })
    expect(route('claude-code')).toBe('own')
    expect(route('codex')).toBe('own')
  })
  test('the switch, not the trial key, lets the other engine answer: on a server that never had a credit too', () => {
    otherAi(true)
    addCred(t.cc, 'openai-api-key', OPENAI_KEY, { label: 'codex' })
    expect(route('claude-code')).toBe('codex')
    expect(route('codex')).toBe('own')
    // a credit given and taken away changes nothing
    grant()
    writeHostedChatKey(t.cc, null)
    expect(route('claude-code')).toBe('codex')
    // the other way: a Codex chat with only a Claude connection goes to Claude Code
    env.db.query('DELETE FROM engine_credentials').run()
    addCred(t.cc, 'anthropic-api-key', TEAM_KEY, { label: 'team' })
    expect(route('codex')).toBe('claude-code')
    // off: the chat's own engine (its usual "no AI connection")
    otherAi(false)
    expect(route('codex')).toBe('own')
    // nothing of the person's on the other engine either: its own engine, the switch on or not
    otherAi(true)
    env.db.query('DELETE FROM engine_credentials').run()
    expect(route('claude-code')).toBe('own')
  })
  test('only ChatGPT / Codex connected with the switch on: Claude Code chats go to Codex, not to the credit, also once it is used up', () => {
    otherAi(true)
    grant()
    expect(route('claude-code')).toBe('trial')
    addCred(t.cc, 'openai-api-key', OPENAI_KEY, { label: 'codex' })
    expect(route('claude-code')).toBe('codex')
    expect(route('codex')).toBe('own')
    chargeHostedChat(env.db, 1)
    expect(route('claude-code')).toBe('codex')
  })
  test('the switch off with a credit: the chat\'s own engine (its usual "no AI connection"); the team has AI of its own, so never the credit', () => {
    grant()
    addCred(t.cc, 'openai-api-key', OPENAI_KEY, { label: 'codex' })
    expect(route('claude-code')).toBe('own')
    // a Claude connection at its limit beside it: the usual wait
    const claude = addCred(t.cc, 'anthropic-api-key', TEAM_KEY, { label: 'team' })
    limit(claude)
    expect(route('claude-code')).toBe('own')
  })
  test('a connection only at its limit while the other engine has one: the usual wait or Codex fallback, never the credit', () => {
    otherAi(true)
    grant()
    const claude = addCred(t.cc, 'anthropic-api-key', TEAM_KEY, { label: 'team' })
    limit(claude)
    expect(route('claude-code')).toBe('trial') // nothing else of the team's works now
    addCred(t.cc, 'openai-api-key', OPENAI_KEY, { label: 'codex' })
    expect(route('claude-code')).toBe('own')
  })
  test('the other engine switched off: it cannot take over, the credit answers; used up or ended: the usual errors', () => {
    otherAi(true)
    grant()
    addCred(t.cc, 'openai-api-key', OPENAI_KEY, { label: 'codex' })
    setEnginesEnabled(env.db, { codex: false })
    expect(route('claude-code')).toBe('trial')
    chargeHostedChat(env.db, 1)
    expect(route('claude-code')).toBe('own')
    grant({ enabled: false })
    expect(route('claude-code')).toBe('own')
  })
  test('the invite link\'s AI line (newMemberAi) counts the other engine the same way', () => {
    // a team connection for everyone on Codex only; a new member gets the team default (Claude Code)
    addCred(t.cc, 'openai-api-key', OPENAI_KEY, { label: 'codex' })
    expect(newMemberAi(ctx, [])).toBe('ask_owner')
    // an active credit does not answer while the team has AI of its own (the turn would say "no AI connection")
    grant()
    expect(newMemberAi(ctx, [])).toBe('ask_owner')
    otherAi(true)
    expect(newMemberAi(ctx, [])).toBe('ready')
    // Codex switched off: it cannot take over, and the credit answers again
    setEnginesEnabled(env.db, { codex: false })
    expect(newMemberAi(ctx, [])).toBe('ready')
    writeHostedChatKey(t.cc, null)
    expect(newMemberAi(ctx, [])).toBe('ask_owner')
  })
  test('the switch\'s limit case: a Claude connection at a long limit and a Codex connection is not "No AI" while the switch is on', () => {
    const member = { id: 'alice', role: 'member' }
    const claude = addCred(t.cc, 'anthropic-api-key', TEAM_KEY, { label: 'team' })
    limit(claude)
    addCred(t.cc, 'openai-api-key', OPENAI_KEY, { label: 'codex' })
    expect(canUseAi(ctx, member)).toBe(false) // a 4-hour limit: the usual wait
    otherAi(true)
    expect(canUseAi(ctx, member)).toBe(true) // Codex finishes those answers (chat/turn.ts limitFallback)
    setEnginesEnabled(env.db, { codex: false })
    expect(canUseAi(ctx, member)).toBe(false)
  })
  test('/api/me/ai-access says the same: usable exactly when something will answer', () => {
    // a member who cannot pick engines: the team default (Claude Code) answers their chats
    const member = { id: 'alice', role: 'member' }
    grant()
    expect(canUseAi(ctx, member)).toBe(true) // the credit
    chargeHostedChat(env.db, 1)
    expect(canUseAi(ctx, member)).toBe(false) // used up, nothing of the team's
    addCred(t.cc, 'openai-api-key', OPENAI_KEY, { label: 'codex' })
    expect(canUseAi(ctx, member)).toBe(false) // a Codex connection, but the switch is off: Claude Code chats need a Claude one
    otherAi(true)
    expect(canUseAi(ctx, member)).toBe(true) // Codex takes the Claude Code chats
    // the key taken away (or the team moved to its own server): the same, the switch decides (Admin › Members "No AI")
    writeHostedChatKey(t.cc, null)
    expect(canUseAi(ctx, member)).toBe(true)
    otherAi(false)
    expect(canUseAi(ctx, member)).toBe(false)
  })
})

describe('the meter of a trial answer (API engine)', () => {
  test('each completion goes to the trial model with the key read again, max_tokens set, and costs what OpenRouter reports', async () => {
    grant()
    const r = await answer({ steps: 2 })
    expect(r.errors).toEqual([])
    expect(r.stops).toEqual([])
    expect(sent.map((s) => [s.auth, s.body.model, s.body.max_tokens])).toEqual([
      [`Bearer ${KEY}`, HOSTED_CHAT_MODEL, HOSTED_CHAT_MAX_TOKENS], [`Bearer ${KEY}`, HOSTED_CHAT_MODEL, HOSTED_CHAT_MAX_TOKENS],
    ])
    expect(hostedChatUsedUsd(env.db)).toBeCloseTo(0.004, 9)
    expect(hostedChatHeldUsd(env.db)).toBe(0)
    // a rotated key is used from the next completion on
    grant({ key: KEY2 })
    await answer()
    expect(sent.at(-1)!.auth).toBe(`Bearer ${KEY2}`)
  })
  test('no cost in the answer: the list price of Claude Haiku 5.5', async () => {
    grant()
    replies = [{ cost: null }]
    await answer()
    expect(hostedChatUsedUsd(env.db)).toBeCloseTo(claudeCost('claude-haiku-5-5', { input_tokens: USAGE.prompt_tokens, output_tokens: USAGE.completion_tokens }), 9)
  })
  test('the cap used: the next completion is not sent, the answer stops with "used"; more credit answers again', async () => {
    grant({ capUsd: 0.003 })
    const r = await answer({ steps: 3 })
    // the second completion went while some credit was left (0.002 spent of 0.003); the third was refused before sending
    expect(sent.length).toBe(2)
    expect(r.stops).toEqual(['used'])
    expect(r.errors).toEqual([])
    expect(hostedChatState(env.db, new Date())).toBe('used')
    sent.length = 0
    expect((await answer()).stops).toEqual(['used'])
    expect(sent).toEqual([])
    grant({ capUsd: 1 })
    expect((await answer()).stops).toEqual([])
    expect(sent.length).toBe(1)
  })
  test('past its end, switched off or taken away: nothing is sent, "ended"', async () => {
    for (const g of [{ endsAt: new Date(Date.now() - 1000).toISOString() }, { enabled: false }]) {
      grant(g)
      expect((await answer()).stops).toEqual(['ended'])
    }
    writeHostedChatKey(t.cc, null)
    expect((await answer()).stops).toEqual(['ended'])
    expect(sent).toEqual([])
  })
  test('OpenRouter refuses the key (401): no completion goes out with it until a new key comes; a late 401 spares a rotated key', async () => {
    grant()
    replies = [{ status: 401, body: { error: { code: 401, message: 'User not found.' } } }]
    const r = await answer()
    expect(r.stops).toEqual(['ended'])
    expect(r.errors).toEqual([])
    expect(hostedChatState(env.db, new Date())).toBe('ended')
    expect(env.db.query("SELECT detail FROM audit_log WHERE action = 'credential.rejected' AND target = ? ORDER BY rowid DESC").get(HOSTED_CHAT_ID)).toBeTruthy()
    sent.length = 0
    expect((await answer()).stops).toEqual(['ended'])
    expect(sent).toEqual([])
    grant({ key: KEY2 })
    expect((await answer()).stops).toEqual([])
    // a 401 for the old key arriving now leaves the new one alone
    const m = createTrialMeter(t.cc, () => {})
    expect(m.refused(401, '{}', KEY)).toBe(true)
    expect(hostedChatState(env.db, new Date())).toBe('active')
  })
  test('OpenRouter\'s own limit on the key (the hosting service\'s backstop) reads as a used credit; other refusals pass on', async () => {
    grant()
    for (const reply of [
      { status: 402, body: { error: { code: 402, message: 'Your account or API key has insufficient credits. Add more credits and retry the request.' } } },
      { status: 403, body: { error: { code: 403, message: 'Key limit exceeded: $5 of $5 used; resets 2026-12-01T00:00:00Z.', metadata: { limit_source: 'openrouter_key_limit', scope: 'api_key' } } } },
    ] satisfies Reply[]) {
      replies = [reply]
      const r = await answer()
      expect(r.stops, JSON.stringify(reply)).toEqual(['used'])
      expect(r.errors).toEqual([])
      expect(hostedChatHeldUsd(env.db)).toBe(0)
    }
    replies = [{ status: 403, body: { error: { code: 403, message: 'Your chosen model requires moderation and your input was flagged' } } }]
    const flagged = await answer()
    expect(flagged.stops).toEqual([])
    expect(flagged.errors).toMatchObject([{ type: 'error', code: 'auth', status: 403 }])
    replies = [{ status: 500, body: { error: { code: 500, message: 'provider down' } } }]
    expect((await answer()).errors).toMatchObject([{ code: 'provider_error', status: 500 }])
    expect(hostedChatUsedUsd(env.db)).toBe(0) // refusals cost nothing
    expect(hostedChatHeldUsd(env.db)).toBe(0)
    // the limit said inside a stream that had started: "used" too, and the started answer counts its reservation
    replies = [{ streamError: { code: 402, message: 'Insufficient credits' } }]
    const inStream = await answer()
    expect(inStream.stops).toEqual(['used'])
    expect(inStream.errors).toEqual([])
    expect(hostedChatUsedUsd(env.db)).toBeGreaterThan(0)
    expect(hostedChatHeldUsd(env.db)).toBe(0)
  })
  test('an answer that started but whose usage never came counts its whole reservation (stopping cannot dodge the cost)', async () => {
    grant()
    replies = [{ cut: true }]
    await answer()
    expect(sent.length).toBe(1)
    const bytes = Buffer.byteLength(JSON.stringify(sent[0]!.body))
    expect(hostedChatUsedUsd(env.db)).toBeCloseTo(trialEstimateUsd(trialEstimate(bytes, HOSTED_CHAT_MAX_TOKENS)), 9)
    expect(hostedChatHeldUsd(env.db)).toBe(0)
  })
  test('many answers at once near the cap: the credit is passed by one completion\'s reservation at most', async () => {
    grant({ capUsd: 1 })
    const reservation = trialEstimateUsd(trialEstimate(2_000, HOSTED_CHAT_MAX_TOKENS))
    chargeHostedChat(env.db, 1 - reservation * 2.5) // room for two holds and a half
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const slow = (async (u: string, init: RequestInit) => { await gate; return fakeOpenRouter(u, init) }) as unknown as typeof fetch
    const stops: string[] = []
    const runs = Array.from({ length: 8 }, () => runApiAgent({ conf: hostedChatConf({ engine: { authMode: 'managed' } }), systemPrompt: 'sys', message: 'hi', rpc: noTools, emit: () => {}, signal: new AbortController().signal, fetchFn: slow,
      meter: createTrialMeter(t.cc, (r) => stops.push(r)), maxTokens: HOSTED_CHAT_MAX_TOKENS }))
    await Bun.sleep(50)
    // all eight tried at the same moment: three holds fit (the third starts under the cap), the rest are refused unsent
    expect(hostedChatHeldUsd(env.db)).toBeGreaterThan(0)
    release()
    await Promise.all(runs)
    expect(sent.length).toBe(3)
    expect(stops).toEqual(Array(5).fill('used'))
    expect(hostedChatUsedUsd(env.db)).toBeLessThanOrEqual(1 + reservation)
    expect(hostedChatHeldUsd(env.db)).toBe(0)
  })
  test('the reservation counts two bytes a token, so Korean text reaches the long-context price in the estimate in time', () => {
    expect(TRIAL_BYTES_PER_TOKEN).toBe(2)
    // 80,000 Hangul syllables: 240,000 bytes, about 80,000-160,000 tokens; at 3 bytes a token it would look like 80,000
    const body = JSON.stringify({ messages: [{ role: 'user', content: '가'.repeat(80_000) }] })
    const est = trialEstimate(Buffer.byteLength(body), 1_000)
    expect(est.inputTokens).toBeGreaterThan(100_000)
    // Claude Haiku 5.5 above 100,000 input tokens: $1 (1-hour cache write) / $2.50 per million
    expect(trialEstimateUsd(est)).toBeCloseTo(est.inputTokens * 1 / 1e6 + 1_000 * 2.5 / 1e6, 9)
    // below it the usual price ($0.20 / $0.50)
    expect(trialEstimateUsd(trialEstimate(180_000, 1_000))).toBeCloseTo(90_000 * 0.2 / 1e6 + 1_000 * 0.5 / 1e6, 9)
  })
  test('the meter alone: a completion that never got an answer gives its hold back', () => {
    grant()
    const m: ApiMeter = createTrialMeter(t.cc, () => {})
    expect(m.start({ bodyBytes: 3_000, maxTokens: 1_000 })).toEqual({ key: KEY })
    expect(hostedChatHeldUsd(env.db)).toBeCloseTo(trialEstimateUsd({ inputTokens: 1_500, maxTokens: 1_000 }), 12)
    m.end('none')
    expect(hostedChatHeldUsd(env.db)).toBe(0)
    expect(hostedChatUsedUsd(env.db)).toBe(0)
  })
  test('the limit errors OpenRouter sends', () => {
    expect(isOpenRouterLimitError(402, '')).toBe(true)
    expect(isOpenRouterLimitError(403, JSON.stringify({ error: { message: 'x', metadata: { limit_source: 'openrouter_key_limit' } } }))).toBe(true)
    expect(isOpenRouterLimitError(403, JSON.stringify({ error: { message: 'Key limit exceeded' } }))).toBe(true)
    expect(isOpenRouterLimitError(0, JSON.stringify({ code: 402, message: 'out' }))).toBe(true)
    expect(isOpenRouterLimitError(403, JSON.stringify({ error: { message: 'Your chosen model requires moderation' } }))).toBe(false)
    expect(isOpenRouterLimitError(401, JSON.stringify({ error: { message: 'insufficient credits' } }))).toBe(false)
    expect(isOpenRouterLimitError(500, 'insufficient credits')).toBe(false)
    expect(isOpenRouterLimitError(403, 'not json: key limit')).toBe(true)
  })
})

describe('what the owner and admins see', () => {
  test('used of the cap, the end, the model; never the key', () => {
    expect(trialCredit(env.db, new Date())).toBeNull()
    const ends = future()
    grant({ capUsd: 10, endsAt: ends })
    chargeHostedChat(env.db, 1.23456)
    expect(trialCredit(env.db, new Date())).toEqual({ active: true, state: 'active', usedUsd: 1.2346, capUsd: 10, endsAt: ends, model: HOSTED_CHAT_MODEL })
    expect(HOSTED_CHAT_MODEL).toBe('anthropic/claude-haiku-5.5')
    expect(hostedChatLeftUsd(env.db)).toBeCloseTo(10 - 1.23456, 9)
    chargeHostedChat(env.db, 9)
    expect(trialCredit(env.db, new Date())).toMatchObject({ active: false, state: 'used' })
    expect(JSON.stringify(trialCredit(env.db, new Date()))).not.toContain('CANARY')
  })
  test('the API engine setup: OpenRouter, the trial model, no key in it', () => {
    expect(hostedChatConf({ engine: { authMode: 'managed' } })).toEqual({ baseUrl: 'https://openrouter.ai/api/v1', model: HOSTED_CHAT_MODEL, label: 'Claude Haiku 5.5', key: null })
    expect(hostedChatConf({ engine: { authMode: 'managed', modelUpstreams: { openrouter: 'http://127.0.0.1:9/api/v1/' } } }).baseUrl).toBe('http://127.0.0.1:9/api/v1')
  })
})

describe('kept like the hosting speech key', () => {
  test('encrypted at rest; credentials-rekey encrypts it again and it still opens', () => {
    grant()
    const raw = () => (env.db.query('SELECT value FROM settings WHERE key = ?').get(HOSTED_CHAT_KEY_SETTING) as { value: string }).value
    expect(raw()).not.toContain('CANARY')
    const before = JSON.parse(raw())
    expect(before.kind).toBe('openrouter-api-key')
    rekeyCredentials(t.cc)
    const after = JSON.parse(raw())
    expect(after.keyVersion).toBeGreaterThan(before.keyVersion)
    expect(after.capUsd).toBe(1)
    expect(readHostedChatKey(t.cc)).toBe(KEY)
  })
  test('a server that is not hosted drops it at start (main.ts)', () => {
    grant()
    expect(dropHostedChatKey(env.db)).toBe(true)
    expect(dropHostedChatKey(env.db)).toBe(false)
    expect(hostedChatState(env.db, new Date())).toBeNull()
  })
  test('the team\'s export leaves it out; a restore keeps the current key and spend, whatever the backup holds', () => {
    grant()
    chargeHostedChat(env.db, 0.25)
    const dir = path.join(env.fx.data, 'trial-copies')
    fs.mkdirSync(dir, { recursive: true })
    const copy = path.join(dir, 'export.db')
    fs.rmSync(copy, { force: true })
    env.db.run(`VACUUM INTO '${copy}'`)
    withoutHostingKey(copy)
    const c = openDb(copy)
    try { expect(c.query('SELECT key FROM settings WHERE key = ?').get(HOSTED_CHAT_KEY_SETTING)).toBeNull() } finally { c.close() }
    // an older backup with less spent: the live rows win
    const staged = path.join(dir, 'staged.db')
    fs.rmSync(staged, { force: true })
    env.db.run(`VACUUM INTO '${staged}'`)
    const s = openDb(staged)
    try { s.query('UPDATE settings SET value = ? WHERE key = ?').run(JSON.stringify({ usd: 0 }), HOSTED_CHAT_USAGE_SETTING) } finally { s.close() }
    const live = path.join(dir, 'live.db')
    fs.rmSync(live, { force: true })
    env.db.run(`VACUUM INTO '${live}'`)
    keepServerSettings(live, staged)
    const r = openDb(staged)
    try { expect(JSON.parse((r.query('SELECT value FROM settings WHERE key = ?').get(HOSTED_CHAT_USAGE_SETTING) as { value: string }).value)).toEqual({ usd: 0.25 }) } finally { r.close() }
  })
})
