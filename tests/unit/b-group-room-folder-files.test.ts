// A department's team room puts a file sent from the computer in its group folder's Chat attachments
// (docs/AGENTS/plan/20261121-0619-structure-polish.md B; rooms/team-place.ts teamPlaceFor, rooms/files.ts
// createInTeamFolder): a room_file_refs row and no bytes in room storage, as in a project room. Each fallback keeps the
// file in room storage, never refused: no folder, a folder not there or in the trash, safe operations, an uploader who
// may not write there, a folder read by someone outside the room (everyone, members by role, another group with an
// outside member, a person; a rule on the team root too), a narrowed Chat attachments, bytes on the download-only list.
// Such a file is "Only in this conversation" (RoomFile.roomOnly), the room keeps its Files list only while it holds such
// files (Room.roomFiles; GET /api/rooms/:id/files lists only those, 404 when none). Two groups, leaving a group, an
// admin outside (reads the folder in Files, 404 in the room), no guest, a renamed group and folder, a deleted group, a
// folder widened after an upload, the welcome steps' team group and the everyone room. Deleting a message keeps a folder
// file and removes a room-stored one. Room.project.sameAsGroup. The check with 2,000 people within 20 ms.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { CHAT_FILES_FOLDER } from '@mycel/shared'
import type { RoomFile } from '@mycel/shared/api'
import { createGroupAs } from '../../server/src/admin/groups'
import { ensureFolderRow, writeFolderAccess } from '../../server/src/admin/folders'
import { teamDefaultLocale } from '../../server/src/admin/settings'
import { roomFilesOf } from '../../server/src/rooms/files'
import { sameAsGroupFor, sameAsGroupOf } from '../../server/src/rooms/project-link'
import { roomsOf } from '../../server/src/rooms/service'
import { membersRead, roomHasTeamPlace, teamPlaceFor, widerThanRoom } from '../../server/src/rooms/team-place'
import { componentC } from '../../server/src/team-files/component'
import { RuleSet } from '../../server/src/policy/access'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'
import { addGuest } from './guest-lib'

setDefaultTimeout(120_000)
let h: Harness
afterEach(async () => { await h?.close(); delete process.env.MYCEL_SAFE_OPS_1A })

const cm = () => 'cm-' + crypto.randomUUID()
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const at = (rel: string) => path.join(h.ctx.files.fx.root, ...rel.split('/'))
const team = () => componentC(h.ctx).files

async function setup(name: string) {
  h = await harness(name)
  const owner = await withOwner(h)
  // ada: an admin outside the department; otto: a member outside it
  const ada = await addMember(h, owner, { username: 'ada', role: 'admin' })
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const group = await owner.call('POST', '/api/admin/groups', { name: 'leads', memberIds: [mia.id, nora.id] })
  const folder = (h.ctx.db.query('SELECT f.id, f.path FROM groups g JOIN folders f ON f.id = g.folder_id WHERE g.id = ?').get(group.id) as { id: string; path: string })
  const roomId = teamRoomOf(group.id)
  const chatName = CHAT_FILES_FOLDER[teamDefaultLocale(h.ctx.db)]
  return { owner, ada, mia, nora, otto, group, folder, roomId, chatName, chat: `${folder.path}/${chatName}` }
}
const teamRoomOf = (groupId: string) => (h.ctx.db.query("SELECT id FROM rooms WHERE kind = 'team' AND group_id = ? AND archived_at IS NULL").get(groupId) as { id: string }).id

