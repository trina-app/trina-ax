// "Make it a project" on a conversation (rooms/make-project.ts; GET and POST /api/rooms/:id/make-project,
// docs/AGENTS/plan/20261121-0619-structure-polish.md A): a named channel and an unnamed group chat convert, every other
// kind is refused; the people are the active members (the creator writes, admins outside are not people); the room is
// renamed, its history floor set, each member keeps their start and alert level, their section, pin and mute; one event
// line by the person and the audit's shape; a stale members hash, a second conversion at the same moment and a failure
// inside the write leave nothing made; a disabled member is dropped first; guests take it as their project or block it;
// a team where only admins make projects refuses a member.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { writeFolderAccess } from '../../server/src/admin/folders'
import { updateTeamSettings } from '../../server/src/admin/settings'
import { makeProject } from '../../server/src/rooms/make-project'
import { roomFileMovesOf } from '../../server/src/rooms/file-moves'
import { roomFilesOf } from '../../server/src/rooms/files'
import { roomsOf } from '../../server/src/rooms/service'
import { ApiFail, addMember, harness, withOwner, type Client, type Harness } from './a-lib'
import { addGuest } from './guest-lib'

setDefaultTimeout(120_000)
let h: Harness
afterEach(async () => { await h?.close() })
const cm = () => 'cm-' + crypto.randomUUID()

async function setup(name: string) {
  h = await harness(name)
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const admin = await addMember(h, owner, { username: 'ada', role: 'admin' })
  roomFileMovesOf(h.ctx).auto = false
  return { owner, mia, nora, otto, admin }
}
const channel = async (c: Client, userIds: string[], name: string | null = 'Launch talk') => (await c.call('POST', '/api/rooms', { kind: 'group', userIds, ...(name ? { name } : {}) })).id as string
const info = (c: Client, roomId: string, name?: string) => c.call('GET', `/api/rooms/${roomId}/make-project${name !== undefined ? `?name=${encodeURIComponent(name)}` : ''}`)
const make = (c: Client, roomId: string, name: string, membersHash: string) => c.call('POST', `/api/rooms/${roomId}/make-project`, { name, membersHash })
async function status(p: Promise<unknown>): Promise<{ status: number; reason?: string; body?: any }> {
  try { await p; return { status: 200 } } catch (e) { if (e instanceof ApiFail) return { status: e.status, reason: e.body?.error?.params?.reason, body: e.body }; throw e }
}
const say = (c: Client, roomId: string, body: string) => c.call('POST', `/api/rooms/${roomId}/messages`, { body, clientMessageId: cm() })
const projects = () => (h.ctx.db.query('SELECT COUNT(*) n FROM projects').get() as { n: number }).n
const projectDirs = () => { try { return fs.readdirSync(path.join(h.ctx.files.fx.root, 'projects')).filter((n) => !n.startsWith('.')) } catch { return [] } }

