// A team room's and the everyone room's history for a member who joins later (docs/DECISIONS.md "지난 대화"): like a
// Slack channel they see what was said before them (people's messages, threads, reactions, files, quotes) and nothing
// old is unread or notifies; group chats and 1:1s still start at the join. An old answer (the room's AI, or one shared
// from a person's own AI chat) that used something the later member cannot open, or whose scope was not kept, is one
// line for them (RoomMessage.withheld) and hidden everywhere else: its thread, quotes, reactions, sources, the rooms
// list, the Inbox, the readers of the person's own AI chat and of AI apps, the room AI's context; an answer that used it
// stays private while such a member is in the room. Answers are written straight into the database where the engine
// is not the point (the fixture team: alice and erin in marketing, bob in finance, carol admin, dana owner).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { API, uuidv7, type Room, type RoomMessage } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { roomsOf } from '../../server/src/rooms/service'
import { decisionJson, roomAiOf } from '../../server/src/rooms/ai'
import { REDECIDE_KEY, redecideHidden } from '../../server/src/rooms/ai-redecide'
import { EARLIER_DEPTH, reasonsChanged } from '../../server/src/rooms/earlier-sources'
import { roomFilesOf } from '../../server/src/rooms/files'
import { openHistories } from '../../server/src/rooms/history'
import { countedUnreadIn } from '../../server/src/rooms/inbox'
import { readRoom, searchRooms } from '../../server/src/rooms/reader'
import { readThread } from '../../server/src/rooms/ai-context'
import { roomTool } from '../../server/src/connectors/remote-mcp/rooms'
import { loadPrincipal } from '../../server/src/policy/access'
import { readMigrations } from '../../server/src/db'
import type { TurnFiles } from '../../server/src/files/service'
import type { ReadSource } from '../../server/src/chat/read-scope'

setDefaultTimeout(60_000)
const cm = () => 'cm-' + crypto.randomUUID()
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const BRIEF = 'groups/marketing/campaign-brief.md'

