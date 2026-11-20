// A private channel linked to a team project (rooms/project-link.ts; docs/decisions/20261119-channel-project-link.md):
// who may link and unlink from either side, the error order (each answer reveals nothing the caller could not see),
// what each viewer gets (Room.project, Project.channel, the event lines), the audit rows (the project only, never the
// room), an inactive row replaced, the lifecycle (archive, delete for good), creating a channel from a project.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'
import { addGuest } from './guest-lib'

setDefaultTimeout(120_000)
let h: Harness
afterEach(async () => { await h?.close() })

const user = (id: string) => ({ subjectType: 'user', subjectId: id })

async function setup(name: string) {
  h = await harness(name)
  const owner = await withOwner(h)
  const ada = await addMember(h, owner, { username: 'ada', role: 'admin' })
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  // Launch: mia (creator) and nora; otto is not in it
  const launch = await mia.client.call('POST', '/api/projects', { name: 'Launch site', participants: [user(nora.id)] })
  const other = await mia.client.call('POST', '/api/projects', { name: 'Other', participants: [] })
  // a private channel of mia, nora and otto
  const channel = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, otto.id], name: 'Launch talk' })
  return { owner, ada, mia, nora, otto, launch, other, channel }
}
const roomOf = (c: Client, id: string) => c.call('GET', `/api/rooms/${id}`)
const link = (c: Client, roomId: string, projectId: string, via?: 'project') => c.try('PUT', `/api/rooms/${roomId}/project`, { projectId, ...(via ? { via } : {}) })
const unlink = (c: Client, roomId: string, via?: 'project') => c.try('DELETE', `/api/rooms/${roomId}/project${via ? '?via=project' : ''}`)
const audits = () => h.ctx.db.query("SELECT actor_id, action, target, detail FROM audit_log WHERE action LIKE 'project.channel_%' ORDER BY id").all() as { actor_id: string | null; action: string; target: string; detail: string }[]
const folderOf = (projectId: string) => (h.ctx.db.query('SELECT folder_path FROM projects WHERE id = ?').get(projectId) as { folder_path: string }).folder_path
const folderRow = (p: string) => (h.ctx.db.query('SELECT id FROM folders WHERE path = ?').get(p) as { id: string }).id
/** a person's own rule on a project's folder, set straight in the table (the project page has no read-only choice) */
const setAccess = (projectId: string, userId: string, access: 'read' | 'write' | null) => {
  const f = folderRow(folderOf(projectId))
  h.ctx.db.query("DELETE FROM folder_rules WHERE folder_id = ? AND subject_type = 'user' AND subject_id = ?").run(f, userId)
  if (access) h.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, 'user', ?, ?)").run(crypto.randomUUID(), f, userId, access)
}
/** an error body without its request id */
const bare = (b: any) => ({ ...b, error: { ...b.error, requestId: undefined } })

test('link from the channel: the project for those who can open it, neutral for the others; the same again is unchanged', async () => {
  const { mia, nora, otto, launch, channel } = await setup('b-rooms-project-link-basic')
  // before: every non-guest member may link
  for (const c of [mia, nora, otto]) expect((await roomOf(c.client, channel.id)).canLinkProject).toBe(true)
  const r = await link(mia.client, channel.id, launch.id)
  expect(r.status).toBe(200)
  expect(r.body.project).toEqual({ id: launch.id, name: 'Launch site', folderPath: folderOf(launch.id), canSave: true })
  expect(r.body.canLinkProject).toBeUndefined()
  // nora (in the project) sees it; otto (not in it) does not, and is not offered a link either
  expect((await roomOf(nora.client, channel.id)).project?.id).toBe(launch.id)
  const ot = await roomOf(otto.client, channel.id)
  expect(ot.project).toBeUndefined()
  expect(ot.canLinkProject).toBeUndefined()
  // the same project again: 200, nothing new written
  const n = audits().length
  expect((await link(nora.client, channel.id, launch.id)).status).toBe(200)
  expect(audits().length).toBe(n)
  // the event line per viewer: the name for those who can open it, none for the others
  const line = async (c: Client) => ((await c.call('GET', `/api/rooms/${channel.id}/messages`)).items as any[]).find((m) => m.event?.type === 'project_linked')?.event
  expect(await line(nora.client)).toEqual({ type: 'project_linked', project: { id: launch.id, name: 'Launch site' } })
  expect(await line(otto.client)).toEqual({ type: 'project_linked', project: null })
  // the project page: its channel for its readers (nora is in it), with Unlink for whoever may
  const pj = await nora.client.call('GET', `/api/projects/${launch.id}`)
  expect(pj.channel).toEqual({ roomId: channel.id, name: 'Launch talk', memberCount: 3, inIt: true, canUnlink: true })
  expect(pj.canLinkChannel).toBeUndefined()
})

