// "Est. cost" on the usage screens is never a flat $0 for real use (QA TC-3143). A subscription sign-in (Claude, ChatGPT)
// adds 0 to the money spent (budgets, connection limits: D16) and its API list price to turns.est_cost_usd; the usage
// totals show both and count the estimated turns. A turn with tokens and no amount counts as unpriced.
import { describe, expect, test } from 'bun:test'
import path from 'node:path'
import { makeEnv } from '../lib/env'
import { addCred, testCredCtx } from '../lib/credentials'
import { createBroker } from '../../server/src/credentials/broker'
import { claudeCost, claudePrice, costOf, estimateOf, openaiCost } from '../../server/src/credentials/prices'
import { budgetBlock, usage } from '../../server/src/admin/budgets'
import { myUsage } from '../../server/src/admin/my-usage'
import { turnAmount } from '../../server/src/admin/usage-amount'
import { setSetting } from '../../server/src/admin/settings'
import { SHARED_SUBSCRIPTIONS_KEY } from '../../server/src/credentials/policy'
import { CodexEventParser } from '../../server/src/engine/codex-parse'

describe('pricing', () => {
  test('Claude Fable 5.2 and Mythos 5.2 are in the table at $8 / $40, cache reads $0.20', () => {
    for (const m of ['claude-fable-5-2', 'claude-mythos-5-2']) {
      expect(claudePrice(m)).toEqual({ in: 8, cw5: 10, cw1h: 16, cr: 0.2, out: 40 })
      expect(claudeCost(m, { input_tokens: 1e6, cache_read_input_tokens: 1e6, output_tokens: 1e6 })).toBeCloseTo(48.2, 6)
    }
  })

  test('a subscription request is estimated at API list prices, never charged; an API key request is charged, not estimated', () => {
    const cu = { input_tokens: 1000, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 2000, output_tokens: 500 }
    expect(costOf('anthropic-oauth', 'claude-opus-5-5', cu)).toBe(0)
    expect(estimateOf('anthropic-oauth', 'claude-opus-5-5', cu)).toBeCloseTo((1000 * 4 + 40_000 * 0.2 + 2000 * 5 + 500 * 20) / 1e6, 9)
    const ou = { input_tokens: 10_000, input_tokens_details: { cached_tokens: 8000 }, output_tokens: 1000 }
    expect(costOf('chatgpt', 'gpt-5.4', ou)).toBe(0)
    expect(estimateOf('chatgpt', 'gpt-5.4', ou)).toBeCloseTo(openaiCost('gpt-5.4', ou), 12)
    expect(estimateOf('chatgpt', 'gpt-5.4', ou)).toBeGreaterThan(0)
    expect(estimateOf('anthropic-api-key', 'claude-opus-5-5', cu)).toBe(0)
    expect(estimateOf('openai-api-key', 'gpt-5.4', ou)).toBe(0)
  })

  test('Codex reports tokens and no cost: its usage is marked price unknown, not free', () => {
    const p = new CodexEventParser()
    const ev = p.push(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 30, reasoning_output_tokens: 10 } }))
    expect(ev).toEqual([{ type: 'usage', inputTokens: 1200, outputTokens: 40, costUnknown: true }])
  })

  test('one turn row: amount = cost + estimate; unpriced = tokens with no amount on a proxy row, or engine_unpriced', () => {
    const r = (o: Partial<Parameters<typeof turnAmount>[0]>) => turnAmount({ input_tokens: 10, output_tokens: 1, cost_usd: 0, est_cost_usd: null, usage_source: 'proxy', ...o })
    expect(r({ est_cost_usd: 0.5 })).toEqual({ usd: 0.5, estimated: true, unpriced: false })
    expect(r({ cost_usd: 0.25, est_cost_usd: 0 })).toEqual({ usd: 0.25, estimated: false, unpriced: false })
    expect(r({})).toEqual({ usd: 0, estimated: false, unpriced: true }) // a subscription turn from before the estimate
    expect(r({ input_tokens: 0, output_tokens: 0 })).toEqual({ usd: 0, estimated: false, unpriced: false }) // nothing used
    expect(r({ usage_source: 'engine_unpriced', cost_usd: 0.1 })).toEqual({ usd: 0.1, estimated: false, unpriced: true })
    expect(r({ usage_source: 'engine', cost_usd: 0.3 })).toEqual({ usd: 0.3, estimated: false, unpriced: false })
  })
})

