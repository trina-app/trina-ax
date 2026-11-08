// Budget and connection-limit notices (docs/DECISIONS.md "AI 연결" D17): a warn budget tells at 100%, a block budget at
// 80% and 100%, once per period, to the owner and admins (and the person whose budget it is); a connection's monthly
// limit tells at 80% / 100% and, with "block", takes the connection out of the resolution.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import path from 'node:path'
import { makeEnv } from '../lib/env'
import { addCred, testCredCtx } from '../lib/credentials'
import { afterUsage } from '../../server/src/admin/budget-watch'
import { budgetBlock } from '../../server/src/admin/budgets'
import { setSetting, updateTeamSettings } from '../../server/src/admin/settings'
import { SHARED_SUBSCRIPTIONS_KEY } from '../../server/src/credentials/policy'
import { afterCredentialUsage } from '../../server/src/credentials/limits'
import { resolveCredential } from '../../server/src/credentials/resolve'
import { createBroker } from '../../server/src/credentials/broker'
import { getRow, teamDay, toCredential, unusable } from '../../server/src/credentials/store'
import { ALL_CREDENTIAL_KINDS } from '../../server/src/app-config'
import type { Notice } from '../../server/src/credentials/store'

const env = makeEnv('a-budget-watch')
const sent: { n: Notice; to?: string[] }[] = []
const notify = (n: Notice, to?: string[]) => sent.push({ n, to })
const turn = (user: string, tokens: number) => env.db.query("INSERT INTO turns (id, chat_id, user_id, engine, input_tokens, output_tokens) VALUES (?, 'c', ?, 'claude-code', ?, 0)").run(crypto.randomUUID(), user, tokens)
beforeEach(() => { sent.length = 0; env.db.query('DELETE FROM turns').run(); env.db.query('DELETE FROM budgets').run(); env.db.query('DELETE FROM budget_notices').run() })

