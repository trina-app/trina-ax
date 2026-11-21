// "Make it a project" and the files it moves (rooms/make-project.ts, rooms/file-moves.ts; docs/AGENTS/plan/
// 20261121-0619-structure-polish.md "Risks and security cases"), beside the matrix rows in lib/rooms-cases.ts:
//   - a guest member of the conversation never reads the confirm nor converts it (the guest gate: 403, nothing named);
//   - an admin outside and a member of the team outside get the room's 404 for both, which names nothing;
//   - a moved file's room endpoint: a former member of the room gets 404 (as for a room they were never in), and their
//     message view has nothing of it;
//   - a member excluded from a narrowed Chat attachments after the move sees the moved file as "unavailable" (its name,
//     path and size blanked) and gets 404 for its bytes; the members who read it still open it;
//   - only files every member saw move: a file sent before someone joined stays a room file they cannot open.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { CHAT_FILES_FOLDER } from '@mycel/shared'
import { ensureFolderRow, writeFolderAccess } from '../../server/src/admin/folders'
import { teamDefaultLocale } from '../../server/src/admin/settings'
import { roomFileMovesOf } from '../../server/src/rooms/file-moves'
import { roomFilesOf } from '../../server/src/rooms/files'
import { addMember, harness, withOwner, type Client, type Harness } from '../unit/a-lib'
import { addGuest } from '../unit/guest-lib'

setDefaultTimeout(120_000)
let h: Harness
const K = { secret: 'SEC-MPR-FILE-9f1', name: 'SEC-MPR-NAME-2c7', early: 'SEC-MPR-EARLY-4e0' } as const
const cm = () => 'cm-' + crypto.randomUUID()
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
let owner: Client
let mia: { client: Client; id: string }, nora: { client: Client; id: string }, otto: { client: Client; id: string }, ada: { client: Client; id: string }
let roomId = '', fileId = '', earlyId = '', chat = ''

async function upload(userId: string, name: string, text: string) {
  const src = path.join(h.ctx.config.dataDir, `up-${crypto.randomUUID()}`)
  fs.writeFileSync(src, text)
  return roomFilesOf(h.ctx).create(userId, roomId, name, src, sha(text))
}
const get = async (c: Client, p: string) => { const r = await c.raw('GET', p); return { status: r.status, text: await r.text() } }

beforeAll(async () => {
  h = await harness('sec-make-project-room')
  owner = await withOwner(h)
  mia = await addMember(h, owner, { username: 'mia' })
  nora = await addMember(h, owner, { username: 'nora' })
  otto = await addMember(h, owner, { username: 'otto' })
  ada = await addMember(h, owner, { username: 'ada', role: 'admin' })
  roomFileMovesOf(h.ctx).auto = false
  roomId = (await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id], name: K.name })).id
  const early = await upload(mia.id, 'early.txt', K.early)
  await mia.client.call('POST', `/api/rooms/${roomId}/messages`, { body: '', clientMessageId: cm(), fileIds: [early.id] })
  earlyId = early.id
  await mia.client.call('POST', `/api/rooms/${roomId}/members`, { userIds: [otto.id] })
  const f = await upload(mia.id, 'plan.txt', K.secret)
  await mia.client.call('POST', `/api/rooms/${roomId}/messages`, { body: '', clientMessageId: cm(), fileIds: [f.id] })
  fileId = f.id
})
afterAll(async () => { await h?.close() })

test('a guest member, an admin outside and a member outside: refused, nothing named', async () => {
  const gus = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'room', id: roomId } })
  for (const [who, c, code] of [['guest', gus.client, 403], ['admin outside', ada.client, 404], ['owner outside', owner, 404]] as const) {
    const info = await get(c, `/api/rooms/${roomId}/make-project`)
    const r = await c.raw('POST', `/api/rooms/${roomId}/make-project`, { name: 'Taken over', membersHash: 'x' })
    const made = { status: r.status, text: await r.text() }
    for (const x of [info, made]) {
      expect(x.status, who).toBe(code)
      expect(x.text).not.toContain(K.name)
      expect(x.text).not.toContain('membersHash')
    }
  }
  // the guest leaves again, so the conversion below has the members only
  await gus.client.call('POST', `/api/rooms/${roomId}/leave`)
})

