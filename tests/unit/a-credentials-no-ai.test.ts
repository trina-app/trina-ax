// "No AI" (Admin › Members, the owner's start checklist; credentials/access.ts): the active people who cannot use any AI
// connection now, by the rules the turn and the proxy use (credentials/resolve.ts): their own connection only while the
// team allows them, assignments, subscription sharing, switched off, expired, refused, the monthly block limit, and the
// engines that answer them. A provider's limit that ends within the hour (resolve.ts SOON_MS) is not "No AI": that
// person only waits; a longer one, or "out of credit" whatever the time, is.
// People (tests/lib/fixtures.ts): alice, erin = marketing; bob = finance; carol = admin; dana = owner.
import { beforeEach, describe, expect, test } from 'bun:test'
import path from 'node:path'
import type { AppConfig } from '../../server/src/app-config'
import { setEnginesEnabled, setSetting } from '../../server/src/admin/settings'
import { setMemberChoice } from '../../server/src/admin/engine-choice'
import { MEMBER_OWN_KEY, SHARED_SUBSCRIPTIONS_KEY } from '../../server/src/credentials/policy'
import { peopleWithoutAi, withoutAi } from '../../server/src/credentials/access'
import { hasCredentialSoonFor, resolveCredential } from '../../server/src/credentials/resolve'
import { ALL_CREDENTIAL_KINDS } from '../../server/src/app-config'
import { makeEnv } from '../lib/env'
import { addCred, chatgptSecret, testCredCtx } from '../lib/credentials'

const env = makeEnv('a-cred-no-ai')
const { cc } = testCredCtx(env.db, path.join(env.fx.data, 'secrets'))
const config = (authMode: 'managed' | 'local-login' = 'managed') => ({ mode: 'dev', dataDir: path.join(env.fx.data, 'no-api-engine'), engine: { authMode } }) as unknown as AppConfig
const ctx = { db: env.db, config: config() }
const EVERYONE = ['alice', 'bob', 'carol', 'dana', 'erin']
const noAi = () => new Set(peopleWithoutAi(ctx))
const n = (s: string) => `sk-ant-api03-${s}${'n'.repeat(30)}`
const sub = (s: string) => `sk-ant-oat01-${s}${'s'.repeat(30)}`
const iso = (ms: number) => new Date(Date.now() + ms).toISOString()

beforeEach(() => {
  env.db.query('DELETE FROM engine_credentials').run()
  env.db.query('DELETE FROM credential_usage_daily').run()
  env.db.query("UPDATE users SET status = 'active'").run()
  setSetting(env.db, MEMBER_OWN_KEY, true)
  setSetting(env.db, SHARED_SUBSCRIPTIONS_KEY, true)
  setEnginesEnabled(env.db, { 'claude-code': true, codex: true })
  setMemberChoice({ db: env.db }, { mode: 'off', groupIds: [], userIds: [] })
})

test('no connection at all: everyone; a team connection for everyone: nobody', () => {
  expect(noAi()).toEqual(new Set(EVERYONE))
  addCred(cc, 'anthropic-api-key', n('team'))
  expect(noAi()).toEqual(new Set())
})

test('a personal connection: only its owner, and only while the team allows personal connections', () => {
  addCred(cc, 'anthropic-oauth', sub('alice'), { owner: 'alice' })
  expect(noAi()).toEqual(new Set(['bob', 'carol', 'dana', 'erin']))
  setSetting(env.db, MEMBER_OWN_KEY, false)
  expect(noAi()).toEqual(new Set(EVERYONE))
})

test('subscription sharing on: a team subscription answers everyone; off: nobody but people with their own', () => {
  addCred(cc, 'anthropic-oauth', sub('team'))
  addCred(cc, 'anthropic-oauth', sub('bob'), { owner: 'bob' })
  expect(noAi()).toEqual(new Set())
  setSetting(env.db, SHARED_SUBSCRIPTIONS_KEY, false)
  expect(noAi()).toEqual(new Set(['alice', 'carol', 'dana', 'erin']))
  // a company API key is not a subscription: sharing does not matter
  addCred(cc, 'anthropic-api-key', n('company'))
  expect(noAi()).toEqual(new Set())
})

test('assigned to a group or a person: only them (the admin\'s personal subscription answers only the admin)', () => {
  addCred(cc, 'anthropic-api-key', n('design'), { assignments: [{ subjectType: 'group', subjectId: 'marketing' }] })
  addCred(cc, 'anthropic-api-key', n('bob'), { assignments: [{ subjectType: 'user', subjectId: 'bob' }] })
  addCred(cc, 'anthropic-oauth', sub('carol'), { owner: 'carol' })
  expect(noAi()).toEqual(new Set(['dana']))
})

