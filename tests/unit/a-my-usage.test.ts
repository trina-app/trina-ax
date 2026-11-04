// Settings > Usage (GET /api/me/usage): a person's own usage and the limits that apply to them. Never anyone else's
// turns, whatever the request asks; the admin's team report (/api/admin/usage) is unchanged and stays admin-only.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { uuidv7 } from '@mycel/shared/api'
import { myPeriodStart, myUsage } from '../../server/src/admin/my-usage'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

describe('my usage', () => {
  let h: Harness
  let owner: Client
  let alice: { client: Client; id: string }
  let bob: { client: Client; id: string }
  let group: string
  beforeAll(async () => {
    h = await harness('my-usage')
    owner = await withOwner(h)
    group = (await owner.call('POST', '/api/admin/groups', { name: 'Design' })).id
    alice = await addMember(h, owner, { username: 'alice', groupIds: [group] })
    bob = await addMember(h, owner, { username: 'bob' })
    const turn = (user: string, engine: string, model: string | null, inT: number, outT: number, cost: number, at: string) =>
      h.ctx.db.query("INSERT INTO turns (id, chat_id, user_id, engine, model, status, started_at, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, 'done', ?, ?, ?, ?)")
        .run(uuidv7(), uuidv7(), user, engine, model, at, inT, outT, cost)
    const now = new Date().toISOString()
    turn(alice.id, 'claude-code', 'sonnet', 100, 50, 0.5, now)
    turn(alice.id, 'claude-code', 'sonnet', 10, 5, 0.1, now)
    turn(alice.id, 'codex', null, 20, 10, 0.2, now)
    turn(bob.id, 'claude-code', 'opus', 9000, 9000, 50, now)
    turn('olga', 'claude-code', 'opus', 7000, 7000, 40, now)
    turn(alice.id, 'claude-code', 'sonnet', 1, 1, 9, new Date(Date.now() - 70 * 86_400_000).toISOString())
  })
  afterAll(() => h.close())

  test('a member sees only their own answers, per engine and model', async () => {
    const r = await alice.client.call('GET', '/api/me/usage')
    expect(r.period).toBe('month')
    expect(r.totals).toEqual({ turns: 3, inputTokens: 130, outputTokens: 65, costUsd: 0.8 })
    expect(r.byModel.map((x: any) => [x.engine, x.model, x.turns])).toEqual([['claude-code', 'sonnet', 2], ['codex', null, 1]])
    expect(JSON.stringify(r)).not.toContain(bob.id)
    expect(JSON.stringify(r)).not.toContain('olga')
    expect((await bob.client.call('GET', '/api/me/usage')).totals.turns).toBe(1)
  })

  test('nothing in the request can point it at someone else', async () => {
    for (const q of [`user=${bob.id}`, `userId=${bob.id}`, `subjectId=${bob.id}`, 'groupBy=user']) {
      const r = await alice.client.try('GET', `/api/me/usage?${q}`)
      // either refused, or still only alice's own three answers
      if (r.status === 200) expect((r.body as any).totals.turns).toBe(3)
      else expect(r.status).toBe(400)
    }
    expect((await alice.client.try('GET', '/api/me/usage?period=year')).status).toBe(400)
    expect((await h.client().try('GET', '/api/me/usage')).status).toBe(401)
  })

  test('the team report stays admin-only and unchanged', async () => {
    expect((await alice.client.try('GET', '/api/admin/usage')).status).toBe(403)
    const team = await owner.call('GET', '/api/admin/usage')
    expect(team.totals.turns).toBe(5)
    expect(team.rows.map((x: any) => x.key).sort()).toEqual([alice.id, bob.id, 'olga'].sort())
  })

  test('limits that apply: their own, their group\'s and the team\'s, fullest that stops answers first', async () => {
    expect((await alice.client.call('GET', '/api/me/usage')).limits).toEqual([])
    await owner.call('POST', '/api/admin/budgets', { subjectType: 'user', subjectId: alice.id, period: 'month', limitUsd: 1, action: 'warn' })
    await owner.call('POST', '/api/admin/budgets', { subjectType: 'group', subjectId: group, period: 'day', limitUsd: 0, limitTokens: 100, action: 'block' })
    await owner.call('POST', '/api/admin/budgets', { subjectType: 'team', subjectId: null, period: 'month', limitUsd: 1000, action: 'block' })
    // bob's own limit is not alice's business, and a 0 money limit with no token limit limits nothing
    await owner.call('POST', '/api/admin/budgets', { subjectType: 'user', subjectId: bob.id, period: 'month', limitUsd: 5, action: 'block' })
    await owner.call('POST', '/api/admin/budgets', { subjectType: 'team', subjectId: null, period: 'day', limitUsd: 0, action: 'warn' })
    const limits = (await alice.client.call('GET', '/api/me/usage')).limits
    expect(limits.map((l: any) => [l.scope, l.name, l.period, l.action, l.exceeded])).toEqual([
      ['group', 'Design', 'day', 'block', true],
      ['you', null, 'month', 'warn', false],
      ['team', null, 'month', 'block', false],
    ])
    expect(limits[0].usedPct).toBe(195)
    expect(limits[1].usedPct).toBe(80)
    expect(limits[2].usedPct).toBeCloseTo(9.1, 1)
    for (const l of limits) expect(Date.parse(l.resetsAt)).toBeGreaterThan(Date.now())
    expect((await bob.client.call('GET', '/api/me/usage')).limits.map((l: any) => l.scope)).toEqual(['you', 'team'])
  })

  test('a week starts on Monday in the team time zone', () => {
    // Wednesday 2026-11-04 10:00 in Seoul -> Monday 2026-11-02 00:00 KST = 2026-11-01 15:00 UTC
    expect(myPeriodStart('week', new Date('2026-11-04T01:00:00Z'), 'Asia/Seoul').toISOString()).toBe('2026-11-01T15:00:00.000Z')
    // a Sunday belongs to the week that began six days before; across a month boundary
    expect(myPeriodStart('week', new Date('2026-11-01T05:00:00Z'), 'UTC').toISOString()).toBe('2026-10-26T00:00:00.000Z')
    expect(myUsage(h.ctx.db, alice.id, 'day').period).toBe('day')
  })
})