test('the confirm\'s read is no probe of project folders: admins-only teams refuse it, a clash is named only for a project one reads, and it is rate limited', async () => {
  const { updateTeamSettings } = await import('../../server/src/admin/settings')
  updateTeamSettings(h.ctx.db, { projectCreators: 'admins' })
  const refused = await get(mia.client, `/api/rooms/${roomId}/make-project?name=${encodeURIComponent('Anything')}`)
  expect(refused.status).toBe(403)
  expect(refused.text).not.toContain('folderName')
  updateTeamSettings(h.ctx.db, { projectCreators: 'members' })
  // a project of the admin's that mia cannot read, and one of her own
  await ada.client.call('POST', '/api/projects', { name: K.name + ' hidden', participants: [] })
  await mia.client.call('POST', '/api/projects', { name: 'Mine to see', participants: [] })
  const hidden = await mia.client.call('GET', `/api/rooms/${roomId}/make-project?name=${encodeURIComponent(K.name + ' hidden')}`)
  expect(hidden).toMatchObject({ nameTaken: false, folderName: K.name + ' hidden' })
  const own = await mia.client.call('GET', `/api/rooms/${roomId}/make-project?name=${encodeURIComponent('Mine to see')}`)
  expect(own).toMatchObject({ nameTaken: true, folderName: 'Mine to see-2' })
  // a burst: the dry run's limit per person (nora, so mia's budget stays for the conversion below)
  let limited = 0
  for (let i = 0; i < 70; i++) if ((await nora.client.raw('GET', `/api/rooms/${roomId}/make-project?name=p${i}`)).status === 429) limited++
  expect(limited).toBeGreaterThan(0)
})

test('after the move: a former member gets 404, a member excluded from a narrowed Chat attachments sees "unavailable"', async () => {
  const i = await mia.client.call('GET', `/api/rooms/${roomId}/make-project`)
  // the file sent before otto joined stays in the conversation
  expect([i.filesMoving, i.filesStaying]).toEqual([1, 1])
  const r = await mia.client.call('POST', `/api/rooms/${roomId}/make-project`, { name: 'Sec plan', membersHash: i.membersHash })
  chat = `${r.project.folderPath}/${CHAT_FILES_FOLDER[teamDefaultLocale(h.ctx.db)]}`
  await roomFileMovesOf(h.ctx).run()
  expect((h.ctx.db.query('SELECT path FROM room_file_refs WHERE room_file_id = ?').get(fileId) as { path: string }).path).toBe(`${chat}/plan.txt`)
  // the early file is still a room file, and otto still cannot open it
  expect((await get(otto.client, `/api/rooms/${roomId}/files/${earlyId}`)).status).toBe(404)
  expect((await get(otto.client, `/api/rooms/${roomId}/files/${fileId}`)).text).toBe(K.secret)
  // narrowed: Chat attachments to mia and nora; otto is a member who no longer reads it
  h.ctx.db.transaction(() => writeFolderAccess(h.ctx.db, ensureFolderRow(h.ctx.db, chat).id, { rules: [{ subjectType: 'user', subjectId: mia.id, access: 'write' }, { subjectType: 'user', subjectId: nora.id, access: 'write' }], limited: true }, mia.id))()
  const page = (await otto.client.call('GET', `/api/rooms/${roomId}/messages`)).items as any[]
  const seen = page.flatMap((m) => m.files as any[]).find((x) => x.id === fileId)
  expect(seen).toMatchObject({ state: 'unavailable', name: '', size: 0 })
  expect(JSON.stringify(page)).not.toContain('plan.txt')
  const bytes = await get(otto.client, `/api/rooms/${roomId}/files/${fileId}`)
  expect(bytes.status).toBe(404)
  expect(bytes.text).not.toContain(K.secret)
  expect((await get(nora.client, `/api/rooms/${roomId}/files/${fileId}`)).text).toBe(K.secret)
  // a former member: nora leaves the project (her rule goes), the sync takes her out of the room
  h.ctx.db.query("DELETE FROM folder_rules WHERE subject_type = 'user' AND subject_id = ?").run(nora.id)
  const { roomsOf } = await import('../../server/src/rooms/service')
  roomsOf(h.ctx).sync({ projects: 'all' })
  expect(h.ctx.db.query('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?').get(roomId, nora.id)).toBeNull()
  for (const id of [fileId, earlyId]) {
    const x = await get(nora.client, `/api/rooms/${roomId}/files/${id}`)
    expect(x.status).toBe(404)
    expect(x.text).not.toContain(K.secret)
    expect(x.text).not.toContain(K.early)
  }
  expect((await get(nora.client, `/api/rooms/${roomId}/messages`)).status).toBe(404)
})