/** a file from the computer as the upload routes hand it over (rooms/files.ts create) */
async function up(userId: string, roomId: string, name: string, text = `content of ${name} ${crypto.randomUUID()}`): Promise<RoomFile> {
  const bytes = new TextEncoder().encode(text)
  const src = path.join(h.ctx.config.dataDir, `upload-${crypto.randomUUID()}`)
  fs.writeFileSync(src, bytes)
  return roomFilesOf(h.ctx).create(userId, roomId, name, src, sha(bytes))
}
const send = (c: Client, roomId: string, fileIds: string[], body = '') => c.call('POST', `/api/rooms/${roomId}/messages`, { body, clientMessageId: cm(), fileIds })
const filesOf = async (c: Client, roomId: string, messageId: string): Promise<RoomFile[]> => ((await c.call('GET', `/api/rooms/${roomId}/messages`)).items as any[]).find((m) => m.id === messageId)?.files ?? []
const fileGet = async (c: Client, roomId: string, fileId: string) => (await c.raw('GET', `/api/rooms/${roomId}/files/${fileId}`)).status
const refRow = (id: string) => h.ctx.db.query('SELECT * FROM room_file_refs WHERE room_file_id = ?').get(id) as { path: string } | null
const roomStore = (roomId: string) => { try { return fs.readdirSync(path.join(h.ctx.files.fx.root, '.system', 'rooms', roomId)).filter((n) => !n.includes('.thumb.')) } catch { return [] } }
const room = async (c: Client, roomId: string) => c.call('GET', `/api/rooms/${roomId}`)
const filesList = (c: Client, roomId: string) => c.try('GET', `/api/rooms/${roomId}/files`)
/** the folder's rules through Admin › Folders (a row made when missing), keeping what `keep` says */
async function setRules(owner: Client, p: string, rules: { subjectType: string; subjectId?: string | null; access: string }[], limited?: boolean) {
  const items = (await owner.call('GET', '/api/admin/folders')).items as { id: string; path: string; rulesHash: string }[]
  const f = items.find((x) => x.path === p)
  const body = { rules: rules.map((r) => ({ subjectType: r.subjectType, subjectId: r.subjectId ?? null, access: r.access })), ...(limited !== undefined ? { limited } : {}) }
  if (f) return owner.call('PUT', `/api/admin/folders/${f.id}/rules`, { ...body, expectedHash: f.rulesHash })
  return owner.call('POST', '/api/admin/folders', { path: p, create: false, ...body })
}
const groupRule = (id: string) => ({ subjectType: 'group', subjectId: id, access: 'write' })
/** the person may read the team file now (the file screen's own read) */
const canRead = async (userId: string, rel: string) => { try { await team().content(userId, rel); return true } catch { return false } }
/** a file through the one-request upload route (multipart) */
async function postFile(c: Client, roomId: string, name: string, text: string) {
  const fd = new FormData()
  fd.set('file', new File([new TextEncoder().encode(text)], name))
  const headers: Record<string, string> = { 'x-mycel-csrf': '1', ...(c.cookie ? { cookie: c.cookie } : {}), ...(c.token ? { authorization: `Bearer ${c.token}` } : {}) }
  const res = await h.fetch(`/api/rooms/${roomId}/files`, { method: 'POST', body: fd, headers, ip: '10.0.0.7' })
  return { status: res.status, body: await res.json().catch(() => null) as any }
}

test('an upload lands in <group folder>/Chat attachments with a ref ("(2)", instruction and file-list names taken); members open it, the room keeps no list', async () => {
  const { mia, nora, otto, roomId, chat } = await setup('b-group-room-folder-place')
  const a = await up(mia.id, roomId, 'brief.pdf', 'first brief')
  const b = await up(mia.id, roomId, 'brief.pdf', 'second brief')
  const c = await up(mia.id, roomId, 'CLAUDE.md', '# not instructions')
  const d = await up(mia.id, roomId, '_FILES.md', '# not the file list')
  expect([a.name, b.name, c.name, d.name]).toEqual(['brief.pdf', 'brief (2).pdf', 'CLAUDE (2).md', '_FILES (2).md'])
  expect(a).toMatchObject({ teamFile: true, teamPath: `${chat}/brief.pdf` })
  expect(a.roomOnly).toBeUndefined()
  expect(fs.existsSync(at(`${chat}/CLAUDE.md`))).toBe(false)
  expect(fs.existsSync(at(`${chat}/_FILES.md`))).toBe(false)
  expect(fs.statSync(at(`${chat}/brief (2).pdf`)).nlink).toBe(1)
  expect(roomStore(roomId)).toEqual([])
  for (const f of [a, b, c, d]) expect(refRow(f.id)?.path).toBe(`${chat}/${f.name}`)
  // through the upload route too
  const viaRoute = (await postFile(mia.client, roomId, 'route.txt', 'route bytes')).body
  expect(viaRoute).toMatchObject({ teamFile: true, teamPath: `${chat}/route.txt` })
  const m = await send(mia.client, roomId, [a.id, b.id, viaRoute.id], 'the briefs')
  const seen = await filesOf(nora.client, roomId, m.id)
  expect(seen.map((f) => [f.name, f.teamFile, f.roomOnly])).toEqual([['brief.pdf', true, undefined], ['brief (2).pdf', true, undefined], ['route.txt', true, undefined]])
  expect(await fileGet(nora.client, roomId, b.id)).toBe(200)
  expect(await fileGet(otto.client, roomId, b.id)).toBe(404)
  // every file is in the folder: one 📁 button, no Files list (404)
  const r = await room(nora.client, roomId)
  expect(r.groupFolder).toBe('groups/leads')
  expect(r.roomFiles).toBeUndefined()
  expect((await filesList(nora.client, roomId)).status).toBe(404)
})

