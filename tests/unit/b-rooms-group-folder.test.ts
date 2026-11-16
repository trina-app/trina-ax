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
