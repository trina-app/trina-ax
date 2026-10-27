// Which AI connection answers a turn (docs/DECISIONS.md "AI 연결" D4/D5): the resolution table of the spec, row by
// row, plus S-5 (another member's personal connection never answers someone else, whatever the settings say).
// People: alice (group marketing = "design"), bob (group finance = "sales"), carol (no group).
import { beforeEach, describe, expect, test } from 'bun:test'
import path from 'node:path'
import { makeEnv } from '../lib/env'
import { addCred, testCredCtx } from '../lib/credentials'
import { hasCredentialFor, MEMBER_OWN_KEY, resolveCredential } from '../../server/src/credentials/resolve'
import { setSetting } from '../../server/src/admin/settings'
import { SHARED_SUBSCRIPTIONS_KEY } from '../../server/src/credentials/policy'
import { ALL_CREDENTIAL_KINDS } from '../../server/src/app-config'

const env = makeEnv('a-cred-resolve')
const { cc } = testCredCtx(env.db, path.join(env.fx.data, 'secrets'))
const ALL = new Set(ALL_CREDENTIAL_KINDS)
const DESIGN = { subjectType: 'group' as const, subjectId: 'marketing' }
const SALES = { subjectType: 'group' as const, subjectId: 'finance' }
const T0 = '2026-01-01T00:00:00.000Z', T1 = '2026-01-02T00:00:00.000Z', T2 = '2026-01-03T00:00:00.000Z'

const who = (userId: string, allowed = ALL) => {
  const r = resolveCredential(env.db, { userId, engine: 'claude-code', allowedKinds: allowed })
  return r.ok ? r.credentialId : r
}
const names = new Map<string, string>()
const add = (name: string, kind: Parameters<typeof addCred>[1], o: Parameters<typeof addCred>[3] = {}) => {
  const id = addCred(cc, kind, kind === 'anthropic-oauth' ? `sk-ant-oat01-${name}${'x'.repeat(30)}` : `sk-ant-api03-${name}${'x'.repeat(30)}`, { label: name, ...o })
  names.set(id, name)
  return id
}
const nameOf = (r: ReturnType<typeof who>) => (typeof r === 'string' ? names.get(r) : r)

beforeEach(() => {
  env.db.query('DELETE FROM engine_credentials').run()
  setSetting(env.db, MEMBER_OWN_KEY, false)
  // This table tests the customer's explicit shared-subscription mode. Fresh defaults are tested separately.
  setSetting(env.db, SHARED_SUBSCRIPTIONS_KEY, true)
  names.clear()
})

