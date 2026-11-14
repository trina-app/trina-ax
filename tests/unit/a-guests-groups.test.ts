// Guests and groups (docs/DECISIONS.md "Guests: only what they were invited to"; guest-review path 5). A guest joins no
// group: creating or changing a group with them in it, and giving them groups on the members screen, is refused (409
// guest_one_place, whose message says to make them a team member). So a group's folder, its team room and every project
// shared with a group never reach a guest; a group rule would not apply to them anyway (policy/access.ts applies()).
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { addMember, harness, withOwner, type Harness } from './a-lib'
import { addGuest, groupChat } from './guest-lib'

setDefaultTimeout(120_000)
let h: Harness
afterEach(async () => { await h?.close() })

test('a guest is never put in a group; members are, as before', async () => {
  h = await harness('a-guests-groups')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const room = await groupChat(mia.client, [nora.id, otto.id])
  const g = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'room', id: room } })
  const reason = (r: { status: number; body: any }) => `${r.status} ${r.body?.error?.params?.reason}`

  // a new group with the guest in it
  expect(reason(await owner.try('POST', '/api/admin/groups', { name: 'design', memberIds: [mia.id, g.id] }))).toBe('409 guest_one_place')
  expect(h.ctx.db.query("SELECT 1 FROM groups WHERE name = 'design'").get()).toBeNull()
  // a group of members: fine
  const group = await owner.call('POST', '/api/admin/groups', { name: 'design', memberIds: [mia.id, nora.id] })
  // adding the guest to it later
  expect(reason(await owner.try('PATCH', `/api/admin/groups/${group.id}`, { memberIds: [mia.id, nora.id, g.id] }))).toBe('409 guest_one_place')
  // the members screen: groups (and a role) for the guest
  expect(reason(await owner.try('PATCH', `/api/admin/users/${g.id}`, { groupIds: [group.id] }))).toBe('403 guest_one_place')
  expect(reason(await owner.try('PATCH', `/api/admin/users/${g.id}`, { role: 'member' }))).toBe('403 guest_one_place')
  expect(reason(await owner.try('PATCH', `/api/admin/users/${g.id}`, { role: 'admin' }))).toBe('403 guest_one_place')
  expect((h.ctx.db.query('SELECT COUNT(*) AS n FROM group_members WHERE user_id = ?').get(g.id) as { n: number }).n).toBe(0)
  // their name can still be changed by an admin
  expect((await owner.call('PATCH', `/api/admin/users/${g.id}`, { name: 'Gus Client' })).name).toBe('Gus Client')
  // a member joins the group as before
  expect((await owner.call('PATCH', `/api/admin/groups/${group.id}`, { memberIds: [mia.id, nora.id, otto.id] })).memberIds?.length ?? 3).toBe(3)
  expect((h.ctx.db.query('SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?').get(group.id) as { n: number }).n).toBe(3)
  // the group's team room is not theirs: the guest's room list has their group chat only (and no team room)
  const kinds = (await g.client.call('GET', '/api/rooms')).items.map((r: any) => r.kind)
  expect(kinds).not.toContain('team')
  // a member can never be made a guest by a role change
  expect((await owner.try('PATCH', `/api/admin/users/${nora.id}`, { role: 'guest' })).status).toBe(400)
})
