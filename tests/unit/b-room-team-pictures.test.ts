// Pictures kept in the team folder show as pictures in rooms (docs/AGENTS/plan/20261122-0840-team-folder-room-pictures.md):
// a picture sent in a department's group channel or a project's room lands in Chat attachments with a room_file_refs
// row; its RoomFile says thumb: true when a preview can be given, and GET ?thumb=1 gives one made from the team file as
// it is now (rooms/team-thumbs.ts: kept per version, made again when the file changes, gone with the row), or the
// picture itself only when it is a small web image and no thumbnail could be made; never a large original. The read
// checks run first every time: a non-member, an admin outside the room, a file renamed to a non-picture name, a deleted
// file, a quarantined file and an unsent upload of someone else get nothing. SVG stays a chip.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { CHAT_FILES_FOLDER } from '@mycel/shared'
import type { RoomFile } from '@mycel/shared/api'
import { teamDefaultLocale } from '../../server/src/admin/settings'
import { which } from '../../server/src/config'
import { roomFilesOf } from '../../server/src/rooms/files'
import { resetConvertTools, TEAM_THUMBS_DIR } from '../../server/src/rooms/team-thumbs'
import { componentC } from '../../server/src/team-files/component'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

setDefaultTimeout(120_000)
let h: Harness
afterEach(async () => { resetConvertTools(); await h?.close() })

