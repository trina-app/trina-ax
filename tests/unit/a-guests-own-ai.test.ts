// A guest's own AI sign-in (docs/DECISIONS.md "Guests: only what they were invited to"; credentials/policy.ts
// personalConnectionsAllowed): a guest whose AI choice is 'own' is told to connect their own (GET /api/me/ai-access
// connect_own, never "ask"), may start their own Claude or ChatGPT sign-in, save their own connection and is answered
// on it, whatever the team's member-own switch says. Only their own personal connection: never a team connection or
// the trial credit. A guest with 'none' (the default) or 'team' adds nothing of their own. Real guests: invited through
// the API and accepted on the invite page; fake providers answer the key check.
import { afterAll, afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import type { SealingKey } from '@mycel/shared/api'
import { ALL_CREDENTIAL_KINDS } from '../../server/src/app-config'
import { setEnginesEnabled, setSetting } from '../../server/src/admin/settings'
import { canUseAi } from '../../server/src/credentials/access'
import { writeHostedChatKey } from '../../server/src/credentials/hosted-chat'
import { credentialLogins } from '../../server/src/credentials/login'
import { personalConnectionsAllowed } from '../../server/src/credentials/policy'
import { MEMBER_OWN_KEY, resolveCredential } from '../../server/src/credentials/resolve'
import { credentialsOf } from '../../server/src/credentials/store'
import { sealSecret } from '../../web/src/lib/seal'
import { addCred } from '../lib/credentials'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'
import { addGuest, groupChat } from './guest-lib'

setDefaultTimeout(60_000)
const fake = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ ok: true }) })
const up = `http://127.0.0.1:${fake.port}`
afterAll(() => { fake.stop(true) })
let h: Harness
afterEach(async () => { await h?.close() })
const ALL = new Set(ALL_CREDENTIAL_KINDS)
const AKEY = (s: string) => 'sk-ant-api03-' + s.padEnd(40, 'k')

async function setup(o: { managed?: boolean } = {}) {
  h = await harness('a-guests-own-ai', o.managed === false ? {} : { engine: { authMode: 'managed', modelUpstreams: { anthropic: up, openai: up + '/v1' } } })
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const room = await groupChat(owner, [mia.id, nora.id])
  setEnginesEnabled(h.ctx.db, { 'claude-code': true, codex: true })
  const cc = credentialsOf(h.ctx)
  const team = addCred(cc, 'anthropic-api-key', AKEY('teamwide'), { label: 'team-wide' })
  const key: SealingKey = await owner.call('GET', '/api/credentials/sealing-key')
  const sealed = (secret: string) => sealSecret(key, secret, 'credential.create')
  const addOwn = async (c: Client, secret: string) => c.try('POST', '/api/me/credentials', { kind: 'anthropic-api-key', label: 'mine', sealed: await sealed(secret) })
  // a sign-in can start (its policy is passed) but this test server has no launcher: 'engine_unavailable' after the
  // checks, never a running sign-in
  credentialLogins(cc, { launcher: async () => null })
  const startLogin = (c: Client, kind: 'chatgpt' | 'anthropic-oauth') => c.try('POST', '/api/me/credential-logins', { kind, label: 'My sign-in', acknowledgedPlanNotice: true })
  return { owner, mia, room, team, addOwn, startLogin }
}

test('own, nothing connected yet: told to connect their own (not "ask"); my AI accounts is open to them, even with the members\' switch off', async () => {
  const { mia, room } = await setup()
  const g = await addGuest(h, mia.client, { username: 'oli', place: { kind: 'room', id: room }, ai: { mode: 'own' } })
  expect(await g.client.call('GET', '/api/me/ai-access')).toMatchObject({ usable: false, action: 'connect_own' })
  expect(await g.client.call('GET', '/api/me/credentials')).toMatchObject({ allowed: true, items: [] })
  setSetting(h.ctx.db, MEMBER_OWN_KEY, false)
  expect(await g.client.call('GET', '/api/me/credentials')).toMatchObject({ allowed: true })
  expect(personalConnectionsAllowed(h.ctx.db, g.id)).toBe(true)
  // the member next to them follows the switch as before
  expect(await mia.client.call('GET', '/api/me/credentials')).toMatchObject({ allowed: false })
  expect(personalConnectionsAllowed(h.ctx.db, mia.id)).toBe(false)
})

