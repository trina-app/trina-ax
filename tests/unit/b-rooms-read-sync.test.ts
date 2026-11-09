// One person, several windows and devices (fix/read-sync): what they read anywhere reaches every other window of theirs
// over the real hub and sockets. A room read (POST …/read), a thread read and a mention: each window gets its position
// and badge (room.read, the room through room.updated, the thread's summary); a reconnecting window gets them in its
// replay; nobody else gets any of it.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { API, uuidv7, type RoomMessage } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'

setDefaultTimeout(30_000)
let h: Harness
beforeAll(async () => {
  h = await startHarness({ name: 'b-rooms-read-sync' })
  // the fixture's groups have short ids ('marketing'); the contract's group ids (and a team room's groupId) are UUIDv7
  const db = h.ctx.db
  db.exec('PRAGMA foreign_keys = OFF')
  for (const g of ['marketing', 'finance']) {
    const id = uuidv7()
    for (const sql of ['UPDATE groups SET id = ?1 WHERE id = ?2', 'UPDATE group_members SET group_id = ?1 WHERE group_id = ?2', "UPDATE folder_rules SET subject_id = ?1 WHERE subject_type = 'group' AND subject_id = ?2", 'UPDATE rooms SET group_id = ?1 WHERE group_id = ?2'])
      db.query(sql).run(id, g)
  }
  db.exec('PRAGMA foreign_keys = ON')
})
afterAll(async () => { await h.close() })

const cm = () => 'cm-' + crypto.randomUUID()
let groups = 0
async function room(memberIds: string[]): Promise<string> {
  const g = await h.api('dana').call(API.createGroup, { body: { name: `read-sync-${++groups}`, memberIds } })
  return (await h.api(memberIds[0]!).call(API.listRooms)).items.find((x) => x.kind === 'team' && x.groupId === g.id)!.id
}
const send = (user: string, roomId: string, body: string, extra: Partial<{ threadRootId: string; mentions: string[] }> = {}): Promise<RoomMessage> =>
  h.api(user).call(API.sendRoomMessage, { params: { id: roomId }, body: { body, clientMessageId: cm(), mentions: extra.mentions ?? [], fileIds: [], ...(extra.threadRootId ? { threadRootId: extra.threadRootId } : {}) } })

test('a room read in one window or device reaches all my others with my badge; nobody else hears of it', async () => {
  const roomId = await room(['alice', 'bob'])
  // alice in two browser windows and on her phone (a bearer session of the app); bob in one window
  const a1 = await h.ws('alice'), a2 = await h.ws('alice'), phone = await h.ws('alice', { bearer: true, client: 'mobile' }), b = await h.ws('bob')
  for (const s of [a1, a2, phone, b]) await s.next('hello')
  const m = await send('bob', roomId, 'hello alice')
  for (const s of [a1, a2, phone]) await s.next('room.message', (f) => f.data.message.id === m.id)
  // (bob's own send read the room for him, and only his windows heard of that)
  await b.next('room.read', (f) => f.data.roomId === roomId)
  const bobBefore = b.frames.length
  // she reads it on her phone
  expect(await h.api('alice', { client: 'mobile' }).call(API.markRoomRead, { params: { id: roomId }, body: { seq: m.seq } })).toMatchObject({ unreadCount: 0 })
  for (const s of [a1, a2, phone]) {
    const f = await s.next('room.read', (x) => x.data.roomId === roomId)
    expect(f.data).toEqual({ roomId, lastReadSeq: m.seq, unreadCount: 0, mentioned: false })
  }
  // bob is not told (no read receipts)
  await Bun.sleep(100)
  expect(b.frames.slice(bobBefore).some((f) => f.type === 'room.read')).toBe(false)
  for (const s of [a1, a2, phone, b]) s.close()
})

test('a mention and a followed thread read elsewhere: my other windows lose the "@" and the thread count', async () => {
  const roomId = await room(['alice', 'bob'])
  const a1 = await h.ws('alice'), a2 = await h.ws('alice')
  for (const s of [a1, a2]) await s.next('hello')
  const root = await send('alice', roomId, 'my root')
  const reply = await send('bob', roomId, '@Alice look', { threadRootId: root.id, mentions: ['alice'] })
  // a2 learns the thread has news for her and that it mentions her
  const news = await a2.next('room.updated', (f) => f.data.roomId === roomId && (f.data.room?.threadsUnread ?? 0) > 0)
  expect(news.data.room).toMatchObject({ threadsUnread: 1, nextThreadId: root.id, mentioned: true })
  // she reads the thread in a1
  await h.api('alice').call(API.markRoomThreadRead, { params: { id: roomId, messageId: root.id }, body: { seq: reply.seq } })
  const read = await a2.next('room.updated', (f) => f.data.roomId === roomId && f.data.room?.threadsUnread === 0)
  expect(read.data.room).toMatchObject({ threadsUnread: 0, nextThreadId: null, mentioned: false })
  const summary = await a2.next('room.thread', (f) => f.data.rootId === root.id && f.data.thread?.newReplies === false)
  expect(summary.data.thread).toMatchObject({ replyCount: 1, newReplies: false })
  for (const s of [a1, a2]) s.close()
})

test('a window that was away gets the read in its replay when it comes back', async () => {
  const roomId = await room(['alice', 'bob'])
  const away = await h.ws('alice', { windowId: 'win-read-away' })
  await away.next('hello')
  const m = await send('bob', roomId, 'while away')
  await away.next('room.message', (f) => f.data.message.id === m.id)
  const seen = away.lastSeq()
  away.close()
  await away.closedWith()
  await h.api('alice').call(API.markRoomRead, { params: { id: roomId }, body: { seq: m.seq } })
  const back = await h.ws('alice', { windowId: 'win-read-away', epoch: h.ctx.epoch, after: seen })
  expect((await back.next('hello')).resumed).toBe(true)
  const f = await back.next('room.read', (x) => x.data.roomId === roomId)
  expect(f.data).toMatchObject({ lastReadSeq: m.seq, unreadCount: 0 })
  back.close()
})
