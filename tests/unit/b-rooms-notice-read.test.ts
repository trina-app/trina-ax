// Reading a room marks the right notices read without reading the whole room (TC-4772): markNoticesRead marks my
// notices of the timeline up to seq only (a room message, or a thread reply also sent to the room; not later ones, not
// another person's, not another room's); markThreadNoticesRead the replies of that one thread up to seq. Both look each
// notice's message up by its id, never list the room's messages (a query plan guard). unreadCount stops counting at
// 1000 and still finds a mention past those rows.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { roomsOf } from '../../server/src/rooms/service'
import { MAX_UNREAD, memberRow, TIMELINE_SQL, unreadCount } from '../../server/src/rooms/store'
import { addMember, harness, withOwner, type Harness } from './a-lib'

setDefaultTimeout(120_000)
let h: Harness
afterEach(async () => { await h?.close() })

async function setup() {
  h = await harness('b-rooms-notice-read')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const room = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  const other = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id], name: 'other' })
  expect(room.id).toBeTruthy()
  expect(other.id).toBeTruthy()
  const db = h.ctx.db
  const now = new Date().toISOString()
  // messages written straight to the table, far above the seq the rooms use so far
  let n = 0
  const msg = (roomId: string, seq: number, o: { author?: string; root?: { id: string; seq: number }; alsoInRoom?: boolean; mentions?: string[] } = {}) => {
    const id = `m-${roomId.slice(0, 6)}-${seq}-${++n}`
    db.query(`INSERT INTO room_messages (id, room_id, seq, author_id, body, mentions, created_at, thread_root_id, thread_root_seq, also_in_room)
      VALUES (?, ?, ?, ?, 'x', ?, ?, ?, ?, ?)`).run(id, roomId, seq, o.author ?? mia.id, JSON.stringify(o.mentions ?? []), now, o.root?.id ?? null, o.root?.seq ?? null, o.alsoInRoom ? 1 : 0)
    return id
  }
  const notice = (userId: string, roomId: string, sourceId: string, type: 'room.dm' | 'room.mention' = 'room.dm') => {
    const id = `n-${sourceId}-${userId.slice(0, 6)}-${type}`
    db.query("INSERT INTO room_notices (id, user_id, event_type, source_id, room_id, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, userId, type, sourceId, roomId, now)
    return id
  }
  const read = (id: string) => !!(db.query('SELECT read_at FROM room_notices WHERE id = ?').get(id) as { read_at: string | null }).read_at
  return { mia, nora, room, other, db, msg, notice, read, rooms: roomsOf(h.ctx) }
}

test('markNoticesRead marks my timeline notices up to seq only: room messages and replies also sent to the room', async () => {
  const { mia, nora, room, other, msg, notice, read, rooms } = await setup()
  const root = msg(room.id, 100)
  const upTo = notice(nora.id, room.id, root, 'room.mention')
  const sent = notice(nora.id, room.id, msg(room.id, 101, { root: { id: root, seq: 100 }, alsoInRoom: true }))
  const inThread = notice(nora.id, room.id, msg(room.id, 102, { root: { id: root, seq: 100 } }))
  const later = notice(nora.id, room.id, msg(room.id, 104))
  const atSeq = notice(nora.id, room.id, msg(room.id, 103))
  // mia's notice of the same messages, and nora's in another room with a lower seq
  const hers = notice(mia.id, room.id, root)
  const elsewhere = notice(nora.id, other.id, msg(other.id, 50))
  // a notice whose source is not a message of this room (an id of the other room) stays
  const wrongRoom = notice(nora.id, room.id, msg(other.id, 51), 'room.mention')

  rooms.markNoticesRead(nora.id, room.id, 103)
  expect([upTo, sent, atSeq].map(read)).toEqual([true, true, true])
  // a reply that stays in its thread is read in the thread; a later message is not read yet
  expect([inThread, later].map(read)).toEqual([false, false])
  expect([hers, elsewhere, wrongRoom].map(read)).toEqual([false, false, false])

  rooms.markNoticesRead(nora.id, room.id, 104)
  expect(read(later)).toBe(true)
  expect([inThread, hers, elsewhere, wrongRoom].map(read)).toEqual([false, false, false, false])
})

test('markThreadNoticesRead marks my notices of that thread up to seq only', async () => {
  const { mia, nora, room, other, msg, notice, read, rooms } = await setup()
  const root = msg(room.id, 200)
  const root2 = msg(room.id, 201)
  const rootNotice = notice(nora.id, room.id, root)
  const r1 = notice(nora.id, room.id, msg(room.id, 202, { root: { id: root, seq: 200 } }))
  const r1Sent = notice(nora.id, room.id, msg(room.id, 203, { root: { id: root, seq: 200 }, alsoInRoom: true }), 'room.mention')
  const r1Later = notice(nora.id, room.id, msg(room.id, 206, { root: { id: root, seq: 200 } }), 'room.mention')
  const otherThread = notice(nora.id, room.id, msg(room.id, 204, { root: { id: root2, seq: 201 } }))
  const plain = notice(nora.id, room.id, msg(room.id, 205))
  const hers = notice(mia.id, room.id, msg(room.id, 207, { root: { id: root, seq: 200 }, author: nora.id }))
  const otherRoomRoot = msg(other.id, 60)
  const elsewhere = notice(nora.id, other.id, msg(other.id, 61, { root: { id: otherRoomRoot, seq: 60 } }))

  rooms.markThreadNoticesRead(nora.id, room.id, root, 205)
  expect([r1, r1Sent].map(read)).toEqual([true, true])
  expect([rootNotice, r1Later, otherThread, plain, hers, elsewhere].map(read)).toEqual([false, false, false, false, false, false])
  rooms.markThreadNoticesRead(nora.id, room.id, root, 210)
  expect(read(r1Later)).toBe(true)
  expect([rootNotice, otherThread, plain, hers, elsewhere].map(read)).toEqual([false, false, false, false, false])
})

