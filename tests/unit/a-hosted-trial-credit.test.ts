// The hosting service's trial AI credit (docs/DECISIONS.md "B — Hosted trial AI credit"): the tenant command and
// admin.js, where it stands in the resolution order (last: any connection of the team or the person comes first), the
// model proxy putting its key on the request on its one model, counting what it spent and refusing before sending once
// the cap is used, past its end or switched off, each attempt's budget, a refused key, and its storage (encrypted,
// rekeyed, dropped off a server that is not hosted, left out of the export, kept over a restore). The model service is
// a local fake.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { tenantCommandProblem, TENANT_COMMANDS } from '@mycel/shared/cloud-protocol'
import { ALL_CREDENTIAL_KINDS, type AppConfig } from '../../server/src/app-config'
import { setSetting } from '../../server/src/admin/settings'
import { createBroker } from '../../server/src/credentials/broker'
import {
  chargeHostedChat, dropHostedChatKey, HOSTED_CHAT_ID, HOSTED_CHAT_KEY_SETTING, HOSTED_CHAT_MODEL, HOSTED_CHAT_USAGE_SETTING,
  hostedChatHeldUsd, hostedChatLeftUsd, hostedChatState, hostedChatUsedUsd, readHostedChatKey, trialCredit, trialEstimateUsd, writeHostedChatKey,
} from '../../server/src/credentials/hosted-chat'
import { claudeCost } from '../../server/src/credentials/prices'
import { SHARED_SUBSCRIPTIONS_KEY } from '../../server/src/credentials/policy'
import { rekeyCredentials } from '../../server/src/credentials/rekey'
import { hasCredentialFor, hasCredentialSoonFor, MEMBER_OWN_KEY, resolveCredential } from '../../server/src/credentials/resolve'
import { issueProxyToken, startModelProxy, type ProxyTurnEvent } from '../../server/src/proxy/model-proxy'
import { keepServerSettings, withoutHostingKey } from '../../server/src/system/backup'
import { setHostedChatKey } from '../../server/src/system/cloud-tenant'
import { openDb } from '../../server/src/db'
import { addCred, testCredCtx } from '../lib/credentials'
import { makeEnv } from '../lib/env'

const KEY = 'sk-ant-api03-TRIAL-CANARY-' + 'k'.repeat(30)
const KEY2 = 'sk-ant-api03-TRIAL-ROTATED-' + 'r'.repeat(30)
const TEAM_KEY = 'sk-ant-api03-TEAM-' + 't'.repeat(30)
const OWN_KEY = 'sk-ant-api03-OWN-' + 'o'.repeat(30)
const ALL = new Set(ALL_CREDENTIAL_KINDS)
const DAY = 86400_000
const future = () => new Date(Date.now() + 14 * DAY).toISOString()

