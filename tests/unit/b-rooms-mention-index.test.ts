// Whether something unread mentions me, past the first 1000 unread messages (TC-4796): unreadCount looks for the mention
// where I am mentioned (room_message_mentions, kept by triggers; "@everyone" through the partial index
// room_messages_mention_all; migration 416) and gives the same answer as reading every unread message did: a picked
// mention or "@everyone" by someone else counts; another person's mention, my own "@everyone", a deleted message, a reply
// that stays in its thread, a message from before I see the room, a hidden old answer, an app's quiet line and a private
// preview do not; an edit that adds or takes out a mention is followed. Query plan guards: both looks are index lookups,
// never a walk of the room's messages (no timing asserts).
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { roomsOf } from '../../server/src/rooms/service'
import { MAX_UNREAD, MENTIONS_SQL, memberRow, seeArgs, SEE_SQL, TIMELINE_SQL, UNREAD_MENTION_ALL_SQL, UNREAD_MENTION_PICKED_SQL, unreadCount } from '../../server/src/rooms/store'
import { addMember, harness, withOwner, type Harness } from './a-lib'

setDefaultTimeout(120_000)
let h: Harness
afterEach(async () => { await h?.close() })

async function setup() {
  h = await harness('b-rooms-mention-index')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const leo = await addMember(h, owner, { username: 'leo' })
  const room = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, leo.id], name: 'big' })
  const db = h.ctx.db
  const now = new Date().toISOString()
  let seq = (db.query('SELECT last_seq FROM rooms WHERE id = ?').get(room.id) as { last_seq: number }).last_seq
  let n = 0
  type Opt = { author?: string; mentions?: string[]; all?: boolean; root?: { id: string; seq: number }; alsoInRoom?: boolean; quiet?: boolean; privateTo?: string }
  const msg = (o: Opt = {}) => {
    const id = `m-${++n}`
    db.query(`INSERT INTO room_messages (id, room_id, seq, author_id, body, mentions, mentions_all, created_at, thread_root_id, thread_root_seq, also_in_room, app_quiet, visibility, visible_to)
      VALUES (?, ?, ?, ?, 'x', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, room.id, ++seq, o.author ?? mia.id, JSON.stringify(o.mentions ?? []), o.all ? 1 : 0, now, o.root?.id ?? null, o.root?.seq ?? null,
      o.alsoInRoom ? 1 : 0, o.quiet ? 1 : 0, o.privateTo ? 'private' : 'room', o.privateTo ?? null)
    db.query('UPDATE rooms SET last_seq = ? WHERE id = ?').run(seq, room.id)
    return { id, seq }
  }
  const bulk = (k: number) => db.transaction(() => { for (let i = 0; i < k; i++) msg() })()
  const me = () => memberRow(db, room.id, nora.id)!
  // what reading every unread message says (the look before migration 416)
  const reference = () => {
    const m = me()
    const from = Math.max(m.last_read_seq, m.visible_from_seq)
    return !!db.query(`SELECT 1 FROM room_messages m WHERE m.room_id = ? AND m.seq > ? AND ${SEE_SQL} AND ${TIMELINE_SQL} AND m.deleted_at IS NULL AND m.event IS NULL AND m.app_quiet = 0
      AND (m.author_id IS NULL OR m.author_id <> ?) AND ${MENTIONS_SQL} LIMIT 1`).get(room.id, from, ...seeArgs(m), nora.id, nora.id, nora.id)
  }
  const mentioned = () => {
    const r = unreadCount(db, room.id, me())
    expect(r.n).toBe(MAX_UNREAD)
    expect(r.mentioned).toBe(reference())
    return r.mentioned
  }
  // who room_message_mentions says message `seq` picks
  const picked = (seq: number) => (db.query('SELECT user_id FROM room_message_mentions WHERE room_id = ? AND seq = ? ORDER BY user_id').all(room.id, seq) as { user_id: string }[]).map((r) => r.user_id)
  const drop = (id: string) => db.query('DELETE FROM room_messages WHERE id = ?').run(id)
  return { mia, nora, leo, room, db, msg, bulk, mentioned, picked, drop, rooms: roomsOf(h.ctx) }
}

test('a mention past the first 1000 unread: exactly what reading every unread message says', async () => {
  const { mia, nora, leo, room, db, msg, bulk, mentioned, picked, drop, rooms } = await setup()
  // 1200 unread messages that mention nobody first: every case below is past the first 1000 rows counted
  // (a message for the visibility case at the end, before them)
  const oldRoot = msg({})
  bulk(1200)
  expect(mentioned()).toBe(false)
  const at = (o: Parameters<typeof msg>[0]) => {
    const m = msg(o)
    bulk(50)
    return m
  }

  // picked: counts
  let m = at({ mentions: [leo.id, nora.id, nora.id] })
  expect(picked(m.seq)).toEqual([leo.id, nora.id].sort())
  expect(mentioned()).toBe(true)
  drop(m.id)
  expect(picked(m.seq)).toEqual([])
  expect(mentioned()).toBe(false)

  // another person's mention: no
  m = at({ mentions: [leo.id] })
  expect(mentioned()).toBe(false)
  drop(m.id)

  // "@everyone" by someone else: yes; by nora herself: no (her own messages are not unread either)
  m = at({ all: true })
  expect(mentioned()).toBe(true)
  drop(m.id)
  m = at({ all: true, author: nora.id, mentions: [nora.id] })
  expect(mentioned()).toBe(false)
  drop(m.id)

  // deleted (Rooms.remove clears its mentions and "@everyone"): no, and it leaves the index
  m = at({ mentions: [nora.id], all: true })
  expect(mentioned()).toBe(true)
  rooms.remove(mia.id, room.id, m.id)
  expect(mentioned()).toBe(false)
  expect(picked(m.seq)).toEqual([])

  // an edit that adds a mention is followed, and one that takes it out
  m = at({})
  expect(mentioned()).toBe(false)
  rooms.edit(mia.id, room.id, m.id, { body: '@NORA hi', mentions: [nora.id] })
  expect(picked(m.seq)).toEqual([nora.id])
  expect(mentioned()).toBe(true)
  rooms.edit(mia.id, room.id, m.id, { body: '@LEO hi', mentions: [leo.id] })
  expect(picked(m.seq)).toEqual([leo.id])
  expect(mentioned()).toBe(false)
  drop(m.id)

  // a reply that stays in its thread is not the timeline's (threadsUnread counts it); sent to the room too it is
  const root = msg({})
  m = at({ mentions: [nora.id], root, alsoInRoom: false })
  expect(mentioned()).toBe(false)
  drop(m.id)
  m = at({ mentions: [nora.id], root, alsoInRoom: true })
  expect(mentioned()).toBe(true)
  drop(m.id)

  // an app's quiet line and a private preview: no
  m = at({ mentions: [nora.id], quiet: true })
  expect(mentioned()).toBe(false)
  drop(m.id)
  m = at({ mentions: [nora.id], privateTo: nora.id })
  expect(mentioned()).toBe(false)
  drop(m.id)

  // a hidden old answer of hers: no
  m = at({ mentions: [nora.id] })
  expect(mentioned()).toBe(true)
  db.query('INSERT INTO room_hidden_answers (room_id, user_id, message_id, see_seq) VALUES (?, ?, ?, 0)').run(room.id, nora.id, m.id)
  expect(mentioned()).toBe(false)
  db.query('DELETE FROM room_hidden_answers WHERE message_id = ?').run(m.id)
  drop(m.id)

  // where she sees the room from: a reply sent to the room whose root is from before then is not hers to see
  db.query('UPDATE room_members SET visible_from_seq = ? WHERE room_id = ? AND user_id = ?').run(oldRoot.seq, room.id, nora.id)
  m = at({ mentions: [nora.id], root: oldRoot, alsoInRoom: true })
  expect(mentioned()).toBe(false)
  drop(m.id)
  m = at({ mentions: [nora.id] })
  expect(mentioned()).toBe(true)
  // the rooms list says the same as unreadCount
  const listed = () => (rooms.listed(nora.id) as any[]).find((r: any) => r.id === room.id)
  expect([listed().unreadCount, listed().mentioned]).toEqual([MAX_UNREAD, true])
  // read past it, with 1200 more after: the mention is not unread any more
  db.query('UPDATE room_members SET last_read_seq = ? WHERE room_id = ? AND user_id = ?').run(m.seq, room.id, nora.id)
  bulk(1200)
  expect(mentioned()).toBe(false)
  expect([listed().unreadCount, listed().mentioned]).toEqual([MAX_UNREAD, false])
})

test('the mention look reads where people are mentioned, never the room (20k messages, with and without statistics)', async () => {
  const { nora, room, db, msg, bulk } = await setup()
  bulk(20_000)
  msg({ mentions: [nora.id] })
  msg({ all: true })
  const m = memberRow(db, room.id, nora.id)!
  const see = seeArgs({ ...m, has_hidden: 1 })
  const unread = [room.id, 0, ...see, nora.id]
  const plan = (sql: string, args: unknown[]) => (db.query('EXPLAIN QUERY PLAN ' + sql).all(...(args as any[])) as { detail: string }[]).map((p) => p.detail)
  for (const stats of [false, true]) {
    if (stats) db.exec('ANALYZE')
    const p1 = plan(UNREAD_MENTION_PICKED_SQL, [room.id, nora.id, 0, ...unread, nora.id, nora.id])
    expect(p1[0], `picked, stats ${stats}: ${p1.join(' | ')}`).toMatch(/SEARCH x USING PRIMARY KEY \(room_id=\? AND user_id=\? AND seq>\?\)/)
    expect(p1.some((d) => /SEARCH m USING INDEX sqlite_autoindex_room_messages_2 \(room_id=\? AND seq=\?\)/.test(d)), `picked, stats ${stats}: ${p1.join(' | ')}`).toBe(true)
    const p2 = plan(UNREAD_MENTION_ALL_SQL, [...unread, nora.id, nora.id])
    expect(p2[0], `everyone, stats ${stats}: ${p2.join(' | ')}`).toMatch(/SEARCH m USING INDEX room_messages_mention_all \(room_id=\? AND seq>\?\)/)
    for (const p of [p1, p2]) expect(p.some((d) => /SCAN (m|x)\b/.test(d)), p.join(' | ')).toBe(false)
  }
})

test('migration 416 fills room_message_mentions from the messages written before it', async () => {
  const { nora, leo, room, db, msg, picked } = await setup()
  const a = msg({ mentions: [nora.id, leo.id] })
  const b = msg({ mentions: [] })
  db.exec('DELETE FROM room_message_mentions')
  const sql = await Bun.file(new URL('../../server/migrations/416_b_room_mentions.sql', import.meta.url)).text()
  db.exec(sql)
  expect(picked(a.seq)).toEqual([nora.id, leo.id].sort())
  expect(picked(b.seq)).toEqual([])
  // a room deleted with its messages takes its rows along
  db.query('DELETE FROM rooms WHERE id = ?').run(room.id)
  expect((db.query('SELECT COUNT(*) n FROM room_message_mentions WHERE room_id = ?').get(room.id) as { n: number }).n).toBe(0)
})