describe('budget notices', () => {
  test('block budget: 80% "soon blocked", then 100%, each once per period; the admins and the person hear it', () => {
    env.db.query("INSERT INTO budgets (id, subject_type, subject_id, period, limit_usd, limit_tokens, action) VALUES ('b1', 'user', 'alice', 'day', 0, 1000, 'block')").run()
    turn('alice', 500)
    afterUsage(env.db, 'alice', notify, new Date(), true)
    expect(sent).toEqual([])
    turn('alice', 300)
    afterUsage(env.db, 'alice', notify, new Date(), true)
    afterUsage(env.db, 'alice', notify, new Date(), true)
    expect(sent.length).toBe(1)
    expect(sent[0]!.n.code).toBe('budget_warn')
    expect(sent[0]!.n.message.en).toContain('80%')
    expect(sent[0]!.to).toContain('alice')
    expect(sent[0]!.to).toContain('dana') // the owner
    turn('alice', 300)
    afterUsage(env.db, 'alice', notify, new Date(), true)
    expect(sent.length).toBe(2)
    expect(sent[1]!.n.message.en).toContain('used up')
    expect((env.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'budget.warned'").get() as { n: number }).n).toBeGreaterThanOrEqual(2)
  })
  test('warn budget: only at 100%; a team budget goes to the admins', () => {
    env.db.query("INSERT INTO budgets (id, subject_type, subject_id, period, limit_usd, limit_tokens, action) VALUES ('b2', 'team', NULL, 'month', 0, 1000, 'warn')").run()
    turn('bob', 900)
    afterUsage(env.db, 'bob', notify, new Date(), true)
    expect(sent).toEqual([])
    turn('bob', 200)
    afterUsage(env.db, 'bob', notify, new Date(), true)
    expect(sent.length).toBe(1)
    expect(sent[0]!.to).not.toContain('bob')
  })
  test('computed at most every 30 seconds per person', () => {
    env.db.query("INSERT INTO budgets (id, subject_type, subject_id, period, limit_usd, limit_tokens, action) VALUES ('b3', 'user', 'erin', 'day', 0, 10, 'warn')").run()
    afterUsage(env.db, 'erin', notify, new Date(), true)
    turn('erin', 100)
    afterUsage(env.db, 'erin', notify, new Date())
    expect(sent).toEqual([])
    afterUsage(env.db, 'erin', notify, new Date(Date.now() + 31_000))
    expect(sent.length).toBe(1)
  })
})

describe('a connection\'s monthly limit', () => {
  beforeEach(() => setSetting(env.db, SHARED_SUBSCRIPTIONS_KEY, true))
  test('80% / 100% once each; "block" takes it out of the resolution, "warn" does not', () => {
    const t = testCredCtx(env.db, path.join(env.fx.data, 'secrets'))
    const a = addCred(t.cc, 'anthropic-oauth', 'sk-ant-oat01-' + 'L'.repeat(40), { label: 'Limited' })
    const b = addCred(t.cc, 'anthropic-oauth', 'sk-ant-oat01-' + 'M'.repeat(40), { label: 'Spare', createdAt: '2099-01-01T00:00:00.000Z' })
    env.db.query("UPDATE engine_credentials SET spend_limit_tokens = 1000, spend_limit_action = 'block' WHERE id = ?").run(a)
    const day = teamDay(env.db, new Date())
    const use = (n: number) => env.db.query('INSERT INTO credential_usage_daily (credential_id, day, requests, input_tokens, output_tokens, cost_usd) VALUES (?, ?, 1, ?, 0, 0) ON CONFLICT(credential_id, day) DO UPDATE SET input_tokens = input_tokens + excluded.input_tokens').run(a, day, n)
    const all = new Set(ALL_CREDENTIAL_KINDS)
    use(850); afterCredentialUsage(t.cc, a); afterCredentialUsage(t.cc, a)
    expect(t.notices.map((x) => x.n.code)).toEqual(['credential_limit'])
    expect(resolveCredential(env.db, { userId: 'alice', engine: 'claude-code', allowedKinds: all })).toMatchObject({ ok: true, credentialId: a })
    use(200); afterCredentialUsage(t.cc, a)
    expect(t.notices.length).toBe(2)
    expect(resolveCredential(env.db, { userId: 'alice', engine: 'claude-code', allowedKinds: all })).toMatchObject({ ok: true, credentialId: b })
    env.db.query("UPDATE engine_credentials SET spend_limit_action = 'warn' WHERE id = ?").run(a)
    expect(resolveCredential(env.db, { userId: 'alice', engine: 'claude-code', allowedKinds: all })).toMatchObject({ ok: true, credentialId: a })
  })
})

// A hosted server runs in UTC; the team counts in Asia/Seoul (UTC+9). Days and months must be the team's, also for
// the once-per-period notice keys and a connection's monthly limit, not the process's.
describe('the team\'s day and month on a server in UTC', () => {
  const tzEnv = makeEnv('a-budget-watch-tz')
  const before = process.env.TZ
  beforeAll(() => { process.env.TZ = 'UTC'; updateTeamSettings(tzEnv.db, { timeZone: 'Asia/Seoul' }) })
  afterAll(() => { if (before === undefined) delete process.env.TZ; else process.env.TZ = before })
  const turnAt = (user: string, at: string, tokens: number) => {
    const id = crypto.randomUUID()
    tzEnv.db.query("INSERT INTO turns (id, chat_id, user_id, engine, status, started_at, input_tokens, output_tokens) VALUES (?, 'c', ?, 'claude-code', 'done', ?, ?, 0)").run(id, user, at, tokens)
    return id
  }

  test('a daily block budget crossed on two Seoul days of one UTC day tells the admins both days', () => {
    expect(new Date('2026-11-09T23:00:00Z').getDate()).toBe(9) // the process really reads UTC
    tzEnv.db.query("INSERT INTO budgets (id, subject_type, subject_id, period, limit_usd, limit_tokens, action) VALUES ('bz', 'user', 'alice', 'day', 0, 1000, 'block')").run()
    const got: { n: Notice; to?: string[] }[] = []
    // yesterday: crossed at 14:00 KST (05:00 UTC on the 9th)
    turnAt('alice', '2026-11-09T04:30:00.000Z', 1000)
    const day1 = new Date('2026-11-09T05:00:00Z')
    afterUsage(tzEnv.db, 'alice', (n, to) => got.push({ n, to }), day1, true)
    expect(got.length).toBe(2) // 80% and used up
    // today: crossed at 08:00 KST, still the 9th in UTC
    turnAt('alice', '2026-11-09T22:30:00.000Z', 1000)
    const day2 = new Date('2026-11-09T23:00:00Z')
    expect(budgetBlock(tzEnv.db, 'alice', 'en', day2)).not.toBeNull() // the person is blocked ...
    afterUsage(tzEnv.db, 'alice', (n, to) => got.push({ n, to }), day2, true)
    expect(got.length).toBe(4) // ... and the admins hear it again
    expect(got[3]!.n.message.en).toContain('used up')
    expect(got[3]!.to).toContain('dana')
    // keyed by the start of the Seoul day: 00:00 KST = 15:00 UTC the day before
    expect((tzEnv.db.query("SELECT period_start FROM budget_notices WHERE budget_id = 'bz' AND level = 'reached' ORDER BY period_start").all() as { period_start: string }[]).map((r) => r.period_start))
      .toEqual(['2026-11-08T15:00:00.000Z', '2026-11-09T15:00:00.000Z'])
  })

  test('a connection\'s month starts at 00:00 KST on the 1st: the limit, its reset time, "this month" and the notices', () => {
    setSetting(tzEnv.db, SHARED_SUBSCRIPTIONS_KEY, true)
    let now = Date.parse('2026-10-31T11:00:00Z') // 20:00 KST on Oct 31
    const t = testCredCtx(tzEnv.db, path.join(tzEnv.fx.data, 'secrets'), { now: () => now })
    const a = addCred(t.cc, 'anthropic-oauth', 'sk-ant-oat01-' + 'Z'.repeat(40), { label: 'Seoul' })
    tzEnv.db.query("UPDATE engine_credentials SET spend_limit_tokens = 1000, spend_limit_action = 'block' WHERE id = ?").run(a)
    const broker = createBroker(t.cc)
    const use = (tokens: number) => {
      broker.record(a, turnAt('alice', new Date(now).toISOString(), 0), 'claude-sonnet-4-5', { input_tokens: tokens, output_tokens: 0 })
      afterCredentialUsage(t.cc, a)
    }
    const all = new Set(ALL_CREDENTIAL_KINDS)
    use(1000)
    expect(t.notices.length).toBe(2) // 80% and 100% of October
    // used up: back at 00:00 KST on Nov 1 (15:00 UTC), not 09:00 KST
    expect(unusable(tzEnv.db, getRow(tzEnv.db, a)!, new Date(now), all)).toEqual({ why: 'over_limit', retryAt: '2026-10-31T15:00:00.000Z' })
    now = Date.parse('2026-10-31T16:00:00Z') // 01:00 KST on Nov 1, still Oct 31 in UTC
    expect(unusable(tzEnv.db, getRow(tzEnv.db, a)!, new Date(now), all)).toBeNull()
    expect(toCredential(t.cc, getRow(tzEnv.db, a)!, 'en').month).toEqual({ usd: 0, tokens: 0, requests: 0 })
    use(850)
    // counted on the team's day, so in November, like the Usage page
    expect(tzEnv.db.query('SELECT day, input_tokens FROM credential_usage_daily WHERE credential_id = ? ORDER BY day').all(a)).toEqual([{ day: '2026-10-31', input_tokens: 1000 }, { day: '2026-11-01', input_tokens: 850 }])
    expect(toCredential(t.cc, getRow(tzEnv.db, a)!, 'en').month.tokens).toBe(850)
    expect(t.notices.length).toBe(3) // November's 80%
    expect(tzEnv.db.query('SELECT period_start, level FROM credential_notices WHERE credential_id = ? ORDER BY period_start, level').all(a))
      .toEqual([{ period_start: '2026-10-01', level: 'near' }, { period_start: '2026-10-01', level: 'reached' }, { period_start: '2026-11-01', level: 'near' }])
  })
})