describe('resolution table (credentials spec 3.3)', () => {
  test('team connection T only: everyone gets T', () => {
    add('T', 'anthropic-oauth')
    expect([nameOf(who('alice')), nameOf(who('bob')), nameOf(who('carol'))]).toEqual(['T', 'T', 'T'])
  })
  test('T + M1 (design): design gets M1, the others T', () => {
    add('T', 'anthropic-oauth', { createdAt: T0 })
    add('M1', 'anthropic-oauth', { assignments: [DESIGN], createdAt: T1 })
    expect([nameOf(who('alice')), nameOf(who('bob')), nameOf(who('carol'))]).toEqual(['M1', 'T', 'T'])
  })
  test('T + M1 (design) + M2 (sales): each group its own, carol T', () => {
    add('T', 'anthropic-oauth', { createdAt: T0 })
    add('M1', 'anthropic-oauth', { assignments: [DESIGN], createdAt: T1 })
    add('M2', 'anthropic-oauth', { assignments: [SALES], createdAt: T2 })
    expect([nameOf(who('alice')), nameOf(who('bob')), nameOf(who('carol'))]).toEqual(['M1', 'M2', 'T'])
  })
  test('... + M1 limited: design falls through to T (D5)', () => {
    add('T', 'anthropic-oauth', { createdAt: T0 })
    const m1 = add('M1', 'anthropic-oauth', { assignments: [DESIGN], createdAt: T1 })
    add('M2', 'anthropic-oauth', { assignments: [SALES], createdAt: T2 })
    env.db.query('UPDATE engine_credentials SET limited_until = ? WHERE id = ?').run(new Date(Date.now() + 3600_000).toISOString(), m1)
    expect([nameOf(who('alice')), nameOf(who('bob')), nameOf(who('carol'))]).toEqual(['T', 'M2', 'T'])
  })
  test('... + T off: alice none (retry when M1 resets), bob M2, carol none (no connection)', () => {
    const t = add('T', 'anthropic-oauth', { createdAt: T0 })
    const m1 = add('M1', 'anthropic-oauth', { assignments: [DESIGN], createdAt: T1 })
    add('M2', 'anthropic-oauth', { assignments: [SALES], createdAt: T2 })
    const until = new Date(Date.now() + 3600_000).toISOString()
    env.db.query('UPDATE engine_credentials SET limited_until = ? WHERE id = ?').run(until, m1)
    env.db.query('UPDATE engine_credentials SET disabled = 1 WHERE id = ?').run(t)
    const a = who('alice')
    expect(a).toMatchObject({ ok: false, reason: 'all_unusable', retryAt: until })
    expect(nameOf(who('bob'))).toBe('M2')
    expect(who('carol')).toMatchObject({ ok: false, reason: 'none', retryAt: null })
  })
  test('same priority: the subscription comes before the API key', () => {
    add('T', 'anthropic-api-key', { priority: 100, createdAt: T0 })
    add('S', 'anthropic-oauth', { priority: 100, createdAt: T1 })
    expect([nameOf(who('alice')), nameOf(who('bob')), nameOf(who('carol'))]).toEqual(['S', 'S', 'S'])
  })
  test('a lower priority number wins over the subscription rule', () => {
    add('T', 'anthropic-api-key', { priority: 10, createdAt: T0 })
    add('S', 'anthropic-oauth', { priority: 100, createdAt: T1 })
    expect([nameOf(who('alice')), nameOf(who('bob')), nameOf(who('carol'))]).toEqual(['T', 'T', 'T'])
  })
  test('bob\'s personal connection B, members may add their own: only bob gets B', () => {
    add('T', 'anthropic-oauth', { createdAt: T0 })
    add('B', 'anthropic-oauth', { owner: 'bob', createdAt: T1 })
    setSetting(env.db, MEMBER_OWN_KEY, true)
    expect([nameOf(who('alice')), nameOf(who('bob')), nameOf(who('carol'))]).toEqual(['T', 'B', 'T'])
  })
  test('bob\'s personal connection B, personal connections switched off: nobody gets B', () => {
    add('T', 'anthropic-oauth', { createdAt: T0 })
    add('B', 'anthropic-oauth', { owner: 'bob', createdAt: T1 })
    expect([nameOf(who('alice')), nameOf(who('bob')), nameOf(who('carol'))]).toEqual(['T', 'T', 'T'])
  })
  test('M1 assigned to the person alice and to the group sales: alice (person tier), bob (group tier), carol T', () => {
    add('T', 'anthropic-oauth', { createdAt: T0 })
    add('M1', 'anthropic-oauth', { assignments: [{ subjectType: 'user', subjectId: 'alice' }, SALES], createdAt: T1 })
    const a = resolveCredential(env.db, { userId: 'alice', engine: 'claude-code', allowedKinds: ALL })
    const b = resolveCredential(env.db, { userId: 'bob', engine: 'claude-code', allowedKinds: ALL })
    expect(a).toMatchObject({ ok: true, tier: 'user' }); expect(b).toMatchObject({ ok: true, tier: 'group' })
    expect([nameOf(who('alice')), nameOf(who('bob')), nameOf(who('carol'))]).toEqual(['M1', 'M1', 'T'])
  })
})

