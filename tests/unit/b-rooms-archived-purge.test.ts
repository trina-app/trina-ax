// The files of a conversation nobody is in any more go 30 days after it was archived; its messages stay. Daily, from
// the rooms' tick (sweep), with the set-aside batches' purge (docs/decisions/20261116-archived-room-files-purge.md).
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { API, uuidv7, type RoomFile, type RoomMessage } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { DAILY_MS, ORPHAN_KEEP_MS, roomFilesOf } from '../../server/src/rooms/files'

setDefaultTimeout(60_000)
const DAY = 86400_000
let h: Harness
beforeAll(async () => { h = await startHarness({ name: 'b-rooms-archived-purge' }) })
afterAll(async () => { await h.close() })

async function upload(user: string, roomId: string, name: string): Promise<RoomFile> {
  const bytes = new TextEncoder().encode(`fake file ${name} ${uuidv7()}`)
  const src = path.join(h.dataDir, `upload-${uuidv7()}`)
  fs.writeFileSync(src, bytes)
  return roomFilesOf(h.ctx).create(user, roomId, name, src, createHash('sha256').update(bytes).digest('hex'))
}
async function roomWithFile(name: string) {
  const roomId = (await h.api('alice').call(API.createRoom, { body: { kind: 'group', userIds: ['erin', 'carol'] } })).id
  const f = await upload('alice', roomId, name)
  const m = await h.api('alice').call(API.sendRoomMessage, { params: { id: roomId }, body: { body: 'here', clientMessageId: 'cm-' + uuidv7(), mentions: [], fileIds: [f.id] } }) as RoomMessage
  return { roomId, file: f, messageId: m.id }
}
const root = () => roomFilesOf(h.ctx).root()
const onDisk = (roomId: string, fileId: string) => fs.existsSync(path.join(root(), roomId, fileId))
const row = (fileId: string) => !!h.ctx.db.query('SELECT 1 FROM room_files WHERE id = ?').get(fileId)
/** archived `ago` before `now`, as the last one out leaves it: no members */
function archive(roomId: string, at: number) {
  h.ctx.db.query('DELETE FROM room_members WHERE room_id = ?').run(roomId)
  h.ctx.db.query('UPDATE rooms SET archived_at = ? WHERE id = ?').run(new Date(at).toISOString(), roomId)
}

test('31 days after it was archived its files and rows go, its messages stay; 29 days and a live conversation keep theirs; the next run waits a day', async () => {
  const now = Date.now() + 2 * DAILY_MS // past the day reconcile counted at start
  const old = await roomWithFile('old.pdf')
  const recent = await roomWithFile('recent.pdf')
  const live = await roomWithFile('live.pdf')
  archive(old.roomId, now - ORPHAN_KEEP_MS - DAY)
  archive(recent.roomId, now - ORPHAN_KEEP_MS + DAY)
  expect(onDisk(old.roomId, old.file.id)).toBe(true)

  roomFilesOf(h.ctx).sweep(now)
  expect([row(old.file.id), onDisk(old.roomId, old.file.id), fs.existsSync(path.join(root(), old.roomId))]).toEqual([false, false, false])
  expect(h.ctx.db.query('SELECT 1 FROM room_messages WHERE id = ?').get(old.messageId)).toBeTruthy()
  expect([row(recent.file.id), onDisk(recent.roomId, recent.file.id)]).toEqual([true, true])
  expect([row(live.file.id), onDisk(live.roomId, live.file.id)]).toEqual([true, true])

  // within the day: nothing more, though the second one is now past 30 days
  roomFilesOf(h.ctx).sweep(now + 1000)
  expect(row(recent.file.id)).toBe(true)
  roomFilesOf(h.ctx).sweep(now + 2 * DAY)
  expect([row(recent.file.id), onDisk(recent.roomId, recent.file.id)]).toEqual([false, false])
  expect(row(live.file.id)).toBe(true)
})

test('an archived conversation that still has a member keeps its files (only unreachable ones go)', async () => {
  const now = Date.now() + 10 * DAILY_MS
  const r = await roomWithFile('member-still.pdf')
  h.ctx.db.query('UPDATE rooms SET archived_at = ? WHERE id = ?').run(new Date(now - ORPHAN_KEEP_MS - DAY).toISOString(), r.roomId)
  expect(roomFilesOf(h.ctx).purgeArchived(now).files).toBe(0)
  expect(row(r.file.id)).toBe(true)
})

test('a clock earlier than the newest room file or archive: nothing goes', async () => {
  const r = await roomWithFile('clock.pdf')
  const now = Date.now()
  archive(r.roomId, now + DAY) // archived "tomorrow": this clock is behind
  expect(roomFilesOf(h.ctx).purgeArchived(now + ORPHAN_KEEP_MS).files).toBe(0)
  expect(row(r.file.id)).toBe(true)
  h.ctx.db.query('UPDATE rooms SET archived_at = ? WHERE id = ?').run(new Date(now - ORPHAN_KEEP_MS - DAY).toISOString(), r.roomId)
  expect(roomFilesOf(h.ctx).purgeArchived(now).files).toBe(1)
})

test('set-aside batches older than 30 days go from the daily tick, not only at start', async () => {
  const now = Date.now() + 40 * DAILY_MS
  const sys = path.dirname(root())
  const batch = path.join(sys, 'rooms-orphans', '20200101T000000Z-1-0')
  fs.mkdirSync(path.join(batch, 'r1'), { recursive: true })
  fs.writeFileSync(path.join(batch, 'r1', 'f1'), 'x')
  const old = new Date(now - ORPHAN_KEEP_MS - DAY)
  fs.utimesSync(batch, old, old)
  roomFilesOf(h.ctx).sweep(now)
  expect(fs.existsSync(batch)).toBe(false)
})