test('a limit that ends within the hour: still has AI (they wait); the monthly block limit used up: No AI', () => {
  const id = addCred(cc, 'anthropic-oauth', sub('limited'))
  env.db.query("UPDATE engine_credentials SET limited_until = ?, status_code = 'rate_limited' WHERE id = ?").run(iso(30 * 60_000), id)
  expect(noAi()).toEqual(new Set())
  expect(hasCredentialSoonFor(env.db, 'alice', 'claude-code', new Set(ALL_CREDENTIAL_KINDS))).toBe(true)
  // limited and over its monthly block limit: the limit it is waiting for is not the only one
  env.db.query("UPDATE engine_credentials SET spend_limit_tokens = 10, spend_limit_action = 'block' WHERE id = ?").run(id)
  const day = new Date()
  env.db.query('INSERT INTO credential_usage_daily (credential_id, day, requests, input_tokens, output_tokens, cost_usd) VALUES (?, ?, 1, 100, 0, 0)')
    .run(id, `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`)
  expect(noAi()).toEqual(new Set(EVERYONE))
})

test('a long limit (a weekly cap, a Codex plan limit until its reset): No AI', () => {
  const id = addCred(cc, 'anthropic-oauth', sub('weekly'))
  env.db.query("UPDATE engine_credentials SET limited_until = ?, status_code = 'rate_limited' WHERE id = ?").run(iso(6 * 86400_000), id)
  expect(noAi()).toEqual(new Set(EVERYONE))
  const codex = addCred(cc, 'chatgpt', chatgptSecret('acct-plan'))
  env.db.query("UPDATE engine_credentials SET limited_until = ?, status_code = 'usage_limit_reached' WHERE id = ?").run(iso(3 * 86400_000), codex)
  setMemberChoice({ db: env.db }, { mode: 'everyone', groupIds: [], userIds: [] })
  expect(noAi()).toEqual(new Set(EVERYONE))
})

test('out of credit or over its spend limit: No AI whatever the time (as the turn says: all_unusable)', () => {
  const id = addCred(cc, 'openai-api-key', 'sk-proj-' + 'c'.repeat(40))
  setMemberChoice({ db: env.db }, { mode: 'everyone', groupIds: [], userIds: [] })
  for (const [code, ms] of [['insufficient_quota', 6 * 86400_000], ['insufficient_quota', 30 * 60_000], ['credit_balance_exhausted', 10 * 60_000], ['project_spend_limit_exceeded', 10 * 60_000]] as const) {
    env.db.query('UPDATE engine_credentials SET limited_until = ?, status_code = ? WHERE id = ?').run(iso(ms), code, id)
    expect(noAi()).toEqual(new Set(EVERYONE))
    expect(resolveCredential(env.db, { userId: 'alice', engine: 'codex', allowedKinds: new Set(ALL_CREDENTIAL_KINDS) })).toMatchObject({ ok: false, reason: 'all_unusable' })
  }
})

test('switched off, expired or refused: No AI', () => {
  const id = addCred(cc, 'anthropic-oauth', sub('t'))
  env.db.query('UPDATE engine_credentials SET disabled = 1 WHERE id = ?').run(id)
  expect(noAi()).toEqual(new Set(EVERYONE))
  env.db.query('UPDATE engine_credentials SET disabled = 0, expires_at = ? WHERE id = ?').run(iso(-60_000), id)
  expect(noAi()).toEqual(new Set(EVERYONE))
  env.db.query("UPDATE engine_credentials SET expires_at = ?, status = 'invalid' WHERE id = ?").run(iso(86400_000), id)
  expect(noAi()).toEqual(new Set(EVERYONE))
  env.db.query("UPDATE engine_credentials SET status = 'ok' WHERE id = ?").run(id)
  expect(noAi()).toEqual(new Set())
})