test('a named channel converts: people = members, renamed, floor set, starts kept, one line by the person, audit shape', async () => {
  const { owner, mia, nora, otto, admin } = await setup('b-make-project-basic')
  const roomId = await channel(mia.client, [nora.id])
  await say(mia.client, roomId, 'before')
  // otto joins later: he sees from his join on
  await mia.client.call('POST', `/api/rooms/${roomId}/members`, { userIds: [otto.id] })
  await say(nora.client, roomId, 'after otto')
  const i = await info(mia.client, roomId)
  expect(i).toMatchObject({ suggestedName: 'Launch talk', folderName: 'Launch talk', nameTaken: false, guestsBlocked: [], filesMoving: 0, filesStaying: 0 })
  expect((i.members as any[]).map((m) => m.id).sort()).toEqual([mia.id, nora.id, otto.id].sort())
  const starts = new Map((h.ctx.db.query('SELECT user_id, visible_from_seq FROM room_members WHERE room_id = ?').all(roomId) as { user_id: string; visible_from_seq: number }[]).map((r) => [r.user_id, r.visible_from_seq]))
  const seqBefore = (h.ctx.db.query('SELECT last_seq FROM rooms WHERE id = ?').get(roomId) as { last_seq: number }).last_seq
  const r = await make(mia.client, roomId, 'Launch site', i.membersHash)
  expect(r.project).toMatchObject({ name: 'Launch site', folderPath: 'projects/Launch site' })
  expect(r.room).toMatchObject({ id: roomId, name: 'Launch site', projectRoom: true, project: { id: r.project.id, room: true } })
  // the people: the three members, the creator first; admins and the owner outside are not people
  const rules = h.ctx.db.query("SELECT subject_type, subject_id, access FROM folder_rules fr JOIN folders f ON f.id = fr.folder_id WHERE f.path = 'projects/Launch site' AND subject_type = 'user' ORDER BY subject_id").all() as any[]
  expect(rules.map((x) => [x.subject_type, x.subject_id, x.access]).sort()).toEqual([mia.id, nora.id, otto.id].sort().map((id) => ['user', id, 'write']))
  expect((await status(owner.call('GET', `/api/projects/${r.project.id}`))).status).toBe(404)
  expect((await status(admin.client.call('GET', `/api/projects/${r.project.id}`))).status).toBe(404)
  // the link and the floor; each member keeps where they see it from
  const link = h.ctx.db.query('SELECT mode, history_floor_seq FROM room_project_links WHERE room_id = ?').get(roomId) as any
  expect(link).toEqual({ mode: 'room', history_floor_seq: seqBefore })
  for (const m of h.ctx.db.query('SELECT user_id, history_from_seq FROM room_members WHERE room_id = ?').all(roomId) as { user_id: string; history_from_seq: number }[]) expect(m.history_from_seq).toBe(starts.get(m.user_id)!)
  // one event line, by mia, project_made; no rename line
  const lines = h.ctx.db.query('SELECT author_id, event FROM room_messages WHERE room_id = ? AND seq > ? ORDER BY seq').all(roomId, seqBefore) as { author_id: string; event: string }[]
  expect(lines.length).toBe(1)
  expect(lines[0]!.author_id).toBe(mia.id)
  expect(JSON.parse(lines[0]!.event)).toEqual({ type: 'project_made', projectId: r.project.id, by: mia.id })
  const page = await nora.client.call('GET', `/api/rooms/${roomId}/messages`)
  const ev = (page.items as any[]).find((m) => m.event?.type === 'project_made')
  expect(ev).toMatchObject({ author: { id: mia.id }, event: { type: 'project_made', project: { id: r.project.id, name: 'Launch site' } } })
  // audits: project.create via room (no room id), project.room via made (the room by its kind)
  const audits = h.ctx.db.query("SELECT action, actor_id AS actor, detail FROM audit_log WHERE target = ? AND action IN ('project.create', 'project.room')").all(r.project.id) as { action: string; actor: string; detail: string }[]
  const create = audits.find((a) => a.action === 'project.create')!
  expect(create.actor).toBe(mia.id)
  expect(JSON.parse(create.detail)).toMatchObject({ via: 'room', name: 'Launch site', folderPath: 'projects/Launch site' })
  expect(create.detail).not.toContain(roomId)
  expect(JSON.parse(audits.find((a) => a.action === 'project.room')!.detail)).toEqual({ room: { kind: 'group' }, via: 'made' })
  // a later project member sees from the floor: not the old messages, but the line
  const folder = h.ctx.db.query("SELECT id FROM folders WHERE path = 'projects/Launch site'").get() as { id: string }
  const userRules = rules.map((x) => ({ subjectType: 'user' as const, subjectId: x.subject_id as string, access: 'write' as const }))
  h.ctx.db.transaction(() => writeFolderAccess(h.ctx.db, folder.id, { rules: [...userRules, { subjectType: 'user', subjectId: admin.id, access: 'write' }], limited: true }, mia.id))()
  roomsOf(h.ctx).sync({ projects: 'all' })
  expect(h.ctx.db.query('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?').get(roomId, admin.id)).toBeTruthy()
  const seen = ((await admin.client.call('GET', `/api/rooms/${roomId}/messages`)).items as any[])
  expect(seen.some((m) => m.body === 'before' || m.body === 'after otto')).toBe(false)
  expect(seen.some((m) => m.event?.type === 'project_made')).toBe(true)
  // converting again: not convertible
  const again = await status(make(mia.client, roomId, 'Again', i.membersHash))
  expect(again).toMatchObject({ status: 409, reason: 'already_project' })
  expect(again.body.error.params.projectId).toBe(r.project.id)
  // permission first: a member who may not make projects is refused as such, before anything about the room or project
  updateTeamSettings(h.ctx.db, { projectCreators: 'admins' })
  for (const x of [await status(info(nora.client, roomId)), await status(make(nora.client, roomId, 'Again', i.membersHash))]) {
    expect(x).toMatchObject({ status: 403, reason: 'projects_admins_only' })
    expect(JSON.stringify(x.body)).not.toContain(r.project.id)
  }
  updateTeamSettings(h.ctx.db, { projectCreators: 'members' })
  // a member of the room who no longer reads the project (narrowed, the sync not yet run): the plain not_convertible
  h.ctx.db.transaction(() => writeFolderAccess(h.ctx.db, folder.id, { rules: [{ subjectType: 'user', subjectId: mia.id, access: 'write' }], limited: true }, mia.id))()
  const hidden = await status(make(nora.client, roomId, 'Again', i.membersHash))
  expect(hidden).toMatchObject({ status: 409, reason: 'not_convertible' })
  expect(JSON.stringify(hidden.body)).not.toContain(r.project.id)
})

