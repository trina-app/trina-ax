// Model and depth choice, usage by model (docs/AGENTS/plan/20261126-0420-model-effort-choice.md, migration 456,
// docs/decisions/20261126-model-effort-choice.md):
// - recording: the model proxy's rows replace the engine's report of a turn and are never added on top of it
//   (credentials/broker.ts, chat/turn-models.ts); turns.model stays the model asked for
// - the depth as engine flags: Claude Code --effort low / none / high, Codex model_reasoning_effort always once chosen
// - who may pick the depth follows "who may pick the engine"; a new team lets everyone pick, an existing one keeps its rule
// - a scheduled run into a shared chat answers with that chat's model and depth
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import os from 'node:os'
import path from 'node:path'
import { API, ApiError } from '@mycel/shared/api'
import { claudeFamily, modelDisplayName, modelVersionName } from '@mycel/shared'
import { makeEnv } from '../lib/env'
import { addCred, testCredCtx } from '../lib/credentials'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { createBroker } from '../../server/src/credentials/broker'
import { writeEngineModelUsage } from '../../server/src/chat/turn-models'
import { myUsage } from '../../server/src/admin/my-usage'
import { usage } from '../../server/src/admin/budgets'
import { setSetting } from '../../server/src/admin/settings'
import { SHARED_SUBSCRIPTIONS_KEY } from '../../server/src/credentials/policy'
import { buildClaudeLaunch, claudeKnowsEffort, CLAUDE_EFFORT } from '../../server/src/engine/claude'
import { codexArgs, CODEX_REASONING } from '../../server/src/engine/codex'
import { ClaudeStreamParser } from '../../server/src/engine/claude-parse'
import { MEMBER_CHOICE_KEY, memberChoice, newChatEngine, settleNewTeamMemberChoice, turnEngine } from '../../server/src/admin/engine-choice'

