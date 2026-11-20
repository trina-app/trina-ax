// A team project is its own chat room (rooms/project-room.ts; docs/decisions/20261120-project-is-room.md): made the first
// time someone opens it (get-or-create, also under a race), its members are exactly the project's readers (added,
// removed, a group, an everyone rule, read-only, leave, a disabled account; guests of the project; never an admin
// outside it; no 100 cap), named after the project, a later member sees its history, the people are managed on the
// project only, trash holds it and restore brings it back, delete for good archives it first, only changed projects are
// recomputed, a read-only member cannot attach.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { afterAccessChange, captureState } from '../../server/src/admin/folders'
import { roomsOf } from '../../server/src/rooms/service'
import { addMember, harness, RecordingHub, withOwner, type Client, type Harness } from './a-lib'
import { addGuest } from './guest-lib'

setDefaultTimeout(120_000)
let h: Harness
afterEach(async () => { await h?.close() })

const user = (id: string) => ({ subjectType: 'user', subjectId: id })
const cm = () => 'cm-' + crypto.randomUUID()

async function setup(name: string, over: Record<string, unknown> = {}) {
  h = await harness(name, over)
  const owner = await withOwner(h)
  const ada = await addMember(h, owner, { username: 'ada', role: 'admin' })
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  // Launch: mia (creator) and nora; otto, ada (an admin) and the owner are not in it
  const launch = await mia.client.call('POST', '/api/projects', { name: 'Launch site', participants: [user(nora.id)] })
  return { owner, ada, mia, nora, otto, launch }
}
const open = (c: Client, projectId: string) => c.try('POST', `/api/projects/${projectId}/room`)
const membersOf = (roomId: string) => (h.ctx.db.query('SELECT user_id FROM room_members WHERE room_id = ? ORDER BY user_id').all(roomId) as { user_id: string }[]).map((r) => r.user_id)
const sorted = (...ids: string[]) => [...ids].sort()
const folderOf = (projectId: string) => (h.ctx.db.query('SELECT folder_path FROM projects WHERE id = ?').get(projectId) as { folder_path: string }).folder_path
const folderRow = (p: string) => (h.ctx.db.query('SELECT id FROM folders WHERE path = ?').get(p) as { id: string }).id
/** a rule on the project's folder set straight in the table, then the access change hooks as a save runs them */
function setRule(projectId: string, subject: { type: 'user' | 'group' | 'everyone'; id: string | null }, access: 'read' | 'write' | 'none' | null) {
  const folder = folderOf(projectId)
  const f = folderRow(folder)
  const before = captureState(h.ctx.db)
  h.ctx.db.query('DELETE FROM folder_rules WHERE folder_id = ? AND subject_type = ? AND subject_id IS ?').run(f, subject.type, subject.id)
  if (access) h.ctx.db.query('INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, ?, ?, ?)').run(crypto.randomUUID(), f, subject.type, subject.id, access)
  afterAccessChange(h.ctx, before, { actor: null as unknown as string, target: folder })
}
const missingId = () => crypto.randomUUID().replace(/^(.{14})./, '$17')
const bare = (b: any) => ({ ...b, error: { ...b.error, requestId: undefined } })