// a fake Anthropic: what it was sent, the usage it answers with, an optional status / error body, a delay, a stream
// that stops after message_start (`stream: 'hang'` waits for the caller to hang up, 'cut' ends there)
const seen: { key: string | null; model: string }[] = []
let usage: Record<string, number> = { input_tokens: 10_000, output_tokens: 2_000 }
let status = 200
let errorBody: unknown = null
let delayMs = 0
let streamMode: 'full' | 'hang' | 'cut' = 'full'
const ORG_HEADERS = { 'anthropic-organization-id': 'org-HOSTING-CANARY', 'anthropic-ratelimit-requests-remaining': '49' }
const upstream = Bun.serve({
  port: 0, hostname: '127.0.0.1', idleTimeout: 0,
  async fetch(req) {
    const body = await req.json() as { model: string; stream?: boolean }
    seen.push({ key: req.headers.get('x-api-key'), model: body.model })
    if (delayMs) await Bun.sleep(delayMs)
    if (status !== 200) return Response.json(errorBody ?? { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, { status, headers: ORG_HEADERS })
    if (body.stream && streamMode !== 'full') {
      const start = `data: ${JSON.stringify({ type: 'message_start', message: { model: body.model, usage: { input_tokens: usage.input_tokens, output_tokens: 1 } } })}\n\n`
      return new Response(new ReadableStream<Uint8Array>({ start(c) {
        c.enqueue(new TextEncoder().encode(start))
        if (streamMode === 'cut') c.close()
      } }), { headers: { 'content-type': 'text/event-stream', ...ORG_HEADERS } })
    }
    if (body.stream) {
      const sse = [`data: ${JSON.stringify({ type: 'message_start', message: { model: body.model, usage: { input_tokens: usage.input_tokens, output_tokens: 1 } } })}`, '',
        `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: usage.output_tokens } })}`, '', 'data: {"type":"message_stop"}', '', ''].join('\n')
      return new Response(sse, { headers: { 'content-type': 'text/event-stream', ...ORG_HEADERS } })
    }
    return Response.json({ id: 'm', model: body.model, content: [{ type: 'text', text: 'ok' }], usage }, { headers: ORG_HEADERS })
  },
})

const env = makeEnv('a-hosted-trial')
const secrets = path.join(env.fx.data, 'secrets')
const t = testCredCtx(env.db, secrets, { upstreams: { anthropic: `http://127.0.0.1:${upstream.port}` } })
const broker = createBroker(t.cc)
const events: { turn: string; ev: ProxyTurnEvent }[] = []
const proxy = await startModelProxy({ db: env.db, broker, onTurnEvent: (turn, ev) => { events.push({ turn, ev }) }, log: { warn: () => {}, debug: () => {} } })
afterAll(async () => { await proxy.stop(); upstream.stop(true) })

let turnN = 0
const newTurn = () => {
  const id = `trial-turn-${++turnN}`
  env.db.query("INSERT INTO turns (id, chat_id, user_id, engine, status) VALUES (?, 'c', 'alice', 'claude-code', 'running')").run(id)
  return id
}
const tok = (turn: string, o: { budgetUsd?: number } = {}) => issueProxyToken(env.db, turn, 'alice', { credentialId: HOSTED_CHAT_ID, family: 'anthropic', ...o })
const call = (token: string, model = HOSTED_CHAT_MODEL, o: { stream?: boolean; maxTokens?: number } = {}) => fetch(proxy.url + '/v1/messages', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': token, 'anthropic-version': '2023-06-01' },
  body: JSON.stringify({ model, max_tokens: o.maxTokens ?? 5, messages: [{ role: 'user', content: 'hi' }], ...(o.stream ? { stream: true } : {}) }),
})
const turnCost = (turn: string) => (env.db.query('SELECT cost_usd FROM turns WHERE id = ?').get(turn) as { cost_usd: number | null }).cost_usd ?? 0
const grant = (o: Partial<{ key: string; capUsd: number; endsAt: string; enabled: boolean }> = {}) =>
  writeHostedChatKey(t.cc, { key: KEY, capUsd: 1, endsAt: future(), enabled: true, ...o })
const resolve = (userId = 'alice', o: { engine?: 'claude-code' | 'codex'; exclude?: Set<string>; allowed?: typeof ALL & { gateway?: string | null }; codexFallback?: boolean } = {}) =>
  resolveCredential(env.db, { userId, engine: o.engine ?? 'claude-code', allowedKinds: o.allowed ?? ALL, ...(o.exclude ? { exclude: o.exclude } : {}), ...(o.codexFallback ? { codexFallback: true } : {}) })
/** one request's cost at the fake's usage, at the trial model's list price */
const perRequest = () => claudeCost(HOSTED_CHAT_MODEL, usage)

beforeEach(() => {
  env.db.query('DELETE FROM engine_credentials').run()
  env.db.query('DELETE FROM settings WHERE key IN (?, ?)').run(HOSTED_CHAT_KEY_SETTING, HOSTED_CHAT_USAGE_SETTING)
  setSetting(env.db, MEMBER_OWN_KEY, false)
  seen.length = 0; events.length = 0
  usage = { input_tokens: 10_000, output_tokens: 2_000 }
  status = 200; errorBody = null; delayMs = 0; streamMode = 'full'
})