setDefaultTimeout(30_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')

describe('migration 456', () => {
  const env = makeEnv('b-model-effort-mig')
  test('adds chats.effort, turns.effort and turn_models (one row per turn and model, gone with its turn)', () => {
    const cols = (t: string) => (env.db.query(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name)
    expect(cols('chats')).toContain('effort')
    expect(cols('turns')).toContain('effort')
    expect(cols('turn_models')).toEqual(['turn_id', 'model', 'source', 'requests', 'input_tokens', 'output_tokens', 'cost_usd', 'est_cost_usd'])
    env.db.query("INSERT INTO turns (id, chat_id, user_id, engine, model, status, started_at) VALUES ('t-m', 'c', 'alice', 'claude-code', NULL, 'done', ?)").run(new Date().toISOString())
    env.db.query("INSERT INTO turn_models (turn_id, model, source) VALUES ('t-m', 'claude-opus-5-5', 'engine')").run()
    expect(() => env.db.query("INSERT INTO turn_models (turn_id, model, source) VALUES ('t-m', 'x', 'guess')").run()).toThrow()
    env.db.query("DELETE FROM turns WHERE id = 't-m'").run()
    expect(env.db.query("SELECT count(*) AS n FROM turn_models WHERE turn_id = 't-m'").get()).toEqual({ n: 0 })
  })
})

describe('recording the model that answered', () => {
  const env = makeEnv('b-model-effort-rec')
  setSetting(env.db, SHARED_SUBSCRIPTIONS_KEY, true)
  const t = testCredCtx(env.db, path.join(env.fx.data, 'secrets'))
  const sub = addCred(t.cc, 'anthropic-oauth', 'sk-ant-oat01-' + 'Q'.repeat(40), { label: 'Team Max' })
  const broker = createBroker(t.cc)
  const turn = (model: string | null = 'opus') => {
    const id = crypto.randomUUID()
    env.db.query("INSERT INTO turns (id, chat_id, user_id, engine, model, status, started_at, input_tokens, output_tokens) VALUES (?, 'c', 'alice', 'claude-code', ?, 'done', ?, 0, 0)")
      .run(id, model, new Date().toISOString())
    return id
  }
  const rows = (id: string) => env.db.query('SELECT model, source, requests, input_tokens AS i, output_tokens AS o FROM turn_models WHERE turn_id = ? ORDER BY model').all(id)
  const cu = { input_tokens: 100, output_tokens: 10 }

  test('the proxy replaces the engine\'s rows on its first request and adds to its own after; tokens are counted once', () => {
    const id = turn()
    // the engine reported first (a running count under the model asked for)
    expect(writeEngineModelUsage(env.db, id, new Map([['opus', { i: 999, o: 99, c: 0 }]]))).toBe(true)
    expect(rows(id)).toEqual([{ model: 'opus', source: 'engine', requests: 0, i: 999, o: 99 }])
    broker.record(sub, id, 'claude-opus-5-5-20261101', cu)
    broker.record(sub, id, 'claude-opus-5-5-20261101', cu)
    broker.record(sub, id, 'claude-haiku-5-5', { input_tokens: 7, output_tokens: 1 })
    expect(rows(id)).toEqual([
      { model: 'claude-haiku-5-5', source: 'proxy', requests: 1, i: 7, o: 1 },
      { model: 'claude-opus-5-5-20261101', source: 'proxy', requests: 2, i: 200, o: 20 },
    ])
    // the engine's later totals never write over or beside the proxy's
    expect(writeEngineModelUsage(env.db, id, new Map([['claude-opus-5-5', { i: 5000, o: 500, c: 0.1 }]]))).toBe(false)
    expect(rows(id)).toHaveLength(2)
    const sum = env.db.query('SELECT SUM(input_tokens) AS i, SUM(output_tokens) AS o FROM turn_models WHERE turn_id = ?').get(id)
    expect(sum).toEqual(env.db.query('SELECT input_tokens AS i, output_tokens AS o FROM turns WHERE id = ?').get(id))
    // turns.model stays what was asked for (a queued turn rebuilt after a restart runs with it)
    expect(env.db.query('SELECT model FROM turns WHERE id = ?').get(id)).toEqual({ model: 'opus' })
  })

  test('without a proxy the engine\'s rows stand and each report replaces the last (a running count, then the total)', () => {
    const id = turn(null)
    writeEngineModelUsage(env.db, id, new Map([['claude-opus-5-5', { i: 10, o: 1, c: 0 }]]))
    writeEngineModelUsage(env.db, id, new Map([['claude-opus-5-5', { i: 300, o: 30, c: 0.02 }], ['claude-haiku-5-5', { i: 4, o: 1, c: 0 }]]))
    expect(rows(id)).toEqual([
      { model: 'claude-haiku-5-5', source: 'engine', requests: 0, i: 4, o: 1 },
      { model: 'claude-opus-5-5', source: 'engine', requests: 0, i: 300, o: 30 },
    ])
  })

  test('usage lists read the real models by name; a turn from before keeps its own row', () => {
    const before = turn('sonnet')
    env.db.query('UPDATE turns SET input_tokens = 50, output_tokens = 5 WHERE id = ?').run(before)
    const mine = myUsage(env.db, 'alice', 'month')
    const names = mine.byModel.map((r) => [r.model ? modelDisplayName(r.model) : null, r.inputTokens])
    // the Opus rows of the two turns (asked "opus", answered claude-opus-5-5…) are one row
    expect(names).toContainEqual(['Claude Opus', 500])
    expect(names).toContainEqual(['Claude Haiku', 11])
    expect(names).toContainEqual(['Claude Sonnet', 50])
    const admin = usage(env.db, { groupBy: 'model', to: new Date(Date.now() + 60_000).toISOString() } as Parameters<typeof usage>[1])
    // Admin keeps one row per real id (the CSV's key), named with its version: never two rows of one name
    const want = [['claude-haiku-5-5', 'Claude Haiku 5.5'], ['claude-opus-5-5', 'Claude Opus 5.5 (claude-opus-5-5)'],
      ['claude-opus-5-5-20261101', 'Claude Opus 5.5 (claude-opus-5-5-20261101)'], ['sonnet', 'Claude Sonnet']].sort()
    expect(admin.rows.map((r) => [r.key, r.label]).sort()).toEqual(want)
    // the model filter's choices read the same
    const facets = usage(env.db, { groupBy: 'model', facets: true, to: new Date(Date.now() + 60_000).toISOString() } as Parameters<typeof usage>[1]).facets!
    expect(facets.models.map((m) => [m.key, m.label]).sort()).toEqual(want)
    // the totals still count whole turns
    expect(admin.totals.turns).toBe(3)
  })

  test('Claude Code\'s result names its models: the usage event carries the split', () => {
    const p = new ClaudeStreamParser()
    const ev = p.push(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: { 'claude-opus-5-5': { inputTokens: 700, outputTokens: 70, cacheReadInputTokens: 30, costUSD: 0.01 }, 'claude-haiku-5-5': { inputTokens: 5, outputTokens: 1 } }, total_cost_usd: 0.011 }))
    expect(ev.find((e) => e.type === 'usage')).toMatchObject({ inputTokens: 735, outputTokens: 71,
      byModel: [{ model: 'claude-opus-5-5', inputTokens: 730, outputTokens: 70, costUsd: 0.01 }, { model: 'claude-haiku-5-5', inputTokens: 5, outputTokens: 1 }] })
  })

  test('display names', () => {
    expect(['opus', 'claude-opus-5-5-20261101', 'anthropic/claude-opus-5-5', 'us.anthropic.claude-opus-5-5', 'claude-3-5-sonnet-20241022', 'claude-haiku-4-5[1m]'].map(modelDisplayName))
      .toEqual(['Claude Opus', 'Claude Opus', 'Claude Opus', 'Claude Opus', 'Claude Sonnet', 'Claude Haiku'])
    expect(modelDisplayName('gpt-5.5-codex')).toBe('GPT-5.5 Codex')
    expect(['claude-opus-4-5-20251101', 'claude-sonnet-4-20250514', 'claude-3-5-sonnet-20241022', 'opus', 'claude-haiku-4-5[1m]', 'gpt-5.5'].map(modelVersionName))
      .toEqual(['Claude Opus 4.5', 'Claude Sonnet 4', 'Claude Sonnet 3.5', 'Claude Opus', 'Claude Haiku 4.5', 'GPT-5.5'])
    expect(modelDisplayName('my-model')).toBe('my-model')
    expect(['opus', 'claude-sonnet-5-5', 'gpt-5.5'].map(claudeFamily)).toEqual(['opus', 'sonnet', null])
  })
})