test('an unnamed group chat converts as "New project" (never the people\'s names: QA TC-6955); a DM, team room, everyone room, project room and archived room are refused', async () => {
  const { owner, mia, nora, otto } = await setup('b-make-project-kinds')
  const group = await channel(mia.client, [nora.id, otto.id], null)
  const i = await info(mia.client, group)
  // (the harness speaks Korean: "New project" in the caller's language)
  expect(i.suggestedName).toBe('새 프로젝트')
  const r = await make(mia.client, group, i.suggestedName, i.membersHash)
  expect(r.room).toMatchObject({ name: '새 프로젝트', projectRoom: true })
  const dm = (await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })).id
  const g = await owner.call('POST', '/api/admin/groups', { name: 'Sales' })
  await owner.call('PATCH', `/api/admin/users/${mia.id}`, { groupIds: [g.id] })
  roomsOf(h.ctx).sync()
  const team = (h.ctx.db.query("SELECT r.id FROM rooms r JOIN room_members m ON m.room_id = r.id WHERE r.kind = 'team' AND m.user_id = ? AND r.archived_at IS NULL").get(mia.id) as { id: string } | null)?.id
  const all = (h.ctx.db.query("SELECT id FROM rooms WHERE kind = 'all'").get() as { id: string }).id
  const proj = await mia.client.call('POST', '/api/projects', { name: 'Made as one', participants: [] })
  const projRoom = (await mia.client.call('POST', `/api/projects/${proj.id}/room`)).id
  const left = await channel(mia.client, [nora.id], 'Old talk')
  await mia.client.call('POST', `/api/rooms/${left}/leave`)
  await nora.client.call('POST', `/api/rooms/${left}/leave`)
  expect(team).toBeTruthy()
  for (const id of [dm, team!, all]) {
    expect(await status(info(mia.client, id))).toMatchObject({ status: 409, reason: 'not_convertible' })
    expect(await status(make(mia.client, id, 'X', 'x'))).toMatchObject({ status: 409, reason: 'not_convertible' })
  }
  // a project's own room (made by the project page, never a conversation): not_convertible, naming nothing; only a
  // conversation that became a project says already_project (TC-6731, the race below)
  for (const r of [await status(info(mia.client, projRoom)), await status(make(mia.client, projRoom, 'X', 'x'))]) {
    expect(r).toMatchObject({ status: 409, reason: 'not_convertible' })
    expect(r.body?.error?.params?.projectId).toBeUndefined()
  }
  // archived: not in it any more, the same 404 as any room one is not in
  expect((await status(make(mia.client, left, 'X', 'x'))).status).toBe(404)
})

