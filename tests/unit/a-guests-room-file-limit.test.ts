// A guest's file limit (docs/decisions/20261116-guest-room-file-limit.md): 100 MB unless the owner or an admin
// raises it in Admin (TeamSettings.guestFileMax: 100 MB or 1 GB); members send up to 1 GB in a room whatever it says
// (docs/decisions/20261116-room-file-limit-1gb.md), and a guest is never allowed more than a member.
// Checked on the server from the sender's role at upload time, where an upload session starts and again where any
// upload is kept (one request, a finished session), in plain words with the guest's own limit.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { GUEST_FILE_MAX, ROOM_FILE_MAX } from '@mycel/shared/api'
import { setSetting } from '../../server/src/admin/settings'
import { HttpError } from '../../server/src/http/errors'
import { roomFilesOf } from '../../server/src/rooms/files'
import { addMember, harness, withOwner, type Harness } from './a-lib'
import { addGuest, groupChat, teamProject } from './guest-lib'

setDefaultTimeout(60_000)
let h: Harness
afterEach(async () => { await h?.close() })

const MB = 1024 * 1024
async function setup() {
  h = await harness('a-guests-room-file-limit')
  const owner = await withOwner(h)
  const ada = await addMember(h, owner, { username: 'ada', role: 'admin' })
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const room = await groupChat(mia.client, [nora.id, ada.id], 'Client call')
  const g = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'room', id: room } })
  await g.client.call('PATCH', '/api/me', { locale: 'en' }).catch(() => {})
  return { owner, ada, mia, room, g }
}
const start = (c: { raw: (m: string, p: string, b?: unknown) => Promise<Response> }, room: string, size: number) =>
  c.raw('POST', '/api/upload-sessions', { target: { kind: 'room', roomId: room, name: 'video.mov' }, size, sha256: 'a'.repeat(64) })
/** a sparse file of that size, as a finished upload leaves it */
function sparse(size: number): string {
  const p = path.join(h.ctx.config.dataDir, `sparse-${size}`)
  const fd = fs.openSync(p, 'w')
  fs.ftruncateSync(fd, size)
  fs.closeSync(fd)
  return p
}
const kept = async (userId: string, room: string, size: number) => {
  try { await roomFilesOf(h.ctx).create(userId, room, 'video.mov', sparse(size), 'b'.repeat(64)); return 'kept' } catch (e) { return e instanceof HttpError ? `${e.code}: ${e.message}` : `threw ${String(e)}` }
}

test('by default a guest sends up to 100 MB; a member up to 1 GB; the guest is told their own limit', async () => {
  const { mia, room, g } = await setup()
  expect((await g.client.call('GET', '/api/me')).team.uploadMaxBytes).toBe(100 * MB)
  expect((await mia.client.call('GET', '/api/me')).team.uploadMaxBytes).toBeUndefined()
  // an upload session: refused before any byte is sent
  expect((await start(g.client, room, 100 * MB)).status).toBe(201)
  const over = await start(g.client, room, 100 * MB + 1)
  expect(over.status).toBe(413)
  const err = ((await over.json()) as { error: { code: string; message: string; params: { reason: string; maxBytes: number } } }).error
  expect(err.code).toBe('payload_too_large')
  expect(err.params).toEqual({ reason: 'room_file_too_large', maxBytes: 100 * MB })
  expect(err.message).toMatch(/100 MB/)
  expect(err.message).not.toMatch(/GB/)
  // a member in the same room is not held to it, only to the room's 1 GB, in plain words
  expect(ROOM_FILE_MAX).toBe(1024 * MB)
  expect((await start(mia.client, room, ROOM_FILE_MAX)).status).toBe(201)
  const big = await start(mia.client, room, ROOM_FILE_MAX + 1)
  expect(big.status).toBe(413)
  const bigErr = ((await big.json()) as { error: { message: string; params: { reason: string; maxBytes: number } } }).error
  expect(bigErr.params).toEqual({ reason: 'room_file_too_large', maxBytes: 1024 * MB })
  expect(bigErr.message).toBe('이 파일은 대화에 보내기엔 너무 커요. 1 GB까지 보낼 수 있어요.')
  // where any upload is kept (a finished session; one request and a team file's copy pass the same check, but carry at
  // most 50 MB each, under the smallest guest limit): the same limit, from the role then
  expect(await kept(g.id, room, 100 * MB)).toBe('kept')
  expect(await kept(g.id, room, 100 * MB + 1)).toMatch(/^payload_too_large: .*100 MB/)
  expect(await kept(mia.id, room, 100 * MB + 1)).toBe('kept')
  // a member's finished upload: 1 GB is kept, one byte more is not
  expect(await kept(mia.id, room, ROOM_FILE_MAX)).toBe('kept')
  expect(await kept(mia.id, room, ROOM_FILE_MAX + 1)).toMatch(/^payload_too_large: .*1 GB/)
})