test('open: made once with the project\'s readers, named after it; again (two calls in one process) the same room; who may open it', async () => {
  const { owner, ada, mia, nora, otto, launch } = await setup('b-project-room-open')
  // two calls together (one process: the immediate write runs them one after the other): one room
  const [a, b] = await Promise.all([open(mia.client, launch.id), open(nora.client, launch.id)])
  expect([a.status, b.status]).toEqual([200, 200])
  expect(a.body.id).toBe(b.body.id)
  const roomId = a.body.id as string
  expect((h.ctx.db.query("SELECT COUNT(*) n FROM room_project_links WHERE project_id = ? AND mode = 'room'").get(launch.id) as { n: number }).n).toBe(1)
  expect(a.body.kind).toBe('group')
  expect(a.body.name).toBe('Launch site')
  expect(a.body.project).toMatchObject({ id: launch.id, name: 'Launch site', canSave: true, room: true })
  expect(a.body.canRename).toBe(false)
  expect(a.body.managerId).toBeNull()
  expect(a.body.canLinkProject).toBeUndefined()
  // a room people are put in: alerts for mentions by default, like a channel
  expect(a.body.notify?.byDefault).toBe('mentions')
  expect(membersOf(roomId)).toEqual(sorted(mia.id, nora.id))
  // the project page: its room and my unread count
  const pj = await nora.client.call('GET', `/api/projects/${launch.id}`)
  expect(pj.room).toEqual({ id: roomId, unread: 0 })
  expect(pj.channel).toBeUndefined()
  expect(pj.canLinkChannel).toBeUndefined()
  await mia.client.call('POST', `/api/rooms/${roomId}/messages`, { body: 'hello', clientMessageId: cm() })
  expect((await nora.client.call('GET', `/api/projects/${launch.id}`)).room).toEqual({ id: roomId, unread: 1 })
  // again: the same room, nothing new made
  expect((await open(mia.client, launch.id)).body.id).toBe(roomId)
  const made = h.ctx.db.query("SELECT actor_id, target, detail FROM audit_log WHERE action = 'project.room'").all() as { actor_id: string; target: string; detail: string }[]
  expect(made.length).toBe(1)
  expect([made[0]!.target, JSON.parse(made[0]!.detail)]).toEqual([launch.id, { room: { kind: 'group' }, via: 'created' }])
  expect(JSON.stringify(made)).not.toContain(roomId)
  // otto (not in it), the admin and the owner outside it: the missing project's 404, never its name; not members
  const missing = await mia.client.try('POST', `/api/projects/${missingId()}/room`)
  for (const c of [otto.client, ada.client, owner]) {
    const r = await open(c, launch.id)
    expect(r.status).toBe(404)
    expect(bare(r.body)).toEqual(bare(missing.body))
    expect(JSON.stringify(r.body)).not.toContain('Launch')
    expect((await c.try('GET', `/api/rooms/${roomId}`)).status).toBe(404)
  }
  // a personal project has none
  const personal = await mia.client.call('POST', '/api/projects', { name: 'Mine', scope: 'personal', participants: [] })
  const pr = await open(mia.client, personal.id)
  expect(pr.status).toBe(409)
  expect(pr.body.error?.params?.reason).toBe('project_not_linkable')
  expect((await mia.client.call('GET', `/api/projects/${personal.id}`)).room).toBeUndefined()
})

test('members follow the project: added (sees the history), removed (notices and replay go), read-only, a group, everyone, leave, disabled; never an admin outside', async () => {
  const { owner, ada, mia, nora, otto, launch } = await setup('b-project-room-members')
  const roomId = (await open(mia.client, launch.id)).body.id as string
  await mia.client.call('POST', `/api/rooms/${roomId}/messages`, { body: 'before otto', clientMessageId: cm(), mentions: [nora.id] })
  expect((h.ctx.db.query('SELECT COUNT(*) n FROM room_notices WHERE room_id = ? AND user_id = ?').get(roomId, nora.id) as { n: number }).n).toBeGreaterThan(0)
  // otto added on the project page: in the room, and he sees what was said before him
  const acc = await mia.client.call('GET', `/api/projects/${launch.id}/access`)
  await mia.client.call('PUT', `/api/projects/${launch.id}/participants`, { participants: [user(nora.id), user(otto.id)], expectedHash: acc.rulesHash })
  expect(membersOf(roomId)).toEqual(sorted(mia.id, nora.id, otto.id))
  const page = await otto.client.call('GET', `/api/rooms/${roomId}/messages`)
  expect((page.items as any[]).some((m) => m.body === 'before otto')).toBe(true)
  // nora taken out: out of the room, her notices and replay buffer go, her windows lose it
  const hub = new RecordingHub()
  h.ctx.services.realtime = hub
  const acc2 = await mia.client.call('GET', `/api/projects/${launch.id}/access`)
  await mia.client.call('PUT', `/api/projects/${launch.id}/participants`, { participants: [user(otto.id)], expectedHash: acc2.rulesHash })
  expect(membersOf(roomId)).toEqual(sorted(mia.id, otto.id))
  expect((h.ctx.db.query('SELECT COUNT(*) n FROM room_notices WHERE room_id = ? AND user_id = ?').get(roomId, nora.id) as { n: number }).n).toBe(0)
  expect(hub.forgotten).toContain(nora.id)
  expect(hub.events.some((e) => e.target === nora.id && (e.data as any).type === 'room.updated' && (e.data as any).data.roomId === roomId && (e.data as any).data.change === 'removed')).toBe(true)
  expect((await nora.client.try('GET', `/api/rooms/${roomId}`)).status).toBe(404)
  // read-only: a member, who can post text
  setRule(launch.id, { type: 'user', id: nora.id }, 'read')
  expect(membersOf(roomId)).toContain(nora.id)
  expect((await nora.client.try('POST', `/api/rooms/${roomId}/messages`, { body: 'read-only can talk', clientMessageId: cm() })).status).toBe(201)
  setRule(launch.id, { type: 'user', id: nora.id }, null)
  // a group: its people, and whoever joins the group later
  const g = await owner.call('POST', '/api/admin/groups', { name: 'design', memberIds: [nora.id] })
  setRule(launch.id, { type: 'group', id: g.id }, 'write')
  expect(membersOf(roomId)).toContain(nora.id)
  const pia = await addMember(h, owner, { username: 'pia' })
  await owner.call('PATCH', `/api/admin/users/${pia.id}`, { groupIds: [g.id] })
  expect(membersOf(roomId)).toContain(pia.id)
  // the admin outside is still not in it (a project is members-only for admins too)
  expect(membersOf(roomId)).not.toContain(ada.id)
  // leave the project: out of the room
  expect((await otto.client.try('POST', `/api/projects/${launch.id}/leave`)).status).toBe(200)
  expect(membersOf(roomId)).not.toContain(otto.id)
  // a disabled account: out
  await owner.call('PATCH', `/api/admin/users/${pia.id}`, { status: 'disabled' })
  expect(membersOf(roomId)).not.toContain(pia.id)
  // the members audited by the project (the room by its kind only)
  const rows = h.ctx.db.query("SELECT target, detail FROM audit_log WHERE action = 'room.members' AND target = ?").all(launch.id) as { target: string; detail: string }[]
  expect(rows.length).toBeGreaterThan(0)
  for (const r of rows) { expect(JSON.parse(r.detail)).toMatchObject({ room: { kind: 'group' }, via: 'project' }); expect(r.detail).not.toContain(roomId) }
})