describe('depth as engine flags', () => {
  const base = { turnId: 't', chatDir: path.join(os.tmpdir(), 'c-effort'), token: 'k', systemPrompt: 's', message: 'm', sessionId: '11111111-1111-4111-8111-111111111111', resume: false, stash: null, maxTurns: 1, timeoutMs: 1 }
  const bin = `/fake/claude-effort-${crypto.randomUUID()}`
  beforeAll(async () => { claudeKnowsEffort(bin, async () => 'Options:\n  --effort <level>'); await Bun.sleep(10) })

  test('Claude Code: 빠르게 = --effort low, 보통 = no flag, 꼼꼼하게 = --effort high; never xhigh or max', () => {
    const args = (effort?: 'low' | 'high') => buildClaudeLaunch({ ...base, ...(effort ? { effort } : {}) }, { bin, authMode: 'local-login', agentHome: '/a' }).args
    const flag = (a: string[]) => { const i = a.indexOf('--effort'); return i >= 0 ? a[i + 1] : null }
    expect([CLAUDE_EFFORT.quick, CLAUDE_EFFORT.normal, CLAUDE_EFFORT.thorough]).toEqual(['low', undefined, 'high'])
    expect(flag(args(CLAUDE_EFFORT.quick))).toBe('low')
    expect(flag(args(CLAUDE_EFFORT.normal))).toBeNull()
    expect(flag(args(CLAUDE_EFFORT.thorough))).toBe('high')
    // nothing chosen: the arguments are exactly today's
    expect(args()).toEqual(args(CLAUDE_EFFORT.normal))
    // an engine without --effort gets no flag (an unknown flag would fail the turn)
    expect(flag(buildClaudeLaunch({ ...base, effort: 'high' }, { bin: '/fake/old-claude', authMode: 'local-login', agentHome: '/a' }).args)).toBeNull()
  })

  test('Codex: model_reasoning_effort low / medium / high (the launch without a depth sends none; a chat turn always passes one, below)', () => {
    const conf = { bin: 'codex', codexHome: '/h', agentHome: '/a', catalog: '/cat.json', model: 'm1', auth: 'agent-own' as const }
    const setting = (a: string[]) => a.find((x) => x.startsWith('model_reasoning_effort='))
    expect(CODEX_REASONING).toEqual({ quick: 'low', normal: 'medium', thorough: 'high' })
    expect(setting(codexArgs(conf, { effort: 'quick' }))).toBe('model_reasoning_effort="low"')
    expect(setting(codexArgs(conf, { effort: 'normal' }))).toBe('model_reasoning_effort="medium"')
    expect(setting(codexArgs(conf, { effort: 'thorough' }))).toBe('model_reasoning_effort="high"')
    expect(setting(codexArgs(conf, {}))).toBeUndefined()
    expect(setting(codexArgs(conf, { effort: null }))).toBeUndefined()
  })
})

