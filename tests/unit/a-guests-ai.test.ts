// Guest AI (docs/DECISIONS.md "Guests: only what they were invited to"; credentials/guest-ai.ts): off by default; 'team'
// = only the one team connection the invite named, only while it is a team connection and the guest's own 'block'
// budget exists; 'own' = only their own sign-in. Never assignments (one would make a team-wide connection assigned-only
// for every member), groups, team-wide connections, the trial credit, the API engine, or a server without AI
// connections. Real guests: invited through the API and accepted on the invite page.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import path from 'node:path'
import { ALL_CREDENTIAL_KINDS, type AppConfig } from '../../server/src/app-config'
import { setEnginesEnabled, setSetting, updateTeamSettings } from '../../server/src/admin/settings'
import { aiAccessFor, canUseAi, connectionRoute } from '../../server/src/credentials/access'
import { writeHostedChatKey } from '../../server/src/credentials/hosted-chat'
import { writeApiEngine } from '../../server/src/engine/api-agent'
import { MEMBER_OWN_KEY, resolveCredential } from '../../server/src/credentials/resolve'
import { addCred, testCredCtx } from '../lib/credentials'
import { addMember, harness, withOwner, type Harness } from './a-lib'
import { addGuest, groupChat } from './guest-lib'

setDefaultTimeout(60_000)
let h: Harness
afterEach(async () => { await h?.close() })
const ALL = new Set(ALL_CREDENTIAL_KINDS)
const key = (s: string) => `sk-ant-api03-${s}${'k'.repeat(30)}`

async function setup() {
  h = await harness('a-guests-ai')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const room = await groupChat(owner, [mia.id, nora.id])
  const t = testCredCtx(h.ctx.db, path.join(h.ctx.config.dataDir, 'test-secrets'))
  setEnginesEnabled(h.ctx.db, { 'claude-code': true, codex: true })
  const team = addCred(t.cc, 'anthropic-api-key', key('teamwide'), { label: 'team-wide' })
  const resolve = (userId: string) => resolveCredential(h.ctx.db, { userId, engine: 'claude-code', allowedKinds: ALL })
  const managed = { db: h.ctx.db, config: { ...h.ctx.config, engine: { authMode: 'managed' } } as unknown as AppConfig }
  const unmanaged = { db: h.ctx.db, config: { ...h.ctx.config, engine: { authMode: 'local-login' } } as unknown as AppConfig }
  return { owner, mia, nora, room, t, team, resolve, managed, unmanaged }
}

test('AI none (the default): no connection at all; the member next to them resolves the team-wide one', async () => {
  const { mia, room, resolve, managed } = await setup()
  const g = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'room', id: room } })
  expect(h.ctx.db.query('SELECT ai, team_credential_id FROM guests WHERE user_id = ?').get(g.id)).toEqual({ ai: 'none', team_credential_id: null })
  expect(resolve(g.id)).toMatchObject({ ok: false, reason: 'none' })
  expect(resolve(mia.id).ok).toBe(true)
  expect(canUseAi(managed, { id: g.id, role: 'guest' })).toBe(false)
  expect(canUseAi(managed, { id: mia.id, role: 'member' })).toBe(true)
  // what the app tells them: ask (never "connect for the team"), no trial line
  expect(aiAccessFor(managed, { id: g.id, role: 'guest' }, true)).toEqual({ usable: false, action: 'ask_owner' })
})

test('AI team: only the named team connection, under their own block budget; no assignment row, members keep the team-wide one', async () => {
  const { owner, mia, room, t, team, resolve, managed } = await setup()
  const other = addCred(t.cc, 'anthropic-api-key', key('better'), { label: 'better', priority: 1 })
  const g = await addGuest(h, owner, { username: 'tia', place: { kind: 'room', id: room }, ai: { mode: 'team', credentialId: team, limitUsd: 5 } })
  expect(h.ctx.db.query('SELECT ai, team_credential_id FROM guests WHERE user_id = ?').get(g.id)).toEqual({ ai: 'team', team_credential_id: team })
  // the limit: a 'user' block budget of their own
  expect(h.ctx.db.query("SELECT period, limit_usd, action FROM budgets WHERE subject_type = 'user' AND subject_id = ?").get(g.id)).toEqual({ period: 'month', limit_usd: 5, action: 'block' })
  // never an assignment: the team-wide connection stays team-wide for every member
  expect((h.ctx.db.query('SELECT COUNT(*) n FROM engine_credential_assignments').get() as { n: number }).n).toBe(0)
  expect(resolve(g.id)).toMatchObject({ ok: true, credentialId: team })
  // members still pick by priority among all team-wide connections (the guest never gets the better one)
  expect(resolve(mia.id)).toMatchObject({ ok: true, credentialId: other })
  h.ctx.db.query('DELETE FROM engine_credentials WHERE id = ?').run(other)
  expect(resolve(mia.id)).toMatchObject({ ok: true, credentialId: team })
  expect(aiAccessFor(managed, { id: g.id, role: 'guest' }, true)).toEqual({ usable: true, action: 'ask_owner' })
  // without their block budget: nothing (the limit is what lets them use a team connection)
  h.ctx.db.query("DELETE FROM budgets WHERE subject_type = 'user' AND subject_id = ?").run(g.id)
  expect(resolve(g.id)).toMatchObject({ ok: false, reason: 'none' })
  h.ctx.db.query("INSERT INTO budgets (id, subject_type, subject_id, period, limit_usd, action) VALUES ('b-again', 'user', ?, 'month', 5, 'block')").run(g.id)
  expect(resolve(g.id).ok).toBe(true)
  // a connection that became someone's personal one is no team connection any more
  h.ctx.db.query('UPDATE engine_credentials SET owner_user_id = ? WHERE id = ?').run(mia.id, team)
  expect(resolve(g.id)).toMatchObject({ ok: false })
})

