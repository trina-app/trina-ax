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
  const roomId = (await h.api('alice').call(API.createRoom, { body: { kind: 'group', userIds: ['erin', 'carol'], name } })).id // named: each a room of its own (the same people's group DM would be opened again)
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

/** the daily part has not run since "this start": the first tick runs it */
const fresh = () => { (roomFilesOf(h.ctx) as unknown as { dailyAt: number | null }).dailyAt = null }
/** whatever the earlier tests left archived and over 30 days old goes first, so each test counts only its own */
const clean = (now: number) => { while (roomFilesOf(h.ctx).purgeArchived(now).more) { /* */ } }

test('31 days after it was archived its files, thumbnails and rows go, its messages stay; 29 days and a live conversation keep theirs; once a day', async () => {
  const now = Date.now() + 60_000 // after the files these tests make (the clock guard looks at the newest)
  const old = await roomWithFile('old.pdf')
  const recent = await roomWithFile('recent.pdf')
  const live = await roomWithFile('live.pdf')
  const thumb = path.join(root(), old.roomId, `${old.file.id}.thumb.jpg`)
  fs.writeFileSync(thumb, 'thumb')
  archive(old.roomId, now - ORPHAN_KEEP_MS - DAY)
  archive(recent.roomId, now - ORPHAN_KEEP_MS + DAY)
  fresh()

  roomFilesOf(h.ctx).sweep(now)
  expect([row(old.file.id), onDisk(old.roomId, old.file.id), fs.existsSync(thumb), fs.existsSync(path.join(root(), old.roomId))]).toEqual([false, false, false, false])
  expect(h.ctx.db.query('SELECT 1 FROM room_messages WHERE id = ?').get(old.messageId)).toBeTruthy()
  expect([row(recent.file.id), onDisk(recent.roomId, recent.file.id)]).toEqual([true, true])
  expect([row(live.file.id), onDisk(live.roomId, live.file.id)]).toEqual([true, true])

  // two days later the second is past 30 days too, but within a day of the last run nothing more is done
  roomFilesOf(h.ctx).sweep(now + DAILY_MS - 1000)
  expect(row(recent.file.id)).toBe(true)
  roomFilesOf(h.ctx).sweep(now + 2 * DAY)
  expect([row(recent.file.id), onDisk(recent.roomId, recent.file.id)]).toEqual([false, false])
  expect(row(live.file.id)).toBe(true)
  // a clock set back: the day starts again from it, so the daily part does not stop for good
  roomFilesOf(h.ctx).sweep(now)
  expect((roomFilesOf(h.ctx) as unknown as { dailyAt: number }).dailyAt).toBe(now)
})

test('an archived conversation that still has a member keeps its files (only unreachable ones go)', async () => {
  const now = Date.now() + 60_000 // after the files these tests make (the clock guard looks at the newest)
  clean(now)
  const r = await roomWithFile('member-still.pdf')
  h.ctx.db.query('UPDATE rooms SET archived_at = ? WHERE id = ?').run(new Date(now - ORPHAN_KEEP_MS - DAY).toISOString(), r.roomId)
  expect(roomFilesOf(h.ctx).purgeArchived(now).files).toBe(0)
  expect(row(r.file.id)).toBe(true)
})

test('a clock earlier than the newest archive or the newest room file: nothing goes', async () => {
  const now = Date.now() + 60_000 // after the files these tests make (the clock guard looks at the newest)
  clean(now)
  const due = await roomWithFile('due.pdf')
  archive(due.roomId, now - ORPHAN_KEEP_MS - DAY)
  // another conversation archived "tomorrow": this clock is behind
  const other = await roomWithFile('other.pdf')
  archive(other.roomId, now + DAY)
  expect(roomFilesOf(h.ctx).purgeArchived(now).files).toBe(0)
  expect(row(due.file.id)).toBe(true)
  archive(other.roomId, now - DAY)
  // a room file stamped "tomorrow"
  h.ctx.db.query('UPDATE room_files SET created_at = ? WHERE id = ?').run(new Date(now + DAY).toISOString(), other.file.id)
  expect(roomFilesOf(h.ctx).purgeArchived(now).files).toBe(0)
  h.ctx.db.query('UPDATE room_files SET created_at = ? WHERE id = ?').run(new Date(now - DAY).toISOString(), other.file.id)
  expect(roomFilesOf(h.ctx).purgeArchived(now).files).toBe(1)
  expect(row(due.file.id)).toBe(false)
})

test('without the room files folder (a share not mounted) nothing goes', async () => {
  const now = Date.now() + 60_000 // after the files these tests make (the clock guard looks at the newest)
  clean(now)
  const r = await roomWithFile('share.pdf')
  archive(r.roomId, now - ORPHAN_KEEP_MS - DAY)
  const away = `${root()}-away`
  fs.renameSync(root(), away)
  try { expect(roomFilesOf(h.ctx).purgeArchived(now).files).toBe(0) } finally { fs.renameSync(away, root()) }
  expect(row(r.file.id)).toBe(true)
  expect(roomFilesOf(h.ctx).purgeArchived(now).files).toBe(1)
})

test('a run cut short goes on at the next tick', async () => {
  const now = Date.now() + 60_000 // after the files these tests make (the clock guard looks at the newest)
  clean(now)
  const a = await roomWithFile('a.pdf')
  const f2 = await upload('alice', a.roomId, 'b.pdf')
  await h.api('alice').call(API.sendRoomMessage, { params: { id: a.roomId }, body: { body: 'more', clientMessageId: 'cm-' + uuidv7(), mentions: [], fileIds: [f2.id] } })
  archive(a.roomId, now - ORPHAN_KEEP_MS - DAY)
  // one row a statement and no time: one file, and more to do
  expect(roomFilesOf(h.ctx).purgeArchived(now, { batch: 1, budgetMs: -1 })).toEqual({ files: 1, more: true })
  expect(roomFilesOf(h.ctx).purgeArchived(now, { batch: 1, budgetMs: -1 }).files).toBe(1)
  expect([row(a.file.id), row(f2.id)]).toEqual([false, false])
})

test('set-aside batches older than 30 days go from the daily tick, not only at start', async () => {
  const now = Date.now() + 60_000 // after the files these tests make (the clock guard looks at the newest)
  const sys = path.dirname(root())
  const batch = path.join(sys, 'rooms-orphans', '20200101T000000Z-1-0')
  fs.mkdirSync(path.join(batch, 'r1'), { recursive: true })
  fs.writeFileSync(path.join(batch, 'r1', 'f1'), 'x')
  const old = new Date(now - ORPHAN_KEEP_MS - DAY)
  fs.utimesSync(batch, old, old)
  fresh()
  roomFilesOf(h.ctx).sweep(now)
  expect(fs.existsSync(batch)).toBe(false)
})
