// A project's room follows its project live (rooms/project-room.ts, project-link.ts; docs/decisions/
// 20261120-project-is-room.md): room.updated to the room's members, each built for them, on a project rename (the room's
// name too), the project to the trash (the room leaves their lists: held), restored (back), deleted for good (gone); and
// after an access change, to whoever's answer to save into the project folder changed, or who lost or gained the room
// (bounded: a folder elsewhere sends nothing).
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
  const channel = await mia.client.call('POST', `/api/projects/${launch.id}/room`)
  const hub = new FanoutHub()
  hub.users = [mia.id, nora.id, otto.id]
  h.ctx.services.realtime = hub
  /** the room.updated of this room since the last look: who got it and their room (null: removed) */
  const sent = (roomId = channel.id) => {
    const out = new Map<string, { name?: string; project?: { id: string; name: string; canSave: boolean } } | null>()
    for (const e of hub.events.splice(0)) {
      const ev = e.data as { type: string; data: { roomId: string; change?: string; room: any } }
      if (ev.type === 'room.updated' && ev.data.roomId === roomId && (ev.data.change === 'updated' || ev.data.change === 'removed' || ev.data.change === 'added')) out.set(e.target, ev.data.change === 'removed' ? null : ev.data.room)
    }
    return out
  }
  const folder = (h.ctx.db.query('SELECT folder_path FROM projects WHERE id = ?').get(launch.id) as { folder_path: string }).folder_path
  return { owner, mia, nora, otto, launch, other, channel, hub, sent, folder }
}

test('rename, trash (held: removed from lists), restore and delete for good each tell the room', async () => {
  const { owner, mia, nora, otto, launch, other, channel, sent } = await setup('b-rooms-project-link-live')
  const room2 = await mia.client.call('POST', `/api/projects/${other.id}/room`)
  sent(); sent(room2.id)
  // a rename: the new name, live, the room's own name too
  await mia.client.call('PATCH', `/api/projects/${launch.id}`, { name: 'Launch 2' })
  let got = sent()
  expect(got.get(nora.id)!.project?.name).toBe('Launch 2')
  expect(got.get(nora.id)!.name).toBe('Launch 2')
  expect(got.has(otto.id)).toBe(false)
  // to the trash: the room leaves the members' lists; the other project's room hears nothing
  sent(room2.id)
  expect((await mia.client.try('DELETE', `/api/projects/${launch.id}`)).status).toBe(204)
  got = sent()
  expect(got.has(nora.id)).toBe(true)
  expect(got.get(nora.id)).toBeNull()
  expect(sent(room2.id).size).toBe(0)
  // restored: back
  expect((await mia.client.try('POST', `/api/projects/${launch.id}/restore`)).status).toBe(200)
  got = sent()
  expect(got.get(nora.id)!.project?.id).toBe(launch.id)
  // delete for good (the other project: to the trash, then the owner deletes it): its room gone for its members
  expect((await mia.client.try('DELETE', `/api/projects/${other.id}`)).status).toBe(204)
  sent(room2.id)
  expect((await owner.try('DELETE', `/api/projects/${other.id}`)).status).toBe(204)
  const last = sent(room2.id)
  expect(last.has(mia.id)).toBe(true)
  expect(last.get(mia.id)).toBeNull()
})

test('access changes: write lost only, write back, read lost, a folder elsewhere: only whose answer changed', async () => {
  const { mia, nora, otto, launch, channel, sent, folder } = await setup('b-rooms-project-link-live-access')
  sent()
  const fid = (h.ctx.db.query('SELECT id FROM folders WHERE path = ?').get(folder) as { id: string }).id
  const change = (access: 'read' | 'write' | null) => {
    const before = captureState(h.ctx.db)
    h.ctx.db.query("DELETE FROM folder_rules WHERE folder_id = ? AND subject_type = 'user' AND subject_id = ?").run(fid, nora.id)
    if (access) h.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, 'user', ?, ?)").run(crypto.randomUUID(), fid, nora.id, access)
    afterAccessChange(h.ctx, before, { actor: mia.id, target: folder })
  }
  // write lost only: Save to project goes, the room stays; nobody else told
  change('read')
  let got = sent()
  expect([...got.keys()]).toEqual([nora.id])
  expect(got.get(nora.id)!.project).toMatchObject({ id: launch.id, canSave: false })
  // write back
  change('write')
  got = sent()
  expect([...got.keys()]).toEqual([nora.id])
  expect(got.get(nora.id)!.project?.canSave).toBe(true)
  // read lost (taken out of the project on its page): nora loses the room; otto (never in it) hears nothing
  const access = await mia.client.call('GET', `/api/projects/${launch.id}/access`)
  await mia.client.call('PUT', `/api/projects/${launch.id}/participants`, { participants: [], expectedHash: access.rulesHash })
  got = sent()
  expect(got.has(nora.id)).toBe(true)
  expect(got.get(nora.id)).toBeNull()
  expect(got.has(otto.id)).toBe(false)
  // a folder elsewhere: nothing for the room
  const before = captureState(h.ctx.db)
  h.ctx.db.query("INSERT INTO folders (id, path) VALUES (?, 'shared/plans')").run(crypto.randomUUID())
  afterAccessChange(h.ctx, before, { actor: mia.id, target: 'shared/plans' })
  expect(sent().size).toBe(0)
  void channel
})
