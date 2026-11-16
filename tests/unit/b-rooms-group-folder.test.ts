// A team room's group folder (Room.groupFolder, rooms/store.ts groupFolderFor; docs/decisions/20261116-room-group-folder-button.md):
// the room header's Files button opens it. Present only in a team room whose group has a folder, and only for someone
// the folder rules let open that folder (RuleSet.canList, as the Files page judges it). Never for the everyone room, a
// 1:1 or a group chat. The list, one room and the room.updated fan-out say the same.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { roomsOf } from '../../server/src/rooms/service'
import { addMember, harness, RecordingHub, withOwner, type Client, type Harness } from './a-lib'

setDefaultTimeout(60_000)
let h: Harness
afterEach(async () => { await h?.close() })

class FanoutHub extends RecordingHub {
  users: string[] = []
  override publishEach(build: (userId: string) => unknown) {
    for (const u of this.users) { const ev = build(u); if (ev) this.events.push({ kind: 'publish', target: u, data: ev }) }
  }
}

test('a team room carries its group folder for those who can open it, and no other room does', async () => {
  h = await harness('b-rooms-group-folder')
  const owner = await withOwner(h)
  const ada = await addMember(h, owner, { username: 'ada', role: 'admin' })
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const group = await owner.call('POST', '/api/admin/groups', { name: 'leads', memberIds: [ada.id, mia.id, nora.id] })
  const folder = (h.ctx.db.query('SELECT f.id, f.path FROM groups g JOIN folders f ON f.id = g.folder_id WHERE g.id = ?').get(group.id) as { id: string; path: string })
  expect(folder.path).toBe('groups/leads')

  const rooms = async (c: Client) => (await c.call('GET', '/api/rooms')).items as any[]
  const teamOf = async (c: Client) => (await rooms(c)).find((r) => r.kind === 'team' && r.groupId === group.id)

  // a member of the group and an admin in it: the folder, in the list and in the room itself
  const team = await teamOf(mia.client)
  expect(team.groupFolder).toBe('groups/leads')
  expect((await mia.client.call('GET', `/api/rooms/${team.id}`)).groupFolder).toBe('groups/leads')
  expect((await teamOf(ada.client)).groupFolder).toBe('groups/leads')
  // someone outside the group is not in the room at all
  expect(await teamOf(otto.client)).toBeUndefined()
  expect((await otto.client.try('GET', `/api/rooms/${team.id}`)).status).toBe(404)

  // the everyone room, a 1:1 and a group chat never carry one
  const dm = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  const chat = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, otto.id] })
  for (const r of await rooms(mia.client)) if (r.id !== team.id) expect(r.groupFolder).toBeUndefined()
  expect(dm.groupFolder).toBeUndefined()
  expect(chat.groupFolder).toBeUndefined()

  // the folder rules decide, not the group: with the group's rule gone only nora (named) and the admin still open it
  await owner.call('PUT', `/api/admin/folders/${folder.id}/rules`, { rules: [{ subjectType: 'user', subjectId: nora.id, access: 'read' }] })
  expect((await teamOf(mia.client)).groupFolder).toBeUndefined()
  expect((await teamOf(nora.client)).groupFolder).toBe('groups/leads')
  expect((await teamOf(ada.client)).groupFolder).toBe('groups/leads')

  // the room.updated fan-out is per person too
  const hub = new FanoutHub()
  hub.users = [ada.id, mia.id, nora.id]
  h.ctx.services.realtime = hub
  roomsOf(h.ctx).roomEvent(team.id, 'updated')
  const got = (uid: string) => (hub.events.find((e) => e.target === uid)?.data as { data: { room: { groupFolder?: string } } }).data.room.groupFolder
  expect(got(mia.id)).toBeUndefined()
  expect(got(nora.id)).toBe('groups/leads')
  expect(got(ada.id)).toBe('groups/leads')

  // a group without a folder row: no folder
  h.ctx.db.query('UPDATE groups SET folder_id = NULL WHERE id = ?').run(group.id)
  expect((await teamOf(ada.client)).groupFolder).toBeUndefined()
})