test('the error order: guest, room, kind, project (one 404 body), zone, write, channel linked, project has a channel', async () => {
  const { owner, ada, mia, nora, otto, launch, other, channel } = await setup('b-rooms-project-link-errors')
  const missingRoom = await mia.client.try('GET', `/api/rooms/${crypto.randomUUID().replace(/^(.{14})./, '$17')}`)
  const missingProject = await mia.client.try('GET', `/api/projects/${crypto.randomUUID().replace(/^(.{14})./, '$17')}`)
  // 2. a room I am not in: the missing room's body (ada the admin is not in the channel)
  const notMine = await link(ada.client, channel.id, launch.id)
  expect(notMine.status).toBe(404)
  expect(bare(notMine.body)).toEqual(bare(missingRoom.body))
  // 3. not a private channel: a group DM and a DM
  const gdm = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, otto.id] })
  const dm = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  for (const id of [gdm.id, dm.id]) {
    const x = await link(mia.client, id, launch.id)
    expect(x.status).toBe(409)
    expect(x.body.error?.params?.reason).toBe('not_private_channel')
  }
  // 4. a project otto cannot read, one that is missing: the missing project's body (never its name)
  const unreadable = await link(otto.client, channel.id, launch.id)
  expect(unreadable.status).toBe(404)
  expect(bare(unreadable.body)).toEqual(bare(missingProject.body))
  expect(JSON.stringify(unreadable.body)).not.toContain('Launch')
  // 5. a personal project: not linkable
  const personal = await mia.client.call('POST', '/api/projects', { name: 'Mine', scope: 'personal', participants: [] })
  const pers = await link(mia.client, channel.id, personal.id)
  expect(pers.status).toBe(409)
  expect(pers.body.error?.params?.reason).toBe('project_not_linkable')
  // 6. read but no write: nora read-only on Launch
  setAccess(launch.id, nora.id, 'read')
  const ro = await link(nora.client, channel.id, launch.id)
  expect(ro.status).toBe(403)
  expect(ro.body.error?.params?.reason).toBe('project_write_needed')
  // 7. linked to another project: channel_linked
  expect((await link(mia.client, channel.id, launch.id)).status).toBe(200)
  const again = await link(mia.client, channel.id, other.id)
  expect(again.status).toBe(409)
  expect(again.body.error?.params?.reason).toBe('channel_linked')
  // 8. the project has a channel: never naming it
  const second = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id], name: 'Secret talk' })
  const has = await link(mia.client, second.id, launch.id)
  expect(has.status).toBe(409)
  expect(has.body.error?.params?.reason).toBe('project_has_channel')
  expect(JSON.stringify(has.body)).not.toContain('Launch talk')
  // the admin outside the project and outside the channel unlinks nothing (404, as for a room that is not theirs)
  expect((await unlink(ada.client, channel.id)).status).toBe(404)
})

