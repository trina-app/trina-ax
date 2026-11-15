// The guest fields the app reads (docs/DECISIONS.md "Guests: only what they were invited to"; phase 2's screens):
// Me.guest, User.guest in the admin list, Person.guest (only to people who may see the guest at all), InviteInfo's
// guestPlace (kind and name only), PATCH /api/admin/users/:id/guest-ai and the optional invite name. Real guests.
import path from 'node:path'
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { addMember, harness, withOwner, type Harness } from './a-lib'
import { addGuest, groupChat } from './guest-lib'
import { addCred, testCredCtx } from '../lib/credentials'

setDefaultTimeout(60_000)
let h: Harness
afterEach(async () => { await h?.close() })

async function setup() {
  h = await harness('a-guests-api-fields')
  const owner = await withOwner(h)
  const ada = await addMember(h, owner, { username: 'ada', role: 'admin' })
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const pia = await addMember(h, owner, { username: 'pia' })
  const room = await groupChat(mia.client, [nora.id, ada.id], 'Client call')
  const g = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'room', id: room } })
  return { owner, ada, mia, nora, pia, room, g }
}

test('Me.guest: the guest\'s place with its name and their AI; a member has none', async () => {
  const { mia, room, g } = await setup()
  const me = await g.client.call('GET', '/api/me')
  expect(me.guest).toEqual({ place: { kind: 'room', id: room, name: 'Client call' }, ai: { mode: 'none' } })
  expect((await mia.client.call('GET', '/api/me')).guest).toBeUndefined()
})

test('User.guest in the admin list; Person.guest only for people who see the guest', async () => {
  const { owner, mia, pia, g } = await setup()
  const users = (await owner.call('GET', '/api/admin/users')).items as any[]
  expect(users.find((u) => u.id === g.id).guest).toMatchObject({ place: { kind: 'room', name: 'Client call' }, ai: { mode: 'none' } })
  expect(users.find((u) => u.id === mia.id).guest).toBeUndefined()
  // a member of the place sees the guest with the tag; members carry no tag
  const seen = (await mia.client.call('GET', '/api/people')).people as any[]
  expect(seen.find((p) => p.id === g.id)?.guest).toBe(true)
  expect(seen.find((p) => p.id === mia.id)?.guest).toBeUndefined()
  // a member outside the place does not get the guest at all (nor the tag)
  expect(((await pia.client.call('GET', '/api/people')).people as any[]).some((p) => p.id === g.id)).toBe(false)
})

test('the invite page names the place by kind and name only; a member link has none; the optional name is taken', async () => {
  const { owner, mia, room } = await setup()
  const inv = await mia.client.call('POST', '/api/guest-invites', { place: { kind: 'room', id: room }, name: 'Kim from Acme' })
  const info = await h.client().call('GET', `/api/invites/${inv.url.split('/invite/')[1]}`)
  expect(info.guestPlace).toEqual({ kind: 'room', name: 'Client call' })
  expect(JSON.stringify(info)).not.toContain(room)
  const member = await owner.call('POST', '/api/admin/invites', { role: 'member' })
  expect((await h.client().call('GET', `/api/invites/${member.url.split('/invite/')[1]}`)).guestPlace).toBeUndefined()
  expect((h.ctx.db.query('SELECT guest_name FROM invites WHERE id = ?').get(inv.invite.id) as { guest_name: string }).guest_name).toBe('Kim from Acme')
})

test('PATCH guest-ai: owner and admins only, with the invite\'s checks; never an assignment row', async () => {
  const { owner, ada, mia, g } = await setup()
  const t = testCredCtx(h.ctx.db, path.join(h.ctx.config.dataDir, 'test-secrets'))
  const team = addCred(t.cc, 'anthropic-api-key', `sk-ant-api03-team${'k'.repeat(30)}`, { label: 'team' })
  const url = `/api/admin/users/${g.id}/guest-ai`
  // a member: 403; a connection that is not a team one: 400; someone not a guest: 409
  expect((await mia.client.try('PATCH', url, { mode: 'own' })).status).toBe(403)
  expect((await owner.try('PATCH', url, { mode: 'team', credentialId: 'nope', limitUsd: 5 })).status).toBe(400)
  expect((await owner.try('PATCH', `/api/admin/users/${mia.id}/guest-ai`, { mode: 'own' })).status).toBe(409)
  // own, then team with a limit (an admin may)
  expect((await owner.call('PATCH', url, { mode: 'own' })).guest.ai).toEqual({ mode: 'own' })
  const u = await ada.client.call('PATCH', url, { mode: 'team', credentialId: team, limitUsd: 7 })
  expect(u.guest.ai).toEqual({ mode: 'team', credentialId: team, limitUsd: 7 })
  expect((await g.client.call('GET', '/api/me')).guest.ai).toEqual({ mode: 'team', credentialId: team, limitUsd: 7 })
  expect(h.ctx.db.query('SELECT COUNT(*) AS n FROM engine_credential_assignments').get()).toEqual({ n: 0 })
  // a new limit replaces the old one
  await owner.call('PATCH', url, { mode: 'team', credentialId: team, limitUsd: 3 })
  expect(h.ctx.db.query("SELECT limit_usd FROM budgets WHERE subject_type = 'user' AND subject_id = ? AND action = 'block'").all(g.id)).toEqual([{ limit_usd: 3 }])
  // and off again
  expect((await owner.call('PATCH', url, { mode: 'none' })).guest.ai).toEqual({ mode: 'none' })
  // a guest cannot change their own
  expect((await g.client.try('PATCH', url, { mode: 'own' })).status).toBe(403)
})