describe('noAiUntil: "No AI" that only a wait fixes says until when', () => {
  const until = () => withoutAi(ctx)!.until
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

  test('the team\'s only connection at a weekly limit: everyone in noAi and in noAiUntil with its end', () => {
    const id = addCred(cc, 'anthropic-oauth', sub('weekly-until'))
    const end = iso(2 * 86400_000)
    env.db.query("UPDATE engine_credentials SET limited_until = ?, status_code = 'rate_limited' WHERE id = ?").run(end, id)
    const r = withoutAi(ctx)!
    expect(new Set(r.ids)).toEqual(new Set(EVERYONE))
    // owner and admins may pick Codex too, which has no connection: Claude coming back is still when they have AI again
    expect(r.until).toEqual(Object.fromEntries(EVERYONE.map((p) => [p, end])))
    // peopleWithoutAi is the same list
    expect(noAi()).toEqual(new Set(EVERYONE))
  })

  test('refused, switched off, expired or out of credit: in noAi, not in noAiUntil (no wait fixes it)', () => {
    const id = addCred(cc, 'anthropic-oauth', sub('refused'))
    for (const set of [
      "status = 'invalid'",
      "status = 'ok', disabled = 1",
      `disabled = 0, expires_at = '${iso(-60_000)}'`,
      `expires_at = NULL, limited_until = '${iso(2 * 86400_000)}', status_code = 'credit_balance_exhausted'`,
    ]) {
      env.db.query(`UPDATE engine_credentials SET ${set} WHERE id = ?`).run(id)
      expect(new Set(withoutAi(ctx)!.ids), set).toEqual(new Set(EVERYONE))
      expect(until(), set).toEqual({})
    }
  })

  test('the earliest end across connections and engines; a limit and the monthly block limit: the later of the two', () => {
    setMemberChoice({ db: env.db }, { mode: 'everyone', groupIds: [], userIds: [] })
    const claude = addCred(cc, 'anthropic-oauth', sub('two-engines'))
    const codex = addCred(cc, 'chatgpt', chatgptSecret('acct-until'))
    const soonest = iso(3 * 3600_000)
    const claudeEnd = iso(5 * 86400_000)
    env.db.query("UPDATE engine_credentials SET limited_until = ?, status_code = 'rate_limited' WHERE id = ?").run(claudeEnd, claude)
    env.db.query("UPDATE engine_credentials SET limited_until = ?, status_code = 'usage_limit_reached' WHERE id = ?").run(soonest, codex)
    expect(until()).toEqual(Object.fromEntries(EVERYONE.map((p) => [p, soonest])))
    // Codex is also over its monthly block limit: it comes back next month, so Claude's end is the earliest
    env.db.query("UPDATE engine_credentials SET spend_limit_tokens = 10, spend_limit_action = 'block' WHERE id = ?").run(codex)
    env.db.query('INSERT INTO credential_usage_daily (credential_id, day, requests, input_tokens, output_tokens, cost_usd) VALUES (?, ?, 1, 100, 0, 0)').run(codex, today())
    // (near the end of a month the next month starts before Claude's end: then that is the earliest)
    const next = new Date(); next.setDate(1); next.setHours(0, 0, 0, 0); next.setMonth(next.getMonth() + 1)
    expect(until().alice).toBe(new Date(Math.min(Date.parse(claudeEnd), Math.max(Date.parse(soonest), next.getTime()))).toISOString())
  })

  test('a personal connection at its limit: only its owner gets the time', () => {
    const own = addCred(cc, 'anthropic-oauth', sub('alice-own'), { owner: 'alice' })
    const end = iso(30 * 3600_000)
    env.db.query("UPDATE engine_credentials SET limited_until = ?, status_code = 'rate_limited' WHERE id = ?").run(end, own)
    const r = withoutAi(ctx)!
    expect(new Set(r.ids)).toEqual(new Set(EVERYONE))
    expect(r.until).toEqual({ alice: end })
  })

  test('absent when the server does not answer with AI connections', () => {
    expect(withoutAi({ db: env.db, config: config('local-login') })).toBeNull()
  })
})

describe('the engines that answer a person', () => {
  test('an engine whose program is missing here answers nobody (as in the composer)', () => {
    addCred(cc, 'chatgpt', chatgptSecret('acct-missing'))
    expect(new Set(peopleWithoutAi(ctx, { problems: { codex: 'engine_missing' } }))).toEqual(new Set(EVERYONE))
    expect(new Set(peopleWithoutAi(ctx, { problems: {} }))).toEqual(new Set(['alice', 'bob', 'erin']))
  })
  test('a Codex connection helps the people who may pick Codex (owner, admins), not members on the team default', () => {
    addCred(cc, 'chatgpt', chatgptSecret('acct-team'))
    expect(noAi()).toEqual(new Set(['alice', 'bob', 'erin']))
    setMemberChoice({ db: env.db }, { mode: 'everyone', groupIds: [], userIds: [] })
    expect(noAi()).toEqual(new Set())
    // Codex switched off: nobody gets it
    setEnginesEnabled(env.db, { codex: false })
    expect(noAi()).toEqual(new Set(EVERYONE))
  })
})

test('only active people; nothing to say when the server does not answer with AI connections', () => {
  env.db.query("UPDATE users SET status = 'disabled' WHERE id = 'erin'").run()
  expect(noAi()).toEqual(new Set(['alice', 'bob', 'carol', 'dana']))
  expect(peopleWithoutAi({ db: env.db, config: config('local-login') })).toBeNull()
})
