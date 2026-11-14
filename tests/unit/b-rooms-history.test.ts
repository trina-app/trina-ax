// A team room's and the everyone room's history for a member who joins later (docs/DECISIONS.md "지난 대화", "People who
// see a shared chat later: nothing new is hidden"): like a Slack channel they see what was said before them (people's
// messages, threads, reactions, files, quotes, answers) and nothing old is unread or notifies; group chats and 1:1s
// still start at the join. From the cutover (migration 295) on nothing is hidden ("from the cutover on" below). An
// answer from before it (the old room AI's, or one shared from a person's own AI chat) is still one line for a later
// member (RoomMessage.withheld), and hidden everywhere else (its thread, quotes, reactions, sources, the rooms list, the
// Inbox, the readers of the person's own AI chat and of AI apps, the room AI's context), only where no card could have
// covered it (rule b): its scope was not kept or not known, it used a person's own folder, a connection or a shared
// Drive the member cannot open, or it used the room where an older answer hidden from them was; one that used team
// folders only is shown. An answer that used a hidden one
// stays private while such a member is in the room. The tests below are about such older answers (the cutover is set
// after them) unless they say otherwise. Answers are written straight into the database where the engine
// is not the point (the fixture team: alice and erin in marketing, bob in finance, carol admin, dana owner).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { API, uuidv7, type Room, type RoomMessage } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { roomsOf } from '../../server/src/rooms/service'
import { roomFilesOf } from '../../server/src/rooms/files'
import { openHistories, wouldSeeFrom } from '../../server/src/rooms/history'
import { setHiddenAnswersCutover } from '../../server/src/chat/shared-answers'
import { countedUnreadIn } from '../../server/src/rooms/inbox'
import { readRoom, searchRooms } from '../../server/src/rooms/reader'
import { roomTool } from '../../server/src/connectors/remote-mcp/rooms'
import { loadPrincipal } from '../../server/src/policy/access'
import { readMigrations } from '../../server/src/db'
import type { TurnFiles } from '../../server/src/files/service'
import type { ReadSource } from '../../server/src/chat/read-scope'

setDefaultTimeout(60_000)
const cm = () => 'cm-' + crypto.randomUUID()
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const BRIEF = 'groups/marketing/campaign-brief.md'
/** a cutover after every message of the test: they are all judged by the old rule (b) */
const OLD_RULE = '9999-12-31T00:00:00.000Z'
/** what alice's own folder gave (her personal folder, her browser, a personal connection): only she reads it, and no
 * card could cover it (rule b keeps an older answer that used it hidden) */
const ALICE_OWN: ReadSource = { type: 'user', id: 'alice' }

