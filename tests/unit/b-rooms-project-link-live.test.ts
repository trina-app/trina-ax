// A linked channel follows its project live (rooms/project-link.ts; docs/decisions/20261119-channel-project-link.md D4
// "Live", D5): room.updated to the channel's members, each built for them, on link, unlink, a project rename, the project
// to the trash (only the channels of the projects it marked), restored, deleted for good; and after an access change, to
// whoever's answer to open the project folder or to save into it changed (bounded: a folder elsewhere sends nothing).
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { afterAccessChange, captureState } from '../../server/src/admin/folders'
import { addMember, harness, RecordingHub, withOwner, type Harness } from './a-lib'

setDefaultTimeout(120_000)
let h: Harness
afterEach(async () => { await h?.close() })

class FanoutHub extends RecordingHub {
  users: string[] = []
  override publishEach(build: (userId: string) => unknown) {
    for (const u of this.users) { const ev = build(u); if (ev) this.events.push({ kind: 'publish', target: u, data: ev }) }
  }
}
const user = (id: string) => ({ subjectType: 'user', subjectId: id })

async function setup(name: string) {
  h = await harness(name)
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const launch = await mia.client.call('POST', '/api/projects', { name: 'Launch site', participants: [user(nora.id)] })
  const other = await mia.client.call('POST', '/api/projects', { name: 'Other', participants: [] })
  const channel = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, otto.id], name: 'Launch talk' })
  const hub = new FanoutHub()
  hub.users = [mia.id, nora.id, otto.id]
  h.ctx.services.realtime = hub
  /** the room.updated 'updated' of this channel since the last look: who got it and their Room.project */
  const sent = (roomId = channel.id) => {
    const out = new Map<string, { project?: { id: string; name: string; canSave: boolean } }>()
    for (const e of hub.events.splice(0)) {
      const ev = e.data as { type: string; data: { roomId: string; change?: string; room: any } }
      if (ev.type === 'room.updated' && ev.data.roomId === roomId && ev.data.change === 'updated' && ev.data.room) out.set(e.target, ev.data.room)
    }
    return out
  }
  const folder = (h.ctx.db.query('SELECT folder_path FROM projects WHERE id = ?').get(launch.id) as { folder_path: string }).folder_path
  return { owner, mia, nora, otto, launch, other, channel, hub, sent, folder }
}

test('link, unlink, rename, trash (only its channels), restore and delete for good each tell the channel', async () => {
  const { owner, mia, nora, otto, launch, other, channel, sent } = await setup('b-rooms-project-link-live')
  const ch2 = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id], name: 'Other talk' })
  await mia.client.call('PUT', `/api/rooms/${ch2.id}/project`, { projectId: other.id })
  sent(); sent(ch2.id)
  await mia.client.call('PUT', `/api/rooms/${channel.id}/project`, { projectId: launch.id })
  let got = sent()
  expect(got.get(nora.id)!.project?.id).toBe(launch.id)
  expect(got.get(otto.id)!.project).toBeUndefined()
  // a rename: the new name, live
  await mia.client.call('PATCH', `/api/projects/${launch.id}`, { name: 'Launch 2' })
  got = sent()
  expect(got.get(nora.id)!.project?.name).toBe('Launch 2')
  // to the trash: the button goes; the other project's channel hears nothing
  sent(ch2.id)
  expect((await mia.client.try('DELETE', `/api/projects/${launch.id}`)).status).toBe(204)
  got = sent()
  expect(got.has(nora.id)).toBe(true)
  expect(got.get(nora.id)!.project).toBeUndefined()
  expect(sent(ch2.id).size).toBe(0)
  // restored: back
  expect((await mia.client.try('POST', `/api/projects/${launch.id}/restore`)).status).toBe(200)
  got = sent()
  expect(got.get(nora.id)!.project?.id).toBe(launch.id)
  // unlink: gone
  expect((await nora.client.try('DELETE', `/api/rooms/${channel.id}/project`)).status).toBe(204)
  expect(sent().get(mia.id)!.project).toBeUndefined()
  // delete for good (the other project: to the trash, then the owner deletes it): its channel told, stays a channel
  expect((await mia.client.try('DELETE', `/api/projects/${other.id}`)).status).toBe(204)
  sent(ch2.id)
  expect((await owner.try('DELETE', `/api/projects/${other.id}`)).status).toBe(204)
  const last = sent(ch2.id)
  expect(last.has(nora.id)).toBe(true)
  expect(last.get(nora.id)!.project).toBeUndefined()
})

test('access changes: read lost, write lost only, write back, a folder elsewhere: only whose answer changed', async () => {
  const { mia, nora, otto, launch, channel, sent, folder } = await setup('b-rooms-project-link-live-access')
  await mia.client.call('PUT', `/api/rooms/${channel.id}/project`, { projectId: launch.id })
  sent()
  const fid = (h.ctx.db.query('SELECT id FROM folders WHERE path = ?').get(folder) as { id: string }).id
  const change = (access: 'read' | 'write' | null) => {
    const before = captureState(h.ctx.db)
    h.ctx.db.query("DELETE FROM folder_rules WHERE folder_id = ? AND subject_type = 'user' AND subject_id = ?").run(fid, nora.id)
    if (access) h.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, 'user', ?, ?)").run(crypto.randomUUID(), fid, nora.id, access)
    afterAccessChange(h.ctx, before, { actor: mia.id, target: folder })
  }
  // write lost only: Save to project goes, the button stays; nobody else told
  change('read')
  let got = sent()
  expect([...got.keys()]).toEqual([nora.id])
  expect(got.get(nora.id)!.project).toMatchObject({ id: launch.id, canSave: false })
  // write back
  change('write')
  got = sent()
  expect([...got.keys()]).toEqual([nora.id])
  expect(got.get(nora.id)!.project?.canSave).toBe(true)
  // read lost (taken out of the project on its page): the button goes
  const access = await mia.client.call('GET', `/api/projects/${launch.id}/access`)
  await mia.client.call('PUT', `/api/projects/${launch.id}/participants`, { participants: [], expectedHash: access.rulesHash })
  got = sent()
  expect(got.has(nora.id)).toBe(true)
  expect(got.get(nora.id)!.project).toBeUndefined()
  expect(got.has(otto.id)).toBe(false)
  // a folder elsewhere: nothing for the channel
  const before = captureState(h.ctx.db)
  h.ctx.db.query("INSERT INTO folders (id, path) VALUES (?, 'shared/plans')").run(crypto.randomUUID())
  afterAccessChange(h.ctx, before, { actor: mia.id, target: 'shared/plans' })
  expect(sent().size).toBe(0)
})