test('each fallback keeps the file in room storage, labelled roomOnly; the Files list then shows only those', async () => {
  const s = await setup('b-group-room-folder-fallbacks')
  const { owner, mia, nora, otto, ada, group, folder, roomId, chat, chatName } = s
  const placed = async (name: string) => { const f = await up(mia.id, roomId, name); return f.teamFile ? 'folder' : f.roomOnly ? 'room (roomOnly)' : 'room' }
  expect(await placed('ok-1.txt')).toBe('folder')

  // 1. safe operations on
  process.env.MYCEL_SAFE_OPS_1A = '1'
  expect(await placed('safe-ops.txt')).toBe('room (roomOnly)')
  delete process.env.MYCEL_SAFE_OPS_1A
  // bytes on the download-only list
  const held = new TextEncoder().encode('held bytes')
  h.ctx.files.quarantine.add(Buffer.from(held), 'image')
  const src = path.join(h.ctx.config.dataDir, 'held-src')
  fs.writeFileSync(src, held)
  expect((await roomFilesOf(h.ctx).create(mia.id, roomId, 'held.png', src, sha(held))).teamFile).toBeUndefined()

  // 2. wider than the members: everyone, members by role, another group with someone outside, a person outside
  await setRules(owner, folder.path, [groupRule(group.id), { subjectType: 'everyone', access: 'read' }])
  expect(await placed('everyone.txt')).toBe('room (roomOnly)')
  // a role rule: the database keeps only the managed marker (admins write), which adds nobody (admins read every folder
  // outside users/ anyway); a members' role rule, which no database can hold any more, would be wider (judged in memory)
  await setRules(owner, folder.path, [groupRule(group.id)])
  h.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, 'role', 'admin', 'write')").run(crypto.randomUUID(), folder.id)
  expect(await placed('role-admin.txt')).toBe('folder')
  h.ctx.db.query("DELETE FROM folder_rules WHERE folder_id = ? AND subject_type = 'role'").run(folder.id)
  const w = RuleSet.load(h.ctx.db).world()
  const withRole = RuleSet.fromWorld({ ...w, rows: [...w.rows, { path: folder.path, subject_type: 'role', subject_id: 'member', access: 'read' }] })
  expect(widerThanRoom(h.ctx.db, withRole, roomId, group.id, chat)).toBe(true)
  expect(widerThanRoom(h.ctx.db, RuleSet.load(h.ctx.db), roomId, group.id, chat)).toBe(false)
  const helpers = await owner.call('POST', '/api/admin/groups', { name: 'helpers', memberIds: [nora.id] })
  await setRules(owner, folder.path, [groupRule(group.id), { subjectType: 'group', subjectId: helpers.id, access: 'read' }])
  // another group whose people are all in the room: nobody outside
  expect(await placed('helpers-inside.txt')).toBe('folder')
  await owner.call('PATCH', `/api/admin/groups/${helpers.id}`, { memberIds: [nora.id, ada.id] })
  // ...an admin outside counts as nobody either
  expect(await placed('helpers-admin.txt')).toBe('folder')
  await owner.call('PATCH', `/api/admin/groups/${helpers.id}`, { memberIds: [nora.id, otto.id] })
  expect(await placed('helpers-otto.txt')).toBe('room (roomOnly)')
  await setRules(owner, folder.path, [groupRule(group.id), { subjectType: 'user', subjectId: otto.id, access: 'read' }])
  expect(await placed('person.txt')).toBe('room (roomOnly)')
  // a person rule for someone in the room: not wider
  await setRules(owner, folder.path, [groupRule(group.id), { subjectType: 'user', subjectId: nora.id, access: 'write' }])
  expect(await placed('person-inside.txt')).toBe('folder')
  // a rule on Chat attachments itself counts too
  await setRules(owner, chat, [{ subjectType: 'user', subjectId: otto.id, access: 'read' }])
  expect(await placed('chat-person.txt')).toBe('room (roomOnly)')
  await setRules(owner, chat, [])
  expect(await placed('ok-2.txt')).toBe('folder')
  // a rule on the team root reaches it (group folders are not limited): everyone reading the root
  const rootRow = ensureFolderRow(h.ctx.db, '')
  const rootRules = h.ctx.db.query('SELECT subject_type subjectType, subject_id subjectId, access FROM folder_rules WHERE folder_id = ?').all(rootRow.id) as any[]
  writeFolderAccess(h.ctx.db, rootRow.id, { rules: [...rootRules, { subjectType: 'everyone', subjectId: null, access: 'read' }] }, null)
  expect(await placed('root.txt')).toBe('room (roomOnly)')
  writeFolderAccess(h.ctx.db, rootRow.id, { rules: rootRules }, null)
  expect(await placed('ok-3.txt')).toBe('folder')

  // 3. Chat attachments narrowed: a member cannot read it
  await setRules(owner, chat, [{ subjectType: 'user', subjectId: mia.id, access: 'write' }], true)
  expect(await placed('narrowed.txt')).toBe('room (roomOnly)')
  // 4. the uploader cannot write there (the group reads only): room storage, no 403
  await setRules(owner, chat, [{ subjectType: 'group', subjectId: group.id, access: 'read' }], true)
  expect(await placed('read-only.txt')).toBe('room (roomOnly)')
  await setRules(owner, chat, [], false)
  expect(await placed('ok-4.txt')).toBe('folder')

  // 1. the folder not there (deleted outside Trina), in the trash, no folder at all
  fs.renameSync(at(folder.path), at('groups/leads-away'))
  expect(await placed('missing.txt')).toBe('room (roomOnly)')
  fs.renameSync(at('groups/leads-away'), at(folder.path))
  expect(await placed('ok-5.txt')).toBe('folder')
  const ownerId = (h.ctx.db.query("SELECT id FROM users WHERE role = 'owner'").get() as { id: string }).id
  const trashed = team().remove(ownerId, folder.path)
  // its row is parked under the trash: no team place, so no label either
  expect(await placed('trashed.txt')).toBe('room')
  team().restoreTrash(ownerId, trashed.trashId)
  expect(await placed('ok-6.txt')).toBe('folder')
  h.ctx.db.query('UPDATE groups SET folder_id = NULL WHERE id = ?').run(group.id)
  expect(await placed('no-folder.txt')).toBe('room')
  expect(roomHasTeamPlace(h.ctx.db, { kind: 'team', group_id: group.id })).toBe(false)
  h.ctx.db.query('UPDATE groups SET folder_id = ? WHERE id = ?').run(folder.id, group.id)
  void chatName

  // the room's Files list: only the files it holds itself, each "Only in this conversation"
  const upAll = async (names: string[]) => { const out: RoomFile[] = []; for (const n of names) out.push(await up(mia.id, roomId, n)); return out }
  await setRules(owner, folder.path, [groupRule(group.id), { subjectType: 'user', subjectId: otto.id, access: 'read' }])
  const [stays] = await upAll(['stays.txt'])
  await setRules(owner, folder.path, [groupRule(group.id)])
  const [goes] = await upAll(['goes.txt'])
  const m = await send(mia.client, roomId, [stays!.id, goes!.id], 'two files')
  expect((await filesOf(nora.client, roomId, m.id)).map((f) => [f.name, !!f.teamFile, f.roomOnly])).toEqual([['stays.txt', false, true], ['goes.txt', true, undefined]])
  expect(stays!.roomOnly).toBe(true)
  expect((await room(nora.client, roomId)).roomFiles).toBe(true)
  const list = await nora.client.call('GET', `/api/rooms/${roomId}/files`)
  expect((list.items as any[]).map((i) => [i.file.name, i.file.roomOnly])).toEqual([['stays.txt', true]])
  // the search still finds both, as each may be read
  const found = await nora.client.call('GET', '/api/room-files?q=goes')
  expect((found.items as any[]).map((i) => i.file.name)).toEqual(['goes.txt'])
  // deleting the message: the folder file stays, the room-stored one goes; the list goes with it
  await mia.client.call('DELETE', `/api/rooms/${roomId}/messages/${m.id}`)
  expect(fs.existsSync(at(`${chat}/goes.txt`))).toBe(true)
  expect(roomStore(roomId)).not.toContain(stays!.id)
  expect((await room(nora.client, roomId)).roomFiles).toBeUndefined()
  expect((await filesList(nora.client, roomId)).status).toBe(404)
})