test('outsiders, admins outside and the owner get 404; members changed since the confirm get 409 members_changed; only-admins teams refuse a member', async () => {
  const { owner, mia, nora, otto, admin } = await setup('b-make-project-refused')
  const roomId = await channel(mia.client, [nora.id])
  for (const c of [otto.client, admin.client, owner]) {
    expect((await status(info(c, roomId))).status).toBe(404)
    expect((await status(make(c, roomId, 'X', 'x'))).status).toBe(404)
  }
  const i = await info(mia.client, roomId)
  await mia.client.call('POST', `/api/rooms/${roomId}/members`, { userIds: [otto.id] })
  expect(await status(make(mia.client, roomId, 'Launch', i.membersHash))).toMatchObject({ status: 409, reason: 'members_changed' })
  expect(projects()).toBe(0)
  expect(projectDirs()).toEqual([])
  const j = await info(mia.client, roomId)
  updateTeamSettings(h.ctx.db, { projectCreators: 'admins' })
  // the confirm's read and the conversion alike
  expect(await status(info(mia.client, roomId))).toMatchObject({ status: 403, reason: 'projects_admins_only' })
  const no = await status(make(mia.client, roomId, 'Launch', j.membersHash))
  expect(no).toMatchObject({ status: 403, reason: 'projects_admins_only' })
  // a conversation has no personal option: the words say only who may (QA TC-6960)
  expect(no.body.error.message).toBe('이 팀에서는 관리자만 팀 프로젝트를 만들 수 있어요.')
  // the name is checked as a new project's
  updateTeamSettings(h.ctx.db, { projectCreators: 'members' })
  for (const [n, bad] of [['   ', true], ['x'.repeat(101), true], ['CLAUDE.md', true], ['_FILES.md', true], ['Fine name', false]] as const) {
    const k = await info(mia.client, roomId, n)
    expect(!!k.nameError).toBe(bad)
  }
  expect((await status(make(mia.client, roomId, 'AGENTS.md', j.membersHash))).status).toBe(400)
  // a name another project has: allowed, its folder "-2"
  await mia.client.call('POST', '/api/projects', { name: 'Launch', participants: [] })
  const k = await info(mia.client, roomId, 'Launch')
  expect(k).toMatchObject({ nameTaken: true, folderName: 'Launch-2' })
  const r = await make(mia.client, roomId, 'Launch', k.membersHash)
  expect(r.project).toMatchObject({ name: 'Launch', folderPath: 'projects/Launch-2' })
  // the lines name the folder the files go to, the "-2" one (QA TC-6953)
  const made = ((await mia.client.call('GET', `/api/rooms/${roomId}/messages`)).items as any[]).find((m) => m.event?.type === 'project_made')
  expect(made.event.project).toEqual({ id: r.project.id, name: 'Launch', folder: 'Launch-2' })
})

test('two conversions at the same moment: one project, one 409, the loser\'s folder unmade; a failure in the write leaves nothing', async () => {
  const { mia, nora } = await setup('b-make-project-race')
  const roomId = await channel(mia.client, [nora.id])
  const i = await info(mia.client, roomId)
  const both = await Promise.all([status(make(mia.client, roomId, 'Race A', i.membersHash)), status(make(nora.client, roomId, 'Race B', i.membersHash))])
  expect(both.map((b) => b.status).sort()).toEqual([200, 409])
  // the loser is told it just became a project, with a link to it (TC-6731), not that it cannot become one
  const loser = both.find((b) => b.status === 409)!
  expect(loser.reason).toBe('already_project')
  expect(loser.body.error.params.projectId).toBe((h.ctx.db.query('SELECT id FROM projects').get() as { id: string }).id)
  expect(projects()).toBe(1)
  expect(projectDirs().length).toBe(1)
  // a failure inside the write (a project row that cannot be written): no project, no folder, no link, no rules
  const other = await channel(mia.client, [nora.id], 'Second')
  const j = await info(mia.client, other)
  h.ctx.db.exec("CREATE TRIGGER fail_projects BEFORE INSERT ON projects WHEN NEW.name = 'Breaks' BEGIN SELECT RAISE(ABORT, 'injected'); END")
  const p = h.ctx.files.principal(mia.id)
  expect(() => makeProject(h.ctx, p, other, { name: 'Breaks', membersHash: j.membersHash }, 'en')).toThrow(/injected/)
  h.ctx.db.exec('DROP TRIGGER fail_projects')
  expect(projects()).toBe(1)
  expect(projectDirs().length).toBe(1)
  expect(h.ctx.db.query('SELECT 1 FROM room_project_links WHERE room_id = ?').get(other)).toBeNull()
  expect(h.ctx.db.query("SELECT 1 FROM folders WHERE path = 'projects/Breaks'").get()).toBeNull()
  expect((h.ctx.db.query('SELECT name FROM rooms WHERE id = ?').get(other) as { name: string }).name).toBe('Second')
})

