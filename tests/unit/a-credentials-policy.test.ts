// D1 policy: synthetic credentials only; provider verification is a local function, never a socket.
import { beforeEach, expect, test } from 'bun:test'
import path from 'node:path'
import { makeEnv } from '../lib/env'
import { addCred, chatgptSecret, fakeJwt, testCredCtx } from '../lib/credentials'
import { setSetting } from '../../server/src/admin/settings'
import { budgetBlock, createBudget } from '../../server/src/admin/budgets'
import { memberOwnAllowed, MEMBER_OWN_KEY, resolveCredential } from '../../server/src/credentials/resolve'
import { createCredential, setCredentialSettings } from '../../server/src/credentials/service'
import { credentialLogins } from '../../server/src/credentials/login'
import { refreshIdle } from '../../server/src/credentials/chatgpt-tokens'
import { createBroker } from '../../server/src/credentials/broker'
import { getRow, stateOf } from '../../server/src/credentials/store'
import { ALL_CREDENTIAL_KINDS } from '../../server/src/app-config'

const env = makeEnv('a-d1-policy')
let providerChecks = 0
const { cc } = testCredCtx(env.db, path.join(env.fx.data, 'secrets'), {
  fetch: (async () => { providerChecks++; return Response.json({ ok: true }) }) as unknown as typeof fetch,
})
const ALL = new Set(ALL_CREDENTIAL_KINDS)
const SHARED = 'credentials.sharedSubscriptions'
const secret = (n: string) => 'sk-ant-oat01-' + n.padEnd(40, 'x')
const who = (userId: string) => resolveCredential(env.db, { userId, engine: 'claude-code', allowedKinds: ALL })
const req = (id: string, userId = 'alice') => createBroker(cc).forRequest({ credentialId: id, family: 'anthropic', turnId: 'turn-policy', userId }, 'anthropic')

beforeEach(() => {
  env.db.query('DELETE FROM engine_credentials').run()
  env.db.query("DELETE FROM settings WHERE key IN (?, ?)").run(MEMBER_OWN_KEY, SHARED)
  env.db.query('DELETE FROM budgets').run()
  env.db.query("DELETE FROM turns WHERE id LIKE 'd1-%'").run()
  providerChecks = 0
})

test('fresh DB permits personal connections; explicit false and corrupt settings remain closed', () => {
  expect(memberOwnAllowed(env.db)).toBe(true)
  setSetting(env.db, MEMBER_OWN_KEY, false)
  expect(memberOwnAllowed(env.db)).toBe(false)
  env.db.query('UPDATE settings SET value = ? WHERE key = ?').run('invalid-json', MEMBER_OWN_KEY)
  expect(memberOwnAllowed(env.db)).toBe(false)
})

test('personal subscription is the default and never answers another person', () => {
  const personal = addCred(cc, 'anthropic-oauth', secret('alice'), { owner: 'alice' })
  const key = addCred(cc, 'anthropic-api-key', 'sk-ant-api03-' + 'k'.repeat(40))
  expect(who('alice')).toMatchObject({ ok: true, credentialId: personal, tier: 'own' })
  expect(who('bob')).toMatchObject({ ok: true, credentialId: key, tier: 'team' })
})

test('existing team subscriptions are blocked by default, including user/group assignments', async () => {
  for (const assignments of [[], [{ subjectType: 'user' as const, subjectId: 'alice' }], [{ subjectType: 'group' as const, subjectId: 'marketing' }]]) {
    const id = addCred(cc, 'anthropic-oauth', secret(String(assignments.length) + JSON.stringify(assignments)), { assignments })
    expect(who('alice').ok).toBe(false)
    expect(stateOf(env.db, getRow(env.db, id)!, new Date(), ALL)).toBe('sharing_off')
    expect((await req(id)).ok).toBe(false)
  }
})

test('shared opt-in restores existing priority rules and revocation stops the next bound request', async () => {
  const shared = addCred(cc, 'anthropic-oauth', secret('team'), { priority: 20 })
  const key = addCred(cc, 'anthropic-api-key', 'sk-ant-api03-' + 'a'.repeat(40), { priority: 10 })
  setSetting(env.db, SHARED, true)
  expect(who('alice')).toMatchObject({ ok: true, credentialId: key })
  env.db.query('UPDATE engine_credentials SET priority = 30 WHERE id = ?').run(key)
  expect(who('alice')).toMatchObject({ ok: true, credentialId: shared })
  expect((await req(shared)).ok).toBe(true)
  setSetting(env.db, SHARED, false)
  expect((await req(shared)).ok).toBe(false)
  expect(who('alice')).toMatchObject({ ok: true, credentialId: key })
})