test('an everyone rule makes a big room: no group cap; a hand-made change is put back; only changed projects are recomputed', async () => {
  const { mia, nora, otto, launch } = await setup('b-project-room-big')
  const roomId = (await open(mia.client, launch.id)).body.id as string
  const add = h.ctx.db.query("INSERT INTO users (id, username, name, role) VALUES (?, ?, ?, 'member')")
  const many: string[] = []
  for (let i = 0; i < 105; i++) { const id = `p${i}`; add.run(id, id, `Person ${i}`); many.push(id) }
  setRule(launch.id, { type: 'everyone', id: null }, 'read')
  expect(membersOf(roomId).length).toBeGreaterThan(105)
  expect(membersOf(roomId)).toContain(otto.id)
  setRule(launch.id, { type: 'everyone', id: null }, null)
  expect(membersOf(roomId)).toEqual(sorted(mia.id, nora.id))
  // a second project's room; a member added by hand (an older build) to it
  const other = await mia.client.call('POST', '/api/projects', { name: 'Other', participants: [] })
  const otherRoom = (await open(mia.client, other.id)).body.id as string
  h.ctx.db.query('INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)').run(otherRoom, otto.id, new Date().toISOString())
  // an access change on Launch only: Other's room is not looked at
  setRule(launch.id, { type: 'user', id: otto.id }, 'read')
  expect(membersOf(otherRoom)).toContain(otto.id)
  // the full pass (start, the minute tick) puts it back
  roomsOf(h.ctx).sync({ projects: 'all' })
  expect(membersOf(otherRoom)).toEqual([mia.id])
})

test('inside a project room: Add people, Remove, Rename and Leave are refused (project_room); leave the project instead', async () => {
  const { mia, nora, otto, launch } = await setup('b-project-room-refuse')
  const roomId = (await open(mia.client, launch.id)).body.id as string
  for (const [m, p, body] of [
    ['POST', `/api/rooms/${roomId}/members`, { userIds: [otto.id] }],
    ['DELETE', `/api/rooms/${roomId}/members/${nora.id}`, undefined],
    ['PATCH', `/api/rooms/${roomId}`, { name: 'Renamed' }],
    ['POST', `/api/rooms/${roomId}/leave`, undefined],
  ] as const) {
    const r = await mia.client.try(m, p, body)
    expect(`${m} ${p} ${r.status} ${r.body?.error?.params?.reason}`).toBe(`${m} ${p} 403 project_room`)
  }
  expect(membersOf(roomId)).toEqual(sorted(mia.id, nora.id))
  // a member's own alert level still changes
  expect((await nora.client.try('PATCH', `/api/rooms/${roomId}`, { notifyLevel: 'all' })).status).toBe(200)
})