test('a disabled member still in the room is removed first and the conversion succeeds', async () => {
  const { owner, mia, nora, otto } = await setup('b-make-project-disabled')
  const roomId = await channel(mia.client, [nora.id, otto.id])
  // otto is disabled, and his member row is still there (the sync has not run)
  h.ctx.db.query("UPDATE users SET status = 'disabled' WHERE id = ?").run(otto.id)
  expect(h.ctx.db.query('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?').get(roomId, otto.id)).toBeTruthy()
  const i = await info(mia.client, roomId)
  expect((i.members as any[]).map((m) => m.id).sort()).toEqual([mia.id, nora.id].sort())
  const r = await make(mia.client, roomId, 'Without otto', i.membersHash)
  expect(r.room.projectRoom).toBe(true)
  expect(h.ctx.db.query('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?').get(roomId, otto.id)).toBeNull()
  void owner
})

test('alert levels, section, pin, hidden state and mute are kept', async () => {
  const { mia, nora, otto } = await setup('b-make-project-kept')
  const roomId = await channel(mia.client, [nora.id, otto.id])
  // mia: no own level, default (direct): 'all' in a group chat, 'mentions' in a project room → 'all' written
  // nora: default none → 'off' before and after: nothing written; otto: muted (his own 'off')
  await nora.client.call('PATCH', '/api/notification-preferences', { roomLevel: 'none' })
  await otto.client.call('PATCH', `/api/rooms/${roomId}`, { notifyLevel: 'off' })
  const before = new Map((await Promise.all([mia, nora, otto].map(async (x) => [x.id, (await x.client.call('GET', `/api/rooms/${roomId}`)).notify.level] as const))))
  expect([...before.values()]).toEqual(['all', 'off', 'off'])
  // mia files it in a section of her own and pins it
  const section = await mia.client.call('POST', '/api/nav-folders', { kind: 'rooms', name: 'Work' })
  await mia.client.call('PUT', `/api/rooms/${roomId}/folder`, { folderId: section.id })
  await mia.client.call('POST', `/api/rooms/${roomId}/pin`)
  const was = await mia.client.call('GET', `/api/rooms/${roomId}`)
  const i = await info(mia.client, roomId)
  const r = await make(mia.client, roomId, 'Kept', i.membersHash)
  expect(r.room.pinnedAt).toBe(was.pinnedAt)
  expect(was.folderId).toBe(section.id)
  expect(r.room.folderId).toBe(section.id)
  for (const x of [mia, nora, otto]) expect((await x.client.call('GET', `/api/rooms/${roomId}`)).notify.level).toBe(before.get(x.id)!)
  expect((h.ctx.db.query('SELECT notify_level, muted FROM room_members WHERE room_id = ? AND user_id = ?').get(roomId, nora.id) as any)).toEqual({ notify_level: null, muted: 0 })
  expect((h.ctx.db.query('SELECT notify_level FROM room_members WHERE room_id = ? AND user_id = ?').get(roomId, mia.id) as any).notify_level).toBe('all')
})

test('guests: one with no project takes it and their room slot clears; one holding another project blocks it (409, nothing written)', async () => {
  const { mia, nora } = await setup('b-make-project-guests')
  const roomId = await channel(mia.client, [nora.id], 'With a client')
  const gus = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'room', id: roomId } })
  expect(h.ctx.db.query('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?').get(roomId, gus.id)).toBeTruthy()
  // a guest never makes one: the guest gate refuses both before anything is read (http/route.ts GUEST_ENDPOINTS)
  expect((await status(info(gus.client, roomId))).status).toBe(403)
  expect((await status(make(gus.client, roomId, 'Mine', 'x'))).status).toBe(403)
  const i = await info(mia.client, roomId)
  expect(i.guestsBlocked).toEqual([])
  const r = await make(mia.client, roomId, 'Client work', i.membersHash)
  const g = h.ctx.db.query('SELECT room_id, project_id FROM guests WHERE user_id = ?').get(gus.id) as { room_id: string | null; project_id: string | null }
  expect(g).toEqual({ room_id: null, project_id: r.project.id })
  // the guest reads the project and its room
  expect((await gus.client.call('GET', `/api/rooms/${roomId}`)).project?.id).toBe(r.project.id)
  // a second channel with a guest who holds another project: blocked before anything is written
  const proj = await mia.client.call('POST', '/api/projects', { name: 'Other client', participants: [] })
  const room2 = await channel(mia.client, [nora.id], 'Second client')
  const pia = await addGuest(h, mia.client, { username: 'pia', place: { kind: 'project', id: proj.id } })
  // put pia in the channel as an older build would (her project is her one place)
  h.ctx.db.query('INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)').run(room2, pia.id, new Date().toISOString())
  const j = await info(mia.client, room2)
  expect(j.guestsBlocked).toEqual([{ id: pia.id, name: 'PIA' }])
  const n = projects()
  const res = await status(make(mia.client, room2, 'Blocked', j.membersHash))
  expect(res).toMatchObject({ status: 409, reason: 'guest_one_place' })
  expect(res.body.error.params.guestId).toBe(pia.id)
  expect(projects()).toBe(n)
  expect(h.ctx.db.query('SELECT 1 FROM room_project_links WHERE room_id = ?').get(room2)).toBeNull()
})

