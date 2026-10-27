// Budget and connection-limit notices (docs/DECISIONS.md "AI 연결" D17): a warn budget tells at 100%, a block budget at
// 80% and 100%, once per period, to the owner and admins (and the person whose budget it is); a connection's monthly
// limit tells at 80% / 100% and, with "block", takes the connection out of the resolution.
import { beforeEach, describe, expect, test } from 'bun:test'
import path from 'node:path'
import { makeEnv } from '../lib/env'
import { addCred, testCredCtx } from '../lib/credentials'
import { afterUsage } from '../../server/src/admin/budget-watch'
import { setSetting } from '../../server/src/admin/settings'
import { SHARED_SUBSCRIPTIONS_KEY } from '../../server/src/credentials/policy'
import { afterCredentialUsage } from '../../server/src/credentials/limits'
import { resolveCredential } from '../../server/src/credentials/resolve'
import { localDay } from '../../server/src/credentials/store'
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
    const day = localDay(new Date())
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