test('AI team: only an owner or admin may give it, and only with a team connection', async () => {
  const { owner, mia, room, t, team } = await setup()
  const r = await mia.client.try('POST', '/api/guest-invites', { place: { kind: 'room', id: room }, ai: { mode: 'team', credentialId: team, limitUsd: 5 } })
  expect(r.status).toBe(403)
  const personal = addCred(t.cc, 'anthropic-api-key', key('olga-own'), { owner: 'olga' })
  expect((await owner.try('POST', '/api/guest-invites', { place: { kind: 'room', id: room }, ai: { mode: 'team', credentialId: personal, limitUsd: 5 } })).status).toBe(403)
  expect((await owner.try('POST', '/api/guest-invites', { place: { kind: 'room', id: room }, ai: { mode: 'team', credentialId: team, limitUsd: 5 } })).status).toBe(201)
})

test('AI own: only their own sign-in, whatever the member-own switch; never the team-wide one; nobody else gets theirs', async () => {
  const { mia, room, t, team, resolve } = await setup()
  const g = await addGuest(h, mia.client, { username: 'oli', place: { kind: 'room', id: room }, ai: { mode: 'own' } })
  expect(resolve(g.id)).toMatchObject({ ok: false, reason: 'none' })
  const own = addCred(t.cc, 'anthropic-api-key', key('oli-own'), { owner: g.id })
  setSetting(h.ctx.db, MEMBER_OWN_KEY, false)
  expect(resolve(g.id)).toMatchObject({ ok: true, credentialId: own })
  setSetting(h.ctx.db, MEMBER_OWN_KEY, true)
  expect(resolve(g.id)).toMatchObject({ ok: true, credentialId: own })
  expect(resolve(mia.id)).toMatchObject({ ok: true, credentialId: team })
})

test('the hosting service\'s trial credit: a member with no connection goes to it, a guest never', async () => {
  const { mia, room, t, team, managed } = await setup()
  const g = await addGuest(h, mia.client, { username: 'tri', place: { kind: 'room', id: room } })
  h.ctx.db.query('DELETE FROM engine_credentials WHERE id = ?').run(team)
  writeHostedChatKey(t.cc, { key: 'sk-or-v1-GUEST-TRIAL-' + 'k'.repeat(40), capUsd: 1, endsAt: new Date(Date.now() + 14 * 86400_000).toISOString(), enabled: true })
  expect(connectionRoute(managed, { id: mia.id }, 'claude-code', { allowed: ALL })).toBe('trial')
  expect(connectionRoute(managed, { id: g.id }, 'claude-code', { allowed: ALL })).toBe('own')
  expect(canUseAi(managed, { id: mia.id, role: 'member' })).toBe(true)
  expect(canUseAi(managed, { id: g.id, role: 'guest' })).toBe(false)
  expect(aiAccessFor(managed, { id: g.id, role: 'guest' }, true)).toEqual({ usable: false, action: 'ask_owner' })
})

test('a server without AI connections (engines on the host\'s own sign-in): members use AI, a guest never, even with a team choice', async () => {
  const { owner, mia, room, team, managed, unmanaged } = await setup()
  const g = await addGuest(h, owner, { username: 'sel', place: { kind: 'room', id: room }, ai: { mode: 'team', credentialId: team, limitUsd: 5 } })
  expect(canUseAi(managed, { id: g.id, role: 'guest' })).toBe(true)
  expect(canUseAi(unmanaged, { id: g.id, role: 'guest' })).toBe(false)
  expect(aiAccessFor(unmanaged, { id: g.id, role: 'guest' }, true).usable).toBe(false)
  expect(aiAccessFor(unmanaged, { id: mia.id, role: 'member' }, true).usable).toBe(true)
})

test('the API engine (the team\'s own key): answers members, never a guest', async () => {
  const { mia, room, team, managed } = await setup()
  const g = await addGuest(h, mia.client, { username: 'api', place: { kind: 'room', id: room } })
  h.ctx.db.query('DELETE FROM engine_credentials WHERE id = ?').run(team)
  writeApiEngine(h.ctx.config.dataDir, { baseUrl: 'http://127.0.0.1:9/v1', model: 'test-model', key: 'sk-test-' + 'a'.repeat(30) })
  setEnginesEnabled(h.ctx.db, { 'claude-code': false, codex: false, api: true })
  updateTeamSettings(h.ctx.db, { defaultEngine: 'api' })
  expect(canUseAi(managed, { id: mia.id, role: 'member' })).toBe(true)
  expect(canUseAi(managed, { id: g.id, role: 'guest' })).toBe(false)
})