test('proxy binding cannot use another personal credential or a revoked personal policy', async () => {
  const id = addCred(cc, 'anthropic-oauth', secret('private'), { owner: 'alice' })
  setSetting(env.db, MEMBER_OWN_KEY, true)
  expect((await req(id, 'bob')).ok).toBe(false)
  expect((await req(id)).ok).toBe(true)
  setSetting(env.db, MEMBER_OWN_KEY, false)
  expect((await req(id)).ok).toBe(false)
})

test('assignment revocation is checked again on the next company key request', async () => {
  const id = addCred(cc, 'anthropic-api-key', 'sk-ant-api03-' + 'r'.repeat(40), { assignments: [{ subjectType: 'user', subjectId: 'alice' }] })
  expect((await req(id)).ok).toBe(true)
  env.db.query("UPDATE engine_credential_assignments SET subject_id = 'bob' WHERE credential_id = ?").run(id)
  expect((await req(id)).ok).toBe(false)
  expect((await req(id, 'bob')).ok).toBe(true)
})

test('team subscription creation requires shared opt-in before any provider check', async () => {
  await expect(createCredential(cc, { kind: 'anthropic-oauth', label: 'shared', secret: secret('new'), ownerUserId: null,
    actor: 'owner', priority: 100, assignments: [], acknowledgedPlanNotice: true }, 'en')).rejects.toThrow()
  expect(providerChecks).toBe(0)
  expect(env.db.query('SELECT COUNT(*) AS n FROM engine_credentials').get()).toEqual({ n: 0 })
})

test('company API key remains available without shared opt-in and monthly user budgets remain separate', async () => {
  const key = await createCredential(cc, { kind: 'anthropic-api-key', label: 'company', secret: 'sk-ant-api03-' + 'c'.repeat(40),
    ownerUserId: null, actor: 'owner', priority: 100, assignments: [] }, 'en')
  expect(key.scope).toBe('team')
  expect(who('alice')).toMatchObject({ ok: true, credentialId: key.id })
  expect(who('bob')).toMatchObject({ ok: true, credentialId: key.id })
  createBudget(env.db, { subjectType: 'user', subjectId: 'alice', period: 'month', limitUsd: 1, limitTokens: null, action: 'block' }, 'en')
  env.db.query("INSERT INTO turns (id, chat_id, user_id, engine, status, started_at, cost_usd) VALUES ('d1-use', 'c', 'alice', 'claude-code', 'done', ?, 1)").run(new Date().toISOString())
  expect(budgetBlock(env.db, 'alice', 'en')).not.toBeNull()
  expect(budgetBlock(env.db, 'bob', 'en')).toBeNull()
})

test('deployment allowed kinds continue to reject subscriptions even with both policy switches on', async () => {
  cc.allowedKinds.delete('anthropic-oauth')
  setSetting(env.db, SHARED, true)
  try {
    await expect(createCredential(cc, { kind: 'anthropic-oauth', label: 'blocked', secret: secret('fleet'), ownerUserId: 'alice', actor: 'alice', priority: 100, assignments: [], acknowledgedPlanNotice: true }, 'en')).rejects.toThrow()
    expect(providerChecks).toBe(0)
  } finally { cc.allowedKinds.add('anthropic-oauth') }
})

test('an opt-in without risk acknowledgement does not partially change the personal setting', () => {
  expect(() => setCredentialSettings(cc, { memberOwn: false, sharedSubscriptions: true }, 'owner', 'en')).toThrow()
  expect(memberOwnAllowed(env.db)).toBe(true)
  expect(setCredentialSettings(cc, { sharedSubscriptions: true, acknowledgedSharedSubscriptionRisk: true }, 'owner', 'en')).toEqual({ memberOwn: true, sharedSubscriptions: true })
  expect(setCredentialSettings(cc, { sharedSubscriptions: false }, 'owner', 'en')).toEqual({ memberOwn: true, sharedSubscriptions: false })
})