test('the name follows a project rename', async () => {
  const { mia, nora, launch } = await setup('b-project-room-rename')
  const roomId = (await open(mia.client, launch.id)).body.id as string
  await mia.client.call('PATCH', `/api/projects/${launch.id}`, { name: 'Launch 2' })
  expect((await nora.client.call('GET', `/api/rooms/${roomId}`)).name).toBe('Launch 2')
  expect((h.ctx.db.query('SELECT name FROM rooms WHERE id = ?').get(roomId) as { name: string }).name).toBe('Launch 2')
})

test('trash holds the room (members, mutes, read positions kept; hidden and refused); restore brings it back with the people put right', async () => {
  const { mia, nora, otto, launch } = await setup('b-project-room-trash')
  const roomId = (await open(mia.client, launch.id)).body.id as string
  await mia.client.call('POST', `/api/rooms/${roomId}/messages`, { body: 'hi', clientMessageId: cm() })
  await nora.client.call('PATCH', `/api/rooms/${roomId}`, { notifyLevel: 'off' })
  await nora.client.call('POST', `/api/rooms/${roomId}/read`, { seq: 1 })
  const before = h.ctx.db.query('SELECT user_id, muted, notify_level, last_read_seq FROM room_members WHERE room_id = ? ORDER BY user_id').all(roomId)
  expect((await mia.client.try('DELETE', `/api/projects/${launch.id}`)).status).toBe(204)
  // held: the rows stay, the room is hidden and refused
  expect(h.ctx.db.query('SELECT user_id, muted, notify_level, last_read_seq FROM room_members WHERE room_id = ? ORDER BY user_id').all(roomId)).toEqual(before)
  roomsOf(h.ctx).sync({ projects: 'all' })
  expect(h.ctx.db.query('SELECT user_id, muted, notify_level, last_read_seq FROM room_members WHERE room_id = ? ORDER BY user_id').all(roomId)).toEqual(before)
  expect((await nora.client.try('GET', `/api/rooms/${roomId}`)).status).toBe(404)
  expect(((await nora.client.call('GET', '/api/rooms')).items as any[]).some((r) => r.id === roomId)).toBe(false)
  expect((await nora.client.try('POST', `/api/rooms/${roomId}/messages`, { body: 'x', clientMessageId: cm() })).status).toBe(404)
  expect((await open(nora.client, launch.id)).status).toBe(404)
  // restored, with otto added meanwhile by a rule: back, nora's mute and place kept, otto in
  expect((await mia.client.try('POST', `/api/projects/${launch.id}/restore`)).status).toBe(200)
  const back = await nora.client.call('GET', `/api/rooms/${roomId}`)
  expect(back.muted).toBe(true)
  expect(back.lastReadSeq).toBe(1)
  setRule(launch.id, { type: 'user', id: otto.id }, 'write')
  expect(membersOf(roomId)).toEqual(sorted(mia.id, nora.id, otto.id))
})

test('delete for good: the room is archived before the project row goes, never left as a plain channel', async () => {
  const { owner, mia, nora, launch } = await setup('b-project-room-delete')
  const roomId = (await open(mia.client, launch.id)).body.id as string
  expect((await mia.client.try('DELETE', `/api/projects/${launch.id}`)).status).toBe(204)
  expect((await owner.try('DELETE', `/api/projects/${launch.id}`)).status).toBe(204)
  const r = h.ctx.db.query('SELECT archived_at FROM rooms WHERE id = ?').get(roomId) as { archived_at: string | null }
  expect(r.archived_at).not.toBeNull()
  expect(h.ctx.db.query('SELECT 1 FROM room_project_links WHERE room_id = ?').get(roomId)).toBeNull()
  expect((await nora.client.try('GET', `/api/rooms/${roomId}`)).status).toBe(404)
  const a = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'project.room' ORDER BY id DESC LIMIT 1").get() as { detail: string }
  expect(JSON.parse(a.detail)).toEqual({ room: { kind: 'group' }, via: 'archived' })
})