test('the files that move get their rows; the confirm counts them', async () => {
  const { mia, nora } = await setup('b-make-project-files')
  const roomId = await channel(mia.client, [nora.id])
  const src = path.join(h.ctx.config.dataDir, `u-${crypto.randomUUID()}`)
  fs.writeFileSync(src, 'quote')
  const file = await roomFilesOf(h.ctx).create(mia.id, roomId, 'quote.pdf', src, new Bun.CryptoHasher('sha256').update('quote').digest('hex'))
  await mia.client.call('POST', `/api/rooms/${roomId}/messages`, { body: '', clientMessageId: cm(), fileIds: [file.id] })
  const i = await info(mia.client, roomId)
  expect([i.filesMoving, i.filesStaying]).toEqual([1, 0])
  const r = await make(mia.client, roomId, 'With files', i.membersHash)
  expect(r.room.filesMoving).toBe(true)
  const rows = h.ctx.db.query('SELECT room_file_id, state, actor, sender FROM room_file_moves WHERE room_id = ?').all(roomId)
  expect(rows).toEqual([{ room_file_id: file.id, state: 'pending', actor: mia.id, sender: mia.id }])
})

// TC-6733: a project room made on purpose is listed before its first message (Room.listed); the room a project page
// opens the first time is not (it is listed after its first message), and "New project with" opens it with ?listed=1.
test('a conversation made a project and a room opened on purpose are listed; the project page\'s first look is not', async () => {
  const { mia, nora } = await setup('b-make-project-listed')
  const roomId = await channel(mia.client, [nora.id])
  const i = await info(mia.client, roomId)
  const r = await make(mia.client, roomId, 'Listed one', i.membersHash)
  expect(r.room.listed).toBe(true)
  expect((await nora.client.call('GET', `/api/rooms/${roomId}`)).listed).toBe(true)
  expect((await nora.client.call('GET', '/api/rooms')).items.find((x: any) => x.id === roomId).listed).toBe(true)
  const lazy = await mia.client.call('POST', '/api/projects', { name: 'Lazy', participants: [{ subjectType: 'user', subjectId: nora.id }] })
  const lazyRoom = await mia.client.call('POST', `/api/projects/${lazy.id}/room`)
  expect(lazyRoom.listed).toBeUndefined()
  // opened on purpose afterwards: listed, every member's list is told once, and it stays so when opened again the plain way
  const sent: { to: string; ev: any }[] = []
  h.ctx.services.realtime.publishEach = (build) => {
    for (const r of h.ctx.db.query('SELECT id FROM users').all() as { id: string }[]) { const ev = build(r.id); if (ev) sent.push({ to: r.id, ev }) }
  }
  expect((await mia.client.call('POST', `/api/projects/${lazy.id}/room?listed=1`)).listed).toBe(true)
  expect(sent.some((e) => e.to === nora.id && e.ev.type === 'room.updated' && e.ev.data.roomId === lazyRoom.id && e.ev.data.room.listed === true)).toBe(true)
  sent.length = 0
  await mia.client.call('POST', `/api/projects/${lazy.id}/room?listed=1`)
  expect(sent.length).toBe(0)
  expect((await nora.client.call('POST', `/api/projects/${lazy.id}/room`)).listed).toBe(true)
  const dm = await mia.client.call('POST', '/api/projects', { name: 'With Nora', participants: [{ subjectType: 'user', subjectId: nora.id }] })
  const dmRoom = await mia.client.call('POST', `/api/projects/${dm.id}/room?listed=1`)
  expect(dmRoom.listed).toBe(true)
  expect((await nora.client.call('GET', `/api/rooms/${dmRoom.id}`)).listed).toBe(true)
})