const FFMPEG = which('ffmpeg')
const MB = 1024 * 1024
const cm = () => 'cm-' + crypto.randomUUID()
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const at = (rel: string) => path.join(h.ctx.files.fx.root, ...rel.split('/'))
const team = () => componentC(h.ctx).files
const user = (id: string) => ({ subjectType: 'user', subjectId: id })
/** a 4 x 4 opaque PNG */
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGM4IScHRwzEcQCxYxBBO0tjggAAAABJRU5ErkJggg==', 'base64')
/** a picture of random pixels made by ffmpeg (large as PNG) */
function noisePng(w: number, hgt: number, seed = 1): Buffer {
  const out = path.join(h.ctx.config.dataDir, `noise-${crypto.randomUUID()}.png`)
  const r = spawnSync(FFMPEG!, ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', `nullsrc=s=${w}x${hgt},geq=random(${seed})*255:random(${seed + 1})*255:128`, '-frames:v', '1', out])
  if (r.status !== 0) throw new Error(String(r.stderr))
  const b = fs.readFileSync(out)
  fs.rmSync(out)
  return b
}
async function up(userId: string, roomId: string, name: string, bytes: Uint8Array): Promise<RoomFile> {
  const src = path.join(h.ctx.config.dataDir, `upload-${crypto.randomUUID()}`)
  fs.writeFileSync(src, bytes)
  return roomFilesOf(h.ctx).create(userId, roomId, name, src, sha(bytes))
}
const send = (c: Client, roomId: string, fileIds: string[], body = '') => c.call('POST', `/api/rooms/${roomId}/messages`, { body, clientMessageId: cm(), fileIds })
const filesOf = async (c: Client, roomId: string, messageId: string): Promise<RoomFile[]> => ((await c.call('GET', `/api/rooms/${roomId}/messages`)).items as any[]).find((m) => m.id === messageId)?.files ?? []
async function thumb(c: Client, roomId: string, fileId: string) {
  const r = await c.raw('GET', `/api/rooms/${roomId}/files/${fileId}?thumb=1`)
  return { status: r.status, type: r.headers.get('content-type') ?? '', bytes: Buffer.from(await r.arrayBuffer()) }
}
const cacheOf = (fileId: string) => { try { return fs.readdirSync(path.join(h.ctx.config.dataDir, TEAM_THUMBS_DIR, fileId)) } catch { return [] } }
const isJpegOrPng = (b: Buffer) => (b[0] === 0xff && b[1] === 0xd8) || (b[0] === 0x89 && b[1] === 0x50)

async function groupChannel(name: string) {
  h = await harness(name)
  const owner = await withOwner(h)
  const ada = await addMember(h, owner, { username: 'ada', role: 'admin' })
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const group = await owner.call('POST', '/api/admin/groups', { name: 'leads', memberIds: [mia.id, nora.id] })
  const folder = h.ctx.db.query('SELECT f.path FROM groups g JOIN folders f ON f.id = g.folder_id WHERE g.id = ?').get(group.id) as { path: string }
  const roomId = (h.ctx.db.query("SELECT id FROM rooms WHERE kind = 'team' AND group_id = ? AND archived_at IS NULL").get(group.id) as { id: string }).id
  return { owner, ada, mia, nora, otto, roomId, chat: `${folder.path}/${CHAT_FILES_FOLDER[teamDefaultLocale(h.ctx.db)]}` }
}
async function projectRoom(name: string) {
  h = await harness(name)
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const p = await mia.client.call('POST', '/api/projects', { name: 'Launch site', participants: [user(nora.id)] })
  const room = await mia.client.call('POST', `/api/projects/${p.id}/room`)
  const root = (h.ctx.db.query('SELECT folder_path FROM projects WHERE id = ?').get(p.id) as { folder_path: string }).folder_path
  return { owner, mia, nora, otto, roomId: room.id as string, root, chat: `${root}/${CHAT_FILES_FOLDER[teamDefaultLocale(h.ctx.db)]}` }
}

test('group channel: a pasted PNG is a picture (thumb), its thumbnail is made from the team file, kept, and only members get it', async () => {
  const { mia, nora, otto, ada, roomId, chat } = await groupChannel('b-room-team-pictures-group')
  const f = await up(mia.id, roomId, 'image.png', TINY_PNG)
  expect(f).toMatchObject({ kind: 'image', thumb: true, teamFile: true, teamPath: `${chat}/image.png` })
  const m = await send(mia.client, roomId, [f.id])
  const [seen] = await filesOf(nora.client, roomId, m.id)
  expect(seen).toMatchObject({ kind: 'image', thumb: true, teamFile: true })
  const t = await thumb(nora.client, roomId, f.id)
  expect(t.status).toBe(200)
  expect(t.type).toMatch(/^image\/(png|jpeg)/)
  expect(isJpegOrPng(t.bytes)).toBe(true)
  if (FFMPEG) expect(cacheOf(f.id).length).toBe(1)
  // the second read is the kept one
  expect((await thumb(nora.client, roomId, f.id)).bytes.equals(t.bytes)).toBe(true)
  // not in the room: nothing, the same as a missing file (an admin outside it reads the folder in Files, not here)
  expect((await thumb(otto.client, roomId, f.id)).status).toBe(404)
  expect((await thumb(ada.client, roomId, f.id)).status).toBe(404)
  // an SVG stays a chip, as in other rooms
  const svg = await up(mia.id, roomId, 'logo.svg', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>'))
  expect(svg.thumb).toBe(false)
  expect((await thumb(mia.client, roomId, svg.id)).status).toBe(404)
  // someone else's unsent upload: nothing
  const unsent = await up(mia.id, roomId, 'draft.png', TINY_PNG)
  expect((await thumb(nora.client, roomId, unsent.id)).status).toBe(404)
  expect((await thumb(mia.client, roomId, unsent.id)).status).toBe(200)
})

test.skipIf(!FFMPEG)('project room: a large picture gets a small thumbnail, never its original; a changed file gets a new one; the message deleted takes the kept thumbnail', async () => {
  const { mia, nora, roomId, chat } = await projectRoom('b-room-team-pictures-large')
  const big = noisePng(1600, 1200)
  expect(big.length).toBeGreaterThan(2 * MB)
  const f = await up(mia.id, roomId, 'photo.png', big)
  expect(f).toMatchObject({ kind: 'image', thumb: true, teamFile: true })
  const m = await send(mia.client, roomId, [f.id])
  const t = await thumb(nora.client, roomId, f.id)
  expect(t.status).toBe(200)
  expect(isJpegOrPng(t.bytes)).toBe(true)
  expect(t.bytes.length).toBeLessThan(big.length / 2)
  const first = cacheOf(f.id)
  expect(first.length).toBe(1)
  // the team file changed in Files (another picture, same name): another thumbnail, the older one goes
  const other = noisePng(1200, 900, 7)
  fs.writeFileSync(at(`${chat}/photo.png`), other)
  const t2 = await thumb(nora.client, roomId, f.id)
  expect(t2.status).toBe(200)
  expect(t2.bytes.equals(t.bytes)).toBe(false)
  const second = cacheOf(f.id)
  expect(second.length).toBe(1)
  expect(second[0]).not.toBe(first[0])
  // no converter here: the large one is a chip (no thumbnail, its original never sent as one); a small one is itself
  resetConvertTools({ ffmpeg: false, heic: false })
  fs.rmSync(path.join(h.ctx.config.dataDir, TEAM_THUMBS_DIR, f.id), { recursive: true, force: true })
  expect((await filesOf(nora.client, roomId, m.id))[0]).toMatchObject({ kind: 'image', thumb: false })
  expect((await thumb(nora.client, roomId, f.id)).status).toBe(404)
  const small = await up(mia.id, roomId, 'small.png', TINY_PNG)
  expect(small.thumb).toBe(true)
  resetConvertTools()
  // the message deleted: the file stays in the folder, its kept thumbnail goes
  await thumb(nora.client, roomId, f.id)
  expect(cacheOf(f.id).length).toBe(1)
  await mia.client.call('DELETE', `/api/rooms/${roomId}/messages/${m.id}`)
  expect(fs.existsSync(at(`${chat}/photo.png`))).toBe(true)
  expect(cacheOf(f.id)).toEqual([])
})

test('renamed to a non-picture name: a chip, no thumbnail; trashed: the gone state, nothing; quarantined: nothing', async () => {
  const { mia, nora, roomId, chat } = await projectRoom('b-room-team-pictures-states')
  const a = await up(mia.id, roomId, 'a.png', TINY_PNG)
  const b = await up(mia.id, roomId, 'b.png', Buffer.concat([TINY_PNG]))
  const m = await send(mia.client, roomId, [a.id, b.id])
  expect((await filesOf(nora.client, roomId, m.id)).map((f) => f.thumb)).toEqual([true, true])
  team().move(mia.id, `${chat}/a.png`, `${chat}/a.txt`, 'fail')
  const [renamed] = await filesOf(nora.client, roomId, m.id)
  expect(renamed).toMatchObject({ name: 'a.txt', kind: 'text', thumb: false })
  expect((await thumb(nora.client, roomId, a.id)).status).toBe(404)
  team().remove(mia.id, `${chat}/b.png`)
  const gone = (await filesOf(nora.client, roomId, m.id))[1]!
  expect(gone).toMatchObject({ state: 'deleted', thumb: false })
  expect((await thumb(nora.client, roomId, b.id)).status).toBe(404)
  // bytes on the download-only list: no preview (unavailable in the room, as any read of a quarantined team file)
  const q = await up(mia.id, roomId, 'q.png', TINY_PNG)
  await send(mia.client, roomId, [q.id])
  h.ctx.files.quarantine.add(fs.readFileSync(at(`${chat}/q.png`)), 'image')
  const qs = await thumb(nora.client, roomId, q.id)
  expect(qs.status).not.toBe(200)
  expect(cacheOf(q.id)).toEqual([])
})