test('guests: a guest of the project is in its room and keeps a group chat too; a guest of another place gets 404', async () => {
  const { mia, nora, launch } = await setup('b-project-room-guests')
  const g = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'project', id: launch.id } })
  const r = await open(g.client, launch.id)
  expect(r.status).toBe(200)
  const roomId = r.body.id as string
  expect(membersOf(roomId)).toContain(g.id)
  expect(r.body.project?.canSave).toBe(false)
  // the project room is not the guest's one group chat: a member may still put them into one, and they keep both
  const chat = await mia.client.try('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, g.id], name: 'With the client' })
  expect(chat.status).toBe(201)
  roomsOf(h.ctx).sync({ projects: 'all' })
  expect(membersOf(roomId)).toContain(g.id)
  expect(membersOf(chat.body.id)).toContain(g.id)
  // a second group chat is still refused (one group chat at most)
  const second = await mia.client.try('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, g.id], name: 'Second' })
  expect(second.status).toBe(409)
  // a guest of another place: the other project's room is 404, never named
  const other = await mia.client.call('POST', '/api/projects', { name: 'Secret plan', participants: [] })
  const elsewhere = await mia.client.call('POST', '/api/projects', { name: 'Elsewhere', participants: [] })
  const g3 = await addGuest(h, mia.client, { username: 'gwen', place: { kind: 'project', id: elsewhere.id } })
  const no = await open(g3.client, other.id)
  expect(no.status).toBe(404)
  expect(JSON.stringify(no.body)).not.toContain('Secret')
})

test('a read-only member cannot attach a file from the computer (403 shared_upload_read_only); a writer can', async () => {
  const { mia, nora, launch } = await setup('b-project-room-readonly-upload')
  const roomId = (await open(mia.client, launch.id)).body.id as string
  setRule(launch.id, { type: 'user', id: nora.id }, 'read')
  const up = async (c: Client) => {
    const f = new FormData()
    f.set('file', new File([new TextEncoder().encode('hello')], 'note.txt', { type: 'text/plain' }))
    const res = await h.fetch(`/api/rooms/${roomId}/files`, { method: 'POST', body: f, headers: { cookie: c.cookie!, 'x-mycel-csrf': '1' } })
    return { status: res.status, body: await res.json() as any }
  }
  const ro = await up(nora.client)
  expect(ro.status).toBe(403)
  expect(ro.body.error?.params?.reason).toBe('shared_upload_read_only')
  // and an upload session with a room target is refused the same way, before a byte is sent
  const s = await nora.client.try('POST', '/api/upload-sessions', { target: { kind: 'room', roomId, name: 'big.bin' }, size: 60 * 1024 * 1024, sha256: 'a'.repeat(64) })
  expect(s.status).toBe(403)
  expect(s.body.error?.params?.reason).toBe('shared_upload_read_only')
  expect((await up(mia.client)).status).toBe(201)
})

test('the unique index answers a race from another process: the write rolls back and the room made there is returned', async () => {
  const { mia, nora, launch } = await setup('b-project-room-race')
  const db = h.ctx.db
  // the other process's room, committed between our check and our write: simulated by a trigger that refuses our link
  // row as the unique index would, and the other room committed right after our write rolled back
  db.query("CREATE TEMP TRIGGER race BEFORE INSERT ON room_project_links WHEN NEW.mode = 'room' BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: room_project_links.project_id'); END").run()
  const theirs = crypto.randomUUID().replace(/^(.{14})./, '$17')
  const real = db.transaction.bind(db)
  ;(db as any).transaction = (fn: any) => {
    const t = real(fn)
    return Object.assign((...a: any[]) => t(...a), { immediate: (...a: any[]) => {
      try { return t.immediate(...a) } catch (e) {
        ;(db as any).transaction = real
        db.query('DROP TRIGGER race').run()
        const now = new Date().toISOString()
        db.query("INSERT INTO rooms (id, kind, created_at, activity_at, name) VALUES (?, 'group', ?, ?, 'Launch site')").run(theirs, now, now)
        db.query("INSERT INTO room_project_links (room_id, project_id, linked_by, linked_at, mode) VALUES (?, ?, ?, ?, 'room')").run(theirs, launch.id, nora.id, now)
        throw e
      }
    } })
  }
  try {
    const r = await open(mia.client, launch.id)
    expect(r.status).toBe(200)
    expect(r.body.id).toBe(theirs)
  } finally { (db as any).transaction = real }
  // our half-made room rolled back: the only project room is theirs, and the sync put mia in it
  expect((db.query("SELECT COUNT(*) n FROM rooms WHERE kind = 'group' AND name = 'Launch site'").get() as { n: number }).n).toBe(1)
  expect(membersOf(theirs)).toContain(mia.id)
})

