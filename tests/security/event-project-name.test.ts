// A room's event line that names a project never tells a person more than the project's own page would (plan
// docs/AGENTS/plan/20261121-1009-event-project-link.md; server/src/rooms/project-link.ts eventProjectsFor). In a channel
// whose lines name a project: the admin outside the project, a plain member outside it and a member who left it get no
// name, no id and no trash state in the timeline, after a rename (the new name is a canary), while it is in the trash and after it is restored. Only its people get its name; deleted for good
// it is "a deleted project" for everyone, with nothing of it.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { uuidv7 } from '@mycel/shared/api'
import { addMember, harness, withOwner, type Client, type Harness } from '../unit/a-lib'

setDefaultTimeout(120_000)
let h: Harness
afterEach(async () => { await h?.close() })

const CANARY = 'SEC-EVPROJ-NEW-7f3a'
const OLD = 'SEC-EVPROJ-OLD-2c9e'

test('outsiders, an admin outside it and someone who left get no name, id or trash state; deleted: nothing of it for anyone', async () => {
  h = await harness('sec-event-project-name')
  const owner = await withOwner(h)
  const ada = await addMember(h, owner, { username: 'ada', role: 'admin' })
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const p = await mia.client.call('POST', '/api/projects', { name: OLD, participants: [{ subjectType: 'user', subjectId: nora.id }] })
  const room = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, otto.id, ada.id], name: 'Talk' })
  const add = h.ctx.db.query(`INSERT INTO room_messages (id, room_id, seq, author_kind, author_id, visibility, body, mentions, created_at, event)
    VALUES (?, ?, (SELECT last_seq + 1 FROM rooms WHERE id = ?), 'user', ?, 'room', '', '[]', ?, ?)`)
  for (const type of ['project_linked', 'project_unlinked', 'project_room']) {
    add.run(uuidv7(), room.id, room.id, mia.id, new Date().toISOString(), JSON.stringify({ type, projectId: p.id }))
    h.ctx.db.query('UPDATE rooms SET last_seq = last_seq + 1 WHERE id = ?').run(room.id)
  }
  const page = async (c: Client) => JSON.stringify(await c.call('GET', `/api/rooms/${room.id}/messages`))
  const events = async (c: Client) => ((await c.call('GET', `/api/rooms/${room.id}/messages`)).items as any[]).filter((m) => m.event?.type?.startsWith('project_')).map((m) => m.event)
  const nothingOf = async (c: Client, what: string) => {
    const text = await page(c)
    for (const s of [CANARY, OLD, p.id, 'trash']) expect(`${what}: ${text.includes(s)}`).toBe(`${what}: false`)
    expect((await events(c)).length).toBe(3)
    for (const e of await events(c)) expect(e.projectGone === undefined || e.projectGone.state === 'deleted').toBe(true)
  }

  expect((await mia.client.try('PATCH', `/api/projects/${p.id}`, { name: CANARY })).status).toBe(200)
  expect(await page(nora.client)).toContain(CANARY)
  // its people get the name now; the old name only as its folder's name (#291 EventProject.folder, QA TC-6953): a
  // rename keeps the folder, which they open in Files anyway. Outsiders get neither (nothingOf checks OLD too)
  for (const e of await events(nora.client)) expect(e.project).toEqual({ id: p.id, name: CANARY, folder: OLD })
  await nothingOf(otto.client, 'outsider after rename')
  await nothingOf(ada.client, 'admin outside it after rename')

  // in the trash: its people only, by name, no id (no link)
  expect((await mia.client.try('DELETE', `/api/projects/${p.id}`)).status).toBe(204)
  for (const e of await events(nora.client)) expect(e).toMatchObject({ project: null, projectGone: { state: 'trash', name: CANARY } })
  expect(await page(nora.client)).not.toContain(p.id)
  await nothingOf(otto.client, 'outsider while trashed')
  await nothingOf(ada.client, 'admin outside it while trashed')

  // restored, then nora leaves: nothing for her any more
  expect((await mia.client.try('POST', `/api/projects/${p.id}/restore`)).status).toBe(200)
  expect((await nora.client.try('POST', `/api/projects/${p.id}/leave`)).status).toBe(200)
  await nothingOf(nora.client, 'a member who left')

  // deleted for good: the same line for everyone, with nothing of the project
  expect((await mia.client.try('DELETE', `/api/projects/${p.id}`)).status).toBe(204)
  expect((await owner.try('DELETE', `/api/projects/${p.id}`)).status).toBe(204)
  for (const c of [mia.client, nora.client, otto.client, ada.client]) {
    await nothingOf(c, 'deleted')
    for (const e of await events(c)) expect(e).toEqual({ type: e.type, project: null, projectGone: { state: 'deleted' } })
  }
})
