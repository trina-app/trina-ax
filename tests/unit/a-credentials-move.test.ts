// "Move it to the team" in the service (credentials/service.ts createCredential with moveFrom): one transaction, so a
// failure leaves the personal copy as it was (never none), and a copy that came or went during the provider check is
// seen in the write (never two). The member whose connection moved is told; the owner moving their own is not.
// Synthetic connections only; the provider check is a local function, never a socket.
import { beforeEach, expect, test } from 'bun:test'
import path from 'node:path'
import { HttpError } from '../../server/src/http/errors'
import { makeEnv } from '../lib/env'
import { addCred, testCredCtx } from '../lib/credentials'
import { createCredential } from '../../server/src/credentials/service'

const env = makeEnv('a-cred-move')
let duringCheck: (() => void) | null = null
const { cc, notices } = testCredCtx(env.db, path.join(env.fx.data, 'secrets'), {
  upstreams: { anthropic: 'http://127.0.0.1:9', openai: 'http://127.0.0.1:9/v1' },
  fetch: (async () => { duringCheck?.(); return Response.json({ ok: true }) }) as unknown as typeof fetch,
})
const TOKEN = 'sk-ant-oat01-' + 'm'.repeat(40)
const rows = () => env.db.query('SELECT id, owner_user_id AS owner FROM engine_credentials ORDER BY created_at, id').all() as { id: string; owner: string | null }[]
const move = (moveFrom: string, actor = 'dana', assignments: { subjectType: 'group' | 'user'; subjectId: string }[] = []) => createCredential(cc, {
  kind: 'anthropic-oauth', label: 'Team Max', secret: TOKEN, assignments, priority: 100, ownerUserId: null, actor, acknowledgedPlanNotice: true, moveFrom,
}, 'en')
const conflict = async (p: Promise<unknown>) => {
  try { await p } catch (e) { if (e instanceof HttpError) return { code: e.code, params: e.extra.params }; throw e }
  throw new Error('expected a conflict')
}

beforeEach(() => {
  env.db.query('DELETE FROM engine_credentials').run()
  notices.length = 0
  duringCheck = null
})

test('moves: the personal copy goes, the team copy comes, the member is told (labels only, no secret)', async () => {
  const p = addCred(cc, 'anthropic-oauth', TOKEN, { owner: 'alice', label: 'Alice Max' })
  const c = await move(p)
  expect(rows()).toEqual([{ id: c.id, owner: null }])
  expect(cc.cache.has(p)).toBe(false)
  expect(notices).toHaveLength(1)
  expect(notices[0]!.to).toEqual(['alice'])
  expect(notices[0]!.n).toMatchObject({ level: 'info', code: 'credential_moved_to_team', link: '/settings/credentials' })
  expect(notices[0]!.n.message.en).toContain("'Alice Max'")
  expect(notices[0]!.n.message.en).toContain("'Team Max'")
  expect(JSON.stringify([notices, c])).not.toContain(TOKEN.slice(13))
})

test('moved to a team connection for other people: the member is told they cannot use it', async () => {
  const p = addCred(cc, 'anthropic-oauth', TOKEN, { owner: 'alice', label: 'Alice Max' })
  await move(p, 'dana', [{ subjectType: 'group', subjectId: 'finance' }])
  expect(notices).toHaveLength(1)
  expect(notices[0]!.to).toEqual(['alice'])
  expect(notices[0]!.n.message.en).toContain('for other people')
  // for her group: the usual notice
  env.db.query('DELETE FROM engine_credentials').run()
  notices.length = 0
  const p2 = addCred(cc, 'anthropic-oauth', TOKEN, { owner: 'alice' })
  await move(p2, 'dana', [{ subjectType: 'group', subjectId: 'marketing' }])
  expect(notices[0]!.n.message.en).not.toContain('for other people')
})

test('two copies left by an older version: a move never leaves two (409, nothing removed)', async () => {
  const p = addCred(cc, 'anthropic-oauth', TOKEN, { owner: 'alice', createdAt: '2026-01-01T00:00:00.000Z' })
  const old = addCred(cc, 'anthropic-oauth', TOKEN, { owner: 'bob', createdAt: '2026-01-02T00:00:00.000Z' })
  expect(await conflict(move(p))).toMatchObject({ code: 'conflict', params: { where: 'personal', credentialId: old } })
  expect(rows().map((r) => r.id)).toEqual([p, old])
  expect(notices).toEqual([])
})

test('a failure while writing the team copy leaves the personal copy as it was (never none)', async () => {
  const p = addCred(cc, 'anthropic-oauth', TOKEN, { owner: 'alice' })
  const encrypt = cc.vault.encrypt.bind(cc.vault)
  cc.vault.encrypt = () => { throw new Error('disk full') }
  try { await expect(move(p)).rejects.toThrow('disk full') } finally { cc.vault.encrypt = encrypt }
  expect(rows()).toEqual([{ id: p, owner: 'alice' }])
  expect(notices).toEqual([])
})

test('another copy that appeared during the provider check: 409 in the write, nothing removed (never two)', async () => {
  const p = addCred(cc, 'anthropic-oauth', TOKEN, { owner: 'alice' })
  let team = ''
  duringCheck = () => { env.db.query('DELETE FROM engine_credentials WHERE id = ?').run(p); team = addCred(cc, 'anthropic-oauth', TOKEN, { label: 'Other team copy' }) }
  expect(await conflict(move(p))).toEqual({ code: 'conflict', params: { reason: 'duplicate_credential', where: 'team', credentialId: team, label: 'Other team copy' } })
  expect(rows()).toEqual([{ id: team, owner: null }])
  expect(notices).toEqual([])
})

test('the personal copy was removed during the check: the team copy is simply made, nobody is told it moved', async () => {
  const p = addCred(cc, 'anthropic-oauth', TOKEN, { owner: 'alice' })
  duringCheck = () => { env.db.query('DELETE FROM engine_credentials WHERE id = ?').run(p) }
  const c = await move(p)
  expect(rows()).toEqual([{ id: c.id, owner: null }])
  expect(notices).toEqual([])
  expect((env.db.query('SELECT action FROM audit_log WHERE target = ?').get(c.id) as { action: string }).action).toBe('credential.create')
})

test('the owner moving their own personal connection: no notice to themselves', async () => {
  const p = addCred(cc, 'anthropic-oauth', TOKEN, { owner: 'dana', label: 'Dana Max' })
  const c = await move(p, 'dana')
  expect(rows()).toEqual([{ id: c.id, owner: null }])
  expect(notices).toEqual([])
  expect((env.db.query("SELECT action FROM audit_log WHERE target = ? AND action LIKE 'credential.%'").get(c.id) as { action: string }).action).toBe('credential.move_to_team')
})

test('a personal connection cannot take another one over (moveFrom is for a team connection only)', async () => {
  const p = addCred(cc, 'anthropic-oauth', TOKEN, { owner: 'alice' })
  const r = createCredential(cc, { kind: 'anthropic-oauth', label: 'x', secret: TOKEN, assignments: [], priority: 100, ownerUserId: 'bob', actor: 'bob', acknowledgedPlanNotice: true, moveFrom: p }, 'en')
  await expect(r).rejects.toBeInstanceOf(HttpError)
  expect(rows()).toEqual([{ id: p, owner: 'alice' }])
})