test('a folder rule or group change shows or hides the Files button live, only for whose answer changed (QA TC-3848)', async () => {
  h = await harness('b-rooms-group-folder-live')
  const owner = await withOwner(h)
  const ada = await addMember(h, owner, { username: 'ada', role: 'admin' })
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const group = await owner.call('POST', '/api/admin/groups', { name: 'leads', memberIds: [ada.id, mia.id, nora.id] })
  const helpers = await owner.call('POST', '/api/admin/groups', { name: 'helpers', memberIds: [] })
  const folder = (h.ctx.db.query('SELECT f.id FROM groups g JOIN folders f ON f.id = g.folder_id WHERE g.id = ?').get(group.id) as { id: string })
  const team = ((await mia.client.call('GET', '/api/rooms')).items as any[]).find((r) => r.kind === 'team' && r.groupId === group.id)
  expect(team.groupFolder).toBe('groups/leads')
  const groupRule = { subjectType: 'group', subjectId: group.id, access: 'write' }
  const noraRule = { subjectType: 'user', subjectId: nora.id, access: 'read' }

  // the realtime hub sees every person as connected; the team room's room.updated 'updated' events since the last look
  // (the sync's own 'added' / 'members' / 'removed' are not these)
  const hub = new FanoutHub()
  hub.users = [ada.id, mia.id, nora.id]
  h.ctx.services.realtime = hub
  const sent = () => {
    const out = new Map<string, { groupFolder?: string }>()
    for (const e of hub.events.splice(0)) {
      const ev = e.data as { type: string; data: { roomId: string; room: { groupFolder?: string } | null } }
      if (ev.type === 'room.updated' && ev.data.roomId === team.id && ev.data.room && (ev.data as { change?: string }).change === 'updated') out.set(e.target, ev.data.room)
    }
    return out
  }

  // the group's rule goes: mia loses the button through the live event; nora (named) and the admin keep it and are
  // not told (nothing changed for them)
  await owner.call('PUT', `/api/admin/folders/${folder.id}/rules`, { rules: [noraRule] })
  let got = sent()
  expect([...got.keys()]).toEqual([mia.id])
  expect(got.get(mia.id)!.groupFolder).toBeUndefined()

  // the rule comes back: mia gets it back, the same way
  await owner.call('PUT', `/api/admin/folders/${folder.id}/rules`, { rules: [groupRule, noraRule] })
  got = sent()
  expect([...got.keys()]).toEqual([mia.id])
  expect(got.get(mia.id)!.groupFolder).toBe('groups/leads')

  // a group membership that decides it: the folder open to helpers (and nora) only; mia joins helpers and regains it
  await owner.call('PUT', `/api/admin/folders/${folder.id}/rules`, { rules: [{ subjectType: 'group', subjectId: helpers.id, access: 'read' }, noraRule] })
  expect(sent().get(mia.id)!.groupFolder).toBeUndefined()
  await owner.call('PATCH', `/api/admin/groups/${helpers.id}`, { memberIds: [mia.id] })
  got = sent()
  expect([...got.keys()]).toEqual([mia.id])
  expect(got.get(mia.id)!.groupFolder).toBe('groups/leads')

  // bounded: a rule on a folder elsewhere sends the team room to nobody
  await owner.call('POST', '/api/admin/folders', { path: 'shared/plans', create: true, rules: [{ subjectType: 'user', subjectId: mia.id, access: 'read' }] })
  expect(sent().size).toBe(0)
})

test('a role change, an account switched off and on, a new member: the live event only for members already in the room', async () => {
  h = await harness('b-rooms-group-folder-people')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const group = await owner.call('POST', '/api/admin/groups', { name: 'leads', memberIds: [mia.id, nora.id] })
  const folder = (h.ctx.db.query('SELECT f.id FROM groups g JOIN folders f ON f.id = g.folder_id WHERE g.id = ?').get(group.id) as { id: string })
  const team = ((await mia.client.call('GET', '/api/rooms')).items as any[]).find((r) => r.kind === 'team' && r.groupId === group.id)
  // the folder open to nora alone: mia, in the room, has no button
  await owner.call('PUT', `/api/admin/folders/${folder.id}/rules`, { rules: [{ subjectType: 'user', subjectId: nora.id, access: 'read' }] })

  const hub = new FanoutHub()
  hub.users = [mia.id, nora.id, otto.id]
  h.ctx.services.realtime = hub
  const events = () => hub.events.splice(0).map((e) => ({ to: e.target, ev: e.data as { type: string; data: { roomId: string; change: string; room: { groupFolder?: string } | null } } }))
    .filter((x) => x.ev.type === 'room.updated' && x.ev.data.roomId === team.id)
    .map((x) => ({ to: x.to, change: x.ev.data.change, groupFolder: x.ev.data.room?.groupFolder ?? null }))

  // a role change: mia made an admin opens every folder, so her button comes back live; nobody else is told
  await owner.call('PATCH', `/api/admin/users/${mia.id}`, { role: 'admin' })
  expect(events()).toEqual([{ to: mia.id, change: 'updated', groupFolder: 'groups/leads' }])
  // and back to member: it goes again
  await owner.call('PATCH', `/api/admin/users/${mia.id}`, { role: 'member' })
  expect(events()).toEqual([{ to: mia.id, change: 'updated', groupFolder: null }])

  // the account switched off: she is taken out of the room (removed, no room); no 'updated' to anyone
  await owner.call('PATCH', `/api/admin/users/${mia.id}`, { status: 'disabled' })
  let got = events()
  expect(got.filter((e) => e.change === 'updated')).toEqual([])
  expect(got.filter((e) => e.to === mia.id)).toEqual([{ to: mia.id, change: 'removed', groupFolder: null }])
  // switched on again with the folder open to the group: she joins with the sync's 'added', which carries the button;
  // not also an 'updated' (she was not in the room before the change)
  await owner.call('PUT', `/api/admin/folders/${folder.id}/rules`, { rules: [{ subjectType: 'group', subjectId: group.id, access: 'read' }] })
  hub.events.splice(0)
  await owner.call('PATCH', `/api/admin/users/${mia.id}`, { status: 'active' })
  got = events()
  expect(got.filter((e) => e.to === mia.id)).toEqual([{ to: mia.id, change: 'added', groupFolder: 'groups/leads' }])
  expect(got.filter((e) => e.change === 'updated')).toEqual([])

  // a new member of the group: 'added' with the button, no 'updated'
  await owner.call('PATCH', `/api/admin/groups/${group.id}`, { memberIds: [mia.id, nora.id, otto.id] })
  got = events()
  expect(got.filter((e) => e.to === otto.id)).toEqual([{ to: otto.id, change: 'added', groupFolder: 'groups/leads' }])
  expect(got.filter((e) => e.change === 'updated')).toEqual([])
})