test('the owner or an admin raises it to 1 GB, never more; a member cannot; lowering it again holds at once', async () => {
  const { owner, ada, mia, room, g } = await setup()
  expect((await owner.call('GET', '/api/admin/settings')).guestFileMax).toBe('100mb')
  expect((await mia.client.raw('PATCH', '/api/admin/settings', { guestFileMax: '1gb' })).status).toBe(403)
  expect((await g.client.raw('PATCH', '/api/admin/settings', { guestFileMax: '1gb' })).status).toBe(403)
  expect((await ada.client.raw('PATCH', '/api/admin/settings', { guestFileMax: '5gb' })).status).toBe(400)
  // 10 GB is no choice any more: above a member's 1 GB
  expect((await owner.raw('PATCH', '/api/admin/settings', { guestFileMax: '10gb' })).status).toBe(400)
  expect(Object.keys(GUEST_FILE_MAX)).toEqual(['100mb', '1gb'])

  await ada.client.call('PATCH', '/api/admin/settings', { guestFileMax: '1gb' })
  expect((await g.client.call('GET', '/api/me')).team.uploadMaxBytes).toBe(GUEST_FILE_MAX['1gb'])
  expect((await start(g.client, room, 100 * MB + 1)).status).toBe(201)
  expect((await start(g.client, room, 1024 * MB)).status).toBe(201)
  const over = await start(g.client, room, 1024 * MB + 1)
  expect(over.status).toBe(413)
  expect(((await over.json()) as { error: { message: string } }).error.message).toMatch(/1 GB/)
  expect(await kept(g.id, room, 200 * MB)).toBe('kept')

  // 10 GB picked before this change, still stored: read as the member limit (1 GB), never above it
  setSetting(h.ctx.db, 'guestFileMax', '10gb')
  expect((await owner.call('GET', '/api/admin/settings')).guestFileMax).toBe('1gb')
  expect((await g.client.call('GET', '/api/me')).team.uploadMaxBytes).toBe(ROOM_FILE_MAX)
  expect((await start(g.client, room, ROOM_FILE_MAX)).status).toBe(201)
  expect((await start(g.client, room, ROOM_FILE_MAX + 1)).status).toBe(413)
  expect(await kept(g.id, room, ROOM_FILE_MAX + 1)).toMatch(/^payload_too_large: .*1 GB/)

  // lowered while a larger upload was on its way: it is not kept when it completes
  await owner.call('PATCH', '/api/admin/settings', { guestFileMax: '100mb' })
  expect(await kept(g.id, room, 200 * MB)).toMatch(/^payload_too_large: .*100 MB/)
  expect((h.ctx.db.query("SELECT COUNT(*) n FROM room_files WHERE user_id = ? AND size > ?").get(g.id, 100 * MB) as { n: number }).n).toBe(1)
})

