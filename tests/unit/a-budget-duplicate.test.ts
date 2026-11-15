// Usage limits: one per subject (a person, a group, the whole team) and period. A second one is refused (409
// budget_duplicate); duplicates already in a database keep working and can still be edited (server/src/admin/budgets.ts).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { uuidv7 } from '@mycel/shared/api'
import { checkBudgets } from '../../server/src/admin/budgets'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

describe('usage limits: no second limit for the same subject and period', () => {
  let h: Harness
  let owner: Client
  let admin: Client
  let mem: { client: Client; id: string }
  let other: { client: Client; id: string }
  let group: string
  const post = (body: Record<string, unknown>) => admin.try('POST', '/api/admin/budgets', { limitUsd: 0, limitTokens: 1000, action: 'warn', ...body })
  beforeAll(async () => {
    h = await harness('budget-dup')
    owner = await withOwner(h)
    admin = (await addMember(h, owner, { username: 'adam', role: 'admin' })).client
    group = (await admin.call('POST', '/api/admin/groups', { name: 'Ops' })).id
    mem = await addMember(h, owner, { username: 'max', groupIds: [group] })
    other = await addMember(h, owner, { username: 'nina' })
    // the admin reads English here (a new account follows the server's default language)
    h.ctx.db.query("UPDATE users SET locale = 'en' WHERE username = 'adam'").run()
  })
  afterAll(() => h.close())

  test('a person, a group and the team: the second limit for a period is refused with a plain line', async () => {
    for (const subject of [{ subjectType: 'user', subjectId: () => mem.id }, { subjectType: 'group', subjectId: () => group }, { subjectType: 'team', subjectId: () => null }] as const) {
      const first = await post({ subjectType: subject.subjectType, subjectId: subject.subjectId(), period: 'month' })
      expect(first.status).toBe(201)
      const second = await post({ subjectType: subject.subjectType, subjectId: subject.subjectId(), period: 'month', limitTokens: 5, action: 'block' })
      expect(second.status).toBe(409)
      expect(second.body.error.code).toBe('conflict')
      expect(second.body.error.params).toMatchObject({ reason: 'budget_duplicate' })
      expect(second.body.error.message).toBe('There is already a usage limit for this with the same period. Edit that one in the list instead.')
    }
    const items = (await admin.call('GET', '/api/admin/budgets')).items
    expect(items).toHaveLength(3)
    // the refused one did not slip in: still the first one's numbers
    expect(items.every((b: any) => b.limitTokens === 1000 && b.action === 'warn')).toBe(true)
  })

  test('another period, another person or another group is still a new limit', async () => {
    expect((await post({ subjectType: 'user', subjectId: mem.id, period: 'day' })).status).toBe(201)
    expect((await post({ subjectType: 'user', subjectId: other.id, period: 'month' })).status).toBe(201)
    const g2 = (await admin.call('POST', '/api/admin/groups', { name: 'Sales' })).id
    expect((await post({ subjectType: 'group', subjectId: g2, period: 'month' })).status).toBe(201)
    expect((await post({ subjectType: 'team', subjectId: null, period: 'day' })).status).toBe(201)
  })

  test("the line is in the admin's own language", async () => {
    h.ctx.db.query("UPDATE users SET locale = 'ko' WHERE username = 'adam'").run()
    try {
      const r = await admin.try('POST', '/api/admin/budgets', { subjectType: 'user', subjectId: mem.id, period: 'month', limitUsd: 1, action: 'warn' })
      expect(r.status).toBe(409)
      expect(r.body.error.message).toBe('같은 대상에 같은 기간의 사용 한도가 이미 있어요. 목록에서 그 한도를 바꿔 주세요.')
    } finally {
      h.ctx.db.query("UPDATE users SET locale = 'en' WHERE username = 'adam'").run()
    }
  })

  test('an edit that moves a limit onto a taken subject and period is refused; an edit in place is not', async () => {
    const items = (await admin.call('GET', '/api/admin/budgets')).items as any[]
    const memDay = items.find((b) => b.subjectType === 'user' && b.subjectId === mem.id && b.period === 'day')
    const otherMonth = items.find((b) => b.subjectType === 'user' && b.subjectId === other.id && b.period === 'month')
    // mem's day limit -> month (mem has one) is refused, and nothing changes
    const moved = await admin.try('PATCH', `/api/admin/budgets/${memDay.id}`, { period: 'month' })
    expect(moved.status).toBe(409)
    expect(moved.body.error.params).toMatchObject({ reason: 'budget_duplicate' })
    // nina's month limit -> mem (mem has a month one) is refused too
    expect((await admin.try('PATCH', `/api/admin/budgets/${otherMonth.id}`, { subjectId: mem.id })).status).toBe(409)
    // a group limit -> the whole team's month (taken) is refused
    const grp = items.find((b) => b.subjectType === 'group' && b.subjectId === group)
    expect((await admin.try('PATCH', `/api/admin/budgets/${grp.id}`, { subjectType: 'team', subjectId: null })).status).toBe(409)
    const after = (await admin.call('GET', '/api/admin/budgets')).items as any[]
    expect(after.find((b) => b.id === memDay.id).period).toBe('day')
    expect(after.find((b) => b.id === otherMonth.id).subjectId).toBe(other.id)
    // an edit that keeps the subject and period, and a move to a free period, are fine
    expect((await admin.call('PATCH', `/api/admin/budgets/${memDay.id}`, { limitTokens: 7, action: 'block' }))).toMatchObject({ limitTokens: 7, period: 'day' })
    expect((await admin.call('PATCH', `/api/admin/budgets/${otherMonth.id}`, { period: 'day' }))).toMatchObject({ period: 'day', subjectId: other.id })
  })

  test('duplicates already in the database keep counting and can still be edited and removed', async () => {
    // an older server let a second one in: put one there directly, as an existing database has it
    const old = uuidv7()
    h.ctx.db.query("INSERT INTO budgets (id, subject_type, subject_id, period, limit_usd, limit_tokens, action) VALUES (?, 'user', ?, 'month', 0, 0, 'block')").run(old, mem.id)
    const mine = (await admin.call('GET', '/api/admin/budgets')).items.filter((b: any) => b.subjectType === 'user' && b.subjectId === mem.id && b.period === 'month')
    expect(mine).toHaveLength(2)
    // both still apply: the 0-token block one is used up at once
    const hits = checkBudgets(h.ctx.db, mem.id).filter((x) => x.budget.subjectType === 'user' && x.budget.period === 'month')
    expect(hits).toHaveLength(2)
    expect(hits.find((x) => x.budget.id === old)?.exceeded).toBe(true)
    // editing either one in place works (same subject and period)
    expect(await admin.call('PATCH', `/api/admin/budgets/${old}`, { limitTokens: 50_000, action: 'warn' })).toMatchObject({ id: old, limitTokens: 50_000, action: 'warn' })
    const first = mine.find((b: any) => b.id !== old)
    expect(await admin.call('PATCH', `/api/admin/budgets/${first.id}`, { limitTokens: 2000, subjectType: 'user', subjectId: mem.id, period: 'month' })).toMatchObject({ id: first.id, limitTokens: 2000 })
    // still no third one
    expect((await post({ subjectType: 'user', subjectId: mem.id, period: 'month' })).status).toBe(409)
    // removing the old one leaves one, and nothing else was deleted
    await admin.call('DELETE', `/api/admin/budgets/${old}`)
    expect((await admin.call('GET', '/api/admin/budgets')).items.filter((b: any) => b.subjectType === 'user' && b.subjectId === mem.id && b.period === 'month')).toHaveLength(1)
  })

  test('a member still cannot add limits at all', async () => {
    expect((await mem.client.try('POST', '/api/admin/budgets', { subjectType: 'user', subjectId: other.id, period: 'month', limitUsd: 1, action: 'warn' })).status).toBe(403)
  })
})