test('a guest never links, unlinks or creates; sees Files of their one project; Project.channel withheld when outside', async () => {
  const { mia, nora, launch, channel } = await setup('b-rooms-project-link-guest')
  const g = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'project', id: launch.id } })
  // a guest in the project, not in the channel: the project page has no channel row
  expect((await link(mia.client, channel.id, launch.id)).status).toBe(200)
  const pj = await g.client.call('GET', `/api/projects/${launch.id}`)
  expect(pj.channel).toBeUndefined()
  expect(pj.canLinkChannel).toBeUndefined()
  // the guest's own calls: 403 before anything else
  expect((await link(g.client, channel.id, launch.id)).status).toBe(403)
  expect((await unlink(g.client, channel.id)).status).toBe(403)
  expect((await g.client.try('POST', `/api/projects/${launch.id}/channel`, { name: 'x', userIds: [nora.id] })).status).toBe(403)
})

test('a second guest case: a guest in the channel and the project sees the Files button, never Save to project', async () => {
  const { mia, nora, launch } = await setup('b-rooms-project-link-guest-in')
  const g = await addGuest(h, mia.client, { username: 'gia', place: { kind: 'project', id: launch.id } })
  // the guest's one group chat: this channel (made by mia with them in it)
  const ch = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, g.id], name: 'With the client' })
  expect((await link(mia.client, ch.id, launch.id)).status).toBe(200)
  const seen = await roomOf(g.client, ch.id)
  expect(seen.project?.id).toBe(launch.id)
  expect(seen.project?.canSave).toBe(false)
  expect(seen.canLinkProject).toBeUndefined()
})

test('unlink from either side: who may; no active link is 204; audit rows name the project only', async () => {
  const { mia, nora, otto, launch, channel } = await setup('b-rooms-project-link-unlink')
  expect((await link(mia.client, channel.id, launch.id, 'project')).status).toBe(200)
  // otto (in the channel, not in the project): 404 like a project he cannot read
  expect((await unlink(otto.client, channel.id)).status).toBe(404)
  expect((await unlink(nora.client, channel.id, 'project')).status).toBe(204)
  expect((await roomOf(mia.client, channel.id)).project).toBeUndefined()
  // nothing to unlink: 204 again
  expect((await unlink(nora.client, channel.id)).status).toBe(204)
  const rows = audits()
  expect(rows.map((r) => [r.action, r.target, JSON.parse(r.detail).via])).toEqual([['project.channel_link', launch.id, 'project'], ['project.channel_unlink', launch.id, 'project']])
  for (const r of rows) {
    expect(JSON.parse(r.detail).room).toEqual({ kind: 'group' })
    expect(JSON.stringify(r)).not.toContain(channel.id)
  }
  // the unlink line per viewer
  const line = async (c: Client) => ((await c.call('GET', `/api/rooms/${channel.id}/messages`)).items as any[]).find((m) => m.event?.type === 'project_unlinked')?.event
  expect((await line(mia.client)).project?.name).toBe('Launch site')
  expect((await line(otto.client)).project).toBeNull()
})

test('an inactive row never blocks: a trashed project, then a project outside the zone; the channel links another', async () => {
  const { mia, nora, launch, other, channel } = await setup('b-rooms-project-link-inactive')
  expect((await link(mia.client, channel.id, launch.id)).status).toBe(200)
  // Launch to the trash: inactive (no button for anyone), and the channel may link another project
  expect((await mia.client.try('DELETE', `/api/projects/${launch.id}`)).status).toBe(204)
  expect((await roomOf(nora.client, channel.id)).project).toBeUndefined()
  expect((await roomOf(nora.client, channel.id)).canLinkProject).toBe(true)
  const r = await link(nora.client, channel.id, other.id)
  // nora is not in Other: 404 (she cannot read it)
  expect(r.status).toBe(404)
  const ok = await link(mia.client, channel.id, other.id)
  expect(ok.status).toBe(200)
  expect(ok.body.project?.id).toBe(other.id)
  const last = audits().at(-1)!
  expect(JSON.parse(last.detail)).toEqual({ room: { kind: 'group' }, via: 'channel', replaced: true })
})

