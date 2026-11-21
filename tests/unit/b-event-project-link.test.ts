// A room event line that names a project reads the project at render time, for each viewer, through one resolver
// (server/src/rooms/project-link.ts eventProjectsFor; plan docs/AGENTS/plan/20261121-1009-event-project-link.md):
// renamed: its name now, for who can open it; no access (never, or no longer): "a project", never the new name; in the
// trash: its name "(in the trash)" for its people only, no link; deleted for good: "a deleted project".
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { uuidv7 } from '@mycel/shared/api'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

setDefaultTimeout(120_000)
let h: Harness
afterEach(async () => { await h?.close() })

const user = (id: string) => ({ subjectType: 'user', subjectId: id })

async function setup(name: string) {
  h = await harness(name)
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const launch = await mia.client.call('POST', '/api/projects', { name: 'Launch site', participants: [user(nora.id)] })
  // a plain channel of the three (otto is not one of the project's people)
  const channel = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, otto.id], name: 'Launch talk' })
  const add = h.ctx.db.query(`INSERT INTO room_messages (id, room_id, seq, author_kind, author_id, visibility, body, mentions, created_at, event)
    VALUES (?, ?, (SELECT last_seq + 1 FROM rooms WHERE id = ?), 'user', ?, 'room', '', '[]', ?, ?)`)
  for (const type of ['project_linked', 'project_room']) {
    add.run(uuidv7(), channel.id, channel.id, type === 'project_room' ? null : mia.id, new Date().toISOString(), JSON.stringify({ type, projectId: launch.id }))
    h.ctx.db.query('UPDATE rooms SET last_seq = last_seq + 1 WHERE id = ?').run(channel.id)
  }
  const lines = async (c: Client) => ((await c.call('GET', `/api/rooms/${channel.id}/messages`)).items as any[]).filter((m) => m.event?.type?.startsWith('project_')).map((m) => m.event)
  return { owner, mia, nora, otto, launch, channel, lines }
}

test('renamed: its people see the name now with a link; an outsider and someone who left see "a project", never the new name', async () => {
  const { mia, nora, otto, launch, lines } = await setup('b-event-project-rename')
  expect((await mia.client.try('PATCH', `/api/projects/${launch.id}`, { name: 'Launch v2' })).status).toBe(200)
  // a rename keeps the folder: its name comes along for the lines that say where files went (#291, QA TC-6953)
  const now = { id: launch.id, name: 'Launch v2', folder: 'Launch site' }
  expect(await lines(mia.client)).toEqual([{ type: 'project_linked', project: now }, { type: 'project_room', project: now }])
  expect(await lines(nora.client)).toEqual([{ type: 'project_linked', project: now }, { type: 'project_room', project: now }])
  const none = [{ type: 'project_linked', project: null }, { type: 'project_room', project: null }]
  expect(await lines(otto.client)).toEqual(none)
  // nora leaves the project: from then on the line is "a project" for her too
  expect((await nora.client.try('POST', `/api/projects/${launch.id}/leave`)).status).toBe(200)
  expect(await lines(nora.client)).toEqual(none)
  const text = JSON.stringify([await lines(otto.client), await lines(nora.client)])
  for (const secret of ['Launch v2', 'Launch site', launch.id]) expect(text).not.toContain(secret)
})

test('in the trash: its people see its name with "in the trash" and no link; an outsider cannot tell it from "a project"', async () => {
  const { mia, nora, otto, launch, lines } = await setup('b-event-project-trash')
  expect((await mia.client.try('DELETE', `/api/projects/${launch.id}`)).status).toBe(204)
  expect((h.ctx.db.query('SELECT trashed_with FROM projects WHERE id = ?').get(launch.id) as { trashed_with: string | null }).trashed_with).not.toBeNull()
  const trash = { project: null, projectGone: { state: 'trash', name: 'Launch site' } }
  for (const c of [mia, nora]) expect(await lines(c.client)).toEqual([{ type: 'project_linked', ...trash }, { type: 'project_room', ...trash }])
  const out = await lines(otto.client)
  expect(out).toEqual([{ type: 'project_linked', project: null }, { type: 'project_room', project: null }])
  expect(JSON.stringify(out)).not.toContain('Launch')
  // restored: a link again
  expect((await mia.client.try('POST', `/api/projects/${launch.id}/restore`)).status).toBe(200)
  expect((await lines(nora.client))[0]).toEqual({ type: 'project_linked', project: { id: launch.id, name: 'Launch site' } })
})

test('deleted for good: "a deleted project" for everyone, with no name and no id', async () => {
  const { owner, mia, nora, otto, launch, lines } = await setup('b-event-project-deleted')
  expect((await mia.client.try('DELETE', `/api/projects/${launch.id}`)).status).toBe(204)
  // the second delete (for good) is the owner's or an admin's while it is in the trash
  expect((await owner.try('DELETE', `/api/projects/${launch.id}`)).status).toBe(204)
  expect(h.ctx.db.query('SELECT id FROM projects WHERE id = ?').get(launch.id)).toBeNull()
  const gone = { project: null, projectGone: { state: 'deleted' } }
  for (const c of [mia, nora, otto]) {
    const out = await lines(c.client)
    expect(out).toEqual([{ type: 'project_linked', ...gone }, { type: 'project_room', ...gone }])
    expect(JSON.stringify(out)).not.toContain('Launch')
  }
})