test('two groups, leaving a group, an admin outside (Files yes, room 404), no guest', async () => {
  const { owner, ada, mia, nora, otto, group, roomId, chat } = await setup('b-group-room-folder-people')
  const ops = await owner.call('POST', '/api/admin/groups', { name: 'ops', memberIds: [mia.id, otto.id] })
  const opsRoom = teamRoomOf(ops.id)
  const opsChat = `groups/ops/${CHAT_FILES_FOLDER[teamDefaultLocale(h.ctx.db)]}`
  const inLeads = await up(mia.id, roomId, 'leads.txt', 'leads only')
  const inOps = await up(mia.id, opsRoom, 'ops.txt', 'ops only')
  expect(inLeads.teamPath).toBe(`${chat}/leads.txt`)
  expect(inOps.teamPath).toBe(`${opsChat}/ops.txt`)
  const noraUp = await up(nora.id, roomId, 'nora.txt', 'from nora')
  const m = await send(mia.client, roomId, [inLeads.id], 'leads')
  const n = await send(nora.client, roomId, [noraUp.id], 'mine')
  expect(await fileGet(otto.client, roomId, inLeads.id)).toBe(404)
  // an admin outside: reads the folder in Files (accepted, 2026-11-21), but is not in the room
  expect(await canRead(ada.id, `${chat}/leads.txt`)).toBe(true)
  expect(await fileGet(ada.client, roomId, inLeads.id)).toBe(404)
  expect((await ada.client.try('GET', `/api/rooms/${roomId}/files`)).status).toBe(404)
  // nora leaves the group: out of the room and the folder; her own upload stays in the folder
  await owner.call('PATCH', `/api/admin/groups/${group.id}`, { memberIds: [mia.id] })
  expect(h.ctx.db.query('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?').get(roomId, nora.id)).toBeNull()
  expect(await fileGet(nora.client, roomId, inLeads.id)).toBe(404)
  expect(await canRead(nora.id, `${chat}/leads.txt`)).toBe(false)
  expect(fs.existsSync(at(`${chat}/nora.txt`))).toBe(true)
  expect(await fileGet(mia.client, roomId, noraUp.id)).toBe(200)
  void m; void n
  // a guest is never in a team room and reads nothing in groups/
  const g = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'room', id: (await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [otto.id], name: 'client' })).id } })
  expect(h.ctx.db.query('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?').get(roomId, g.id)).toBeNull()
  expect((await postFile(g.client, roomId, 'x.txt', 'x')).status).toBe(404)
  expect(await canRead(g.id, `${chat}/leads.txt`)).toBe(false)
})