test('archive deletes the link (last person leaves); delete for good deletes it; both audited by the system', async () => {
  const { owner, mia, nora, otto, launch, other, channel } = await setup('b-rooms-project-link-lifecycle')
  expect((await link(mia.client, channel.id, launch.id)).status).toBe(200)
  for (const c of [otto, nora, mia]) expect((await c.client.try('POST', `/api/rooms/${channel.id}/leave`)).status).toBe(204)
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM room_project_links').get()).toEqual({ n: 0 })
  const arch = audits().at(-1)!
  expect([arch.actor_id, arch.action, arch.target, JSON.parse(arch.detail)]).toEqual([null, 'project.channel_unlink', launch.id, { room: { kind: 'group' }, via: 'room_archived', replaced: false }])
  expect(JSON.stringify(arch)).not.toContain(channel.id)
  // the project page offers Create / Link again
  expect((await mia.client.call('GET', `/api/projects/${launch.id}`)).canLinkChannel).toBe(true)

  // delete for good: a project in the trash, then deleted for good
  const ch2 = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id], name: 'Other talk' })
  expect((await link(mia.client, ch2.id, other.id)).status).toBe(200)
  expect((await mia.client.try('DELETE', `/api/projects/${other.id}`)).status).toBe(204)
  // the owner deletes it for good (the project in the trash)
  expect((await owner.try('DELETE', `/api/projects/${other.id}`)).status).toBe(204)
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM room_project_links WHERE room_id = ?').get(ch2.id)).toEqual({ n: 0 })
  const del = audits().at(-1)!
  expect([del.actor_id, del.action, del.target, JSON.parse(del.detail).via]).toEqual([null, 'project.channel_unlink', other.id, 'project_deleted'])
  expect(JSON.stringify(del)).not.toContain(ch2.id)
  // the channel stays a plain private channel
  expect((await roomOf(nora.client, ch2.id)).name).toBe('Other talk')
})

test('create a channel from the project: linked in the same write, both lines, the project page shows it', async () => {
  const { mia, nora, otto, launch } = await setup('b-rooms-project-link-create')
  const r = await mia.client.try('POST', `/api/projects/${launch.id}/channel`, { name: 'Launch site', userIds: [nora.id] })
  expect(r.status).toBe(201)
  expect(r.body.project?.id).toBe(launch.id)
  const kinds = ((await mia.client.call('GET', `/api/rooms/${r.body.id}/messages`)).items as any[]).filter((m) => m.event).map((m) => m.event.type)
  expect(kinds).toEqual(['created', 'project_linked'])
  expect((await nora.client.call('GET', `/api/projects/${launch.id}`)).channel?.roomId).toBe(r.body.id)
  expect(JSON.parse(audits().at(-1)!.detail).via).toBe('create')
  // a second one: project_has_channel, and no room is left behind
  const before = (h.ctx.db.query("SELECT COUNT(*) n FROM rooms WHERE kind = 'group'").get() as { n: number }).n
  const again = await mia.client.try('POST', `/api/projects/${launch.id}/channel`, { name: 'Again', userIds: [nora.id] })
  expect(again.status).toBe(409)
  expect(again.body.error?.params?.reason).toBe('project_has_channel')
  expect((h.ctx.db.query("SELECT COUNT(*) n FROM rooms WHERE kind = 'group'").get() as { n: number }).n).toBe(before)
  // otto cannot read the project: 404, no room
  expect((await otto.client.try('POST', `/api/projects/${launch.id}/channel`, { name: 'x', userIds: [mia.id] })).status).toBe(404)
})

