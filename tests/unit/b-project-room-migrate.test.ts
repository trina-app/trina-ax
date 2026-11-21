// The 0.5.21 linked channels at the upgrade (rooms/project-room.ts settleLinkedInTx; docs/decisions/
// 20261120-project-is-room.md D7): one pass at start, after the gone accounts left. The same people as the project's
// readers: the channel becomes the project's room (each member keeps their start, later members see from the floor, one
// event line, the project's name); anything else (other people, an archived room, a trashed project): the link goes and
// the channel stays as it was. A row an older build writes after a rollback is settled on the next start; a project
// room's row is never touched; the audit names the project and the room by its kind only; a guest of the project who is
// in a converted channel keeps their place.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { afterAccessChange, captureState } from '../../server/src/admin/folders'
import { roomsOf } from '../../server/src/rooms/service'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'
import { addGuest } from './guest-lib'

setDefaultTimeout(120_000)
let h: Harness
afterEach(async () => { await h?.close() })

const user = (id: string) => ({ subjectType: 'user', subjectId: id })
const cm = () => 'cm-' + crypto.randomUUID()

async function setup(name: string) {
  h = await harness(name)
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const launch = await mia.client.call('POST', '/api/projects', { name: 'Launch site', participants: [user(nora.id)] })
  return { owner, mia, nora, otto, launch }
}
/** a 0.5.21 link, as that build wrote it (the column defaults: mode 'linked') */
const linkRow = (roomId: string, projectId: string, by: string) =>
  h.ctx.db.query('INSERT INTO room_project_links (room_id, project_id, linked_by, linked_at) VALUES (?, ?, ?, ?)').run(roomId, projectId, by, new Date().toISOString())
const link = (roomId: string) => h.ctx.db.query('SELECT mode, history_floor_seq FROM room_project_links WHERE room_id = ?').get(roomId) as { mode: string; history_floor_seq: number } | null
const start = () => roomsOf(h.ctx).sync({ projects: 'all' })
const audits = () => (h.ctx.db.query("SELECT actor_id, target, detail FROM audit_log WHERE action = 'project.room' ORDER BY id").all() as { actor_id: string | null; target: string; detail: string }[])
const say = (c: Client, roomId: string, body: string) => c.call('POST', `/api/rooms/${roomId}/messages`, { body, clientMessageId: cm() })
const bodies = async (c: Client, roomId: string) => ((await c.call('GET', `/api/rooms/${roomId}/messages`)).items as any[]).filter((m) => !m.event).map((m) => m.body)

test('the same people: converted; each member keeps their start; later members see from the floor; one line; the audit names no room', async () => {
  const { owner, mia, nora, otto, launch } = await setup('b-project-room-migrate-same')
  // the channel of mia and nora; nora invited after the first message (she sees from then on)
  const ch = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [otto.id], name: 'Launch talk' })
  await say(mia.client, ch.id, 'private past')
  await mia.client.call('POST', `/api/rooms/${ch.id}/members`, { userIds: [nora.id] })
  await mia.client.call('DELETE', `/api/rooms/${ch.id}/members/${otto.id}`)
  await say(mia.client, ch.id, 'with nora')
  // a disabled account still in the channel leaves first and does not spoil the comparison
  const dan = await addMember(h, owner, { username: 'dan' })
  await mia.client.call('POST', `/api/rooms/${ch.id}/members`, { userIds: [dan.id] })
  h.ctx.db.query("UPDATE users SET status = 'disabled' WHERE id = ?").run(dan.id)
  linkRow(ch.id, launch.id, mia.id)
  const seqBefore = (h.ctx.db.query('SELECT last_seq FROM rooms WHERE id = ?').get(ch.id) as { last_seq: number }).last_seq
  start()
  const l = link(ch.id)!
  expect(l.mode).toBe('room')
  // the floor: the room's seq before the line (dan's leave line came first)
  const lineSeq = (h.ctx.db.query("SELECT seq FROM room_messages WHERE room_id = ? AND event LIKE '%project_room%'").get(ch.id) as { seq: number }).seq
  expect(l.history_floor_seq).toBe(lineSeq - 1)
  expect(l.history_floor_seq).toBeGreaterThanOrEqual(seqBefore)
  // named after the project; nora still does not see what was said before she joined
  const room = await nora.client.call('GET', `/api/rooms/${ch.id}`)
  expect(room.name).toBe('Launch site')
  expect(room.project?.room).toBe(true)
  expect(await bodies(nora.client, ch.id)).toEqual(['with nora'])
  expect(await bodies(mia.client, ch.id)).toEqual(['private past', 'with nora'])
  // the line, by the system, naming the project to who can open it
  const ev = ((await nora.client.call('GET', `/api/rooms/${ch.id}/messages`)).items as any[]).find((m) => m.event?.type === 'project_room')
  expect(ev.event).toEqual({ type: 'project_room', project: { id: launch.id, name: 'Launch site' } })
  expect(ev.author).toBeNull()
  // audited by the project, the room by its kind only
  const a = audits()
  expect(a.length).toBe(1)
  expect([a[0]!.actor_id, a[0]!.target, JSON.parse(a[0]!.detail)]).toEqual([null, launch.id, { room: { kind: 'group' }, via: 'converted' }])
  expect(JSON.stringify(a)).not.toContain(ch.id)
  // otto joins the project later: he sees from the floor on, never the old channel's private past
  const acc = await mia.client.call('GET', `/api/projects/${launch.id}/access`)
  await mia.client.call('PUT', `/api/projects/${launch.id}/participants`, { participants: [user(nora.id), user(otto.id)], expectedHash: acc.rulesHash })
  expect(await bodies(otto.client, ch.id)).toEqual([])
  await say(mia.client, ch.id, 'after')
  expect(await bodies(otto.client, ch.id)).toEqual(['after'])
  // the project's room is this one
  expect((await nora.client.call('POST', `/api/projects/${launch.id}/room`)).id).toBe(ch.id)
  // a second start changes nothing
  start()
  expect(audits().length).toBe(1)
})