describe('choosing, in a running server', () => {
  let h: Harness
  let alice: TestSocket
  let carol: TestSocket
  beforeAll(async () => {
    h = await startHarness({ name: 'model-effort', memberChoice: { mode: 'off', groupIds: [], userIds: [] } })
    alice = await h.ws('alice')
    carol = await h.ws('carol')
    await alice.next('hello')
    await carol.next('hello')
  })
  afterAll(async () => { alice?.close(); carol?.close(); await h?.close() })

  const status = async (p: Promise<unknown>) => { try { await p; return 200 } catch (e) { if (e instanceof ApiError) return e.status; throw e } }

  test('the depth follows who may pick: a member of a team that keeps "off" cannot set it; an admin can, and it is kept for the chat', async () => {
    const mine = await h.api('alice').call(API.createChat, { body: {} })
    expect(await status(h.api('alice').call(API.createChat, { body: { effort: 'thorough' } }))).toBe(403)
    expect(await status(h.api('alice').call(API.updateChat, { params: { id: mine.id }, body: { effort: 'quick' } }))).toBe(403)
    expect(await status(h.api('alice').call(API.sendMessage, { params: { id: mine.id }, body: { content: 'x', clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [], effort: 'thorough' } }))).toBe(403)
    const chat = await h.api('carol').call(API.createChat, { body: { effort: 'thorough' } })
    expect(chat.effort).toBe('thorough')
    const r = await h.api('carol').call(API.sendMessage, { params: { id: chat.id }, body: { content: fake({ say: 'ok' }), clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
    await carol.next('message.done', (f) => f.data.messageId === r.assistantMessage.id)
    expect(h.ctx.db.query('SELECT effort FROM turns WHERE id = ?').get(r.turnId)).toEqual({ effort: 'thorough' })
    const r2 = await h.api('carol').call(API.sendMessage, { params: { id: chat.id }, body: { content: fake({ say: 'ok' }), clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [], effort: 'quick' } })
    await carol.next('message.done', (f) => f.data.messageId === r2.assistantMessage.id)
    expect((await h.api('carol').call(API.getChat, { params: { id: chat.id } })).effort).toBe('quick')
    // the person's own default and the team default
    await h.api('carol').call(API.updateMe, { body: { prefs: { effort: 'thorough' } } })
    expect((await h.api('carol').call(API.createChat, { body: {} })).effort).toBe('thorough')
    await h.api('dana').call(API.updateEngines, { body: { defaultEffort: 'quick' } })
    expect((await h.api('alice').call(API.chatEngines)).defaultEffort).toBe('quick')
    expect(turnEngine(h.ctx, { id: 'alice', role: 'member' }, { engine: 'claude-code', model: null, effort: null }, {}, 'en', () => null).effort).toBe('quick')
    await h.api('dana').call(API.updateEngines, { body: { defaultEffort: null } })
    await h.api('carol').call(API.updateMe, { body: { prefs: { effort: null } } })
  })

  test('a Codex turn nobody chose a depth for runs on 보통: model_reasoning_effort="medium", like the picker shows', async () => {
    const chat = await h.api('carol').call(API.createChat, { body: { engine: 'codex' } })
    expect(chat.effort ?? null).toBeNull()
    const { done } = await ask(h, carol, 'carol', chat.id, fake({ echo: 'args' }))
    expect(done.engine).toBe('codex')
    expect(done.content).toContain('model_reasoning_effort=\\"medium\\"')
  })

  test('GET /api/engines: which engines take a depth', async () => {
    const e = await h.api('carol').call(API.chatEngines)
    expect(e.engines.map((x) => [x.id, x.effort])).toEqual(e.engines.map((x) => [x.id, x.id !== 'api']))
  })

  test('the engine\'s report per model is recorded, turns.model stays what was asked for', async () => {
    const chat = await h.api('carol').call(API.createChat, { body: { model: 'sonnet' } })
    const { started } = await ask(h, carol, 'carol', chat.id, fake({ modelUsage: { 'claude-sonnet-5-5': { inputTokens: 40, outputTokens: 4 }, 'claude-haiku-5-5': { inputTokens: 3, outputTokens: 1 } } }, { say: 'ok' }))
    const id = started.turnId
    await Bun.sleep(50)
    expect(h.ctx.db.query('SELECT model, source, input_tokens AS i FROM turn_models WHERE turn_id = ? ORDER BY model').all(id))
      .toEqual([{ model: 'claude-haiku-5-5', source: 'engine', i: 3 }, { model: 'claude-sonnet-5-5', source: 'engine', i: 40 }])
    expect(h.ctx.db.query('SELECT model FROM turns WHERE id = ?').get(id)).toEqual({ model: 'sonnet' })
  })

  test('a new team lets everyone pick; a team from before keeps its rule', () => {
    expect(memberChoice(h.ctx).mode).toBe('off')
    settleNewTeamMemberChoice(h.ctx) // the key is set: untouched
    expect(memberChoice(h.ctx).mode).toBe('off')
    const env = makeEnv('b-model-effort-new-team')
    expect(env.db.query('SELECT 1 FROM settings WHERE key = ?').get(MEMBER_CHOICE_KEY)).toBeNull()
    settleNewTeamMemberChoice(env)
    expect(memberChoice(env).mode).toBe('everyone')
  })

  test('a scheduled run into a shared chat answers with that chat\'s model and depth, not the owner\'s default', async () => {
    await h.api('dana').call(API.updateEngines, { body: { memberChoice: { mode: 'everyone', groupIds: [], userIds: [] } } })
    try {
      // (alice's groups in this fixture are not real group ids, so her prefs are written here, not by PATCH /api/me)
      h.ctx.db.query(`UPDATE users SET prefs = '{"engine":"claude-code","model":"haiku","effort":"quick"}' WHERE id = 'alice'`).run()
      // a chat whose own model and depth differ from alice's defaults
      const chat = await h.api('alice').call(API.createChat, { body: { model: 'sonnet', effort: 'thorough' } })
      expect(newChatEngine(h.ctx, { id: 'alice', role: 'member' }, {}, 'en')).toEqual({ engine: 'claude-code', model: 'haiku', effort: 'quick' })
      const te = turnEngine(h.ctx, { id: 'alice', role: 'member' }, h.rt().store.chatRow(chat.id)!, {}, 'en', () => null)
      expect(te).toMatchObject({ engine: 'claude-code', model: 'sonnet', effort: 'thorough' })
      // the runtime decides from the chat the run lands in (ChatRuntime.createTurn engineFor, used by schedules.ts)
      const started = h.rt().createTurn({ chat: h.rt().store.chatRow(chat.id)!, userId: 'alice', locale: 'en', windowId: null, clientKind: 'schedule', engine: 'claude-code', model: 'haiku', effort: 'quick',
        engineFor: (c: Parameters<typeof turnEngine>[2]) => turnEngine(h.ctx, { id: 'alice', role: 'member' }, c, {}, 'en', () => null),
        user: { parentId: null, content: fake({ say: 'run' }), attachments: [], clientMessageId: 'cm-' + crypto.randomUUID() } })
      await alice.next('message.done', (f) => f.data.messageId === started.assistantMessage.id)
      expect(h.ctx.db.query('SELECT model, effort FROM turns WHERE id = ?').get(started.turnId)).toEqual({ model: 'sonnet', effort: 'thorough' })
    } finally {
      h.ctx.db.query("UPDATE users SET prefs = '{}' WHERE id = 'alice'").run()
      await h.api('dana').call(API.updateEngines, { body: { memberChoice: { mode: 'off', groupIds: [], userIds: [] } } })
    }
  })
})
