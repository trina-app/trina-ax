// A guest's room file limit (docs/decisions/20261116-guest-room-file-limit.md): 100 MB unless the owner or an admin
// raises it in Admin (TeamSettings.guestRoomFileMax: 100 MB, 1 GB or 10 GB); members send up to 10 GB whatever it says.
// Checked on the server from the sender's role at upload time, where an upload session starts and again where any
// upload is kept (one request, a finished session), in plain words with the guest's own limit.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { GUEST_ROOM_FILE_MAX, ROOM_FILE_MAX } from '@mycel/shared/api'
import { HttpError } from '../../server/src/http/errors'
import { roomFilesOf } from '../../server/src/rooms/files'
import { addMember, harness, withOwner, type Harness } from './a-lib'
import { addGuest, groupChat } from './guest-lib'

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

test('by default a guest sends up to 100 MB; a member up to 10 GB; the guest is told their own limit', async () => {
  const { mia, room, g } = await setup()
  expect((await g.client.call('GET', '/api/me')).team.roomFileMaxBytes).toBe(100 * MB)
  expect((await mia.client.call('GET', '/api/me')).team.roomFileMaxBytes).toBeUndefined()
  // an upload session: refused before any byte is sent
  expect((await start(g.client, room, 100 * MB)).status).toBe(201)
  const over = await start(g.client, room, 100 * MB + 1)
  expect(over.status).toBe(413)
  const err = ((await over.json()) as { error: { code: string; message: string; params: { reason: string; maxBytes: number } } }).error
  expect(err.code).toBe('payload_too_large')
  expect(err.params).toEqual({ reason: 'room_file_too_large', maxBytes: 100 * MB })
  expect(err.message).toMatch(/100 MB/)
  expect(err.message).not.toMatch(/10 GB/)
  // a member in the same room is not held to it
  expect((await start(mia.client, room, ROOM_FILE_MAX)).status).toBe(201)
  expect((await start(mia.client, room, ROOM_FILE_MAX + 1)).status).toBe(413)
  // where any upload is kept (a finished session; one request and a team file's copy pass the same check, but carry at
  // most 50 MB each, under the smallest guest limit): the same limit, from the role then
  expect(await kept(g.id, room, 100 * MB)).toBe('kept')
  expect(await kept(g.id, room, 100 * MB + 1)).toMatch(/^payload_too_large: .*100 MB/)
  expect(await kept(mia.id, room, 100 * MB + 1)).toBe('kept')
})

test('the owner or an admin raises it (1 GB, 10 GB); a member cannot; lowering it again holds at once', async () => {
  const { owner, ada, mia, room, g } = await setup()
  expect((await owner.call('GET', '/api/admin/settings')).guestRoomFileMax).toBe('100mb')
  expect((await mia.client.raw('PATCH', '/api/admin/settings', { guestRoomFileMax: '10gb' })).status).toBe(403)
  expect((await g.client.raw('PATCH', '/api/admin/settings', { guestRoomFileMax: '10gb' })).status).toBe(403)
  expect((await ada.client.raw('PATCH', '/api/admin/settings', { guestRoomFileMax: '5gb' })).status).toBe(400)

  await ada.client.call('PATCH', '/api/admin/settings', { guestRoomFileMax: '1gb' })
  expect((await g.client.call('GET', '/api/me')).team.roomFileMaxBytes).toBe(GUEST_ROOM_FILE_MAX['1gb'])
  expect((await start(g.client, room, 100 * MB + 1)).status).toBe(201)
  expect((await start(g.client, room, 1024 * MB)).status).toBe(201)
  const over = await start(g.client, room, 1024 * MB + 1)
  expect(over.status).toBe(413)
  expect(((await over.json()) as { error: { message: string } }).error.message).toMatch(/1 GB/)
  expect(await kept(g.id, room, 200 * MB)).toBe('kept')

  await owner.call('PATCH', '/api/admin/settings', { guestRoomFileMax: '10gb' })
  expect((await start(g.client, room, ROOM_FILE_MAX)).status).toBe(201)
  expect((await start(g.client, room, ROOM_FILE_MAX + 1)).status).toBe(413)

  // lowered while a larger upload was on its way: it is not kept when it completes
  await owner.call('PATCH', '/api/admin/settings', { guestRoomFileMax: '100mb' })
  expect(await kept(g.id, room, 200 * MB)).toMatch(/^payload_too_large: .*100 MB/)
  expect((h.ctx.db.query("SELECT COUNT(*) n FROM room_files WHERE user_id = ? AND size > ?").get(g.id, 100 * MB) as { n: number }).n).toBe(1)
})

test('an upload session that was allowed when it started is refused when it completes after the limit was lowered, and nothing of it stays', async () => {
  const { owner, room, g } = await setup()
  await owner.call('PATCH', '/api/admin/settings', { guestRoomFileMax: '1gb' })
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
  await owner.call('PATCH', '/api/admin/settings', { guestRoomFileMax: '100mb' })
  const done = await g.client.raw('POST', `/api/upload-sessions/${s.id}/complete`)
  expect(done.status).toBe(413)
  expect(((await done.json()) as { error: { message: string; params: { maxBytes: number } } }).error.params.maxBytes).toBe(100 * MB)
  expect(h.ctx.db.query('SELECT 1 FROM upload_sessions WHERE id = ?').get(s.id)).toBeNull()
  expect(fs.existsSync(path.join(h.ctx.config.dataDir, 'uploads', `${s.id}.part`))).toBe(false)
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM room_files WHERE user_id = ?').get(g.id)).toEqual({ n: 0 })
})