test('ChatGPT shared login cannot start the launcher without the shared opt-in', async () => {
  let calls = 0
  const manager = credentialLogins(cc, { async launcher() { calls++; return null } })
  await expect(manager.start({ userId: 'alice', locale: 'en', personal: false, label: 'shared', assignments: [], priority: 100 })).rejects.toThrow()
  expect(calls).toBe(0)
})

test('revoking policy during provider verification prevents storage', async () => {
  setSetting(env.db, SHARED, true)
  const original = cc.fetch
  cc.fetch = (async () => { setSetting(env.db, SHARED, false); return Response.json({ ok: true }) }) as unknown as typeof fetch
  try {
    await expect(createCredential(cc, { kind: 'anthropic-oauth', label: 'race', secret: secret('race'), ownerUserId: null,
      actor: 'owner', priority: 100, assignments: [], acknowledgedPlanNotice: true }, 'en')).rejects.toThrow()
    expect(env.db.query('SELECT COUNT(*) AS n FROM engine_credentials').get()).toEqual({ n: 0 })
  } finally { cc.fetch = original }
})

test('revoking sharing while an OpenAI token refresh is pending prevents token injection', async () => {
  setSetting(env.db, SHARED, true)
  const id = addCred(cc, 'chatgpt', chatgptSecret('policy-test', { expSec: 1 }))
  const original = cc.fetch
  cc.fetch = (async () => {
    setSetting(env.db, SHARED, false)
    return Response.json({ access_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }), refresh_token: 'synthetic-refresh', expires_in: 3600 })
  }) as unknown as typeof fetch
  try {
    expect((await createBroker(cc).forRequest({ credentialId: id, family: 'openai', turnId: 'turn-policy', userId: 'alice' }, 'openai')).ok).toBe(false)
  } finally { cc.fetch = original }
})


test('idle token maintenance does not contact providers for policy-disabled subscriptions', async () => {
  const old = { ...chatgptSecret('idle-shared'), lastRefresh: '2020-01-01T00:00:00Z' }
  addCred(cc, 'chatgpt', old)
  const personal = { ...chatgptSecret('idle-personal'), lastRefresh: '2020-01-01T00:00:00Z' }
  addCred(cc, 'chatgpt', personal, { owner: 'alice' })
  setSetting(env.db, MEMBER_OWN_KEY, false)
  expect(await refreshIdle(cc)).toBe(0)
  expect(providerChecks).toBe(0)
  setSetting(env.db, MEMBER_OWN_KEY, true)
  setSetting(env.db, SHARED, true)
  cc.allowedKinds.delete('chatgpt')
  try {
    expect(await refreshIdle(cc)).toBe(0)
    expect(providerChecks).toBe(0)
  } finally { cc.allowedKinds.add('chatgpt') }
})

test('a late 401 cannot start a new refresh after sharing, personal access, or the credential is disabled', async () => {
  setSetting(env.db, SHARED, true)
  const sharedSecret = chatgptSecret('late-shared'), personalSecret = chatgptSecret('late-personal')
  const shared = addCred(cc, 'chatgpt', sharedSecret)
  const personal = addCred(cc, 'chatgpt', personalSecret, { owner: 'alice' })
  const broker = createBroker(cc)
  setSetting(env.db, SHARED, false)
  const refused = await broker.onUnauthorized(shared, sharedSecret.accessToken)
  expect(providerChecks).toBe(0)
  expect(refused).toBe('refused')
  setSetting(env.db, MEMBER_OWN_KEY, false)
  expect(await broker.onUnauthorized(personal, personalSecret.accessToken)).toBe('refused')
  setSetting(env.db, SHARED, true)
  env.db.query('UPDATE engine_credentials SET disabled=1 WHERE id=?').run(shared)
  expect(await broker.onUnauthorized(shared, sharedSecret.accessToken)).toBe('refused')
  env.db.query('UPDATE engine_credentials SET disabled=0 WHERE id=?').run(shared)
  cc.allowedKinds.delete('chatgpt')
  try { expect(await broker.onUnauthorized(shared, sharedSecret.accessToken)).toBe('refused') }
  finally { cc.allowedKinds.add('chatgpt') }
  expect(providerChecks).toBe(0)
})