test('own: starts their own Claude and ChatGPT sign-in, saves their own key and is answered on it, never on the team\'s', async () => {
  const { mia, room, team, addOwn, startLogin } = await setup()
  setSetting(h.ctx.db, MEMBER_OWN_KEY, false)
  const g = await addGuest(h, mia.client, { username: 'oli', place: { kind: 'room', id: room }, ai: { mode: 'own' } })
  // the team-wide connection is not theirs
  expect(resolveCredential(h.ctx.db, { userId: g.id, engine: 'claude-code', allowedKinds: ALL })).toMatchObject({ ok: false, reason: 'none' })
  // the sign-in passes the policy (this server has no launcher to run it)
  for (const kind of ['anthropic-oauth', 'chatgpt'] as const) {
    const r = await startLogin(g.client, kind)
    expect(r.status).not.toBe(403)
    expect(r.body?.error?.code).toBe('engine_unavailable')
  }
  const saved = await addOwn(g.client, AKEY('oli-own'))
  expect(saved.status).toBe(201)
  const id = saved.body.id as string
  expect(h.ctx.db.query('SELECT owner_user_id FROM engine_credentials WHERE id = ?').get(id)).toEqual({ owner_user_id: g.id })
  expect((await g.client.call('GET', '/api/me/credentials')).items.map((x: { id: string }) => x.id)).toEqual([id])
  expect(resolveCredential(h.ctx.db, { userId: g.id, engine: 'claude-code', allowedKinds: ALL })).toMatchObject({ ok: true, credentialId: id })
  expect(await g.client.call('GET', '/api/me/ai-access')).toMatchObject({ usable: true, action: 'connect_own' })
  // the member keeps the team-wide one; nobody else gets the guest's
  expect(resolveCredential(h.ctx.db, { userId: mia.id, engine: 'claude-code', allowedKinds: ALL })).toMatchObject({ ok: true, credentialId: team })
  // they remove their own: nothing answers them again
  expect((await g.client.try('DELETE', `/api/me/credentials/${id}`)).status).toBe(204)
  expect(resolveCredential(h.ctx.db, { userId: g.id, engine: 'claude-code', allowedKinds: ALL })).toMatchObject({ ok: false })
})

test('own: never a team connection, never the trial credit; the team endpoints stay closed to them', async () => {
  const { mia, room, team } = await setup()
  const g = await addGuest(h, mia.client, { username: 'oli', place: { kind: 'room', id: room }, ai: { mode: 'own' } })
  h.ctx.db.query('DELETE FROM engine_credentials WHERE id = ?').run(team)
  writeHostedChatKey(credentialsOf(h.ctx), { key: 'sk-or-v1-GUEST-OWN-TRIAL-' + 'k'.repeat(40), capUsd: 1, endsAt: new Date(Date.now() + 14 * 86400_000).toISOString(), enabled: true })
  expect(canUseAi(h.ctx, { id: g.id, role: 'guest' })).toBe(false)
  expect(await g.client.call('GET', '/api/me/ai-access')).toMatchObject({ usable: false, action: 'connect_own' })
  expect((await g.client.call('GET', '/api/me/ai-access')).trial).toBeUndefined()
  // a team connection or a team sign-in: the admin endpoints, closed to a guest
  expect((await g.client.try('POST', '/api/admin/credentials', { kind: 'anthropic-api-key', label: 'team', sealed: {} })).status).toBe(403)
  expect((await g.client.try('POST', '/api/admin/credential-logins', { kind: 'chatgpt', label: 'team' })).status).toBe(403)
  expect((await g.client.try('POST', '/api/me/ai-access/request')).status).toBe(403)
  // a member's own connection someone else holds is never theirs, nor theirs a member's
  const mias = addCred(credentialsOf(h.ctx), 'anthropic-api-key', AKEY('mia-own'), { owner: mia.id })
  expect(resolveCredential(h.ctx.db, { userId: g.id, engine: 'claude-code', allowedKinds: ALL })).toMatchObject({ ok: false })
  expect((await g.client.try('DELETE', `/api/me/credentials/${mias}`)).status).toBe(404)
})

test('none (the default) and team: no connection of their own, no sign-in; still "ask"', async () => {
  const { owner, mia, room, team, addOwn, startLogin } = await setup()
  const none = await addGuest(h, mia.client, { username: 'nan', place: { kind: 'room', id: room } })
  const tea = await addGuest(h, owner, { username: 'tea', place: { kind: 'room', id: room }, ai: { mode: 'team', credentialId: team, limitUsd: 5 } })
  for (const g of [none, tea]) {
    expect((await g.client.call('GET', '/api/me/ai-access')).action).toBe('ask_owner')
    expect(await g.client.call('GET', '/api/me/credentials')).toMatchObject({ allowed: false })
    expect((await addOwn(g.client, AKEY(`own-${g.id.slice(-6)}`))).status).toBe(403)
    expect((await startLogin(g.client, 'chatgpt')).status).toBe(403)
    expect((await startLogin(g.client, 'anthropic-oauth')).status).toBe(403)
    expect(personalConnectionsAllowed(h.ctx.db, g.id)).toBe(false)
  }
  expect((h.ctx.db.query('SELECT COUNT(*) n FROM engine_credentials WHERE owner_user_id IS NOT NULL').get() as { n: number }).n).toBe(0)
  // a connection left from an earlier 'own' (the choice changed to none) is not used
  addCred(credentialsOf(h.ctx), 'anthropic-api-key', AKEY('left-over'), { owner: none.id })
  expect(resolveCredential(h.ctx.db, { userId: none.id, engine: 'claude-code', allowedKinds: ALL })).toMatchObject({ ok: false })
})

test('own on a server whose engines use the host\'s own sign-in: nothing to connect (a guest is never answered there)', async () => {
  const { mia, room } = await setup({ managed: false })
  const g = await addGuest(h, mia.client, { username: 'oli', place: { kind: 'room', id: room }, ai: { mode: 'own' } })
  expect(await g.client.call('GET', '/api/me/ai-access')).toMatchObject({ usable: false, action: 'ask_owner' })
})