test('marking read looks each notice message up by its id, not a list of the room (20k messages)', async () => {
  const { nora, room, db, msg, notice } = await setup()
  db.transaction(() => { for (let s = 1000; s < 21000; s++) msg(room.id, s) })()
  notice(nora.id, room.id, msg(room.id, 21000))
  // the same statements as rooms/service.ts markNoticesRead and markThreadNoticesRead
  const src = await Bun.file(new URL('../../server/src/rooms/service.ts', import.meta.url)).text()
  const body = (name: string) => src.slice(src.indexOf(`  ${name}(`), src.indexOf('\n  }\n', src.indexOf(`  ${name}(`)))
  // production never runs ANALYZE, so the plan is checked without statistics first, then with them
  for (const stats of [false, true]) for (const name of ['markNoticesRead', 'markThreadNoticesRead']) {
    if (stats && name === 'markNoticesRead') db.exec('ANALYZE')
    const sql = body(name).match(/UPDATE room_notices[\s\S]*?`\)\.run/)?.[0].slice(0, -'`).run'.length)
    expect(sql, name).toBeTruthy()
    const text = sql!.replace('${TIMELINE_SQL}', TIMELINE_SQL)
    const args = name === 'markNoticesRead' ? ['now', nora.id, room.id, 21000, room.id, 21000] : ['now', nora.id, room.id, 21000, room.id, 'root', 21000]
    const plan = (db.query('EXPLAIN QUERY PLAN ' + text).all(...args) as { detail: string }[]).map((p) => p.detail)
    expect(plan.some((d) => /SEARCH m USING INDEX sqlite_autoindex_room_messages_1 \(id=\?\)/.test(d)), `${name}, stats ${stats}: ${plan.join(' | ')}`).toBe(true)
    expect(plan.some((d) => /LIST SUBQUERY|SCAN m\b/.test(d)), `${name}, stats ${stats}: ${plan.join(' | ')}`).toBe(false)
  }
})

test('unreadCount stops at 999 and still finds a mention past the rows it counted', async () => {
  const { mia, nora, room, db, msg } = await setup()
  const me = () => memberRow(db, room.id, nora.id)!
  const base = me()
  const from = Math.max(base.last_read_seq, base.visible_from_seq)
  expect(unreadCount(db, room.id, me())).toEqual({ n: 0, mentioned: false })
  let seq = from + 1000
  const add = (k: number, mentions: string[] = []) => db.transaction(() => { for (let i = 0; i < k; i++) msg(room.id, ++seq, { mentions }) })()
  add(998)
  expect(unreadCount(db, room.id, me())).toEqual({ n: 998, mentioned: false })
  add(1)
  expect(unreadCount(db, room.id, me())).toEqual({ n: 999, mentioned: false })
  add(1)
  expect(unreadCount(db, room.id, me())).toEqual({ n: MAX_UNREAD, mentioned: false })
  add(500)
  expect(unreadCount(db, room.id, me())).toEqual({ n: MAX_UNREAD, mentioned: false })
  // my own messages do not count, nor mention me
  db.transaction(() => { for (let i = 0; i < 5; i++) msg(room.id, ++seq, { author: nora.id, mentions: [nora.id] }) })()
  expect(unreadCount(db, room.id, me()).mentioned).toBe(false)
  // the newest message mentions nora: past the first 1000 counted, still found
  add(1, [nora.id])
  expect(unreadCount(db, room.id, me())).toEqual({ n: MAX_UNREAD, mentioned: true })
  // the room list says the same
  const listed = (roomsOf(h.ctx).listed(nora.id) as any[]).find((r: any) => r.id === room.id)
  expect(listed.unreadCount).toBe(MAX_UNREAD)
  expect(listed.mentioned).toBe(true)
  // read up to the end: nothing unread
  db.query('UPDATE room_members SET last_read_seq = ? WHERE room_id = ? AND user_id = ?').run(seq, room.id, nora.id)
  expect(unreadCount(db, room.id, me())).toEqual({ n: 0, mentioned: false })
  // a mention among the first rows counted, with more than 1000 unread
  add(1, [nora.id]); add(1200)
  expect(unreadCount(db, room.id, me())).toEqual({ n: MAX_UNREAD, mentioned: true })
  expect(mia.id).toBeTruthy()
})