describe('the tenant command hosted-chat-key-set (mycel-ctl → admin.js hosted-chat-key)', () => {
  test('the gate: a direct Anthropic key with cap, end and switch, or { key: null }; nothing else', () => {
    expect(Object.keys(TENANT_COMMANDS)).toContain('hosted-chat-key-set')
    const ok = { key: KEY, capUsd: 10, endsAt: '2026-11-18T15:00:00Z', enabled: true }
    expect(tenantCommandProblem('hosted-chat-key-set', {}, ok)).toBeNull()
    expect(tenantCommandProblem('hosted-chat-key-set', {}, { key: null })).toBeNull()
    for (const bad of [
      { ...ok, key: 'sk-or-v1-' + 'a'.repeat(40) }, { ...ok, key: 'sk-ant-oat01-' + 'a'.repeat(40) }, { ...ok, capUsd: -1 }, { ...ok, capUsd: 1001 },
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
  test('refused on a server that is not hosted, and for anything else; errors never hold the key', () => {
    expect(() => setHostedChatKey(o('self'), { key: KEY, capUsd: 10, endsAt: future(), enabled: true })).toThrow('hosted servers only')
    for (const bad of [{}, { key: 'sk-or-short' }, { key: KEY }, { key: KEY, capUsd: 1, endsAt: future(), enabled: true, x: 1 }, { key: 7 }, null, []]) {
      let msg = ''
      try { setHostedChatKey(o('hosted'), bad) } catch (e) { msg = (e as Error).message }
      expect(msg).toContain('stdin must be')
      expect(msg).not.toContain('CANARY')
    }
    expect(readHostedChatKey(t.cc)).toBeNull()
  })
})

describe('which AI answers: the trial credit is last', () => {
  test('nothing connected and no trial credit: no connection, as before', () => {
    const r = resolve()
    expect(r).toMatchObject({ ok: false, reason: 'none' })
    expect((r as { trial?: string }).trial).toBeUndefined()
  })
  test('nothing connected: the trial credit answers Claude turns (never Codex)', () => {
    grant()
    expect(resolve()).toEqual({ ok: true, credentialId: HOSTED_CHAT_ID, kind: 'anthropic-api-key', tier: 'hosted' })
    expect(resolve('bob')).toMatchObject({ ok: true, credentialId: HOSTED_CHAT_ID })
    expect(resolve('alice', { engine: 'codex' })).toMatchObject({ ok: false, reason: 'none' })
    expect(hasCredentialFor(env.db, 'alice', 'claude-code', ALL)).toBe(true)
    expect(hasCredentialSoonFor(env.db, 'alice', 'claude-code', ALL)).toBe(true)
    expect(hasCredentialFor(env.db, 'alice', 'codex', ALL)).toBe(false)
    expect(hasCredentialSoonFor(env.db, 'alice', 'codex', ALL)).toBe(false)
  })
  test('a team connection wins over it, and a person\'s own connection wins over both', () => {
    grant()
    const team = addCred(t.cc, 'anthropic-api-key', TEAM_KEY, { label: 'team', priority: 1000 })
    expect(resolve()).toMatchObject({ ok: true, credentialId: team, tier: 'team' })
    // a subscription token too
    env.db.query('DELETE FROM engine_credentials').run()
    const sub = addCred(t.cc, 'anthropic-oauth', 'sk-ant-oat01-' + 's'.repeat(40), { label: 'sub' })
    setSetting(env.db, SHARED_SUBSCRIPTIONS_KEY, true)
    expect(resolve()).toMatchObject({ ok: true, credentialId: sub })
    setSetting(env.db, MEMBER_OWN_KEY, true)
    const own = addCred(t.cc, 'anthropic-api-key', OWN_KEY, { label: 'mine', owner: 'alice' })
    expect(resolve('alice')).toMatchObject({ ok: true, credentialId: own, tier: 'own' })
    expect(resolve('bob')).toMatchObject({ ok: true, credentialId: sub })
  })
  test('a connection that cannot answer now falls through to it; excluded (the attempt failed on it): none', () => {
    grant()
    const team = addCred(t.cc, 'anthropic-api-key', TEAM_KEY, { label: 'team' })
    env.db.query("UPDATE engine_credentials SET status = 'invalid' WHERE id = ?").run(team)
    expect(resolve()).toMatchObject({ ok: true, credentialId: HOSTED_CHAT_ID })
    env.db.query("UPDATE engine_credentials SET status = 'ok', disabled = 1 WHERE id = ?").run(team)
    expect(resolve()).toMatchObject({ ok: true, credentialId: HOSTED_CHAT_ID })
    expect(resolve('alice', { exclude: new Set([HOSTED_CHAT_ID]) })).toMatchObject({ ok: false, reason: 'none' })
  })
  test('used up, past its end or switched off: "none" says which, so the person hears about the trial', () => {
    grant({ capUsd: 0.5 })
    chargeHostedChat(env.db, 0.5)
    expect(resolve()).toMatchObject({ ok: false, reason: 'none', trial: 'used' })
    expect(hasCredentialFor(env.db, 'alice', 'claude-code', ALL)).toBe(false)
    expect(hasCredentialSoonFor(env.db, 'alice', 'claude-code', ALL)).toBe(false)
    grant({ endsAt: new Date(Date.now() - 1000).toISOString() })
    expect(resolve()).toMatchObject({ ok: false, reason: 'none', trial: 'ended' })
    grant({ capUsd: 10, enabled: false })
    expect(resolve()).toMatchObject({ ok: false, reason: 'none', trial: 'ended' })
    // a connection of the team's own that is only limited for now: its wait is what the person hears
    grant({ capUsd: 0.1 })
    const team = addCred(t.cc, 'anthropic-api-key', TEAM_KEY, { label: 'team' })
    const until = new Date(Date.now() + 3600_000).toISOString()
    env.db.query('UPDATE engine_credentials SET limited_until = ? WHERE id = ?').run(until, team)
    const r = resolve()
    expect(r).toMatchObject({ ok: false, reason: 'all_unusable', retryAt: until })
    expect((r as { trial?: string }).trial).toBeUndefined()
  })
  test('a Claude limit that goes on to the person\'s Codex (the admin\'s fallback) keeps the credit out', () => {
    grant()
    const team = addCred(t.cc, 'anthropic-api-key', TEAM_KEY, { label: 'team' })
    const until = new Date(Date.now() + 3600_000).toISOString()
    env.db.query('UPDATE engine_credentials SET limited_until = ? WHERE id = ?').run(until, team)
    // without the fallback the credit answers; with it the limit stands, so the turn moves on to Codex
    expect(resolve()).toMatchObject({ ok: true, credentialId: HOSTED_CHAT_ID })
    expect(resolve('alice', { codexFallback: true })).toMatchObject({ ok: false, reason: 'all_unusable', retryAt: until })
    // a connection that is off (not limited) does not lead to Codex: the credit answers
    env.db.query('UPDATE engine_credentials SET limited_until = NULL, disabled = 1 WHERE id = ?').run(team)
    expect(resolve('alice', { codexFallback: true })).toMatchObject({ ok: true, credentialId: HOSTED_CHAT_ID })
  })
  test('with an Anthropic-compatible gateway the direct key is never offered (nor shown)', () => {
    grant()
    const gw = Object.assign(new Set(ALL_CREDENTIAL_KINDS.filter((k) => k !== 'anthropic-oauth')), { gateway: 'openrouter.ai' })
    expect(resolve('alice', { allowed: gw })).toMatchObject({ ok: false, reason: 'none' })
    expect((resolve('alice', { allowed: gw }) as { trial?: string }).trial).toBeUndefined()
    expect(trialCredit(env.db, new Date(), gw)).toBeNull()
    expect(hostedChatState(env.db, new Date(), gw)).toBeNull()
  })
  test('what the owner and admins see: used of the cap, the end, the model; never the key', () => {
    expect(trialCredit(env.db, new Date(), ALL)).toBeNull()
    const ends = future()
    grant({ capUsd: 10, endsAt: ends })
    chargeHostedChat(env.db, 1.23456)
    expect(trialCredit(env.db, new Date(), ALL)).toEqual({ active: true, state: 'active', usedUsd: 1.2346, capUsd: 10, endsAt: ends, model: HOSTED_CHAT_MODEL })
    chargeHostedChat(env.db, 9)
    expect(trialCredit(env.db, new Date(), ALL)).toMatchObject({ active: false, state: 'used' })
    expect(JSON.stringify(trialCredit(env.db, new Date(), ALL))).not.toContain('CANARY')
  })
})

describe('the model proxy with the trial credit', () => {
  test('its key goes on the request as x-api-key, on its one model only; others are refused before anything is sent', async () => {
    grant()
    const turn = newTurn()
    const r = await call(tok(turn))
    expect(r.status).toBe(200)
    expect(seen).toEqual([{ key: KEY, model: HOSTED_CHAT_MODEL }])
    seen.length = 0
    for (const m of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'haiku', `${HOSTED_CHAT_MODEL}-x`]) {
      const x = await call(tok(turn), m)
      expect(x.status, m).toBe(403)
    }
    expect(seen).toEqual([])
  })
  test('what it spent is counted (turn and trial, at the model\'s list price), streamed or not; no connection row is touched', async () => {
    grant()
    const turn = newTurn()
    await (await call(tok(turn))).text()
    await (await call(tok(turn), HOSTED_CHAT_MODEL, { stream: true })).text()
    const each = perRequest()
    expect(each).toBeCloseTo((10_000 * 0.1 + 2_000 * 0.5) / 1e6, 9)
    expect(turnCost(turn)).toBeCloseTo(2 * each, 9)
    expect(hostedChatUsedUsd(env.db)).toBeCloseTo(2 * each, 9)
    expect(hostedChatLeftUsd(env.db)).toBeCloseTo(1 - 2 * each, 9)
    expect(env.db.query('SELECT COUNT(*) AS n FROM credential_usage_daily').get()).toEqual({ n: 0 })
  })
  test('the cap used: the next request is refused before it is sent, and the turn hears "used"', async () => {
    grant({ capUsd: perRequest() * 2 })
    const turn = newTurn()
    expect((await call(tok(turn))).status).toBe(200)
    expect((await call(tok(turn))).status).toBe(200)
    expect(hostedChatState(env.db, new Date())).toBe('used')
    seen.length = 0
    const r = await call(tok(turn))
    expect(r.status).toBe(403)
    expect((await r.json()).error.message).toBe('trial_credit_used')
    expect(seen).toEqual([])
    expect(events.at(-1)).toEqual({ turn, ev: { type: 'trial', reason: 'used' } })
    // more credit from the hosting service (a higher cap): it answers again
    grant({ capUsd: 1 })
    expect((await call(tok(turn))).status).toBe(200)
  })
  test('each attempt\'s budget is what was left: one turn cannot spend past the cap, other turns are not stopped by it', async () => {
    grant({ capUsd: 1 })
    chargeHostedChat(env.db, 1 - perRequest() * 1.5) // a request and a half left
    const turn = newTurn()
    // how a turn issues its trial token (chat/turn.ts): what the turn spent so far + what is left of the credit
    const budget = turnCost(turn) + hostedChatLeftUsd(env.db)
    const token = tok(turn, { budgetUsd: budget })
    expect((await call(token)).status).toBe(200)
    expect((await call(token)).status).toBe(200) // under the budget when sent: the one request may go past it
    seen.length = 0
    const r = await call(token)
    expect(r.status).toBe(403)
    expect(seen).toEqual([])
    expect(events.at(-1)).toEqual({ turn, ev: { type: 'trial', reason: 'used' } })
    expect(env.db.query('SELECT budget_usd FROM proxy_tokens WHERE turn_id = ? AND budget_usd IS NOT NULL').get(turn)).toEqual({ budget_usd: budget })
  })
  test('past its end or switched off: refused before sending, the turn hears "ended"', async () => {
    for (const g of [{ endsAt: new Date(Date.now() - 1000).toISOString() }, { enabled: false }]) {
      grant(g)
      const turn = newTurn()
      seen.length = 0
      const r = await call(tok(turn))
      expect(r.status).toBe(403)
      expect((await r.json()).error.message).toBe('trial_ended')
      expect(seen).toEqual([])
      expect(events.at(-1)).toEqual({ turn, ev: { type: 'trial', reason: 'ended' } })
    }
  })
  test('Anthropic refuses the key (401): no request goes out with it any more until the hosting service sends a key again', async () => {
    grant()
    status = 401
    const turn = newTurn()
    expect((await call(tok(turn))).status).toBe(401)
    expect(hostedChatState(env.db, new Date())).toBe('ended')
    expect(resolve()).toMatchObject({ ok: false, reason: 'none', trial: 'ended' })
    expect(env.db.query("SELECT detail FROM audit_log WHERE action = 'credential.rejected' AND target = ? ORDER BY rowid DESC").get(HOSTED_CHAT_ID)).toBeTruthy()
    status = 200
    seen.length = 0
    expect((await call(tok(turn))).status).toBe(403)
    expect(seen).toEqual([])
    grant({ key: KEY2 })
    expect((await call(tok(turn))).status).toBe(200)
    expect(seen).toEqual([{ key: KEY2, model: HOSTED_CHAT_MODEL }])
  })
  test('a late 401 for a key rotated away since leaves the new key alone', async () => {
    grant({ key: KEY2 })
    expect(await broker.onUnauthorized(HOSTED_CHAT_ID, KEY)).toBe('refused')
    expect(hostedChatState(env.db, new Date())).toBe('active')
    expect(await broker.onUnauthorized(HOSTED_CHAT_ID, KEY2)).toBe('refused')
    expect(hostedChatState(env.db, new Date())).toBe('ended')
  })
})

describe('requests in flight: held when sent, settled when counted', () => {
  const waitFor = async (ok: () => boolean) => { for (let i = 0; i < 200 && !ok(); i++) await Bun.sleep(10); return ok() }
  test('many turns at once near the cap: the credit is passed by one request\'s reservation at most', async () => {
    const cap = 1
    grant({ capUsd: cap })
    const each = perRequest() // what one answer really costs here
    chargeHostedChat(env.db, cap - each * 3) // three answers left
    const reservation = trialEstimateUsd({ inputTokens: 100, maxTokens: 8_000 }) // about what each request holds
    expect(reservation).toBeGreaterThan(each) // the hold covers the answer
    delayMs = 100 // all of them are out at the same moment
    const turns = Array.from({ length: 8 }, () => newTurn())
    const rs = await Promise.all(turns.map((turn) => call(tok(turn), HOSTED_CHAT_MODEL, { maxTokens: 8_000 })))
    const ok = rs.filter((r) => r.status === 200).length
    const refused = await Promise.all(rs.filter((r) => r.status === 403).map(async (r) => (await r.json()).error.message))
    // without holds all eight would go: 5 answers past the credit
    expect(ok).toBe(2) // 3 answers left, each request holding 2 answers' worth
    expect(ok + refused.length).toBe(8)
    expect(new Set(refused)).toEqual(new Set(['trial_credit_used']))
    expect(seen.length).toBe(ok)
    expect(hostedChatUsedUsd(env.db)).toBeLessThanOrEqual(cap + reservation)
    expect(hostedChatHeldUsd(env.db)).toBe(0) // everything settled
  })
  test('a hold goes back when no answer came (an error, an unreachable service), and with count_tokens nothing is held', async () => {
    grant()
    const turn = newTurn()
    status = 500
    expect((await call(tok(turn), HOSTED_CHAT_MODEL, { maxTokens: 8_000 })).status).toBe(500)
    expect(hostedChatHeldUsd(env.db)).toBe(0)
    expect(hostedChatUsedUsd(env.db)).toBe(0)
    status = 200
    const r = await fetch(proxy.url + '/v1/messages/count_tokens', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': tok(turn), 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: HOSTED_CHAT_MODEL, messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(r.status).toBe(200)
    expect(hostedChatHeldUsd(env.db)).toBe(0)
  })
  test('a stream the engine hangs up on counts its whole output reservation (stopping cannot dodge the cost)', async () => {
    grant()
    streamMode = 'hang'
    const turn = newTurn()
    const r = await call(tok(turn), HOSTED_CHAT_MODEL, { stream: true, maxTokens: 4_000 })
    const reader = r.body!.getReader()
    await reader.read() // message_start arrived
    await reader.cancel()
    const expected = claudeCost(HOSTED_CHAT_MODEL, { input_tokens: usage.input_tokens, output_tokens: 4_000 })
    expect(await waitFor(() => hostedChatUsedUsd(env.db) > 0)).toBe(true)
    expect(hostedChatUsedUsd(env.db)).toBeCloseTo(expected, 9)
    expect(turnCost(turn)).toBeCloseTo(expected, 9)
    expect(hostedChatHeldUsd(env.db)).toBe(0)
  })
  test('a stream that breaks off before its final usage counts the same way', async () => {
    grant()
    streamMode = 'cut'
    const turn = newTurn()
    await (await call(tok(turn), HOSTED_CHAT_MODEL, { stream: true, maxTokens: 3_000 })).text()
    expect(await waitFor(() => hostedChatUsedUsd(env.db) > 0)).toBe(true)
    expect(hostedChatUsedUsd(env.db)).toBeCloseTo(claudeCost(HOSTED_CHAT_MODEL, { input_tokens: usage.input_tokens, output_tokens: 3_000 }), 9)
  })
  test('Anthropic\'s own spend limit on the key (the hosting service\'s backstop) reads as a used credit', async () => {
    grant()
    for (const [st, body] of [
      [402, { type: 'error', error: { type: 'billing_error', message: 'billing' } }],
      [400, { type: 'error', error: { type: 'invalid_request_error', message: 'You have reached your specified workspace API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.' } }],
      [400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }],
    ] as const) {
      status = st; errorBody = body
      const turn = newTurn()
      const r = await call(tok(turn), HOSTED_CHAT_MODEL, { maxTokens: 8_000 })
      expect(r.status).toBe(403)
      expect((await r.json()).error.message).toBe('trial_credit_used')
      expect(events.at(-1)).toEqual({ turn, ev: { type: 'trial', reason: 'used' } })
      expect(hostedChatHeldUsd(env.db)).toBe(0)
    }
    // any other refusal passes on as it came
    status = 400; errorBody = { type: 'error', error: { type: 'invalid_request_error', message: 'messages: roles must alternate' } }
    const r = await call(tok(newTurn()))
    expect(r.status).toBe(400)
    expect((await r.json()).error.message).toBe('messages: roles must alternate')
    // a team connection's own 402 is not the trial's business
    status = 402; errorBody = null
    const team = addCred(t.cc, 'anthropic-api-key', TEAM_KEY, { label: 'team' })
    const teamTurn = newTurn()
    expect((await call(issueProxyToken(env.db, teamTurn, 'alice', { credentialId: team, family: 'anthropic' }), 'claude-sonnet-5-5')).status).toBe(402)
  })
  test('a trial answer does not name the hosting service\'s Anthropic organization; a team connection\'s still does', async () => {
    grant()
    for (const stream of [false, true]) {
      const r = await call(tok(newTurn()), HOSTED_CHAT_MODEL, { stream })
      await r.text()
      expect(r.headers.get('anthropic-organization-id')).toBeNull()
      expect(r.headers.get('anthropic-ratelimit-requests-remaining')).toBe('49') // the engine paces itself by these
    }
    const team = addCred(t.cc, 'anthropic-api-key', TEAM_KEY, { label: 'team' })
    const r = await call(issueProxyToken(env.db, newTurn(), 'alice', { credentialId: team, family: 'anthropic' }), 'claude-sonnet-5-5')
    await r.text()
    expect(r.headers.get('anthropic-organization-id')).toBe('org-HOSTING-CANARY')
  })
})

describe('kept like the hosting speech key', () => {
  test('encrypted at rest; credentials-rekey encrypts it again and it still opens', () => {
    grant()
    const raw = () => (env.db.query('SELECT value FROM settings WHERE key = ?').get(HOSTED_CHAT_KEY_SETTING) as { value: string }).value
    expect(raw()).not.toContain('CANARY')
    const before = JSON.parse(raw())
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
    expect(resolve()).toMatchObject({ ok: false, reason: 'none' })
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
    // an older backup with another key and less spent: the live rows win
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