test('a renamed group and folder, a deleted group, a folder widened after an upload', async () => {
  const { owner, mia, nora, otto, group, folder, roomId, chat, chatName } = await setup('b-group-room-folder-changes')
  const a = await up(mia.id, roomId, 'a.txt', 'aaa')
  await send(mia.client, roomId, [a.id], 'a')
  // the group renamed: its folder (folder_id) is the same, the uploads still go there
  await owner.call('PATCH', `/api/admin/groups/${group.id}`, { name: 'leaders' })
  expect((await up(mia.id, roomId, 'b.txt')).teamPath).toBe(`${chat}/b.txt`)
  // the folder moved in Files: the reference follows it, and new uploads go to its new place
  const ownerId = (h.ctx.db.query("SELECT id FROM users WHERE role = 'owner'").get() as { id: string }).id
  team().move(ownerId, folder.path, 'groups/leaders', 'fail')
  const seen = (await filesOf(nora.client, roomId, (await nora.client.call('GET', `/api/rooms/${roomId}/messages`)).items.find((x: any) => x.files?.length).id))[0]!
  expect(seen).toMatchObject({ name: 'a.txt', teamPath: `groups/leaders/${chatName}/a.txt` })
  expect((await up(mia.id, roomId, 'c.txt')).teamPath).toBe(`groups/leaders/${chatName}/c.txt`)
  // widened after an upload: the new reader sees the file in Files (not the room); new uploads stay in the room
  const f = (await owner.call('GET', '/api/admin/folders')).items.find((x: any) => x.path === 'groups/leaders')
  await owner.call('PUT', `/api/admin/folders/${f.id}/rules`, { rules: [groupRule(group.id), { subjectType: 'user', subjectId: otto.id, access: 'read' }], expectedHash: f.rulesHash })
  expect(await canRead(otto.id, `groups/leaders/${chatName}/a.txt`)).toBe(true)
  expect(await fileGet(otto.client, roomId, a.id)).toBe(404)
  expect((await up(mia.id, roomId, 'd.txt')).roomOnly).toBe(true)
  // the group deleted: the room is archived, the files stay in the folder
  await owner.call('DELETE', `/api/admin/groups/${group.id}`)
  expect((h.ctx.db.query('SELECT archived_at FROM rooms WHERE id = ?').get(roomId) as { archived_at: string | null }).archived_at).not.toBeNull()
  expect(fs.readFileSync(at(`groups/leaders/${chatName}/a.txt`), 'utf8')).toBe('aaa')
  expect(teamPlaceFor(h.ctx, roomId, mia.id)).toBeNull()
})