test('other people, an archived room, a trashed project: the link goes, the channel stays; the project gets a room of its own', async () => {
  const { owner, mia, nora, otto, launch } = await setup('b-project-room-migrate-unlink')
  const other = await mia.client.call('POST', '/api/projects', { name: 'Other', participants: [user(nora.id)] })
  const third = await mia.client.call('POST', '/api/projects', { name: 'Third', participants: [user(nora.id)] })
  // otto is in the channel but not in Launch
  const ch = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, otto.id], name: 'Launch talk' })
  linkRow(ch.id, launch.id, mia.id)
  // an archived channel (everyone left) linked to Other
  const gone = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id], name: 'Gone' })
  linkRow(gone.id, other.id, mia.id)
  h.ctx.db.query('UPDATE rooms SET archived_at = ? WHERE id = ?').run(new Date().toISOString(), gone.id)
  // Third in the trash, its channel with the same people
  const tch = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id], name: 'Third talk' })
  linkRow(tch.id, third.id, mia.id)
  expect((await mia.client.try('DELETE', `/api/projects/${third.id}`)).status).toBe(204)
  const before = h.ctx.db.query('SELECT id, name, last_seq FROM rooms WHERE id IN (?, ?) ORDER BY id').all(ch.id, tch.id)
  start()
  for (const id of [ch.id, gone.id, tch.id]) expect(link(id)).toBeNull()
  // the channels as they were: same name, people, nothing written in them
  expect(h.ctx.db.query('SELECT id, name, last_seq FROM rooms WHERE id IN (?, ?) ORDER BY id').all(ch.id, tch.id)).toEqual(before)
  expect((h.ctx.db.query('SELECT COUNT(*) n FROM room_members WHERE room_id = ?').get(ch.id) as { n: number }).n).toBe(3)
  expect((await otto.client.call('GET', `/api/rooms/${ch.id}`)).project).toBeUndefined()
  expect(audits().map((a) => JSON.parse(a.detail).via)).toEqual(['unlinked', 'unlinked', 'unlinked'])
  for (const a of audits()) expect(JSON.stringify(a)).not.toMatch(new RegExp(`${ch.id}|${gone.id}|${tch.id}`))
  // Launch's Chat room makes a new room, its people only
  const r = await mia.client.call('POST', `/api/projects/${launch.id}/room`)
  expect(r.id).not.toBe(ch.id)
  expect(r.memberCount).toBe(2)
  void owner
})