describe('more rules', () => {
  test('S-5: another member\'s personal connection is never a candidate, even when it is the only one', () => {
    const b = add('B', 'anthropic-oauth', { owner: 'bob' })
    setSetting(env.db, MEMBER_OWN_KEY, true)
    for (const u of ['alice', 'carol', 'dana']) {
      const r = resolveCredential(env.db, { userId: u, engine: 'claude-code', allowedKinds: ALL })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.skipped.map((s) => s.id)).not.toContain(b)
    }
    expect(nameOf(who('bob'))).toBe('B')
  })
  test('the engine decides the family: Claude turns never get an OpenAI connection and Codex turns never an Anthropic one', () => {
    add('A', 'anthropic-oauth')
    const o = addCred(cc, 'openai-api-key', 'sk-' + 'o'.repeat(40))
    expect(resolveCredential(env.db, { userId: 'alice', engine: 'codex', allowedKinds: ALL })).toMatchObject({ ok: true, credentialId: o })
    env.db.query('DELETE FROM engine_credentials WHERE id = ?').run(o)
    expect(resolveCredential(env.db, { userId: 'alice', engine: 'codex', allowedKinds: ALL })).toMatchObject({ ok: false, reason: 'none' })
  })
  test('a kind this server does not allow is skipped (shown as off, never deleted)', () => {
    add('S', 'anthropic-oauth', { createdAt: T0 })
    add('K', 'anthropic-api-key', { createdAt: T1 })
    expect(nameOf(who('alice', new Set(['anthropic-api-key', 'openai-api-key'])))).toBe('K')
    env.db.query("DELETE FROM engine_credentials WHERE kind = 'anthropic-api-key'").run()
    expect(who('alice', new Set(['anthropic-api-key', 'openai-api-key']))).toMatchObject({ ok: false, reason: 'none' })
  })
  test('refused, needing a new sign-in, expired, over the monthly block limit: skipped; exclude skips one', () => {
    const a = add('A', 'anthropic-oauth', { createdAt: T0 })
    const b = add('B', 'anthropic-oauth', { createdAt: T1 })
    expect(nameOf(who('alice'))).toBe('A')
    env.db.query("UPDATE engine_credentials SET status = 'invalid' WHERE id = ?").run(a)
    expect(nameOf(who('alice'))).toBe('B')
    env.db.query("UPDATE engine_credentials SET status = 'ok', expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), a)
    expect(nameOf(who('alice'))).toBe('B')
    env.db.query('UPDATE engine_credentials SET expires_at = NULL, spend_limit_tokens = 100, spend_limit_action = ? WHERE id = ?').run('block', a)
    const d = new Date()
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    env.db.query('INSERT INTO credential_usage_daily (credential_id, day, requests, input_tokens, output_tokens, cost_usd) VALUES (?, ?, 1, 80, 30, 0)').run(a, day)
    expect(nameOf(who('alice'))).toBe('B')
    env.db.query("UPDATE engine_credentials SET spend_limit_action = 'warn' WHERE id = ?").run(a)
    expect(nameOf(who('alice'))).toBe('A') // warn only tells, never blocks
    const r = resolveCredential(env.db, { userId: 'alice', engine: 'claude-code', allowedKinds: ALL, exclude: new Set([a]) })
    expect(r).toMatchObject({ ok: true, credentialId: b })
  })
  test('deterministic: the same state gives the same answer; groups are read as they are now', () => {
    add('T', 'anthropic-oauth', { createdAt: T0 })
    add('M1', 'anthropic-oauth', { assignments: [DESIGN], createdAt: T1 })
    const first = who('carol')
    for (let i = 0; i < 20; i++) expect(who('carol')).toBe(first)
    env.db.query("INSERT INTO group_members (group_id, user_id) VALUES ('marketing', 'carol')").run()
    try { expect(nameOf(who('carol'))).toBe('M1') } finally { env.db.query("DELETE FROM group_members WHERE group_id = 'marketing' AND user_id = 'carol'").run() }
    expect(hasCredentialFor(env.db, 'carol', 'claude-code', ALL)).toBe(true)
    expect(hasCredentialFor(env.db, 'carol', 'codex', ALL)).toBe(false)
  })
})