let h: Harness
const ws: Record<string, TestSocket> = {}
let clock = Date.now()
const groupIds: Record<string, string> = {}
beforeAll(async () => {
  h = await startHarness({ name: 'b-rooms-history', askUserTimeoutMs: 3000, stallTimeoutMs: 60_000 })
  const db = h.ctx.db
  db.exec('PRAGMA foreign_keys = OFF')
  for (const g of ['marketing', 'finance']) {
    const id = uuidv7()
    groupIds[g] = id
    for (const sql of ['UPDATE groups SET id = ?1 WHERE id = ?2', 'UPDATE group_members SET group_id = ?1 WHERE group_id = ?2', "UPDATE folder_rules SET subject_id = ?1 WHERE subject_type = 'group' AND subject_id = ?2", 'UPDATE rooms SET group_id = ?1 WHERE group_id = ?2'])
      db.query(sql).run(id, g)
  }
  db.exec('PRAGMA foreign_keys = ON')
  roomsOf(h.ctx).clock = () => (clock += 10_000)
  setHiddenAnswersCutover(db, OLD_RULE)
  for (const u of ['alice', 'bob']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

let groups = 0
/** a team room of its own: a new group with these people */
async function teamRoom(memberIds: string[]): Promise<{ roomId: string; groupId: string }> {
  const g = await h.api('dana').call(API.createGroup, { body: { name: `history-${++groups}`, memberIds } })
  const r = (await h.api(memberIds[0]!).call(API.listRooms)).items.find((x) => x.kind === 'team' && x.groupId === g.id)
  if (!r) throw new Error('no team room')
  return { roomId: r.id, groupId: g.id }
}
const setMembers = (groupId: string, memberIds: string[]) => h.api('dana').call(API.updateGroup, { params: { id: groupId }, body: { memberIds } })
const send = (user: string, roomId: string, body: string, extra: Record<string, unknown> = {}) =>
  h.api(user).call(API.sendRoomMessage, { params: { id: roomId }, body: { body, clientMessageId: cm(), mentions: [], fileIds: [], ...extra } }) as Promise<RoomMessage>
const timeline = async (user: string, roomId: string) => (await h.api(user).call(API.listRoomMessages, { params: { id: roomId }, query: {} })).items as RoomMessage[]
const roomFor = async (user: string, roomId: string) => (await h.api(user).call(API.listRooms)).items.find((r) => r.id === roomId) as Room
const folder = (p: string): ReadSource => ({ type: 'folder', id: (h.ctx.db.query('SELECT id FROM folders WHERE path = ?').get(p) as { id: string }).id })

/** An AI answer to `asker`'s question, straight into the database (the engine is not the point here): the question, the
 * answer for the whole room (or in a thread), and the turn row with the question's scope (null: none kept). */
function aiAnswer(roomId: string, asker: string, body: string, scope: { sources: ReadSource[]; outside?: boolean } | null, o: { threadRootId?: string; noTurn?: boolean } = {}) {
  const db = h.ctx.db, now = new Date().toISOString()
  const root = o.threadRootId ? db.query('SELECT id, seq FROM room_messages WHERE id = ?').get(o.threadRootId) as { id: string; seq: number } : null
  const next = () => (db.query('UPDATE rooms SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq').get(roomId) as { last_seq: number }).last_seq
  const qid = uuidv7(), aid = uuidv7()
  db.query(`INSERT INTO room_messages (id, room_id, seq, author_kind, author_id, visibility, body, mentions, created_at, thread_root_id, thread_root_seq) VALUES (?, ?, ?, 'user', ?, 'room', ?, '[]', ?, ?, ?)`)
    .run(qid, roomId, next(), asker, '@트리나 what does it say?', now, root?.id ?? null, root?.seq ?? null)
  db.query(`INSERT INTO room_messages (id, room_id, seq, author_kind, author_id, asked_by, visibility, body, reply_to_id, mentions, created_at, thread_root_id, thread_root_seq) VALUES (?, ?, ?, 'ai', NULL, ?, 'room', ?, ?, '[]', ?, ?, ?)`)
    .run(aid, roomId, next(), asker, body, qid, now, root?.id ?? null, root?.seq ?? null)
  if (!o.noTurn) db.query(`INSERT INTO room_ai_turns (turn_id, room_id, user_id, chat_id, question_id, status, answer_id, scope, created_at, ended_at) VALUES (?, ?, ?, ?, ?, 'posted', ?, ?, ?, ?)`)
    .run(uuidv7(), roomId, asker, uuidv7(), qid, aid, scope ? JSON.stringify({ outside: false, ...scope }) : null, now, now)
  return { questionId: qid, answerId: aid, seq: (db.query('SELECT seq FROM room_messages WHERE id = ?').get(aid) as { seq: number }).seq }
}
const hiddenRows = (roomId: string, userId: string) => (h.ctx.db.query('SELECT message_id FROM room_hidden_answers WHERE room_id = ? AND user_id = ? ORDER BY see_seq, message_id').all(roomId, userId) as { message_id: string }[]).map((r) => r.message_id)

describe('the history of a team room', () => {
  test('a later member sees what was said before them (messages, threads, reactions, quotes), and nothing old is unread', async () => {
    const { roomId, groupId } = await teamRoom(['alice', 'erin'])
    const first = await send('alice', roomId, 'before bob: the plan @Erin', { mentions: ['erin'] })
    const reply = await send('erin', roomId, 'in the thread', { threadRootId: first.id })
    await h.api('erin').call(API.reactRoomMessage, { params: { id: roomId, messageId: first.id }, body: { emoji: '👍', on: true } })
    const quote = await send('erin', roomId, 'quoting it', { replyToId: first.id })
    const src = path.join(h.dataDir, `upload-${uuidv7()}`), bytes = new TextEncoder().encode('# old notes\n')
    fs.writeFileSync(src, bytes)
    const file = await roomFilesOf(h.ctx).create('erin', roomId, 'old-notes.md', src, createHash('sha256').update(bytes).digest('hex'))
    const withFile = await send('erin', roomId, 'the notes', { fileIds: [file.id] })
    await setMembers(groupId, ['alice', 'erin', 'bob'])
    const room = await roomFor('bob', roomId)
    expect(room).toMatchObject({ unreadCount: 0, threadsUnread: 0, mentioned: false, lastMessage: { id: withFile.id } })
    expect(room.lastReadSeq).toBe(room.lastSeq)
    const items = await timeline('bob', roomId)
    expect(items.map((m) => m.body)).toEqual(['before bob: the plan @Erin', 'quoting it', 'the notes'])
    // the room file sent before he joined is his to open
    expect((await h.req('bob', `/api/rooms/${roomId}/files/${file.id}`)).status).toBe(200)
    expect(items[0]).toMatchObject({ thread: { replyCount: 1 }, reactions: [{ emoji: '👍', count: 1 }] })
    expect(items[1]!.replyTo).toMatchObject({ id: first.id, excerpt: 'before bob: the plan @Erin', deleted: false })
    const thread = await h.api('bob').call(API.listRoomThread, { params: { id: roomId, messageId: first.id }, query: {} })
    expect(thread.items.map((m) => m.id)).toEqual([reply.id])
    // nothing old notified him, and his read position is the room's newest message
    expect(h.ctx.db.query('SELECT COUNT(*) n FROM room_notices WHERE user_id = ? AND room_id = ?').get('bob', roomId)).toEqual({ n: 0 })
    const m = h.ctx.db.query('SELECT visible_from_seq, history_from_seq, last_read_seq FROM room_members WHERE room_id = ? AND user_id = ?').get(roomId, 'bob') as { visible_from_seq: number; history_from_seq: number; last_read_seq: number }
    expect(m.history_from_seq).toBe(0)
    expect(m.last_read_seq).toBe(m.visible_from_seq)
    // he may answer in the old thread, and follows it from then on
    await send('bob', roomId, 'joining in', { threadRootId: first.id })
    const welcome = await send('alice', roomId, 'welcome', { threadRootId: first.id })
    expect((await roomFor('bob', roomId)).threadsUnread).toBe(1)
    // an unposted private answer of the removed room AI in that thread (old data, shown to nobody): never unread, and
    // reading the thread up to its newest visible reply clears the badge
    const seq = (h.ctx.db.query('UPDATE rooms SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq').get(roomId) as { last_seq: number }).last_seq
    h.ctx.db.query(`INSERT INTO room_messages (id, room_id, seq, author_kind, author_id, visibility, visible_to, body, mentions, created_at, thread_root_id, thread_root_seq)
      VALUES ('old-private-preview', ?, ?, 'ai', NULL, 'private', 'bob', 'old answer', '[]', ?, ?, ?)`).run(roomId, seq, new Date().toISOString(), first.id, first.seq)
    await h.api('bob').call(API.markRoomThreadRead, { params: { id: roomId, messageId: first.id }, body: { seq: welcome.seq } })
    expect((await roomFor('bob', roomId)).threadsUnread ?? 0).toBe(0)
  })

  test('group chats and 1:1s still start at the join', async () => {
    const g = await h.api('alice').call(API.createRoom, { body: { kind: 'group', userIds: ['erin', 'carol'] } })
    await send('alice', g.id, 'before bob in the group chat')
    await h.api('alice').call(API.inviteRoomMembers, { params: { id: g.id }, body: { userIds: ['bob'] } })
    expect(JSON.stringify(await timeline('bob', g.id))).not.toContain('before bob in the group chat')
    expect(h.ctx.db.query('SELECT history_from_seq FROM room_members WHERE room_id = ? AND user_id = ?').get(g.id, 'bob')).toEqual({ history_from_seq: null })
  })
})

describe('old answers a later member could not open', () => {
  test('hidden from a member who cannot read what it used, shown to one who can; one line, nothing else', async () => {
    const { roomId, groupId } = await teamRoom(['alice', 'erin'])
    const a = aiAnswer(roomId, 'alice', 'The brief says CANARY-BRIEF-1 [brief](/files/view?path=groups/marketing/campaign-brief.md)', { sources: [ALICE_OWN] })
    // an older answer that used a team folder only: a card could have covered it, so it is shown (rule b)
    const f = aiAnswer(roomId, 'alice', 'FROM-THE-TEAM-FOLDER', { sources: [folder('groups/marketing')] })
    h.ctx.db.query("INSERT INTO room_message_sources (message_id, ord, path, sha256, locs, via, by_main, by_subagent) VALUES (?, 0, ?, NULL, '[]', 'read', 1, 0)").run(a.answerId, BRIEF)
    const said = await send('erin', roomId, 'thanks, noted')
    const inThread = await send('erin', roomId, 'about CANARY-BRIEF-1 again', { threadRootId: a.answerId })
    await h.api('erin').call(API.reactRoomMessage, { params: { id: roomId, messageId: a.answerId }, body: { emoji: '🎉', on: true } })
    await setMembers(groupId, ['alice', 'erin', 'bob', 'carol'])
    // bob cannot read alice's own folder: one line, who asked, the question; nothing of the answer
    const forBob = await timeline('bob', roomId)
    const line = forBob.find((m) => m.id === a.answerId)!
    expect(line).toMatchObject({ withheld: true, body: '', authorKind: 'ai', askedBy: { id: 'alice' }, files: [], mentions: [] })
    for (const k of ['sourceCount', 'openable', 'reactions', 'thread', 'sharedAnswer', 'preview']) expect(line).not.toHaveProperty(k)
    expect(JSON.stringify(forBob)).not.toContain('CANARY-BRIEF-1')
    expect(forBob.map((m) => m.id)).toContain(said.id)
    // its thread, sources, reactions, a reply in it, a quote of it: as for a message that is not there
    expect((await h.req('bob', `/api/rooms/${roomId}/messages/${a.answerId}/thread`)).status).toBe(404)
    expect((await h.req('bob', `/api/rooms/${roomId}/messages/${a.answerId}/sources`)).status).toBe(404)
    expect((await h.req('bob', `/api/rooms/${roomId}/messages/${a.answerId}/reactions`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ emoji: '👍', on: true }) })).status).toBe(404)
    expect((await h.req('bob', `/api/rooms/${roomId}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'x', threadRootId: a.answerId, clientMessageId: cm() }) })).status).toBe(400)
    // nor carol (admin): a person's own folder is theirs only. The team-folder answer is shown to both (bob cannot read
    // groups/marketing): a card could have covered it
    expect((await timeline('carol', roomId)).find((m) => m.id === a.answerId)!.withheld).toBe(true)
    for (const u of ['bob', 'carol']) expect((await timeline(u, roomId)).find((m) => m.id === f.answerId)).toMatchObject({ body: 'FROM-THE-TEAM-FOLDER' })
    // erin, who was there, sees it with its thread
    const forErin = (await timeline('erin', roomId)).find((m) => m.id === a.answerId)!
    expect(forErin.withheld).toBeUndefined()
    expect(forErin.thread?.replyCount).toBe(1)
    void inThread
  })
})

describe('what an old answer used', () => {
  test('not known (no turn, no scope kept, the web): hidden from every later member, the admin too', async () => {
    const { roomId, groupId } = await teamRoom(['alice', 'erin'])
    const none = aiAnswer(roomId, 'alice', 'NO-TURN', null, { noTurn: true })
    const unkept = aiAnswer(roomId, 'alice', 'NO-SCOPE', null)
    const web = aiAnswer(roomId, 'alice', 'FROM-THE-WEB', { sources: [], outside: true })
    const plain = aiAnswer(roomId, 'alice', 'SHARED-ONLY', { sources: [folder('shared')] })
    await setMembers(groupId, ['alice', 'erin', 'carol'])
    const items = await timeline('carol', roomId)
    const shown = (id: string) => !items.find((m) => m.id === id)!.withheld
    expect([none, unkept, web].map((x) => shown(x.answerId))).toEqual([false, false, false])
    expect(shown(plain.answerId)).toBe(true)
    // the members who were there when they were posted keep seeing them
    expect((await timeline('erin', roomId)).filter((m) => m.withheld)).toEqual([])
  })

  test('an answer shared from a person\'s own AI chat goes by the scope kept with it; none kept: hidden', async () => {
    const { roomId, groupId } = await teamRoom(['alice', 'erin'])
    const db = h.ctx.db
    const shared = (scope: string | null, body: string) => {
      const id = uuidv7(), seq = (db.query('UPDATE rooms SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq').get(roomId) as { last_seq: number }).last_seq
      db.query(`INSERT INTO room_messages (id, room_id, seq, author_kind, author_id, visibility, body, mentions, created_at, answer_at, source_scope) VALUES (?, ?, ?, 'user', 'alice', 'room', ?, '[]', ?, 0, ?)`)
        .run(id, roomId, seq, body, new Date().toISOString(), scope)
      return id
    }
    const own = shared(JSON.stringify({ sources: [ALICE_OWN], unknown: false }), 'SHARED-OWN')
    const unknown = shared(JSON.stringify({ sources: [], unknown: true }), 'SHARED-UNKNOWN')
    const older = shared(null, 'SHARED-OLDER')
    const fine = shared(JSON.stringify({ sources: [folder('shared')], unknown: false }), 'SHARED-FINE')
    // a team folder bob cannot read: shown (rule b)
    const marketing = shared(JSON.stringify({ sources: [folder('groups/marketing')], unknown: false }), 'SHARED-MARKETING')
    await setMembers(groupId, ['alice', 'erin', 'bob'])
    const items = await timeline('bob', roomId)
    const w = (id: string) => items.find((m) => m.id === id)!
    expect([own, unknown, older].map((id) => w(id).withheld)).toEqual([true, true, true])
    expect(w(own)).toMatchObject({ author: { id: 'alice' }, body: '', withheld: true })
    expect(w(fine).body).toBe('SHARED-FINE')
    expect(w(marketing).body).toBe('SHARED-MARKETING')
  })

  test('an answer built on one hidden from them is hidden too; one whose context started after it is not', async () => {
    const { roomId, groupId } = await teamRoom(['alice', 'erin'])
    const a = aiAnswer(roomId, 'alice', 'SECRET-A', { sources: [ALICE_OWN] })
    const b = aiAnswer(roomId, 'erin', 'BUILT-ON-A', { sources: [{ type: 'room', id: roomId, fromSeq: a.seq - 1 }] })
    const later = await send('alice', roomId, 'something else')
    const c = aiAnswer(roomId, 'erin', 'AFTER-A', { sources: [{ type: 'room', id: roomId, fromSeq: later.seq }] })
    await setMembers(groupId, ['alice', 'erin', 'bob'])
    const items = await timeline('bob', roomId)
    const w = (id: string) => items.find((m) => m.id === id)!.withheld ?? false
    expect([w(a.answerId), w(b.answerId), w(c.answerId)]).toEqual([true, true, false])
  })
})

describe('everywhere else the room is read', () => {
  test('the readers of the person\'s own AI chat and of AI apps and the search leave a hidden answer out', async () => {
    const { roomId, groupId } = await teamRoom(['alice', 'erin'])
    const a = aiAnswer(roomId, 'alice', 'READER-CANARY-7', { sources: [ALICE_OWN] })
    await send('erin', roomId, 'people talk before bob')
    await send('erin', roomId, 'in its thread READER-CANARY-7', { threadRootId: a.answerId })
    await setMembers(groupId, ['alice', 'erin', 'bob'])
    const tz = 'UTC'
    const read = readRoom(h.ctx.db, 'bob', tz, { room: roomId })
    expect(read.text).toContain('people talk before bob')
    expect(read.text).not.toContain('READER-CANARY-7')
    expect(readRoom(h.ctx.db, 'bob', tz, { room: roomId, thread: a.answerId }).text).toContain('No thread')
    expect(searchRooms(h.ctx.db, 'bob', tz, { query: 'READER-CANARY-7' }).text).toContain('No messages')
    // erin, who was there, still reads it
    expect(readRoom(h.ctx.db, 'erin', tz, { room: roomId }).text).toContain('READER-CANARY-7')
  })
})



describe('when it is worked out', () => {
  test('existing later members (an upgrade, a row an older build made): from their join on until the next pass, then the history with the same check', async () => {
    const { roomId, groupId } = await teamRoom(['alice', 'erin'])
    const a = aiAnswer(roomId, 'alice', 'UPGRADE-HIDDEN', { sources: [ALICE_OWN] })
    await send('alice', roomId, 'PRE-JOIN-TALK')
    await setMembers(groupId, ['alice', 'erin', 'bob'])
    const db = h.ctx.db
    // as the database is after migration 264, or after an older build added him
    db.query('UPDATE room_members SET history_from_seq = NULL WHERE room_id = ? AND user_id = ?').run(roomId, 'bob')
    db.query('DELETE FROM room_hidden_answers WHERE room_id = ? AND user_id = ?').run(roomId, 'bob')
    expect(readRoom(db, 'bob', 'UTC', { room: roomId }).text).not.toContain('PRE-JOIN-TALK')
    openHistories(h.ctx)
    expect(db.query('SELECT history_from_seq FROM room_members WHERE room_id = ? AND user_id = ?').get(roomId, 'bob')).toEqual({ history_from_seq: 0 })
    expect(db.query('SELECT message_id FROM room_hidden_answers WHERE room_id = ? AND user_id = ?').all(roomId, 'bob')).toEqual([{ message_id: a.answerId }])
    const text = readRoom(db, 'bob', 'UTC', { room: roomId }).text
    expect(text).toContain('PRE-JOIN-TALK')
    expect(text).not.toContain('UPGRADE-HIDDEN')
    // the first members have nothing to work out; visible_from_seq (the join point) is never changed
    expect(db.query("SELECT COUNT(*) n FROM room_members m JOIN rooms r ON r.id = m.room_id WHERE r.kind IN ('team', 'all') AND m.history_from_seq IS NULL").get()).toEqual({ n: 0 })
  })

  test('migration 264 is additive (reader level stays)', () => {
    const m = readMigrations().find((x) => x.name === '264_b_room_history.sql')!
    expect(m.minCompatibleReader).toBe(1)
    expect(readMigrations().filter((x) => x.version === 264)).toHaveLength(1)
  })


  test('an answer in a thread that started before the join is judged, whenever it came (before the cutover); a deleted answer still counts', async () => {
    const { roomId, groupId } = await teamRoom(['alice', 'erin'])
    const root = await send('alice', roomId, 'old thread start')
    const gone = aiAnswer(roomId, 'alice', 'DELETED-SECRET', { sources: [ALICE_OWN] })
    const onGone = aiAnswer(roomId, 'erin', 'BUILT-ON-DELETED', { sources: [{ type: 'room', id: roomId, fromSeq: gone.seq }] })
    h.ctx.db.query("UPDATE room_messages SET body = '', deleted_at = ? WHERE id = ?").run(new Date().toISOString(), gone.answerId)
    await setMembers(groupId, ['alice', 'erin', 'bob'])
    // as after the upgrade (or before his history opened): an answer in the old thread, posted after he joined
    const db = h.ctx.db
    db.query('UPDATE room_members SET history_from_seq = NULL WHERE room_id = ? AND user_id = ?').run(roomId, 'bob')
    db.query('DELETE FROM room_hidden_answers WHERE room_id = ? AND user_id = ?').run(roomId, 'bob')
    const late = aiAnswer(roomId, 'alice', 'LATE-IN-OLD-THREAD', { sources: [ALICE_OWN] }, { threadRootId: root.id })
    openHistories(h.ctx)
    expect(hiddenRows(roomId, 'bob').sort()).toEqual([gone.answerId, onGone.answerId, late.answerId].sort())
    const thread = await h.api('bob').call(API.listRoomThread, { params: { id: roomId, messageId: root.id }, query: {} })
    expect(thread.items.find((m) => m.id === late.answerId)).toMatchObject({ withheld: true, body: '' })
    expect(JSON.stringify(thread)).not.toContain('LATE-IN-OLD-THREAD')
  })
})

describe('what people send that came from elsewhere', () => {
  test('a shared answer keeps what it used with it; a message an AI app sent after reading keeps what the app had read (a team folder: shown later, rule b)', async () => {
    const { roomId, groupId } = await teamRoom(['alice', 'erin'])
    const db = h.ctx.db
    // alice's own AI chat answered from the marketing brief; she shares it to the room (everyone there may read it)
    const chatId = uuidv7(), askId = uuidv7(), answerId = uuidv7()
    db.query('INSERT INTO chats (id, user_id, session_read_scope) VALUES (?, ?, ?)').run(chatId, 'alice', JSON.stringify({ sources: [folder('groups/marketing')] }))
    db.query("INSERT INTO messages (id, chat_id, role, content, status) VALUES (?, ?, 'user', '정리해 줘', 'done')").run(askId, chatId)
    db.query("INSERT INTO messages (id, chat_id, parent_id, role, content, status) VALUES (?, ?, ?, 'assistant', 'SHARED-BRIEF-CANARY', 'done')").run(answerId, chatId, askId)
    db.query('UPDATE chats SET active_leaf_id = ? WHERE id = ?').run(answerId, chatId)
    const r = await h.req('alice', `/api/chats/${chatId}/messages/${answerId}/share-to-room`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ roomId, clientMessageId: cm() }) })
    expect(r.status).toBe(200)
    const shared = (await r.json() as { message: RoomMessage }).message
    expect(JSON.parse((db.query('SELECT source_scope s FROM room_messages WHERE id = ?').get(shared.id) as { s: string }).s)).toEqual({ sources: [folder('groups/marketing')], unknown: false })
    // erin's AI app read the brief and sends a line as her (everyone there may read it)
    const sent = await roomTool(h.ctx, loadPrincipal(db, 'erin')!, 'room_send', { room: roomId, text: 'APP-SENT-CANARY' }, {} as TurnFiles, { sources: [folder('groups/marketing')], session: true })
    expect(sent.isError).toBeFalsy()
    const appMsg = db.query("SELECT id, source_scope s FROM room_messages WHERE room_id = ? AND body = 'APP-SENT-CANARY'").get(roomId) as { id: string; s: string }
    expect(JSON.parse(appMsg.s)).toEqual({ sources: [folder('groups/marketing')], unknown: false })
    // a person's own words keep nothing
    const own = await send('erin', roomId, 'my own words')
    expect(db.query('SELECT source_scope s FROM room_messages WHERE id = ?').get(own.id)).toEqual({ s: null })
    // bob joins: both used a team folder only (he cannot read groups/marketing), so a card could have covered them: he
    // sees them, by their author (rule b); his own words are there
    await setMembers(groupId, ['alice', 'erin', 'bob'])
    const items = await timeline('bob', roomId)
    expect(items.find((m) => m.id === shared.id)).toMatchObject({ author: { id: 'alice' } })
    expect(items.find((m) => m.id === shared.id)?.withheld).toBeUndefined()
    expect(items.find((m) => m.id === appMsg.id)).toMatchObject({ author: { id: 'erin' }, body: 'APP-SENT-CANARY' })
    expect(items.find((m) => m.id === own.id)?.body).toBe('my own words')
    expect(hiddenRows(roomId, 'bob')).toEqual([])
    // an AI app that read the room's history may send after it: nothing in it is hidden from bob
    const read = readRoom(db, 'erin', 'UTC', { room: roomId })
    const seen = read.seen.map((x): ReadSource => ({ type: 'room', id: x.roomId, ...(x.fromSeq !== undefined ? { fromSeq: x.fromSeq } : {}) }))
    const passed = await roomTool(h.ctx, loadPrincipal(db, 'erin')!, 'room_send', { room: roomId, text: 'passing it on' }, {} as TurnFiles, { sources: seen, session: true })
    expect(passed.isError).toBeFalsy()
    // bob's own app too
    const bobs = readRoom(db, 'bob', 'UTC', { room: roomId })
    const ok = await roomTool(h.ctx, loadPrincipal(db, 'bob')!, 'room_send', { room: roomId, text: 'bob after reading' }, {} as TurnFiles, { sources: bobs.seen.map((x): ReadSource => ({ type: 'room', id: x.roomId, ...(x.fromSeq !== undefined ? { fromSeq: x.fromSeq } : {}) })), session: true })
    expect(ok.isError).toBeFalsy()
  })
})

describe('a shared answer in a thread (a side chat sends it there)', () => {
  test("a later member gets it judged with its thread's first message: one that used a team folder is shown (rule b)", async () => {
    const { roomId, groupId } = await teamRoom(['alice', 'erin'])
    const db = h.ctx.db
    const root = await send('erin', roomId, 'THREAD-ROOT-CANARY 로고 시안 언제 나와요?')
    /** alice's own chat answered from `scope`; shared into the root's thread */
    const shareInto = async (text: string, scope: ReadSource[]) => {
      const chatId = uuidv7(), askId = uuidv7(), answerId = uuidv7()
      db.query('INSERT INTO chats (id, user_id, session_read_scope) VALUES (?, ?, ?)').run(chatId, 'alice', JSON.stringify({ sources: scope }))
      db.query("INSERT INTO messages (id, chat_id, role, content, status) VALUES (?, ?, 'user', '정리해 줘', 'done')").run(askId, chatId)
      db.query("INSERT INTO messages (id, chat_id, parent_id, role, content, status) VALUES (?, ?, ?, 'assistant', ?, 'done')").run(answerId, chatId, askId, text)
      db.query('UPDATE chats SET active_leaf_id = ? WHERE id = ?').run(answerId, chatId)
      const r = await h.req('alice', `/api/chats/${chatId}/messages/${answerId}/share-to-room`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ roomId, threadRootId: root.id, clientMessageId: cm() }) })
      expect(r.status).toBe(200)
      const m = (await r.json() as { status: string; message: RoomMessage }).message
      expect(m.threadRootId).toBe(root.id)
      return m
    }
    // from the marketing brief (bob, in finance, cannot read it), and from the shared folder (everyone may)
    const closed = await shareInto('THREAD-BRIEF-CANARY', [folder('groups/marketing')])
    const open = await shareInto('THREAD-SHARED-CANARY', [folder('shared')])
    // the thread's first message's seq decides (COALESCE(thread_root_seq, seq)): both were there before bob; the brief
    // is a team folder, which a card could have covered: shown (rule b)
    await setMembers(groupId, ['alice', 'erin', 'bob'])
    expect(hiddenRows(roomId, 'bob')).toEqual([])
    expect((await timeline('bob', roomId)).find((m) => m.id === root.id)?.body).toContain('THREAD-ROOT-CANARY')
    const thread = await h.api('bob').call(API.listRoomThread, { params: { id: roomId, messageId: root.id }, query: {} })
    expect(thread.items.find((m) => m.id === closed.id)?.body).toBe('THREAD-BRIEF-CANARY')
    expect(thread.items.find((m) => m.id === open.id)?.body).toBe('THREAD-SHARED-CANARY')
    // erin, who was there, keeps both
    const hers = await h.api('erin').call(API.listRoomThread, { params: { id: roomId, messageId: root.id }, query: {} })
    expect(hers.items.map((m) => m.body)).toEqual(['THREAD-BRIEF-CANARY', 'THREAD-SHARED-CANARY'])
  })
})

describe('notices and the Inbox', () => {
  test('nothing old notifies a later member; a reply in an old thread they follow counts in the Inbox', async () => {
    const { roomId, groupId } = await teamRoom(['alice', 'erin'])
    const root = await send('alice', roomId, 'old thread @Bob? (not yet here)')
    await send('erin', roomId, 'an old reply', { threadRootId: root.id })
    await setMembers(groupId, ['alice', 'erin', 'bob'])
    expect(countedUnreadIn(h.ctx.db, 'bob', roomId)).toBe(false)
    await send('bob', roomId, 'me too', { threadRootId: root.id })
    await send('alice', roomId, 'welcome', { threadRootId: root.id })
    expect(countedUnreadIn(h.ctx.db, 'bob', roomId)).toBe(true)
  })
})

// ---------------- found in the independent code review (2026-11-07) ----------------
describe('what an answer may not carry past a hidden answer', () => {

  test('a shared answer read before its sender left and joined again is judged without their rows now', async () => {
    const { roomId, groupId } = await teamRoom(['alice', 'erin'])
    const db = h.ctx.db
    const H = aiAnswer(roomId, 'alice', 'H-PERSONAL-SECRET', { sources: [{ type: 'user', id: 'alice' }] })
    await send('alice', roomId, 'talk after it')
    const read = readRoom(db, 'erin', 'UTC', { room: roomId })
    expect(read.text).toContain('H-PERSONAL-SECRET')
    const roomSrc = { type: 'room', id: roomId, fromSeq: read.seen[0]!.fromSeq }
    const chatId = uuidv7(), askId = uuidv7(), answerId = uuidv7()
    db.query('INSERT INTO chats (id, user_id, session_read_scope) VALUES (?, ?, ?)').run(chatId, 'erin', JSON.stringify({ sources: [roomSrc] }))
    db.query("INSERT INTO messages (id, chat_id, role, content, status) VALUES (?, ?, 'user', 'summarize the room', 'done')").run(askId, chatId)
    db.query("INSERT INTO messages (id, chat_id, parent_id, role, content, status) VALUES (?, ?, ?, 'assistant', 'ERIN-SUMMARY: H-PERSONAL-SECRET', 'done')").run(answerId, chatId, askId)
    db.query('UPDATE chats SET active_leaf_id = ? WHERE id = ?').run(answerId, chatId)
    // erin leaves and comes back: H is hidden from her now (alice's own folder); her chat read it before
    await setMembers(groupId, ['alice'])
    await setMembers(groupId, ['alice', 'erin'])
    expect(hiddenRows(roomId, 'erin')).toEqual([H.answerId])
    const r = await h.req('erin', `/api/chats/${chatId}/messages/${answerId}/share-to-room`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ roomId, clientMessageId: cm() }) })
    expect(r.status).toBe(200)
    await setMembers(groupId, ['alice', 'erin', 'bob'])
    expect(JSON.stringify(await timeline('bob', roomId))).not.toContain('H-PERSONAL-SECRET')
    // and erin may take her own message away although it is hidden from her now
    const mine = db.query("SELECT id FROM room_messages WHERE room_id = ? AND author_id = 'erin' AND answer_at IS NOT NULL").get(roomId) as { id: string }
    expect((await h.req('erin', `/api/rooms/${roomId}/messages/${mine.id}`, { method: 'DELETE' })).status).toBe(204)
  })


  test('an answer of my own AI chat that used a hidden answer is not sent to the room, confirmed or not', async () => {
    const { roomId, groupId } = await teamRoom(['alice', 'erin'])
    const db = h.ctx.db
    aiAnswer(roomId, 'alice', 'H-SHARE-SECRET', { sources: [ALICE_OWN] })
    await setMembers(groupId, ['alice', 'erin', 'bob'])
    const read = readRoom(db, 'alice', 'UTC', { room: roomId })
    expect(read.text).toContain('H-SHARE-SECRET')
    const chatId = uuidv7(), askId = uuidv7(), answerId = uuidv7()
    db.query('INSERT INTO chats (id, user_id, session_read_scope) VALUES (?, ?, ?)').run(chatId, 'alice', JSON.stringify({ sources: [{ type: 'room', id: roomId, fromSeq: read.seen[0]!.fromSeq }] }))
    db.query("INSERT INTO messages (id, chat_id, role, content, status) VALUES (?, ?, 'user', 'summarize', 'done')").run(askId, chatId)
    db.query("INSERT INTO messages (id, chat_id, parent_id, role, content, status) VALUES (?, ?, ?, 'assistant', 'SUMMARY: H-SHARE-SECRET', 'done')").run(answerId, chatId, askId)
    db.query('UPDATE chats SET active_leaf_id = ? WHERE id = ?').run(answerId, chatId)
    for (const confirm of [undefined, 5]) {
      const r = await h.req('alice', `/api/chats/${chatId}/messages/${answerId}/share-to-room`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ roomId, clientMessageId: cm(), ...(confirm !== undefined ? { confirm } : {}) }) })
      expect(r.status).toBe(409)
      expect(await r.text()).toContain('answer_share_hidden')
    }
    expect(JSON.stringify(await timeline('bob', roomId))).not.toContain('H-SHARE-SECRET')
  })
})


describe('found in the second PR review', () => {
  /** an answer of alice's own chat that read rooms without its scope saying which (an older chat) */
  function roomsReadChat(content: string, o: { saved?: { path: string; sha256: string } } = {}) {
    const db = h.ctx.db
    const chatId = uuidv7(), askId = uuidv7(), answerId = uuidv7()
    db.query('INSERT INTO chats (id, user_id, session_read_scope, rooms_seen) VALUES (?, ?, NULL, 1)').run(chatId, 'alice')
    db.query("INSERT INTO messages (id, chat_id, role, content, status) VALUES (?, ?, 'user', 'what did they say', 'done')").run(askId, chatId)
    db.query("INSERT INTO messages (id, chat_id, parent_id, role, content, status) VALUES (?, ?, ?, 'assistant', ?, 'done')").run(answerId, chatId, askId, content)
    db.query('UPDATE chats SET active_leaf_id = ? WHERE id = ?').run(answerId, chatId)
    if (o.saved) {
      const turnId = uuidv7()
      db.query("INSERT INTO turns (id, chat_id, user_id, engine, status, message_id) VALUES (?, ?, 'alice', 'claude-code', 'done', ?)").run(turnId, chatId, answerId)
      db.query('UPDATE messages SET turn_id = ? WHERE id = ?').run(turnId, answerId)
      db.query("INSERT INTO file_events (turn_id, user_id, path, action, size, sha256) VALUES (?, 'alice', ?, 'create', 1, ?)").run(turnId, o.saved.path, o.saved.sha256)
    }
    return { chatId, answerId }
  }
  const shareIt = (a: { chatId: string; answerId: string }, body: Record<string, unknown>) =>
    h.req('alice', `/api/chats/${a.chatId}/messages/${a.answerId}/share-to-room`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientMessageId: cm(), ...body }) })

  test('an answer of a chat that read rooms without saying which is not sent past a member with hidden answers, confirmed or not', async () => {
    const { roomId, groupId } = await teamRoom(['alice', 'erin'])
    aiAnswer(roomId, 'alice', 'H3-SECRET', { sources: [ALICE_OWN] })
    await setMembers(groupId, ['alice', 'erin', 'bob'])
    const a = roomsReadChat('RESTATES H3-SECRET')
    for (const confirm of [undefined, 5]) {
      const r = await shareIt(a, { roomId, ...(confirm !== undefined ? { confirm } : {}) })
      expect(r.status).toBe(409)
      expect(await r.text()).toContain('answer_share_hidden')
    }
    expect(JSON.stringify(await timeline('bob', roomId))).not.toContain('H3-SECRET')
    // where nobody else has anything hidden anywhere (dana was there from the start), the same chat is asked about as
    // before: a confirm (erin, who has hidden answers since joining a room again in an earlier test, would block it too)
    expect(h.ctx.db.query("SELECT COUNT(*) n FROM room_hidden_answers WHERE user_id = 'dana'").get()).toEqual({ n: 0 })
    const { roomId: plain } = await teamRoom(['alice', 'dana'])
    const ask = await shareIt(a, { roomId: plain })
    expect(ask.status).toBe(200)
    expect((await ask.json() as { status: string }).status).toBe('confirm')
  })

  test('nor an AI-made file attached from such a chat', async () => {
    const { roomId, groupId } = await teamRoom(['alice', 'erin'])
    aiAnswer(roomId, 'alice', 'H4-SECRET', { sources: [ALICE_OWN] })
    await setMembers(groupId, ['alice', 'erin', 'bob'])
    const rel = 'users/alice/restated-h4.md', text = 'RESTATES H4-SECRET\n'
    const abs = path.join(h.ctx.files.fx.root, ...rel.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, text)
    roomsReadChat('made the file', { saved: { path: rel, sha256: createHash('sha256').update(text).digest('hex') } })
    // another chat of alice's (its own scope known, nothing read) links the file: it would go as a copy
    const db = h.ctx.db
    const chatId = uuidv7(), askId = uuidv7(), answerId = uuidv7()
    db.query('INSERT INTO chats (id, user_id) VALUES (?, ?)').run(chatId, 'alice')
    db.query("INSERT INTO messages (id, chat_id, role, content, status) VALUES (?, ?, 'user', 'share it', 'done')").run(askId, chatId)
    db.query("INSERT INTO messages (id, chat_id, parent_id, role, content, status) VALUES (?, ?, ?, 'assistant', ?, 'done')").run(answerId, chatId, askId, `the file: [restated-h4.md](/files/view?path=${rel})`)
    db.query('UPDATE chats SET active_leaf_id = ? WHERE id = ?').run(answerId, chatId)
    const r = await shareIt({ chatId, answerId }, { roomId })
    expect(r.status).toBe(409)
    expect(await r.text()).toContain('answer_share_hidden')
    expect(db.query('SELECT COUNT(*) n FROM room_files WHERE room_id = ? AND name = ?').get(roomId, 'restated-h4.md')).toEqual({ n: 0 })
  })
})

describe('from the cutover on nothing is hidden (TC-1404)', () => {
  /** the cutover now: what was made before it is older, what comes after it new */
  const cutNow = async () => { await Bun.sleep(5); setHiddenAnswersCutover(h.ctx.db, new Date().toISOString()); await Bun.sleep(5) }
  afterAll(() => setHiddenAnswersCutover(h.ctx.db, OLD_RULE))

  test('an older answer with a closed scope stays hidden from a later member; a new one that used the same is shown; replies in a hidden thread stay hidden', async () => {
    const { roomId, groupId } = await teamRoom(['alice', 'erin'])
    const old = aiAnswer(roomId, 'alice', 'OLD-CLOSED-CANARY', { sources: [ALICE_OWN] })
    const oldFolder = aiAnswer(roomId, 'alice', 'OLD-FOLDER-CANARY', { sources: [folder('groups/marketing')] })
    await cutNow()
    const fresh = aiAnswer(roomId, 'alice', 'NEW-OWN-CANARY', { sources: [ALICE_OWN] })
    const web = aiAnswer(roomId, 'alice', 'NEW-WEB-CANARY', { sources: [], outside: true })
    const reply = aiAnswer(roomId, 'erin', 'NEW-REPLY-IN-OLD-THREAD', { sources: [] }, { threadRootId: old.answerId })
    await setMembers(groupId, ['alice', 'erin', 'bob'])
    const items = await timeline('bob', roomId)
    const w = (id: string) => items.find((m) => m.id === id)
    expect(w(old.answerId)?.withheld).toBe(true)
    expect(w(oldFolder.answerId)?.body).toBe('OLD-FOLDER-CANARY')
    expect(w(fresh.answerId)?.body).toBe('NEW-OWN-CANARY')
    expect(w(web.answerId)?.body).toBe('NEW-WEB-CANARY')
    expect(hiddenRows(roomId, 'bob').sort()).toEqual([old.answerId, reply.answerId].sort())
    expect(JSON.stringify(items)).not.toContain('OLD-CLOSED-CANARY')
  })

  test('wouldSeeFrom: an owner or admin would see the room from a seq on when no older hidden answer is there from it on; new answers never count', async () => {
    const { roomId } = await teamRoom(['alice', 'erin'])
    setHiddenAnswersCutover(h.ctx.db, OLD_RULE)
    const old = aiAnswer(roomId, 'alice', 'WSF-OLD', { sources: [ALICE_OWN] })
    const after = await send('alice', roomId, 'talk after the old answer')
    // carol (admin) cannot read alice's own folder: from before the old answer, no; from after it, yes
    expect(wouldSeeFrom(h.ctx, roomId, 'carol', old.seq - 1)).toBe(false)
    expect(wouldSeeFrom(h.ctx, roomId, 'carol', after.seq)).toBe(true)
    // from the cutover on: a new answer that used the same is no reason
    await cutNow()
    const fresh = aiAnswer(roomId, 'alice', 'WSF-NEW', { sources: [ALICE_OWN] })
    expect(wouldSeeFrom(h.ctx, roomId, 'carol', fresh.seq - 1)).toBe(true)
    expect(wouldSeeFrom(h.ctx, roomId, 'carol', old.seq - 1)).toBe(false)
    // a room that is not a team room: no
    const g = await h.api('alice').call(API.createRoom, { body: { kind: 'group', userIds: ['erin', 'carol'] } })
    expect(wouldSeeFrom(h.ctx, g.id, 'carol', 0)).toBe(false)
  })
})