describe('usage totals', () => {
  const env = makeEnv('a-usage-estimate')
  setSetting(env.db, SHARED_SUBSCRIPTIONS_KEY, true)
  const t = testCredCtx(env.db, path.join(env.fx.data, 'secrets'))
  const sub = addCred(t.cc, 'anthropic-oauth', 'sk-ant-oat01-' + 'Q'.repeat(40), { label: 'Team Max' })
  const key = addCred(t.cc, 'anthropic-api-key', 'sk-ant-api03-' + 'K'.repeat(40), { label: 'Team key' })
  const broker = createBroker(t.cc)
  const now = new Date()
  const turn = (user: string, engine = 'claude-code', model: string | null = 'claude-opus-5-5') => {
    const id = crypto.randomUUID()
    env.db.query("INSERT INTO turns (id, chat_id, user_id, engine, model, status, started_at, input_tokens, output_tokens) VALUES (?, 'c', ?, ?, ?, 'done', ?, 0, 0)")
      .run(id, user, engine, model, now.toISOString())
    return id
  }
  const cu = { input_tokens: 1000, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 2000, output_tokens: 500 }
  const est = estimateOf('anthropic-oauth', 'claude-opus-5-5', cu)
  const charged = costOf('anthropic-api-key', 'claude-opus-5-5', cu)

  // alice: two requests of one turn on the team subscription, one turn on the API key
  const subTurn = turn('alice')
  broker.record(sub, subTurn, 'claude-opus-5-5', cu)
  broker.record(sub, subTurn, 'claude-opus-5-5', cu)
  const keyTurn = turn('alice')
  broker.record(key, keyTurn, 'claude-opus-5-5', cu)
  // bob: a subscription turn from before the estimate (the proxy wrote cost 0 and no estimate), and Codex on a local login
  const old = turn('bob')
  env.db.query("UPDATE turns SET input_tokens = 500, output_tokens = 20, cost_usd = 0, usage_source = 'proxy' WHERE id = ?").run(old)
  const codex = turn('bob', 'codex', null)
  env.db.query("UPDATE turns SET input_tokens = 900, output_tokens = 40, cost_usd = 0, usage_source = 'engine_unpriced' WHERE id = ?").run(codex)

  test('the proxy writes the estimate beside the money spent; the connection\'s day keeps the money only', () => {
    const row = (id: string) => env.db.query('SELECT input_tokens, output_tokens, cost_usd, est_cost_usd, usage_source FROM turns WHERE id = ?').get(id) as Record<string, number | string>
    expect(row(subTurn)).toMatchObject({ input_tokens: 86_000, output_tokens: 1000, cost_usd: 0, usage_source: 'proxy' })
    expect(row(subTurn).est_cost_usd as number).toBeCloseTo(2 * est, 9)
    expect(row(keyTurn).cost_usd as number).toBeCloseTo(charged, 9)
    expect(row(keyTurn).est_cost_usd).toBe(0)
    expect((env.db.query('SELECT cost_usd FROM credential_usage_daily WHERE credential_id = ?').get(sub) as { cost_usd: number }).cost_usd).toBe(0)
  })

  test('Admin › Usage: totals sum money and estimate, count estimated and unpriced turns, by any grouping', () => {
    for (const groupBy of ['user', 'model', 'engine', 'day', 'credential'] as const) {
      const r = usage(env.db, { groupBy } as Parameters<typeof usage>[1])
      expect(r.totals.turns).toBe(4)
      expect(r.totals.costUsd).toBeCloseTo(2 * est + charged, 9)
      expect(r.totals.estimatedTurns).toBe(1)
      expect(r.totals.unpricedTurns).toBe(2)
    }
    const byUser = usage(env.db, { groupBy: 'user' } as Parameters<typeof usage>[1]).rows
    const alice = byUser.find((x) => x.key === 'alice')!
    expect(alice.costUsd).toBeCloseTo(2 * est + charged, 9)
    expect(alice.estimatedTurns).toBe(1)
    expect(alice.unpricedTurns).toBeUndefined()
    // bob used tokens and nothing of it has a price: never a plain $0
    expect(byUser.find((x) => x.key === 'bob')).toMatchObject({ costUsd: 0, unpricedTurns: 2 })
    expect(byUser.find((x) => x.key === 'bob')!.estimatedTurns).toBeUndefined()
    const byDay = usage(env.db, { groupBy: 'day' } as Parameters<typeof usage>[1]).rows
    expect(byDay).toHaveLength(1)
    expect(byDay[0]).toMatchObject({ turns: 4, estimatedTurns: 1, unpricedTurns: 2 })
  })

  test('Settings › Usage: the person\'s own totals the same way', () => {
    const a = myUsage(env.db, 'alice', 'day', now)
    expect(a.totals.costUsd).toBeCloseTo(2 * est + charged, 9)
    expect(a.totals).toMatchObject({ turns: 2, estimatedTurns: 1 })
    expect(a.totals.unpricedTurns).toBeUndefined()
    expect(myUsage(env.db, 'bob', 'day', now).totals).toMatchObject({ turns: 2, costUsd: 0, unpricedTurns: 2 })
  })

  test('budgets still count money spent only: a subscription estimate never fills a USD limit', () => {
    env.db.query("INSERT INTO budgets (id, subject_type, subject_id, period, limit_usd, limit_tokens, action) VALUES ('b-est', 'user', 'alice', 'day', ?, NULL, 'block')").run(charged * 1.5)
    expect(budgetBlock(env.db, 'alice', 'en', now)).toBeNull()
  })
})