test('an upload session that was allowed when it started is refused when it completes after the limit was lowered, and nothing of it stays', async () => {
  const { owner, room, g } = await setup()
  await owner.call('PATCH', '/api/admin/settings', { guestFileMax: '1gb' })
  // 100 MB + 1 of zeros, sent in 8 MB chunks as the web app does
  const size = 100 * MB + 1
  const hash = crypto.createHash('sha256')
  const chunk = Buffer.alloc(8 * MB)
  for (let left = size; left > 0; left -= chunk.length) hash.update(left >= chunk.length ? chunk : chunk.subarray(0, left))
  const s = await g.client.call('POST', '/api/upload-sessions', { target: { kind: 'room', roomId: room, name: 'video.mov' }, size, sha256: hash.digest('hex') })
  // the guest's own session (its cookie or token), for a body that is bytes
  const auth: Record<string, string> = { 'x-mycel-csrf': '1', ...(g.client.cookie ? { cookie: g.client.cookie } : {}), ...(g.client.token ? { authorization: `Bearer ${g.client.token}` } : {}) }
  const send = (p: string, init: RequestInit) => h.fetch(p, { ...init, headers: auth, ip: '10.0.0.9' })
  for (let n = 0; n < s.chunkCount; n++) {
    const len = Math.min(chunk.length, size - n * chunk.length)
    expect((await send(`/api/upload-sessions/${s.id}/chunks/${n}`, { method: 'PUT', body: chunk.subarray(0, len) })).status).toBe(200)
  }
  await owner.call('PATCH', '/api/admin/settings', { guestFileMax: '100mb' })
  const done = await g.client.raw('POST', `/api/upload-sessions/${s.id}/complete`)
  expect(done.status).toBe(413)
  expect(((await done.json()) as { error: { message: string; params: { maxBytes: number } } }).error.params.maxBytes).toBe(100 * MB)
  expect(h.ctx.db.query('SELECT 1 FROM upload_sessions WHERE id = ?').get(s.id)).toBeNull()
  expect(fs.existsSync(path.join(h.ctx.config.dataDir, 'uploads', `${s.id}.part`))).toBe(false)
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM room_files WHERE user_id = ?').get(g.id)).toEqual({ n: 0 })
})