test('create rolls back when the re-check inside the write fails, a guest claim included', async () => {
  const { mia, nora, launch } = await setup('b-rooms-project-link-create-rollback')
  const g = await addGuest(h, mia.client, { username: 'gwen', place: { kind: 'project', id: launch.id } })
  // a channel linked to the project appears between the first check and the write: simulated by linking one inside
  // createGroup's own transaction hook (the unique index refuses the second)
  const other = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id], name: 'First' })
  const { roomsOf } = await import('../../server/src/rooms/service')
  const rooms = roomsOf(h.ctx)
  const real = rooms.createGroup.bind(rooms)
  rooms.createGroup = ((userId: string, ids: readonly string[], name?: string | null, locale?: any, inTx?: (id: string) => void) => real(userId, ids, name, locale, (id) => {
    h.ctx.db.query('INSERT INTO room_project_links (room_id, project_id, linked_by, linked_at) VALUES (?, ?, ?, ?)').run(other.id, launch.id, mia.id, new Date().toISOString())
    inTx?.(id)
  })) as typeof rooms.createGroup
  const before = (h.ctx.db.query("SELECT COUNT(*) n FROM rooms WHERE kind = 'group'").get() as { n: number }).n
  const r = await mia.client.try('POST', `/api/projects/${launch.id}/channel`, { name: 'Second', userIds: [nora.id, g.id] })
  rooms.createGroup = real
  expect(r.status).toBe(409)
  expect(r.body.error?.params?.reason).toBe('project_has_channel')
  expect((h.ctx.db.query("SELECT COUNT(*) n FROM rooms WHERE kind = 'group'").get() as { n: number }).n).toBe(before)
  // the guest's one group chat was not taken (the claim rolled back with the room)
  expect(h.ctx.db.query('SELECT 1 FROM room_project_links WHERE room_id = ?').get(other.id)).toBeNull()
  const third = await mia.client.try('POST', '/api/rooms', { kind: 'group', userIds: [g.id], name: 'Guest room' })
  expect(third.status).toBe(201)
})

test('Room.project per viewer: read-only member, admin outside, member not in the project; Project.channel for a reader outside the channel', async () => {
  const { owner, ada, mia, nora, otto, launch, channel } = await setup('b-rooms-project-link-viewers')
  expect((await link(mia.client, channel.id, launch.id)).status).toBe(200)
  // nora read-only: the button, no save
  setAccess(launch.id, nora.id, 'read')
  expect((await roomOf(nora.client, channel.id)).project?.canSave).toBe(false)
  // otto: nothing
  expect((await roomOf(otto.client, channel.id)).project).toBeUndefined()
  // a project reader outside the channel (ada added to the project as a member): the channel's name and count, not in it
  setAccess(launch.id, ada.id, 'write')
  const pj = await ada.client.call('GET', `/api/projects/${launch.id}`)
  expect(pj.channel).toEqual({ roomId: channel.id, name: 'Launch talk', memberCount: 3, inIt: false })
  // the owner outside the project (manage=1): member false, no channel
  const om = await owner.call('GET', `/api/projects/${launch.id}?manage=1`)
  expect(om.member).toBe(false)
  expect(om.channel).toBeUndefined()
})

test('account removal: the link stays; who linked it is never shown', async () => {
  const { owner, mia, nora, launch } = await setup('b-rooms-project-link-account')
  // nora (a member of Launch) links her channel, then her account goes
  const ch = await nora.client.call('POST', '/api/rooms', { kind: 'group', userIds: [mia.id], name: 'Nora channel' })
  expect((await link(nora.client, ch.id, launch.id)).status).toBe(200)
  await owner.call('DELETE', `/api/admin/users/${nora.id}`)
  // the account is a tombstone (its row stays): the link stays, and who made it is never in any answer
  expect((await roomOf(mia.client, ch.id)).project?.id).toBe(launch.id)
  expect(JSON.stringify(await mia.client.call('GET', `/api/projects/${launch.id}`))).not.toContain(nora.id)
})