test('a guest link never names a project room: create refused, an old link of a converted channel refused at accept, the guest reads nothing', async () => {
  const { mia, nora, launch } = await setup('b-project-room-guest-link')
  const roomId = (await open(mia.client, launch.id)).body.id as string
  await mia.client.call('POST', `/api/rooms/${roomId}/messages`, { body: 'secret plan before the guest', clientMessageId: cm() })
  // create: refused for a member (also read-only) and the creator
  setRule(launch.id, { type: 'user', id: nora.id }, 'read')
  for (const c of [nora.client, mia.client]) expect((await c.try('POST', '/api/guest-invites', { place: { kind: 'room', id: roomId } })).status).toBeGreaterThanOrEqual(400)
  // an invite made for a channel before it became the project's room (0.5.21): its accept is refused
  const ch = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id], name: 'Launch talk' })
  const inv = await mia.client.call('POST', '/api/guest-invites', { place: { kind: 'room', id: ch.id } })
  // (the project's own room set aside, so the channel's 0.5.21 link is the one the start pass settles)
  h.ctx.db.query('DELETE FROM room_project_links WHERE room_id = ?').run(roomId)
  h.ctx.db.query('UPDATE rooms SET archived_at = ? WHERE id = ?').run(new Date().toISOString(), roomId)
  h.ctx.db.query('INSERT INTO room_project_links (room_id, project_id, linked_by, linked_at) VALUES (?, ?, ?, ?)').run(ch.id, launch.id, mia.id, new Date().toISOString())
  setRule(launch.id, { type: 'user', id: nora.id }, 'write')
  roomsOf(h.ctx).sync({ projects: 'all' })
  expect((h.ctx.db.query('SELECT mode FROM room_project_links WHERE room_id = ?').get(ch.id) as { mode: string }).mode).toBe('room')
  const token = String(inv.url).split('/invite/')[1]!
  const c = h.client({ ip: '10.0.0.9' })
  const acc = await c.try('POST', `/api/invites/${token}/accept`, { username: 'gus', name: 'GUS', password: 'guest river lamp 77' })
  expect(acc.status).toBeGreaterThanOrEqual(400)
  expect(membersOf(ch.id)).toEqual(sorted(mia.id, nora.id))
  // and nothing adds anyone to a project room but the sync (the guest link's own step refuses it)
  expect(() => roomsOf(h.ctx).addInTx(ch.id, mia.id, ['x'])).toThrow()
})

test('a held room (project in the trash): an app post is refused and no notice is pushed', async () => {
  const { mia, nora, launch } = await setup('b-project-room-held-apps', { publicOrigins: ['https://team.acme-corp.com'] })
  const roomId = (await open(mia.client, launch.id)).body.id as string
  const app = await mia.client.call('POST', `/api/rooms/${roomId}/apps`, { kind: 'other', name: 'Hook' })
  const token = (app.address as string).split('/in/')[1]!
  await mia.client.call('POST', `/api/rooms/${roomId}/messages`, { body: `@${'NORA'} hi`, clientMessageId: cm(), mentions: [nora.id] })
  const notice = h.ctx.db.query('SELECT id FROM room_notices WHERE room_id = ? AND user_id = ?').get(roomId, nora.id) as { id: string }
  const { noticeWanted } = await import('../../server/src/rooms/alerts')
  expect(noticeWanted(h.ctx.db, notice.id)).toBe(true)
  // while the project is there an app's post lands
  const ok = await h.fetch(`/in/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'before' }) })
  expect(ok.status).toBeLessThan(300)
  expect((await mia.client.try('DELETE', `/api/projects/${launch.id}`)).status).toBe(204)
  expect(noticeWanted(h.ctx.db, notice.id)).toBe(false)
  const before = (h.ctx.db.query('SELECT last_seq FROM rooms WHERE id = ?').get(roomId) as { last_seq: number }).last_seq
  const res = await h.fetch(`/in/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'deploy done' }) })
  expect(res.status).toBe(404)
  expect((h.ctx.db.query('SELECT last_seq FROM rooms WHERE id = ?').get(roomId) as { last_seq: number }).last_seq).toBe(before)
})