test('the welcome steps\' team group has no room; the everyone room never has a folder', async () => {
  const { mia } = await setup('b-group-room-folder-welcome')
  const ownerId = (h.ctx.db.query("SELECT id FROM users WHERE role = 'owner'").get() as { id: string }).id
  const tg = createGroupAs(h.ctx, ownerId, { name: 'Acme team', memberIds: [mia.id], room: false }, 'en')
  expect(h.ctx.db.query("SELECT 1 FROM rooms WHERE kind = 'team' AND group_id = ? AND archived_at IS NULL").get(tg.id)).toBeNull()
  const all = (h.ctx.db.query("SELECT * FROM rooms WHERE kind = 'all'").get() as any)
  expect(roomHasTeamPlace(h.ctx.db, all)).toBe(false)
  expect(teamPlaceFor(h.ctx, all.id, mia.id)).toBeNull()
  const f = await up(mia.id, all.id, 'everyone.txt')
  expect(f.teamFile).toBeUndefined()
  expect(f.roomOnly).toBeUndefined()
  expect((await room(mia.client, all.id)).roomFiles).toBeUndefined()
})

test('Room.project.sameAsGroup: a project room with exactly a department\'s people, once per pass, never to someone outside that room', async () => {
  const { owner, mia, nora, otto, group, roomId } = await setup('b-group-room-folder-same')
  const p = await mia.client.call('POST', '/api/projects', { name: 'Launch', participants: [{ subjectType: 'user', subjectId: nora.id }] })
  const pr = await mia.client.call('POST', `/api/projects/${p.id}/room`)
  expect(pr.project.sameAsGroup).toEqual({ groupId: group.id, name: 'leads', roomId })
  expect((await room(nora.client, pr.id)).project.sameAsGroup).toEqual({ groupId: group.id, name: 'leads', roomId })
  // only project rooms carry it
  expect((await room(nora.client, roomId)).project).toBeUndefined()
  // never to a viewer who is not in that team room
  expect(sameAsGroupFor(h.ctx.db, pr.id, otto.id)).toBeUndefined()
  // once per pass: the same pass object keeps its answer, a new one sees the change
  const pass = {}
  expect(sameAsGroupFor(h.ctx.db, pr.id, mia.id, pass)?.roomId).toBe(roomId)
  await owner.call('PATCH', `/api/admin/groups/${group.id}`, { memberIds: [mia.id, nora.id, otto.id] })
  expect(sameAsGroupFor(h.ctx.db, pr.id, mia.id, pass)?.roomId).toBe(roomId)
  expect(sameAsGroupFor(h.ctx.db, pr.id, mia.id, {})).toBeUndefined()
  expect(sameAsGroupOf(h.ctx.db, pr.id)).toBeNull()
  expect((await room(mia.client, pr.id)).project.sameAsGroup).toBeUndefined()
})

