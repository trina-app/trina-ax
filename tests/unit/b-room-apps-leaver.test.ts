// Apps posting in rooms: "Someone who left knows the address of <app>" in Activity (docs/DECISIONS.md "Apps posting in
// rooms"; notifications 'room_app.leaver', room_app_leaver_notices, migration 351). The sweep (RoomApps.leaverSweep)
// tells the room's members who may manage the app, once per address; a new address settles them and a later leaver of it
// tells them again; a member who may not manage apps is never told; removing the app takes its notices away.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { roomAppsOf } from '../../server/src/rooms/apps/service'
import { addMember, harness, withOwner, type Harness } from './a-lib'

setDefaultTimeout(60_000)
let h: Harness
afterEach(async () => { await h?.close() })

const notices = (userId: string) => h.ctx.db.query("SELECT id, source_id, read_at FROM room_app_leaver_notices WHERE user_id = ? ORDER BY created_at, id").all(userId) as { id: string; source_id: string; read_at: string | null }[]

test('a manager who copied the address leaves: the other managers are told once; a new address settles it; a later leaver tells again; removing the app takes them away', async () => {
  h = await harness('b-room-apps-leaver', { publicOrigins: ['https://team.acme-corp.com'] })
  const owner = await withOwner(h)
  const ada = await addMember(h, owner, { username: 'ada', role: 'admin' })
  const pia = await addMember(h, owner, { username: 'pia', role: 'admin' })
  const quinn = await addMember(h, owner, { username: 'quinn', role: 'admin' })
  const mia = await addMember(h, owner, { username: 'mia' })
  const group = await owner.call('POST', '/api/admin/groups', { name: 'design', memberIds: [ada.id, pia.id, mia.id] })
  const team = (await ada.client.call('GET', '/api/rooms')).items.find((r: any) => r.kind === 'team' && r.groupId === group.id)
  const a = await ada.client.call('POST', `/api/rooms/${team.id}/apps`, { kind: 'other', name: 'Deploys' })
  const apps = roomAppsOf(h.ctx)

  // nobody left yet: nothing
  expect(apps.leaverSweep()).toBe(0)
  expect(notices(pia.id)).toEqual([])

  // ada (who was shown the address) leaves the team room
  await owner.call('PATCH', `/api/admin/groups/${group.id}`, { memberIds: [pia.id, mia.id] })
  expect(apps.leaverSweep()).toBe(1)
  const first = notices(pia.id)
  expect(first).toHaveLength(1)
  expect(first[0]!.read_at).toBeNull()
  // the leaver and a member who may not manage apps get nothing
  expect(notices(ada.id)).toEqual([])
  expect(notices(mia.id)).toEqual([])

  // what Activity shows
  const listed = (await pia.client.call('GET', '/api/notifications')).items.find((n: any) => n.code === 'room_app.leaver')
  expect(listed).toMatchObject({ link: 'room', roomAppLeaver: { appId: a.app.id, name: 'Deploys', roomId: team.id, roomKind: 'team', roomName: 'design' } })

  // again: no second notice
  apps.leaverSweep()
  expect(notices(pia.id)).toHaveLength(1)

  // a new address: the notice is read and no longer names the app; nobody who left knows the new one
  await pia.client.call('POST', `/api/rooms/${team.id}/apps/${a.app.id}/rotate`)
  const rotated = notices(pia.id)
  expect(rotated).toHaveLength(1)
  expect(rotated[0]!.read_at).not.toBeNull()
  const after = (await pia.client.call('GET', '/api/notifications')).items.find((n: any) => n.code === 'room_app.leaver')
  expect(after.roomAppLeaver).toBeUndefined()
  expect(after.link).toBeNull()
  expect(apps.leaverSweep()).toBe(0)

  // quinn joins, copies the new address and leaves: pia is told again (a new address, a new notice)
  await owner.call('PATCH', `/api/admin/groups/${group.id}`, { memberIds: [pia.id, mia.id, quinn.id] })
  await quinn.client.call('GET', `/api/rooms/${team.id}/apps/${a.app.id}/address`)
  await owner.call('PATCH', `/api/admin/groups/${group.id}`, { memberIds: [pia.id, mia.id] })
  apps.leaverSweep()
  const again = notices(pia.id)
  expect(again).toHaveLength(2)
  expect(again[1]!.source_id).not.toBe(again[0]!.source_id)
  expect(again[1]!.read_at).toBeNull()
  expect(notices(mia.id)).toEqual([])
  expect(notices(quinn.id)).toEqual([])

  // removing the app takes its notices away
  await pia.client.call('DELETE', `/api/rooms/${team.id}/apps/${a.app.id}`)
  expect(notices(pia.id)).toEqual([])
})

test('a group chat: everyone in it manages its apps, so everyone still in it is told when someone who copied the address leaves', async () => {
  h = await harness('b-room-apps-leaver-group', { publicOrigins: ['https://team.acme-corp.com'] })
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const gc = (await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, otto.id] })).id
  const a = await nora.client.call('POST', `/api/rooms/${gc}/apps`, { kind: 'other', name: 'Deploys' })
  await otto.client.call('GET', `/api/rooms/${gc}/apps/${a.app.id}/address`)
  await otto.client.call('POST', `/api/rooms/${gc}/leave`)
  roomAppsOf(h.ctx).leaverSweep()
  expect(notices(mia.id)).toHaveLength(1)
  expect(notices(nora.id)).toHaveLength(1)
  expect(notices(otto.id)).toEqual([])
})