test('a row an older build wrote after a rollback is settled on the next start; a project room\'s row is never touched', async () => {
  const { mia, nora, launch } = await setup('b-project-room-migrate-rollback')
  const room = await mia.client.call('POST', `/api/projects/${launch.id}/room`)
  const other = await mia.client.call('POST', '/api/projects', { name: 'Other', participants: [user(nora.id)] })
  // an older build links a channel of the same people to Other
  const ch = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id], name: 'Other talk' })
  linkRow(ch.id, other.id, mia.id)
  // opening Other's room settles that row first: it is the same people, so the channel is Other's room
  expect((await nora.client.call('POST', `/api/projects/${other.id}/room`)).id).toBe(ch.id)
  expect(link(ch.id)?.mode).toBe('room')
  // Launch's room: unchanged by any start
  const was = link(room.id)
  start(); start()
  expect(link(room.id)).toEqual(was)
  expect(audits().filter((a) => a.target === launch.id).map((a) => JSON.parse(a.detail).via)).toEqual(['created'])
})

test('a guest of the project in a converted channel: still in their place, and may still be put into a group chat', async () => {
  const { mia, nora, launch } = await setup('b-project-room-migrate-guest')
  const g = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'project', id: launch.id } })
  // the guest's group chat is the linked channel (claimed when they were put in it)
  const ch = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, g.id], name: 'With the client' })
  linkRow(ch.id, launch.id, mia.id)
  start()
  expect(link(ch.id)?.mode).toBe('room')
  // they read the project by a person rule: in the room and in their place
  expect((await g.client.call('GET', `/api/rooms/${ch.id}`)).project?.room).toBe(true)
  expect((await g.client.call('GET', `/api/projects/${launch.id}`)).room?.id).toBe(ch.id)
  // the project room is not a group chat of theirs: a member may put them into one
  const chat = await mia.client.try('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, g.id], name: 'A real group chat' })
  expect(chat.status).toBe(201)
  // they keep both, and an access change does not switch them off
  const before = captureState(h.ctx.db)
  afterAccessChange(h.ctx, before, { actor: mia.id, target: 'shared' })
  expect((await g.client.try('GET', `/api/rooms/${ch.id}`)).status).toBe(200)
  expect((await g.client.try('GET', `/api/rooms/${chat.body.id}`)).status).toBe(200)
})

test('settleLinkedInTx with `made` (make-project): the line is the person\'s project_made and the audit via made; without it the start pass is unchanged', async () => {
  const { mia, nora, launch } = await setup('b-project-room-migrate-made')
  const a = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id], name: 'Made here' })
  const b = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id], name: 'At start' })
  const other = await mia.client.call('POST', '/api/projects', { name: 'Second', participants: [user(nora.id)] })
  linkRow(a.id, launch.id, mia.id)
  const db = h.ctx.db
  const { settleLinkedInTx, activePeople } = await import('../../server/src/rooms/project-room')
  const { RuleSet } = await import('../../server/src/policy/access')
  const made = db.transaction(() => settleLinkedInTx(db, a.id, RuleSet.load(db), activePeople(db), { actor: mia.id, via: 'made' }))()
  expect(made?.state).toBe('converted')
  const line = db.query('SELECT author_id, event FROM room_messages WHERE id = ?').get((made as { line: string }).line) as { author_id: string; event: string }
  expect(line.author_id).toBe(mia.id)
  expect(JSON.parse(line.event)).toEqual({ type: 'project_made', projectId: launch.id, by: mia.id })
  expect(audits().at(-1)).toMatchObject({ actor_id: mia.id, target: launch.id })
  expect(JSON.parse(audits().at(-1)!.detail)).toEqual({ room: { kind: 'group' }, via: 'made' })
  // the start pass: by the system, project_room, via converted
  linkRow(b.id, other.id, mia.id)
  start()
  const startLine = db.query("SELECT author_id, event FROM room_messages WHERE room_id = ? AND event IS NOT NULL ORDER BY seq DESC LIMIT 1").get(b.id) as { author_id: string | null; event: string }
  expect(startLine.author_id).toBeNull()
  expect(JSON.parse(startLine.event)).toEqual({ type: 'project_room', projectId: other.id })
  expect(JSON.parse(audits().at(-1)!.detail)).toEqual({ room: { kind: 'group' }, via: 'converted' })
  expect(audits().at(-1)!.actor_id).toBeNull()
})