test('the check reads only the rule subjects: 2,000 people within 20 ms', async () => {
  const { owner, group, folder, roomId, chat } = await setup('b-group-room-folder-speed')
  const db = h.ctx.db
  const others = await owner.call('POST', '/api/admin/groups', { name: 'others', memberIds: [] })
  const now = new Date().toISOString()
  const room = db.query('SELECT last_seq FROM rooms WHERE id = ?').get(roomId) as { last_seq: number }
  db.transaction(() => {
    const u = db.query("INSERT INTO users (id, username, name, role, status) VALUES (?, ?, ?, 'member', 'active')")
    const gm = db.query('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)')
    const rm = db.query('INSERT INTO room_members (room_id, user_id, joined_at, last_read_seq, visible_from_seq) VALUES (?, ?, ?, ?, ?)')
    for (let i = 0; i < 2000; i++) {
      const id = `perf${String(i).padStart(4, '0')}`
      u.run(id, id, id)
      gm.run(group.id, id)
      // everyone in the room; the other group has them all too (in the room: not wider)
      rm.run(roomId, id, now, room.last_seq, room.last_seq)
      gm.run(others.id, id)
    }
  })()
  // the other group and 50 people named on the folder, all in the room
  const people = Array.from({ length: 50 }, (_, i) => ({ subjectType: 'user', subjectId: `perf${String(i).padStart(4, '0')}`, access: 'read' }))
  await setRules(owner, folder.path, [groupRule(group.id), { subjectType: 'group', subjectId: others.id, access: 'read' }, ...people])
  const rules = RuleSet.load(db)
  const mia = (db.query("SELECT id FROM users WHERE username = 'mia'").get() as { id: string }).id
  // warm up, then time the whole place check (rules load included) and the two checks alone
  teamPlaceFor(h.ctx, roomId, mia)
  const runs: number[] = []
  for (let i = 0; i < 5; i++) {
    const t = performance.now()
    expect(teamPlaceFor(h.ctx, roomId, mia)?.folder).toBe(chat)
    runs.push(performance.now() - t)
  }
  runs.sort((a, b) => a - b)
  const t = performance.now()
  expect(widerThanRoom(db, rules, roomId, group.id, chat)).toBe(false)
  expect(membersRead(db, rules, roomId, group.id, chat)).toBe(true)
  const checks = performance.now() - t
  console.log(`team place check with 2,000 people: median ${runs[2]!.toFixed(2)} ms, checks alone ${checks.toFixed(2)} ms`)
  expect(runs[2]!).toBeLessThan(20)
  // the slow path of membersRead (no group rule reaching it: each member judged) stays within it too
  for (const u of ['mia', 'nora']) db.query('INSERT INTO group_members (group_id, user_id) SELECT ?, id FROM users WHERE username = ?').run(others.id, u)
  await setRules(owner, folder.path, [{ subjectType: 'group', subjectId: others.id, access: 'write' }])
  const slowRules = RuleSet.load(db)
  const slow = performance.now()
  expect(membersRead(db, slowRules, roomId, group.id, chat)).toBe(true)
  const slowMs = performance.now() - slow
  console.log(`members judged one by one: ${slowMs.toFixed(2)} ms`)
  expect(slowMs).toBeLessThan(20)
})
