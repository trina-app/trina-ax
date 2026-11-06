// Admin > Usage in the Console style: the read-only report takes filters (person, engine, model, AI connection, group),
// a per-day series for the chart and the filter choices (facets). The rows, totals and series follow the filters;
// the facets do not. Synthetic turns only.
import { beforeEach, expect, test } from 'bun:test'
import { makeEnv } from '../lib/env'
import { usage } from '../../server/src/admin/budgets'
import { UsageQuery } from '@mycel/shared/api'

const env = makeEnv('a-usage-console')
const from = '2026-10-01T00:00:00.000Z', to = '2026-10-04T00:00:00.000Z'
const report = (q: Record<string, string>) => usage(env.db, UsageQuery.parse({ from, to, ...q }))

beforeEach(() => {
  env.db.query("DELETE FROM turns WHERE id LIKE 'uc-%'").run()
  env.db.query("DELETE FROM group_members WHERE group_id = 'uc-group'").run()
  env.db.query("DELETE FROM groups WHERE id = 'uc-group'").run()
  // day 1: alice claude model-a 10/2, bob codex (default model) 5/1; day 2: alice claude model-b 20/4; outside: alice
  const turns: [string, string, string, string, string | null, number, number][] = [
    ['uc-1', '2026-10-01T10:00:00.000Z', 'alice', 'claude-code', 'model-a', 10, 2],
    ['uc-2', '2026-10-01T11:00:00.000Z', 'bob', 'codex', null, 5, 1],
    ['uc-3', '2026-10-02T10:00:00.000Z', 'alice', 'claude-code', 'model-b', 20, 4],
    ['uc-out', '2026-10-04T10:00:00.000Z', 'alice', 'claude-code', 'model-a', 999, 999],
  ]
  for (const [id, at, user, engine, model, i, o] of turns) {
    env.db.query("INSERT INTO turns (id, chat_id, user_id, engine, model, status, started_at, input_tokens, output_tokens, cost_usd) VALUES (?, 'c', ?, ?, ?, 'done', ?, ?, ?, 0)").run(id, user, engine, model, at, i, o)
  }
  env.db.query("INSERT INTO groups (id, name) VALUES ('uc-group', 'UC Sales')").run()
  env.db.query("INSERT INTO group_members (group_id, user_id) VALUES ('uc-group', 'bob')").run()
})

test('the new query fields are optional and parse from query strings', () => {
  expect(UsageQuery.parse({}).series).toBeUndefined()
  expect(UsageQuery.parse({ series: '1', facets: 'true', model: '' })).toMatchObject({ series: true, facets: true, model: '' })
})

test('without filters the report is what it was: rows, totals, and no series or facets', () => {
  const r = report({ groupBy: 'user' })
  expect(r.totals).toMatchObject({ turns: 3, inputTokens: 35, outputTokens: 7 })
  expect(r.series).toBeUndefined()
  expect(r.facets).toBeUndefined()
})

test('filters narrow rows and totals alike', () => {
  expect(report({ groupBy: 'model', user: 'alice' }).totals).toMatchObject({ turns: 2, inputTokens: 30, outputTokens: 6 })
  expect(report({ groupBy: 'user', engine: 'codex' }).rows.map((r) => r.key)).toEqual(['bob'])
  // '' is the default model
  expect(report({ groupBy: 'user', model: '' }).totals).toMatchObject({ turns: 1, inputTokens: 5 })
  expect(report({ groupBy: 'engine', model: 'model-b' }).rows).toEqual([expect.objectContaining({ key: 'claude-code', turns: 1, inputTokens: 20 })])
  // a group's members
  expect(report({ groupBy: 'user', group: 'uc-group' }).totals).toMatchObject({ turns: 1, inputTokens: 5, outputTokens: 1 })
  // filters also apply to the per-day rows
  expect(report({ groupBy: 'day', user: 'alice' }).rows.reduce((n, r) => n + r.turns, 0)).toBe(2)
})

test('the series is tokens per day by the groupBy key, follows the filters, and adds up to the totals', () => {
  const r = report({ groupBy: 'user', series: '1' })
  const sum = (s: NonNullable<typeof r.series>) => s.reduce((n, p) => n + p.inputTokens + p.outputTokens, 0)
  expect(sum(r.series!)).toBe(r.totals.inputTokens + r.totals.outputTokens)
  expect(new Set(r.series!.map((p) => p.key))).toEqual(new Set(['alice', 'bob']))
  expect(r.series!.every((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.day))).toBe(true)
  const days = report({ groupBy: 'day', series: '1' }).series!
  expect(days.every((p) => p.key === 'all')).toBe(true)
  const alice = report({ groupBy: 'model', series: '1', user: 'alice' })
  expect(sum(alice.series!)).toBe(36)
  expect(new Set(alice.series!.map((p) => p.key))).toEqual(new Set(['model-a', 'model-b']))
})

test('facets list the choices in the range whatever the filters are', () => {
  const f = report({ groupBy: 'user', facets: '1', user: 'bob' }).facets!
  expect(f.users.map((u) => u.key).sort()).toEqual(['alice', 'bob'])
  expect(f.engines.map((e) => e.key)).toEqual(['claude-code', 'codex'])
  expect(f.models).toContainEqual({ key: '', label: '(default)' })
  expect(f.groups).toContainEqual({ key: 'uc-group', label: 'UC Sales' })
})