let h: Harness
const ws: Record<string, TestSocket> = {}
let clock = Date.now()
const groupIds: Record<string, string> = {}
beforeAll(async () => {
  h = await startHarness({ name: 'b-rooms-history', askUserTimeoutMs: 3000, turnTimeoutMs: 60_000 })
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
/** ask the room's AI and wait for the end of the answer (the fake engine through the real launcher) */
async function ask(user: string, roomId: string, body: string): Promise<RoomMessage> {
  const q = await send(user, roomId, body)
  const f = await ws[user]!.next('room.ai.run', (x) => x.data.run.questionId === q.id && ['done', 'stopped', 'error'].includes(x.data.run.state), 40_000)
  expect(f.data.run.state, JSON.stringify(f.data.run.error)).toBe('done')
  return q
}
const answerTo = async (user: string, roomId: string, q: RoomMessage) => (await timeline(user, roomId)).find((m) => m.authorKind === 'ai' && m.replyTo?.id === q.id)
/** the <room_context> block a question in the timeline would get now */
function contextOf(roomId: string, userId: string): string {
  const r = roomAiOf(h.ctx).prepare({ chatId: 'none', roomId, userId, userMessageId: 'none', continues: false })
  if ('error' in r) throw new Error(JSON.stringify(r.error))
  return r.block
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
    await send('alice', roomId, 'welcome', { threadRootId: first.id })
    expect((await roomFor('bob', roomId)).threadsUnread).toBe(1)
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
    const a = aiAnswer(roomId, 'alice', 'The brief says CANARY-BRIEF-1 [brief](/files/view?path=groups/marketing/campaign-brief.md)', { sources: [folder('groups/marketing')] })
    h.ctx.db.query("INSERT INTO room_message_sources (message_id, ord, path, sha256, locs, via, by_main, by_subagent) VALUES (?, 0, ?, NULL, '[]', 'read', 1, 0)").run(a.answerId, BRIEF)
    const said = await send('erin', roomId, 'thanks, noted')
    const inThread = await send('erin', roomId, 'about CANARY-BRIEF-1 again', { threadRootId: a.answerId })
    await h.api('erin').call(API.reactRoomMessage, { params: { id: roomId, messageId: a.answerId }, body: { emoji: '🎉', on: true } })
    await setMembers(groupId, ['alice', 'erin', 'bob', 'carol'])
    // bob (finance) cannot read groups/marketing: one line, who asked, the question; nothing of the answer
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
    // carol (admin) may read it: the answer as everyone saw it
    const forCarol = (await timeline('carol', roomId)).find((m) => m.id === a.answerId)!
    expect(forCarol.withheld).toBeUndefined()
    expect(forCarol.body).toContain('CANARY-BRIEF-1')
    expect(forCarol.thread?.replyCount).toBe(1)
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
    const marketing = shared(JSON.stringify({ sources: [folder('groups/marketing')], unknown: false }), 'SHARED-MARKETING')
    const unknown = shared(JSON.stringify({ sources: [], unknown: true }), 'SHARED-UNKNOWN')
    const older = shared(null, 'SHARED-OLDER')
    const fine = shared(JSON.stringify({ sources: [folder('shared')], unknown: false }), 'SHARED-FINE')
    await setMembers(groupId, ['alice', 'erin', 'bob'])
    const items = await timeline('bob', roomId)
    const w = (id: string) => items.find((m) => m.id === id)!
    expect([marketing, unknown, older].map((id) => w(id).withheld)).toEqual([true, true, true])
    expect(w(marketing)).toMatchObject({ author: { id: 'alice' }, body: '', withheld: true })
    expect(w(fine).body).toBe('SHARED-FINE')
  })

  test('an answer built on one hidden from them is hidden too; one whose context started after it is not', async () => {
    const { roomId, groupId } = await teamRoom(['alice', 'erin'])
    const a = aiAnswer(roomId, 'alice', 'SECRET-A', { sources: [folder('groups/marketing')] })
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
  test('the readers of the person\'s own AI chat and of AI apps, room_thread and the search leave a hidden answer out', async () => {
    const { roomId, groupId } = await teamRoom(['alice', 'erin'])
    const a = aiAnswer(roomId, 'alice', 'READER-CANARY-7', { sources: [folder('groups/marketing')] })
    await send('erin', roomId, 'people talk before bob')
    await send('erin', roomId, 'in its thread READER-CANARY-7', { threadRootId: a.answerId })
    await setMembers(groupId, ['alice', 'erin', 'bob'])
    const tz = 'UTC'
    const read = readRoom(h.ctx.db, 'bob', tz, { room: roomId })
    expect(read.text).toContain('people talk before bob')
    expect(read.text).not.toContain('READER-CANARY-7')
    expect(readRoom(h.ctx.db, 'bob', tz, { room: roomId, thread: a.answerId }).text).toContain('No thread')
    expect(searchRooms(h.ctx.db, 'bob', tz, { query: 'READER-CANARY-7' }).text).toContain('No messages')
    expect(readThread(h.ctx.db, () => false, { roomId, userId: 'bob', thread: a.answerId }).text).toContain('No thread')
    // erin, who was there, still reads it
    expect(readRoom(h.ctx.db, 'erin', tz, { room: roomId }).text).toContain('READER-CANARY-7')
  })
})

describe('the room AI after a later member joined', () => {
  test('an answer whose context held an old answer hidden from someone stays private; their own question does not', async () => {
    const { roomId, groupId } = await teamRoom(['alice', 'erin'])
    aiAnswer(roomId, 'alice', 'HIDDEN-FROM-BOB-9', { sources: [folder('groups/marketing')] })
    await send('erin', roomId, 'people talk')
    await setMembers(groupId, ['alice', 'erin', 'bob'])
    // the context bob's AI gets: the people's words, never the answer hidden from him
    const bobs = contextOf(roomId, 'bob')
    expect(bobs).toContain('people talk')
    expect(bobs).not.toContain('HIDDEN-FROM-BOB-9')
    // alice asks: her AI saw the old answer, which bob cannot: private, and why without naming him. What the old
    // answer was built on (the marketing folder, which she may open) is named to her with how many cannot see it
    const a = await ask('alice', roomId, `@트리나 what was said\n${fake({ echo: 'message' })}`)
    const forAlice = (await answerTo('alice', roomId, a))!
    expect(forAlice.body).toContain('HIDDEN-FROM-BOB-9')
    expect(forAlice).toMatchObject({ visibility: 'private', preview: { earlier: true, folders: ['groups/marketing'], unable: { 'groups/marketing': 1 }, joinedLater: [] } })
    expect(forAlice.preview).not.toHaveProperty('hidden')
    expect(JSON.stringify(forAlice.preview)).not.toContain('Bob')
    // bob asks: what is hidden from him was never given, so it keeps nothing private
    const b = await ask('bob', roomId, `@트리나 what was said\n${fake({ echo: 'message' })}`)
    const forBob = (await answerTo('bob', roomId, b))!
    expect(forBob.body).not.toContain('HIDDEN-FROM-BOB-9')
    expect(forBob.visibility).toBe('room')
    // shown what is at stake, she may post hers (docs/DECISIONS.md "방에 올리기…"): then bob sees it, asked by her
    const post = await h.req('alice', `/api/rooms/${roomId}/messages/${forAlice.id}/share`, { method: 'POST' })
    expect(post.status).toBe(200)
    expect((await timeline('bob', roomId)).find((m) => m.id === forAlice.id)).toMatchObject({ visibility: 'room', askedBy: { id: 'alice' }, body: expect.stringContaining('HIDDEN-FROM-BOB-9') })
  })
})

describe('a thread\'s audience in a team room', () => {
  test('a member whose history is not open yet counts (worked out first, so it is decided on what they will see); one to whom the root is hidden does not', async () => {
    const { roomId, groupId } = await teamRoom(['alice', 'erin'])
    const root = await send('alice', roomId, 'thread start')
    const hiddenRoot = aiAnswer(roomId, 'alice', 'ROOT-SECRET', { sources: [folder('groups/marketing')] })
    await setMembers(groupId, ['alice', 'erin', 'bob', 'carol'])
    const db = h.ctx.db
    const chatId = uuidv7()
    db.query('INSERT INTO chats (id, user_id, room_id) VALUES (?, ?, ?)').run(chatId, 'alice', roomId)
    const ai = roomAiOf(h.ctx)
    const scope = { sources: [{ type: 'room' as const, id: roomId, fromSeq: root.seq }], outside: false }
    // carol's history not open yet (as after an upgrade): it is worked out before deciding (she may read everything)
    db.query('UPDATE room_members SET history_from_seq = NULL WHERE room_id = ? AND user_id = ?').run(roomId, 'carol')
    expect(ai.decide(roomId, chatId, scope, root.seq, { id: root.id, seq: root.seq }, root.seq + 100)).toMatchObject({ post: true, joinedLater: [] })
    expect(db.query('SELECT history_from_seq FROM room_members WHERE room_id = ? AND user_id = ?').get(roomId, 'carol')).toEqual({ history_from_seq: 0 })
    // the thread of the answer hidden from bob: he is not of its audience (he never sees it), so he keeps nothing private
    const inHidden = { sources: [{ type: 'room' as const, id: roomId, fromSeq: hiddenRoot.seq }], outside: false }
    const d2 = ai.decide(roomId, chatId, inHidden, hiddenRoot.seq, { id: hiddenRoot.answerId, seq: hiddenRoot.seq }, hiddenRoot.seq + 100)
    expect(d2).toMatchObject({ post: true, hidden: false })
  })
})

describe('when it is worked out', () => {
  test('existing later members (an upgrade, a row an older build made): from their join on until the next pass, then the history with the same check', async () => {
    const { roomId, groupId } = await teamRoom(['alice', 'erin'])
    const a = aiAnswer(roomId, 'alice', 'UPGRADE-HIDDEN', { sources: [folder('groups/marketing')] })
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

  test('hidden answers only become fewer: access gained later shows them, access lost later hides nothing they could read', async () => {
    const { roomId, groupId } = await teamRoom(['alice', 'erin'])
    const a = aiAnswer(roomId, 'alice', 'FEWER-CANARY', { sources: [folder('groups/marketing')] })
    const b = aiAnswer(roomId, 'alice', 'BUILT-ON-FEWER', { sources: [{ type: 'room', id: roomId, fromSeq: a.seq - 1 }] }, { threadRootId: a.answerId })
    await setMembers(groupId, ['alice', 'erin', 'bob'])
    expect(hiddenRows(roomId, 'bob')).toEqual([a.answerId, b.answerId].sort())
    const hidden = async () => (await timeline('bob', roomId)).find((m) => m.id === a.answerId)!.withheld ?? false
    try {
      // bob joins Marketing (he may read groups/marketing now): the access change checks his hidden answers again
      await setMembers(groupIds.marketing!, ['alice', 'erin', 'bob'])
      expect(await hidden()).toBe(false)
      expect(hiddenRows(roomId, 'bob')).toEqual([])
      expect((await h.api('bob').call(API.listRoomThread, { params: { id: roomId, messageId: a.answerId }, query: {} })).items.map((m) => m.body)).toEqual(['@트리나 what does it say?', 'BUILT-ON-FEWER'])
      // and leaves it again: what he could read stays his (as for the members who were there when it was posted)
      await setMembers(groupIds.marketing!, ['alice', 'erin'])
      expect(await hidden()).toBe(false)
      // leaving the room and joining again: worked out again with his access now
      await setMembers(groupId, ['alice', 'erin'])
      expect(hiddenRows(roomId, 'bob')).toEqual([])
      await setMembers(groupId, ['alice', 'erin', 'bob'])
      expect(await hidden()).toBe(true)
    } finally { await setMembers(groupIds.marketing!, ['alice', 'erin']) }
  })

  test('an answer in a thread that started before the join is judged, whenever it came; a deleted answer still counts', async () => {
    const { roomId, groupId } = await teamRoom(['alice', 'erin'])
    const root = await send('alice', roomId, 'old thread start')
    const gone = aiAnswer(roomId, 'alice', 'DELETED-SECRET', { sources: [folder('groups/marketing')] })
    const onGone = aiAnswer(roomId, 'erin', 'BUILT-ON-DELETED', { sources: [{ type: 'room', id: roomId, fromSeq: gone.seq }] })
    h.ctx.db.query("UPDATE room_messages SET body = '', deleted_at = ? WHERE id = ?").run(new Date().toISOString(), gone.answerId)
    await setMembers(groupId, ['alice', 'erin', 'bob'])
    // as after the upgrade (or before his history opened): an answer in the old thread, posted after he joined
    const db = h.ctx.db
    db.query('UPDATE room_members SET history_from_seq = NULL WHERE room_id = ? AND user_id = ?').run(roomId, 'bob')
    db.query('DELETE FROM room_hidden_answers WHERE room_id = ? AND user_id = ?').run(roomId, 'bob')
    const late = aiAnswer(roomId, 'alice', 'LATE-IN-OLD-THREAD', { sources: [folder('groups/marketing')] }, { threadRootId: root.id })
    openHistories(h.ctx)
    expect(hiddenRows(roomId, 'bob').sort()).toEqual([gone.answerId, onGone.answerId, late.answerId].sort())
    const thread = await h.api('bob').call(API.listRoomThread, { params: { id: roomId, messageId: root.id }, query: {} })
    expect(thread.items.find((m) => m.id === late.answerId)).toMatchObject({ withheld: true, body: '' })
    expect(JSON.stringify(thread)).not.toContain('LATE-IN-OLD-THREAD')
  })
})

describe('what people send that came from elsewhere', () => {
  test('a shared answer keeps what it used with it; a message an AI app sent after reading keeps what the app had read', async () => {
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
    // bob joins: both are one line for him, by their author; his own words are there
    await setMembers(groupId, ['alice', 'erin', 'bob'])
    const items = await timeline('bob', roomId)
    expect(items.find((m) => m.id === shared.id)).toMatchObject({ withheld: true, author: { id: 'alice' }, body: '' })
    expect(items.find((m) => m.id === appMsg.id)).toMatchObject({ withheld: true, author: { id: 'erin' }, body: '' })
    expect(items.find((m) => m.id === own.id)?.body).toBe('my own words')
    expect(JSON.stringify(items)).not.toMatch(/SHARED-BRIEF-CANARY|APP-SENT-CANARY/)
    // an AI app that read the room's history (with the line hidden from bob in it) cannot send it on to bob's thread…
    const read = readRoom(db, 'erin', 'UTC', { room: roomId })
    const seen = read.seen.map((x): ReadSource => ({ type: 'room', id: x.roomId, ...(x.fromSeq !== undefined ? { fromSeq: x.fromSeq } : {}) }))
    const refused = await roomTool(h.ctx, loadPrincipal(db, 'erin')!, 'room_send', { room: roomId, text: 'passing it on' }, {} as TurnFiles, { sources: seen, session: true })
    expect(refused.isError).toBe(true)
    // …while bob's own app, which never got it, may send after reading the same room
    const bobs = readRoom(db, 'bob', 'UTC', { room: roomId })
    const ok = await roomTool(h.ctx, loadPrincipal(db, 'bob')!, 'room_send', { room: roomId, text: 'bob after reading' }, {} as TurnFiles, { sources: bobs.seen.map((x): ReadSource => ({ type: 'room', id: x.roomId, ...(x.fromSeq !== undefined ? { fromSeq: x.fromSeq } : {}) })), session: true })
    expect(ok.isError).toBeFalsy()
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
  test('a question in a thread that reads a file from a hidden answer\'s thread keeps its answer private', async () => {
    const { roomId, groupId } = await teamRoom(['alice', 'erin'])
    const T = await send('alice', roomId, 'thread start (bob will see this)')
    const H = aiAnswer(roomId, 'alice', 'H-SECRET', { sources: [folder('groups/marketing')] })
    const src = path.join(h.dataDir, `upload-${uuidv7()}`), bytes = new TextEncoder().encode('FILE-CANARY-42 from the hidden thread\n')
    fs.writeFileSync(src, bytes)
    const file = await roomFilesOf(h.ctx).create('erin', roomId, 'budget-hidden.md', src, createHash('sha256').update(bytes).digest('hex'))
    await send('erin', roomId, 'the numbers for H', { threadRootId: H.answerId, fileIds: [file.id] })
    await setMembers(groupId, ['alice', 'erin', 'bob'])
    expect((await h.req('bob', `/api/rooms/${roomId}/files/${file.id}`)).status).toBe(404)
    const q = await send('alice', roomId, `@트리나 what does budget-hidden.md say?\n${fake({ tool: 'room_file', args: { file: 'budget-hidden.md' }, sayResult: true })}`, { threadRootId: T.id })
    const f = await ws.alice!.next('room.ai.run', (x) => x.data.run.questionId === q.id && ['done', 'stopped', 'error'].includes(x.data.run.state), 40_000)
    expect(f.data.run.state).toBe('done')
    const forAlice = (await h.api('alice').call(API.listRoomThread, { params: { id: roomId, messageId: T.id }, query: {} })).items.find((m) => m.authorKind === 'ai')!
    expect(forAlice.body).toContain('FILE-CANARY-42')
    expect(forAlice).toMatchObject({ visibility: 'private', preview: { hidden: true } })
    expect(JSON.stringify(await h.api('bob').call(API.listRoomThread, { params: { id: roomId, messageId: T.id }, query: {} }))).not.toContain('FILE-CANARY-42')
  })

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

  test('a member whose history is not worked out yet: the answer is decided on what they will see, and not postable past it', async () => {
    const { roomId, groupId } = await teamRoom(['alice', 'erin'])
    const db = h.ctx.db
    const H = aiAnswer(roomId, 'alice', 'H-MKT-SECRET', { sources: [folder('groups/marketing')] })
    await setMembers(groupId, ['alice', 'erin', 'bob'])
    db.query('UPDATE room_members SET history_from_seq = NULL WHERE room_id = ? AND user_id = ?').run(roomId, 'bob')
    db.query('DELETE FROM room_hidden_answers WHERE room_id = ? AND user_id = ?').run(roomId, 'bob')
    const chatId = uuidv7()
    db.query('INSERT INTO chats (id, user_id, room_id) VALUES (?, ?, ?)').run(chatId, 'alice', roomId)
    const next = () => (db.query('UPDATE rooms SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq').get(roomId) as { last_seq: number }).last_seq
    const qid = uuidv7(), pid = uuidv7(), now = new Date().toISOString()
    db.query(`INSERT INTO room_messages (id, room_id, seq, author_kind, author_id, visibility, body, mentions, created_at) VALUES (?, ?, ?, 'user', 'alice', 'room', '@트리나 recap', '[]', ?)`).run(qid, roomId, next(), now)
    db.query(`INSERT INTO room_messages (id, room_id, seq, author_kind, author_id, asked_by, visibility, visible_to, body, reply_to_id, mentions, created_at) VALUES (?, ?, ?, 'ai', NULL, 'alice', 'private', 'alice', 'RECAP: H-MKT-SECRET', ?, '[]', ?)`).run(pid, roomId, next(), qid, now)
    const scope = { sources: [{ type: 'room' as const, id: roomId, fromSeq: H.seq - 1 }], outside: false }
    // the reasons kept from before (as an older decision would have said: bob joined later)
    db.query(`INSERT INTO room_ai_turns (turn_id, room_id, user_id, chat_id, question_id, status, answer_id, scope, decision, created_at, ended_at) VALUES (?, ?, 'alice', ?, ?, 'private', ?, ?, ?, ?, ?)`)
      .run(uuidv7(), roomId, chatId, qid, pid, JSON.stringify(scope), JSON.stringify({ folders: [], otherFolders: false, personal: false, outside: false, joinedLater: ['Bob Lee'] }), now, now)
    // worked out first: what the answer hidden from him used (marketing, which alice may open) is named to her now, so
    // the new reasons are shown before anything is posted (docs/DECISIONS.md "방에 올리기…")
    const post = await h.req('alice', `/api/rooms/${roomId}/messages/${pid}/share`, { method: 'POST' })
    expect(post.status).toBe(409)
    expect(await post.text()).toContain('room_ai_reasons_changed')
    expect(hiddenRows(roomId, 'bob')).toContain(H.answerId)
    expect(JSON.stringify(await timeline('bob', roomId))).not.toContain('H-MKT-SECRET')
    expect((await timeline('alice', roomId)).find((m) => m.id === pid)?.preview).toMatchObject({ earlier: true, folders: ['groups/marketing'], unable: { 'groups/marketing': 1 } })
  })

  test('an answer of my own AI chat that used a hidden answer is not sent to the room, confirmed or not', async () => {
    const { roomId, groupId } = await teamRoom(['alice', 'erin'])
    const db = h.ctx.db
    aiAnswer(roomId, 'alice', 'H-SHARE-SECRET', { sources: [folder('groups/marketing')] })
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

// ---------------- found in the PR review (2026-11-07) ----------------
describe('found in the PR review', () => {
  test('deciding an answer spends a bounded time on members still waiting (an upgrade); one left waiting keeps it unpostable', async () => {
    const { roomId } = await teamRoom(['alice', 'erin'])
    const db = h.ctx.db, now = new Date().toISOString()
    const ANSWERS = 3000, WAITING = 30
    db.transaction(() => {
      const ins = db.query(`INSERT INTO room_messages (id, room_id, seq, author_kind, author_id, asked_by, visibility, body, mentions, created_at, reply_to_id) VALUES (?, ?, ?, ?, ?, ?, 'room', ?, '[]', ?, ?)`)
      const turn = db.query(`INSERT INTO room_ai_turns (turn_id, room_id, user_id, chat_id, question_id, status, answer_id, scope, created_at) VALUES (?, ?, 'alice', 'c', ?, 'posted', ?, ?, ?)`)
      let seq = (db.query('SELECT last_seq FROM rooms WHERE id = ?').get(roomId) as { last_seq: number }).last_seq, q = ''
      for (let i = 0; i < ANSWERS; i++) {
        q = uuidv7(); ins.run(q, roomId, ++seq, 'user', 'alice', null, `q ${i}`, now, null)
        const a = uuidv7(); ins.run(a, roomId, ++seq, 'ai', null, 'alice', `a ${i}`, now, q)
        // every third used the web (hidden from later members), each one's context the room from 30 back
        turn.run(uuidv7(), roomId, q, a, JSON.stringify({ sources: [{ type: 'room', id: roomId, fromSeq: Math.max(1, seq - 30) }], outside: i % 3 === 0 }), now)
      }
      db.query('UPDATE rooms SET last_seq = ? WHERE id = ?').run(seq, roomId)
      // members as migration 264 leaves them: joined at the end, history not worked out
      for (let i = 0; i < WAITING; i++) {
        const u = `wait${i}`
        db.query("INSERT OR IGNORE INTO users (id, username, name, role, status) VALUES (?, ?, ?, 'member', 'active')").run(u, u, `Waiting ${i}`)
        db.query('INSERT INTO room_members (room_id, user_id, joined_at, last_read_seq, visible_from_seq) VALUES (?, ?, ?, ?, ?)').run(roomId, u, now, seq, seq)
      }
    })()
    const last = (db.query('SELECT last_seq FROM rooms WHERE id = ?').get(roomId) as { last_seq: number }).last_seq
    const chatId = uuidv7()
    db.query('INSERT INTO chats (id, user_id, room_id) VALUES (?, ?, ?)').run(chatId, 'alice', roomId)
    const ai = roomAiOf(h.ctx)
    const scope = { sources: [{ type: 'room' as const, id: roomId, fromSeq: last - 10 }], outside: false }
    const t = performance.now()
    const d = ai.decide(roomId, chatId, scope, last + 1, undefined, last + 1)
    const took = performance.now() - t
    // the turn's end is held for about the budget, not for every waiting member's walk
    expect(took).toBeLessThan(1500)
    const still = (db.query('SELECT COUNT(*) n FROM room_members WHERE room_id = ? AND history_from_seq IS NULL').get(roomId) as { n: number }).n
    expect(still).toBeGreaterThan(0)
    expect(d).toMatchObject({ post: false, hidden: true })
    // one member's walk over 3,000 old answers (most hidden, each built on the ones before): linear, well under a second
    db.query("UPDATE room_members SET history_from_seq = NULL WHERE room_id = ? AND user_id = 'wait0'").run(roomId)
    const w = performance.now()
    openHistories(h.ctx, { roomId, userId: 'wait0' })
    expect(performance.now() - w).toBeLessThan(1000)
    expect(hiddenRows(roomId, 'wait0').length).toBeGreaterThan(ANSWERS * 0.9)
    // the rest worked out (the background passes): decided on what they see, the answer may go to the room
    openHistories(h.ctx, { roomId })
    expect(ai.decide(roomId, chatId, { sources: [], outside: false }, last + 1, undefined, last + 1).post).toBe(true)
    db.query("DELETE FROM room_members WHERE room_id = ? AND user_id LIKE 'wait%'").run(roomId)
  })

  test('a preview from before migration 246 (no scope kept) is never posted in a team room', async () => {
    const { roomId, groupId } = await teamRoom(['alice', 'erin'])
    const db = h.ctx.db
    aiAnswer(roomId, 'alice', 'H-OLD-SECRET', { sources: [folder('groups/marketing')] })
    await setMembers(groupId, ['alice', 'erin', 'bob'])
    // as after the upgrade: bob not worked out yet
    db.query('UPDATE room_members SET history_from_seq = NULL WHERE room_id = ? AND user_id = ?').run(roomId, 'bob')
    db.query('DELETE FROM room_hidden_answers WHERE room_id = ? AND user_id = ?').run(roomId, 'bob')
    const next = () => (db.query('UPDATE rooms SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq').get(roomId) as { last_seq: number }).last_seq
    const qid = uuidv7(), pid = uuidv7(), now = new Date().toISOString()
    db.query(`INSERT INTO room_messages (id, room_id, seq, author_kind, author_id, visibility, body, mentions, created_at) VALUES (?, ?, ?, 'user', 'alice', 'room', '@트리나 recap', '[]', ?)`).run(qid, roomId, next(), now)
    db.query(`INSERT INTO room_messages (id, room_id, seq, author_kind, author_id, asked_by, visibility, visible_to, body, reply_to_id, mentions, created_at) VALUES (?, ?, ?, 'ai', NULL, 'alice', 'private', 'alice', 'RECAP: H-OLD-SECRET', ?, '[]', ?)`).run(pid, roomId, next(), qid, now)
    db.query(`INSERT INTO room_ai_turns (turn_id, room_id, user_id, chat_id, question_id, status, answer_id, scope, decision, created_at, ended_at) VALUES (?, ?, 'alice', ?, ?, 'private', ?, NULL, ?, ?, ?)`)
      .run(uuidv7(), roomId, uuidv7(), qid, pid, JSON.stringify({ folders: [], otherFolders: false, personal: false, outside: false, joinedLater: [] }), now, now)
    const post = await h.req('alice', `/api/rooms/${roomId}/messages/${pid}/share`, { method: 'POST' })
    expect(post.status).toBe(409)
    expect(await post.text()).toContain('room_ai_ask_again')
    expect(JSON.stringify(await timeline('bob', roomId))).not.toContain('H-OLD-SECRET')
  })

  test('my own private preview from before I left and joined again stays out of sight', async () => {
    const { roomId, groupId } = await teamRoom(['alice', 'erin'])
    const db = h.ctx.db
    const next = () => (db.query('UPDATE rooms SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq').get(roomId) as { last_seq: number }).last_seq
    const pid = uuidv7()
    db.query(`INSERT INTO room_messages (id, room_id, seq, author_kind, author_id, asked_by, visibility, visible_to, body, mentions, created_at) VALUES (?, ?, ?, 'ai', NULL, 'erin', 'private', 'erin', 'OLD-PREVIEW-CANARY', '[]', ?)`).run(pid, roomId, next(), new Date().toISOString())
    expect(JSON.stringify(await timeline('erin', roomId))).toContain('OLD-PREVIEW-CANARY')
    await setMembers(groupId, ['alice'])
    await setMembers(groupId, ['alice', 'erin'])
    expect(JSON.stringify(await timeline('erin', roomId))).not.toContain('OLD-PREVIEW-CANARY')
    expect(readRoom(db, 'erin', 'UTC', { room: roomId }).text).not.toContain('OLD-PREVIEW-CANARY')
    expect((await h.req('erin', `/api/rooms/${roomId}/messages/${pid}/share`, { method: 'POST' })).status).toBe(404)
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
    aiAnswer(roomId, 'alice', 'H3-SECRET', { sources: [folder('groups/marketing')] })
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
    aiAnswer(roomId, 'alice', 'H4-SECRET', { sources: [folder('groups/marketing')] })
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

// ---------------- 방에 올리기… (2026-11-08, product owner): an answer built on a hidden one, shown what it used ----------------
describe('an answer built on an old answer hidden from someone', () => {
  /** alice's private preview of a question with this scope, straight into the database and decided as a turn's end
   * decides it (the engine is not the point): the question, the preview, the turn row with scope and decision */
  function preview(roomId: string, body: string, scope: { sources: ReadSource[]; outside?: boolean }, o: { threadRootId?: string; asker?: string } = {}) {
    const db = h.ctx.db, now = new Date().toISOString(), asker = o.asker ?? 'alice'
    const root = o.threadRootId ? db.query('SELECT id, seq FROM room_messages WHERE id = ?').get(o.threadRootId) as { id: string; seq: number } : null
    const next = () => (db.query('UPDATE rooms SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq').get(roomId) as { last_seq: number }).last_seq
    const chatId = uuidv7(), qid = uuidv7(), pid = uuidv7(), turnId = uuidv7()
    db.query('INSERT INTO chats (id, user_id, room_id) VALUES (?, ?, ?)').run(chatId, asker, roomId)
    const qseq = next()
    db.query(`INSERT INTO room_messages (id, room_id, seq, author_kind, author_id, visibility, body, mentions, created_at, thread_root_id, thread_root_seq) VALUES (?, ?, ?, 'user', ?, 'room', '@트리나 recap', '[]', ?, ?, ?)`)
      .run(qid, roomId, qseq, asker, now, root?.id ?? null, root?.seq ?? null)
    db.query(`INSERT INTO room_messages (id, room_id, seq, author_kind, author_id, asked_by, visibility, visible_to, body, reply_to_id, mentions, created_at, thread_root_id, thread_root_seq) VALUES (?, ?, ?, 'ai', NULL, ?, 'private', ?, ?, ?, '[]', ?, ?, ?)`)
      .run(pid, roomId, next(), asker, asker, body, qid, now, root?.id ?? null, root?.seq ?? null)
    const full = { outside: false, ...scope }
    const d = roomAiOf(h.ctx).decide(roomId, chatId, full, root?.seq ?? qseq, root ?? undefined, qseq)
    db.query(`INSERT INTO room_ai_turns (turn_id, room_id, user_id, chat_id, question_id, status, answer_id, scope, decision, created_at, ended_at) VALUES (?, ?, ?, ?, ?, 'private', ?, ?, ?, ?, ?)`)
      .run(turnId, roomId, asker, chatId, qid, pid, JSON.stringify(full), d.post ? null : decisionJson(d), now, now)
    return { id: pid, questionId: qid, decision: d }
  }
  const share = (user: string, roomId: string, id: string) => h.req(user, `/api/rooms/${roomId}/messages/${id}/share`, { method: 'POST' })
  const mine = async (roomId: string, id: string, rootId?: string) => (rootId ? (await h.api('alice').call(API.listRoomThread, { params: { id: roomId, messageId: rootId }, query: {} })).items : await timeline('alice', roomId)).find((m) => m.id === id)
  const fromSeq = (roomId: string, id: string) => (h.ctx.db.query('SELECT seq FROM room_messages WHERE room_id = ? AND id = ?').get(roomId, id) as { seq: number }).seq

  test('followed through the answers it was built on: the folders named with counts, posted only by the asker, after they say yes; audited', async () => {
    const { roomId, groupId } = await teamRoom(['alice', 'erin'])
    // H1 read marketing; H2 (erin's) was built on H1 alone: both hidden from bob, who cannot open marketing
    const H1 = aiAnswer(roomId, 'alice', 'H1-SECRET', { sources: [folder('groups/marketing')] })
    const H2 = aiAnswer(roomId, 'erin', 'H2 repeats H1-SECRET', { sources: [{ type: 'room', id: roomId, fromSeq: H1.seq - 1 }] })
    await setMembers(groupId, ['alice', 'erin', 'bob'])
    expect(hiddenRows(roomId, 'bob').sort()).toEqual([H1.answerId, H2.answerId].sort())
    // alice's question saw H2 only (its context starts after H1): what H2 was built on is followed to H1's folder
    const p = preview(roomId, 'RECAP: H1-SECRET', { sources: [{ type: 'room', id: roomId, fromSeq: H2.seq }] })
    expect(p.decision).toMatchObject({ post: false, hidden: false, earlier: true, folders: ['groups/marketing'], unable: { 'groups/marketing': 1 }, personal: false, outside: false })
    expect((await mine(roomId, p.id))!.preview).toEqual({ folders: ['groups/marketing'], personal: false, outside: false, joinedLater: [], earlier: true, unable: { 'groups/marketing': 1 } })
    // never anyone else's to post: erin and bob get the same 404 as a message that does not exist
    for (const u of ['erin', 'bob']) expect((await share(u, roomId, p.id)).status).toBe(404)
    expect(JSON.stringify(await timeline('bob', roomId))).not.toContain('RECAP: H1-SECRET')
    // the asker posts it: everyone sees it, asked by her; audited with `earlier`
    const r = await share('alice', roomId, p.id)
    expect(r.status).toBe(200)
    for (const u of ['bob', 'erin']) expect((await timeline(u, roomId)).find((m) => m.id === p.id)).toMatchObject({ visibility: 'room', askedBy: { id: 'alice' }, body: 'RECAP: H1-SECRET' })
    const a = h.ctx.db.query("SELECT actor_id, detail FROM audit_log WHERE action = 'room.ai_share' AND target = ?").get(p.id) as { actor_id: string; detail: string }
    expect(a.actor_id).toBe('alice')
    expect(JSON.parse(a.detail)).toMatchObject({ roomId, earlier: true, sourcesLeftOut: 0 })
    expect(a.detail).not.toContain('bob')
  })

  test('one that used another room, a connection, someone else\'s folder, a folder the asker cannot open, or people\'s words in its thread: no button, refused', async () => {
    const db = h.ctx.db
    // a 1:1 of alice and erin that a team room answer read
    const dm = await h.api('alice').call(API.createRoom, { body: { kind: 'dm', userId: 'erin' } })
    const cases: { name: string; asker: string; sources: ReadSource[]; members: string[]; later: string; reply?: boolean }[] = [
      { name: 'a 1:1', asker: 'alice', sources: [{ type: 'room', id: dm.id }], members: ['alice', 'erin'], later: 'bob' },
      { name: 'a connection', asker: 'alice', sources: [{ type: 'integration', id: uuidv7() }], members: ['alice', 'erin'], later: 'bob' },
      { name: "erin's own folder", asker: 'erin', sources: [{ type: 'user', id: 'erin' }], members: ['alice', 'erin'], later: 'bob' },
      // carol (admin) read finance, which alice cannot open: erin, joining later, cannot either
      { name: 'a folder alice cannot open', asker: 'carol', sources: [folder('groups/finance')], members: ['alice', 'carol'], later: 'erin' },
      { name: "people's words in its thread", asker: 'alice', sources: [folder('groups/marketing')], members: ['alice', 'erin'], later: 'bob', reply: true },
    ]
    for (const c of cases) {
      const { roomId, groupId } = await teamRoom(c.members)
      const H = aiAnswer(roomId, c.asker, `H-${c.name}`, { sources: c.sources })
      if (c.reply) await send(c.members[1]!, roomId, 'a word in its thread', { threadRootId: H.answerId })
      await setMembers(groupId, [...c.members, c.later])
      expect(hiddenRows(roomId, c.later), c.name).toContain(H.answerId)
      const p = preview(roomId, `RECAP ${c.name}`, { sources: [{ type: 'room', id: roomId, fromSeq: H.seq - 1 }] })
      expect(p.decision, c.name).toMatchObject({ post: false, hidden: true, earlier: false })
      expect((await mine(roomId, p.id))!.preview, c.name).toMatchObject({ hidden: true })
      expect((await mine(roomId, p.id))!.preview, c.name).not.toHaveProperty('earlier')
      const r = await share('alice', roomId, p.id)
      expect(r.status, c.name).toBe(409)
      expect((await r.json()).error.params.reason, c.name).toBe('room_ai_hidden')
      expect(JSON.stringify(await timeline(c.later, roomId)), c.name).not.toContain(`RECAP ${c.name}`)
    }
    expect(db.query("SELECT COUNT(*) n FROM audit_log WHERE action = 'room.ai_share' AND json_extract(detail, '$.earlier') = 1 AND target IN (SELECT id FROM room_messages WHERE body LIKE 'RECAP %')").get()).toEqual({ n: 0 })
  })

  test('a team room member whose history cannot be worked out yet keeps it unpostable, whatever the hidden answer used', async () => {
    const { roomId, groupId } = await teamRoom(['alice', 'erin'])
    const db = h.ctx.db
    const H = aiAnswer(roomId, 'alice', 'H-WAIT-SECRET', { sources: [folder('groups/marketing')] })
    await setMembers(groupId, ['alice', 'erin', 'bob'])
    // his history as after an upgrade, and its pass failing (tried again only minutes later)
    db.query('UPDATE room_members SET history_from_seq = NULL WHERE room_id = ? AND user_id = ?').run(roomId, 'bob')
    db.query('DELETE FROM room_hidden_answers WHERE room_id = ? AND user_id = ?').run(roomId, 'bob')
    db.exec(`CREATE TEMP TRIGGER bob_history_fails BEFORE UPDATE OF history_from_seq ON room_members WHEN NEW.user_id = 'bob' AND NEW.room_id = '${roomId}' BEGIN SELECT RAISE(ABORT, 'test: history fails'); END`)
    try {
      openHistories(h.ctx, { roomId })
      const p = preview(roomId, 'RECAP: H-WAIT-SECRET', { sources: [{ type: 'room', id: roomId, fromSeq: H.seq - 1 }] })
      expect(p.decision).toMatchObject({ post: false, hidden: true, earlier: false })
      const r = await share('alice', roomId, p.id)
      expect(r.status).toBe(409)
      expect((await r.json()).error.params.reason).toBe('room_ai_hidden')
      expect(JSON.stringify(await timeline('bob', roomId))).not.toContain('RECAP: H-WAIT-SECRET')
    } finally { db.exec('DROP TRIGGER IF EXISTS bob_history_fails') }
  })

  test('reasons that changed since (one more member who cannot see the folder) are shown first: 409, the preview updated, then it goes', async () => {
    const { roomId, groupId } = await teamRoom(['alice', 'erin'])
    const db = h.ctx.db
    const H = aiAnswer(roomId, 'alice', 'H-COUNT-SECRET', { sources: [folder('groups/marketing')] })
    await setMembers(groupId, ['alice', 'erin', 'bob'])
    const p = preview(roomId, 'RECAP: H-COUNT-SECRET', { sources: [{ type: 'room', id: roomId, fromSeq: H.seq - 1 }] })
    expect(p.decision.unable).toEqual({ 'groups/marketing': 1 })
    db.query("INSERT OR IGNORE INTO users (id, username, name, role, status) VALUES ('frank', 'frank', 'Frank Ode', 'member', 'active')").run()
    await setMembers(groupId, ['alice', 'erin', 'bob', 'frank'])
    const updated = ws.alice!.next('room.message.updated', (x) => x.data.message.id === p.id && x.data.message.preview?.unable?.['groups/marketing'] === 2)
    const r = await share('alice', roomId, p.id)
    expect(r.status).toBe(409)
    expect((await r.json()).error.params.reason).toBe('room_ai_reasons_changed')
    expect((await updated).data.message.preview).toMatchObject({ earlier: true, unable: { 'groups/marketing': 2 } })
    const visibility = () => (db.query('SELECT visibility FROM room_messages WHERE id = ?').get(p.id) as { visibility: string }).visibility
    expect(visibility()).toBe('private')
    // asked again with the new count in sight: it goes
    expect((await share('alice', roomId, p.id)).status).toBe(200)
    expect(visibility()).toBe('room')
    expect((await timeline('bob', roomId)).find((m) => m.id === p.id)).toMatchObject({ visibility: 'room' })
  })

  test('in a thread: the hidden answer there is followed the same way, and the answer is posted into the thread', async () => {
    const { roomId, groupId } = await teamRoom(['alice', 'erin'])
    const T = await send('erin', roomId, 'thread start (bob will see this)')
    const H = aiAnswer(roomId, 'alice', 'TH-SECRET', { sources: [folder('groups/marketing')] }, { threadRootId: T.id })
    await setMembers(groupId, ['alice', 'erin', 'bob'])
    expect(hiddenRows(roomId, 'bob')).toContain(H.answerId)
    const p = preview(roomId, 'THREAD RECAP: TH-SECRET', { sources: [{ type: 'room', id: roomId, fromSeq: T.seq }] }, { threadRootId: T.id })
    expect(p.decision).toMatchObject({ post: false, hidden: false, earlier: true, folders: ['groups/marketing'], unable: { 'groups/marketing': 1 } })
    expect((await mine(roomId, p.id, T.id))!.preview).toMatchObject({ earlier: true })
    expect((await share('alice', roomId, p.id)).status).toBe(200)
    const forBob = (await h.api('bob').call(API.listRoomThread, { params: { id: roomId, messageId: T.id }, query: {} })).items
    expect(forBob.find((m) => m.id === p.id)).toMatchObject({ visibility: 'room', askedBy: { id: 'alice' }, threadRootId: T.id })
    // not in the timeline (an answer in a thread stays there)
    expect((await timeline('bob', roomId)).some((m) => m.id === p.id)).toBe(false)
    expect(fromSeq(roomId, p.id)).toBeGreaterThan(H.seq)
  })

  test('at start, a preview kept as not postable before this build is decided again (nothing posted)', async () => {
    const { roomId, groupId } = await teamRoom(['alice', 'erin'])
    const db = h.ctx.db
    const H = aiAnswer(roomId, 'alice', 'H-OLD-REFUSED', { sources: [folder('groups/marketing')] })
    await setMembers(groupId, ['alice', 'erin', 'bob'])
    const p = preview(roomId, 'RECAP: H-OLD-REFUSED', { sources: [{ type: 'room', id: roomId, fromSeq: H.seq - 1 }] })
    // as an older build kept it
    db.query('UPDATE room_ai_turns SET decision = ? WHERE answer_id = ?').run(JSON.stringify({ folders: [], otherFolders: false, personal: false, outside: false, joinedLater: [], hidden: true }), p.id)
    expect((await mine(roomId, p.id))!.preview).toMatchObject({ hidden: true })
    // once per database: the harness's start went through (no previews then), so it runs again only when forced
    expect(db.query('SELECT 1 n FROM settings WHERE key = ?').get(REDECIDE_KEY)).toEqual({ n: 1 })
    expect(redecideHidden(h.ctx)).toBe(0)
    expect((await mine(roomId, p.id))!.preview).toMatchObject({ hidden: true })
    expect(redecideHidden(h.ctx, { force: true })).toBeGreaterThanOrEqual(1)
    expect((await mine(roomId, p.id))!.preview).toMatchObject({ earlier: true, folders: ['groups/marketing'], unable: { 'groups/marketing': 1 } })
    expect((await mine(roomId, p.id))!.visibility).toBe('private')
    expect(JSON.stringify(await timeline('bob', roomId))).not.toContain('RECAP: H-OLD-REFUSED')
  })

  /** a person's message straight into the database: a shared answer (`answerAt`: where the answer starts, 0 without a
   * note) with what it used kept, as "대화방에 보내기" keeps it */
  function shared(roomId: string, author: string, body: string, answerAt: number, sources: ReadSource[], root?: { id: string; seq: number }) {
    const db = h.ctx.db
    const seq = (db.query('UPDATE rooms SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq').get(roomId) as { last_seq: number }).last_seq
    const id = uuidv7()
    db.query(`INSERT INTO room_messages (id, room_id, seq, author_kind, author_id, visibility, body, mentions, created_at, answer_at, source_scope, thread_root_id, thread_root_seq) VALUES (?, ?, ?, 'user', ?, 'room', ?, '[]', ?, ?, ?, ?, ?)`)
      .run(id, roomId, seq, author, body, new Date().toISOString(), answerAt, JSON.stringify({ sources, unknown: false }), root?.id ?? null, root?.seq ?? null)
    return { id, seq }
  }

  test("people's words are never followed: a shared answer's note, a deleted reply in a hidden answer's thread, files on a hidden message", async () => {
    const db = h.ctx.db
    const cases: { name: string; build: (roomId: string) => Promise<number> }[] = [
      // (each returns where the question's context starts: the hidden message itself, or an AI answer's question)
      { name: 'a note', build: async (roomId) => shared(roomId, 'erin', 'my note\n\nSHARED-SECRET', 9, [folder('groups/marketing')]).seq },
      { name: 'a deleted reply', build: async (roomId) => {
        const H = aiAnswer(roomId, 'alice', 'H-DEL-SECRET', { sources: [folder('groups/marketing')] })
        const r = await send('erin', roomId, 'a word that went to the AI', { threadRootId: H.answerId })
        expect((await h.req('erin', `/api/rooms/${roomId}/messages/${r.id}`, { method: 'DELETE' })).status).toBe(204)
        return H.seq
      } },
      { name: 'files', build: async (roomId) => {
        const src = path.join(h.dataDir, `upload-${uuidv7()}`), bytes = new TextEncoder().encode('UPLOAD-SECRET\n')
        fs.writeFileSync(src, bytes)
        const file = await roomFilesOf(h.ctx).create('erin', roomId, 'upload.md', src, createHash('sha256').update(bytes).digest('hex'))
        const m = await send('erin', roomId, 'SHARED-WITH-FILE', { fileIds: [file.id] })
        db.query('UPDATE room_messages SET answer_at = 0, source_scope = ? WHERE id = ?').run(JSON.stringify({ sources: [folder('groups/marketing')], unknown: false }), m.id)
        return m.seq
      } },
      // an AI answer in a hidden answer's thread: the question that asked it there is a person's words
      { name: 'an AI answer in its thread', build: async (roomId) => {
        const R = aiAnswer(roomId, 'alice', 'ROOT-SECRET', { sources: [folder('groups/marketing')] })
        aiAnswer(roomId, 'erin', 'REPLY repeats ROOT-SECRET', { sources: [{ type: 'room', id: roomId, fromSeq: R.seq }] }, { threadRootId: R.answerId })
        return R.seq
      } },
    ]
    for (const c of cases) {
      const { roomId, groupId } = await teamRoom(['alice', 'erin'])
      const from = await c.build(roomId)
      await setMembers(groupId, ['alice', 'erin', 'bob'])
      expect(hiddenRows(roomId, 'bob').length, c.name).toBeGreaterThan(0)
      const p = preview(roomId, `RECAP ${c.name}`, { sources: [{ type: 'room', id: roomId, fromSeq: from }] })
      expect(p.decision, c.name).toMatchObject({ hidden: true, earlier: false })
      expect((await share('alice', roomId, p.id)).status, c.name).toBe(409)
    }
    // a shared answer without a note is the AI's words alone: what it used is followed
    const { roomId, groupId } = await teamRoom(['alice', 'erin'])
    const S = shared(roomId, 'erin', 'SHARED-NO-NOTE', 0, [folder('groups/marketing')])
    await setMembers(groupId, ['alice', 'erin', 'bob'])
    expect(preview(roomId, 'RECAP no note', { sources: [{ type: 'room', id: roomId, fromSeq: S.seq }] }).decision).toMatchObject({ hidden: false, earlier: true, folders: ['groups/marketing'] })
  })

  test("a hidden reply in a hidden answer's thread goes through that answer; the asker's own folder and a name are named; too deep is refused", async () => {
    // the reply (an answer shared there without a note) and its thread's first message are both hidden from bob: the
    // reply is followed, and through it the first message and what each used
    {
      const { roomId, groupId } = await teamRoom(['alice', 'erin'])
      const R = aiAnswer(roomId, 'alice', 'ROOT-SECRET', { sources: [{ type: 'user', id: 'alice' }] })
      const reply = shared(roomId, 'erin', 'REPLY from marketing', 0, [folder('groups/marketing')], { id: R.answerId, seq: R.seq })
      await setMembers(groupId, ['alice', 'erin', 'bob'])
      expect(hiddenRows(roomId, 'bob')).toEqual(expect.arrayContaining([R.answerId, reply.id]))
      expect(preview(roomId, 'RECAP thread', { sources: [{ type: 'room', id: roomId, fromSeq: R.seq }] }).decision)
        .toMatchObject({ hidden: false, earlier: true, personal: true, folders: ['groups/marketing'], unable: { 'groups/marketing': 1 } })
    }
    // her own folder: the "my folder" reason; a name she may read: its folder named with its count
    {
      const { roomId, groupId } = await teamRoom(['alice', 'erin'])
      const own = aiAnswer(roomId, 'alice', 'OWN-SECRET', { sources: [{ type: 'user', id: 'alice' }] })
      const name = aiAnswer(roomId, 'alice', 'NAME-SECRET', { sources: [{ type: 'name', path: BRIEF }] })
      await setMembers(groupId, ['alice', 'erin', 'bob'])
      expect(hiddenRows(roomId, 'bob')).toEqual(expect.arrayContaining([own.answerId, name.answerId]))
      expect(preview(roomId, 'RECAP own and name', { sources: [{ type: 'room', id: roomId, fromSeq: own.seq - 1 }] }).decision)
        .toMatchObject({ hidden: false, earlier: true, personal: true, folders: ['groups/marketing'], unable: { 'groups/marketing': 1 } })
    }
    // a chain of answers each built on the one before: followed to EARLIER_DEPTH levels, refused past them
    for (const [length, refused] of [[EARLIER_DEPTH, false], [EARLIER_DEPTH + 2, true]] as const) {
      const { roomId, groupId } = await teamRoom(['alice', 'erin'])
      let last = aiAnswer(roomId, 'alice', 'CHAIN-0', { sources: [folder('groups/marketing')] })
      for (let i = 1; i < length; i++) last = aiAnswer(roomId, 'erin', `CHAIN-${i}`, { sources: [{ type: 'room', id: roomId, fromSeq: last.seq }] })
      await setMembers(groupId, ['alice', 'erin', 'bob'])
      expect(hiddenRows(roomId, 'bob').length).toBe(length)
      const d = preview(roomId, `RECAP chain ${length}`, { sources: [{ type: 'room', id: roomId, fromSeq: last.seq }] }).decision
      expect(d, `chain of ${length}`).toMatchObject(refused ? { hidden: true, earlier: false } : { hidden: false, earlier: true, folders: ['groups/marketing'] })
    }
  })

  test('a decision kept before the counts is compared without them; any other change is a change', () => {
    const before = JSON.stringify({ folders: ['groups/marketing'], otherFolders: false, personal: false, outside: false, joinedLater: [] })
    const now = JSON.stringify({ folders: ['groups/marketing'], otherFolders: false, personal: false, outside: false, joinedLater: [], unable: { 'groups/marketing': 2 } })
    expect(reasonsChanged(before, now)).toBe(false)
    expect(reasonsChanged(now, now)).toBe(false)
    expect(reasonsChanged(now, now.replace('"groups/marketing":2', '"groups/marketing":3'))).toBe(true)
    expect(reasonsChanged(before, now.replace('"joinedLater":[]', '"joinedLater":["Bob Lee"]'))).toBe(true)
    expect(reasonsChanged(before, now.replace('"joinedLater":[]', '"joinedLater":[],"earlier":true'))).toBe(true)
    expect(reasonsChanged(null, now)).toBe(true)
  })
})