test('the limit covers every upload a guest makes: a file put in their project\'s folder and a file attached to a chat, at the start and at the end', async () => {
  h = await harness('a-guests-room-file-limit')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const project = await teamProject(mia.client, 'Acme bid')
  const g = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'project', id: project.id } })
  const chat = await g.client.call('POST', '/api/chats', { projectId: project.id })
  const sha = 'a'.repeat(64)
  const toFolder = (c: typeof g.client, size: number, name = 'survey.mov') => c.raw('POST', '/api/upload-sessions', { target: { kind: 'path', path: `${project.folder}/${name}`, onExists: 'rename' }, size, sha256: sha })
  const toChat = (c: typeof g.client, chatId: string, size: number) => c.raw('POST', '/api/upload-sessions', { target: { kind: 'attachment', chatId, name: 'survey.mov' }, size, sha256: sha })
  const refusal = async (r: Response) => ({ status: r.status, ...(((await r.json()) as { error: { message: string; params?: { reason?: string; maxBytes?: number } } }).error) })

  // the project's folder: 100 MB fits, one byte more does not; in plain words with the guest's own limit
  expect((await toFolder(g.client, 100 * MB)).status).toBe(201)
  const folder = await refusal(await toFolder(g.client, 100 * MB + 1))
  expect(folder).toMatchObject({ status: 413, code: 'payload_too_large', params: { reason: 'guest_file_too_large', maxBytes: 100 * MB } })
  expect(folder.message).toMatch(/100 MB/)
  expect(folder.message).not.toMatch(/GB/)
  // their AI chat
  expect((await toChat(g.client, chat.id, 100 * MB)).status).toBe(201)
  expect(await refusal(await toChat(g.client, chat.id, 100 * MB + 1))).toMatchObject({ status: 413, params: { reason: 'guest_file_too_large', maxBytes: 100 * MB } })
  // a recording to transcribe: not for a guest at all, whatever its size
  expect((await g.client.raw('POST', '/api/upload-sessions', { target: { kind: 'transcribe', name: 'call.webm' }, size: 1000, sha256: sha })).status).toBe(403)
  // a member in the same project is not held to it
  expect((await toFolder(mia.client, 5 * 1024 * MB, 'film.mov')).status).toBe(201)
  // no disk room is reserved for what was refused
  expect((h.ctx.db.query('SELECT COALESCE(MAX(size), 0) n FROM upload_sessions WHERE user_id = ?').get(g.id) as { n: number }).n).toBe(100 * MB)

  // raised: more fits; lowered again while a file was on its way: refused when it completes, nothing kept
  await owner.call('PATCH', '/api/admin/settings', { guestFileMax: '1gb' })
  expect((await toChat(g.client, chat.id, 1024 * MB)).status).toBe(201)
  expect((await refusal(await toChat(g.client, chat.id, 1024 * MB + 1))).message).toMatch(/1 GB/)
  const data = Buffer.alloc(3000, 7)
  const auth: Record<string, string> = { 'x-mycel-csrf': '1', ...(g.client.cookie ? { cookie: g.client.cookie } : {}), ...(g.client.token ? { authorization: `Bearer ${g.client.token}` } : {}) }
  for (const target of [{ kind: 'path', path: `${project.folder}/late.bin`, onExists: 'rename' }, { kind: 'attachment', chatId: chat.id, name: 'late.bin' }]) {
    const s = await g.client.call('POST', '/api/upload-sessions', { target, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') })
    expect((await h.fetch(`/api/upload-sessions/${s.id}/chunks/0`, { method: 'PUT', body: data, headers: auth, ip: '10.0.0.9' })).status).toBe(200)
    // the team's limit drops below this file (a stored value that is no choice counts as the smallest: here the test
    // makes the file larger than it instead, by saying so in the session)
    h.ctx.db.query('UPDATE upload_sessions SET size = ? WHERE id = ?').run(1024 * MB + 1, s.id)
    const done = await refusal(await g.client.raw('POST', `/api/upload-sessions/${s.id}/complete`))
    expect(done).toMatchObject({ status: 413, params: { reason: 'guest_file_too_large' } })
    expect(h.ctx.db.query('SELECT 1 FROM upload_sessions WHERE id = ?').get(s.id)).toBeNull()
    expect(fs.existsSync(path.join(h.ctx.config.dataDir, 'uploads', `${s.id}.part`))).toBe(false)
  }
  expect(fs.existsSync(path.join(h.ctx.files.fx.root, ...project.folder.split('/'), 'late.bin'))).toBe(false)
})

test('one request (a file to a folder, a chat attachment): a guest within the limit uploads as before', async () => {
  h = await harness('a-guests-room-file-limit')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const project = await teamProject(mia.client, 'Acme bid')
  const g = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'project', id: project.id } })
  const chat = await g.client.call('POST', '/api/chats', { projectId: project.id })
  const auth: Record<string, string> = { 'x-mycel-csrf': '1', ...(g.client.cookie ? { cookie: g.client.cookie } : {}), ...(g.client.token ? { authorization: `Bearer ${g.client.token}` } : {}) }
  const post = (p: string, fields: Record<string, string>) => {
    const fd = new FormData()
    for (const [k, v] of Object.entries(fields)) fd.set(k, v)
    fd.set('file', new File([Buffer.alloc(2000, 1)], 'note.bin'))
    return h.fetch(p, { method: 'POST', body: fd, headers: auth, ip: '10.0.0.9' })
  }
  // one request carries at most 50 MB, under the smallest guest limit: the check is there and passes
  expect((await post('/api/files/upload', { folder: project.folder, name: 'note.bin' })).status).toBe(201)
  expect((await post('/api/uploads', { chatId: chat.id, name: 'note.bin' })).status).toBe(201)
})
