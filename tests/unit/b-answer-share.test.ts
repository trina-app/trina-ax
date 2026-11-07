// "대화방에 보내기" (shared/src/api/chats.ts shareAnswerToRoom, server/src/chat/answer-share.ts): a finished answer of my
// own AI chat goes to a room I am in as my message (my note, then the answer; RoomMessage.sharedAnswer). Covered: who
// may (my own chat only; not a room's AI session, a deleted chat, another chat's message; a room I am not in answers like
// one that does not exist), what may be sent (a finished answer only), "confirm" when some member could not read what it
// used (how many, the places I may name myself, never who; the files of every answer on its branch, the paths it links
// to, an answer the session's scope does not describe, a disabled member), confirm with that number sends (a larger
// number of people asks again), a long answer cut with a line in my language, its file links per viewer, no mention and
// no room AI whatever its text says, no edit, the same request again, a confidential conversation, the sending budget
// (the check too), and the audit row. Chats, answers and their read scope are written straight into the
// database (the fixture team: alice and erin in marketing, bob in finance, carol admin, dana owner).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, ROOM_MESSAGE_MAX, uuidv7, type Room, type RoomMessage } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { roomsOf, SEND_BURST } from '../../server/src/rooms/service'
import { answerCutLine } from '../../server/src/chat/answer-share'
import { readMigrations } from '../../server/src/db'
import type { ReadSource } from '../../server/src/chat/read-scope'

setDefaultTimeout(60_000)
const cm = () => 'cm-' + crypto.randomUUID()
const NAMES = ['alice', 'bob', 'carol', 'dana', 'erin', 'Alice', 'Bob', 'Carol', 'Dana', 'Erin']

let h: Harness
let erinWs: TestSocket
let rooms: { all: string; marketing: string; finance: string; dmAliceBob: string; group: string }
let clock = Date.now()
beforeAll(async () => {
  h = await startHarness({ name: 'b-answer-share' })
  // the contract's group ids (and a team room's groupId) are UUIDv7; the fixture's are short
  const db = h.ctx.db
  db.exec('PRAGMA foreign_keys = OFF')
  for (const g of ['marketing', 'finance']) {
    const id = uuidv7()
    for (const sql of ['UPDATE groups SET id = ?1 WHERE id = ?2', 'UPDATE group_members SET group_id = ?1 WHERE group_id = ?2', "UPDATE folder_rules SET subject_id = ?1 WHERE subject_type = 'group' AND subject_id = ?2", 'UPDATE rooms SET group_id = ?1 WHERE group_id = ?2'])
      db.query(sql).run(id, g)
  }
  db.exec('PRAGMA foreign_keys = ON')
  // the sending budget refills between requests (its own test freezes it)
  roomsOf(h.ctx).clock = () => (clock += 10_000)
  const list = async (u: string) => (await h.api(u).call(API.listRooms)).items as Room[]
  const team = (l: Room[], name: string) => l.find((r) => r.kind === 'team' && r.name === name)!.id
  const alice = await list('alice')
  rooms = {
    all: alice.find((r) => r.kind === 'all')!.id,
    marketing: team(alice, 'Marketing'),
    finance: team(await list('bob'), 'Finance'),
    dmAliceBob: (await h.api('alice').call(API.createRoom, { body: { kind: 'dm', userId: 'bob' } })).id,
    group: (await h.api('alice').call(API.createRoom, { body: { kind: 'group', userIds: ['bob', 'erin'] } })).id,
  }
  erinWs = await h.ws('erin')
  await erinWs.next('hello')
})
afterAll(async () => { erinWs?.close(); await h.close() })

/** An answer of `user`'s own chat, written straight into the database: the files it read, the chat's read scope. */
function answer(user: string, content: string, o: { read?: string[]; scope?: ReadSource[]; status?: string; roomsSeen?: boolean; roomSession?: string; deleted?: boolean } = {}) {
  const db = h.ctx.db
  const chatId = uuidv7(), askId = uuidv7(), answerId = uuidv7()
  db.query('INSERT INTO chats (id, user_id, room_id, session_read_scope, rooms_seen, deleted_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(chatId, user, o.roomSession ?? null, o.scope ? JSON.stringify({ sources: o.scope }) : null, o.roomsSeen ? 1 : 0, o.deleted ? new Date().toISOString() : null)
  db.query("INSERT INTO messages (id, chat_id, role, content, status) VALUES (?, ?, 'user', '정리해 줘', 'done')").run(askId, chatId)
  db.query("INSERT INTO messages (id, chat_id, parent_id, role, content, status) VALUES (?, ?, ?, 'assistant', ?, ?)").run(answerId, chatId, askId, content, o.status ?? 'done')
  db.query('UPDATE chats SET active_leaf_id = ? WHERE id = ?').run(answerId, chatId)
  ;(o.read ?? []).forEach((p, i) => db.query("INSERT INTO message_sources (message_id, ord, path, sha256, locs, via, by_main, by_subagent) VALUES (?, ?, ?, NULL, '[]', 'read', 1, 0)").run(answerId, i, p))
  return { chatId, askId, answerId }
}
async function share(user: string, a: { chatId: string; answerId: string }, body: Record<string, unknown>) {
  const r = await h.req(user, `/api/chats/${a.chatId}/messages/${a.answerId}/share-to-room`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientMessageId: cm(), ...body }) })
  const text = await r.text()
  return { status: r.status, text, json: text ? JSON.parse(text) : undefined }
}
const messagesAs = async (user: string, roomId: string) => (await h.api(user).call(API.listRoomMessages, { params: { id: roomId }, query: {} })).items as RoomMessage[]
const folderId = (p: string) => (h.ctx.db.query('SELECT id FROM folders WHERE path = ?').get(p) as { id: string }).id
const BRIEF = 'groups/marketing/campaign-brief.md'

describe('who may share what', () => {
  test("only my own chat's finished answer, to a room I am in; everything else answers like nothing is there", async () => {
    const a = answer('alice', '요약이에요.')
    // someone else's chat, a room's AI session, a deleted chat, a message of another chat: 404
    expect((await share('bob', a, { roomId: rooms.all })).status).toBe(404)
    expect((await share('dana', a, { roomId: rooms.all })).status).toBe(404)
    expect((await share('alice', answer('alice', 'x', { roomSession: rooms.marketing }), { roomId: rooms.marketing })).status).toBe(404)
    expect((await share('alice', answer('alice', 'x', { deleted: true }), { roomId: rooms.marketing })).status).toBe(404)
    expect((await share('alice', { chatId: a.chatId, answerId: answer('alice', 'x').answerId }, { roomId: rooms.marketing })).status).toBe(404)
    // a room I am not in, and one that does not exist: the same 404
    const notIn = await share('alice', a, { roomId: rooms.finance })
    const unknown = await share('alice', a, { roomId: uuidv7() })
    expect(notIn.status).toBe(404)
    expect(unknown.status).toBe(404)
    expect(notIn.json.error.code).toBe(unknown.json.error.code)
    // my question, an answer still being written, an empty answer: refused, nothing sent
    const before = (await messagesAs('alice', rooms.marketing)).length
    expect((await share('alice', { chatId: a.chatId, answerId: a.askId }, { roomId: rooms.marketing })).status).toBe(400)
    const streaming = await share('alice', answer('alice', '쓰는 중', { status: 'streaming' }), { roomId: rooms.marketing })
    expect(streaming.status).toBe(409)
    expect(streaming.json.error.params.reason).toBe('answer_not_finished')
    expect((await share('alice', answer('alice', '   '), { roomId: rooms.marketing })).status).toBe(409)
    expect((await share('alice', answer('alice', 'x', { status: 'error' }), { roomId: rooms.marketing })).status).toBe(409)
    expect((await messagesAs('alice', rooms.marketing)).length).toBe(before)
  })
})

describe('sent when everyone in the room may read what it used', () => {
  test('my message: my note, then the answer; no mention; the others get it', async () => {
    const content = '## 요약\n\n- 마케팅 브리프 [brief](/files/view?path=groups/marketing/campaign-brief.md)\n- 용어집'
    const a = answer('alice', content, { read: [BRIEF, 'shared/glossary.md', 'skills/team-rules.md'] })
    const r = await share('alice', a, { roomId: rooms.marketing, note: '  회의 전에\n봐 주세요  ' })
    expect(r.status).toBe(200)
    expect(r.json.status).toBe('sent')
    expect(r.json.cut).toBe(false)
    const m = r.json.message as RoomMessage
    expect(m).toMatchObject({ authorKind: 'user', author: { id: 'alice' }, mentions: [], visibility: 'room' })
    expect(m.body).toBe(`회의 전에 봐 주세요\n\n${content}`)
    expect(m.sharedAnswer).toEqual({ at: '회의 전에 봐 주세요'.length + 2, cut: false })
    expect(m.openable).toEqual([BRIEF])
    // erin, the other member, gets it as a room message, with the same mark
    const ev = await erinWs.next('room.message', (f) => f.data.message.id === m.id)
    expect(ev.data.message.sharedAnswer).toEqual(m.sharedAnswer)
    // no note: the answer starts the message
    const plain = await share('alice', answer('alice', '짧은 답', { read: ['shared/glossary.md'] }), { roomId: rooms.marketing })
    expect(plain.json.message.body).toBe('짧은 답')
    expect(plain.json.message.sharedAnswer).toEqual({ at: 0, cut: false })
    // audited: the room, how many could not read (none), not confirmed; no content, no names
    const row = h.ctx.db.query("SELECT actor_id, target, detail FROM audit_log WHERE action = 'room.answer_share' AND target = ?").get(m.id) as { actor_id: string; target: string; detail: string }
    expect(row.actor_id).toBe('alice')
    expect(JSON.parse(row.detail)).toEqual({ roomId: rooms.marketing, people: 0, confirmed: false, cut: false })
  })

  test('a room the answer read whose members are all in the target room: no question', async () => {
    // the everyone room's messages, shared into the marketing room (both of its members are in the everyone room)
    const r = await share('alice', answer('alice', '전체 방 요약', { scope: [{ type: 'room', id: rooms.all }] }), { roomId: rooms.marketing })
    expect(r.json.status).toBe('sent')
  })
})

describe('"confirm" first when some member could not read what it used', () => {
  test('a team folder: how many and which folder, never who; confirm with that number sends', async () => {
    const a = answer('alice', '브리프 요약', { read: [BRIEF] })
    const body = { roomId: rooms.all, clientMessageId: cm() }
    const before = (await messagesAs('alice', rooms.all)).length
    const r = await share('alice', a, body)
    expect(r.status).toBe(200)
    // bob (finance) cannot read groups/marketing; carol and dana (admin, owner) and erin may
    expect(r.json).toEqual({ status: 'confirm', people: 1, places: [{ kind: 'folder', path: 'groups/marketing' }], otherPlaces: false })
    for (const n of NAMES) expect(r.text).not.toContain(n)
    expect((await messagesAs('alice', rooms.all)).length).toBe(before)
    // sent with the person's yes; audited as confirmed
    const yes = await share('alice', a, { ...body, confirm: 1 })
    expect(yes.json.status).toBe('sent')
    expect((await messagesAs('alice', rooms.all)).length).toBe(before + 1)
    const row = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'room.answer_share' AND target = ?").get(yes.json.message.id) as { detail: string }
    expect(JSON.parse(row.detail)).toEqual({ roomId: rooms.all, people: 1, confirmed: true, cut: false })
  })

  test('my own folder is "mine"; a folder I cannot read myself is not named', async () => {
    const mine = await share('alice', answer('alice', '내 메모', { read: ['users/alice/notes.md'] }), { roomId: rooms.marketing })
    expect(mine.json).toEqual({ status: 'confirm', people: 1, places: [{ kind: 'mine' }], otherPlaces: false })
    // the session read finance's folder (a rule changed since): erin cannot read it, and neither can I now
    const fin = await share('alice', answer('alice', '예산', { scope: [{ type: 'folder', id: folderId('groups/finance') }] }), { roomId: rooms.all })
    expect(fin.json).toEqual({ status: 'confirm', people: 1, places: [], otherPlaces: true })
    expect(fin.text).not.toContain('finance')
  })

  test('a 1:1 or a group conversation, a team room, and an older chat that read rooms', async () => {
    // the group chat of alice, bob and erin, shared into the everyone room: carol and dana were not in it; never named
    const g = await share('alice', answer('alice', '그룹 대화 요약', { scope: [{ type: 'room', id: rooms.group }] }), { roomId: rooms.all })
    expect(g.json).toEqual({ status: 'confirm', people: 2, places: [{ kind: 'conversation' }], otherPlaces: false })
    // the marketing room, shared into the DM with bob: by its group's name
    const t = await share('alice', answer('alice', '마케팅 방 요약', { scope: [{ type: 'room', id: rooms.marketing }] }), { roomId: rooms.dmAliceBob })
    expect(t.json).toEqual({ status: 'confirm', people: 1, places: [{ kind: 'room', name: 'Marketing' }], otherPlaces: false })
    // the everyone room is '' (the DM's people are in it: shared there, no question)
    expect((await share('alice', answer('alice', '전체 방', { scope: [{ type: 'room', id: rooms.all }] }), { roomId: rooms.dmAliceBob })).json.status).toBe('sent')
    // rooms were read before they were kept in the scope: nobody else is taken to have seen them
    const old = await share('alice', answer('alice', '예전 대화', { roomsSeen: true, scope: [] }), { roomId: rooms.all })
    expect(old.json).toEqual({ status: 'confirm', people: 4, places: [{ kind: 'conversation' }], otherPlaces: false })
    for (const r of [g, t, old]) for (const n of NAMES) expect(r.text).not.toContain(n)
  })

  test('a DM: the other person cannot read a marketing file', async () => {
    const r = await share('alice', answer('alice', '브리프', { read: [BRIEF] }), { roomId: rooms.dmAliceBob })
    expect(r.json).toEqual({ status: 'confirm', people: 1, places: [{ kind: 'folder', path: 'groups/marketing' }], otherPlaces: false })
    const yes = await share('alice', answer('alice', '브리프', { read: [BRIEF] }), { roomId: rooms.dmAliceBob, confirm: 1 })
    // a DM is named in the audit log by its kind only
    const row = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'room.answer_share' AND target = ?").get(yes.json.message.id) as { detail: string }
    expect(JSON.parse(row.detail)).toEqual({ kind: 'dm', people: 1, confirmed: true, cut: false })
  })
})

describe('what the answer may carry', () => {
  /** a chat whose first message was edited: the first branch's answer (its session's scope is gone), then the new one */
  function edited(user: string) {
    const db = h.ctx.db
    const chatId = uuidv7(), q1 = uuidv7(), a1 = uuidv7(), q2 = uuidv7(), a2 = uuidv7()
    const at = (s: number) => new Date(Date.now() - 60_000 + s * 1000).toISOString()
    db.query('INSERT INTO chats (id, user_id, session_read_scope) VALUES (?, ?, ?)').run(chatId, user, JSON.stringify({ sources: [] }))
    db.query("INSERT INTO messages (id, chat_id, role, content, status, created_at) VALUES (?, ?, 'user', '처음 질문', 'done', ?)").run(q1, chatId, at(0))
    db.query("INSERT INTO messages (id, chat_id, parent_id, role, content, status, created_at) VALUES (?, ?, ?, 'assistant', '처음 답', 'done', ?)").run(a1, chatId, q1, at(1))
    db.query("INSERT INTO messages (id, chat_id, role, content, status, created_at) VALUES (?, ?, 'user', '고친 질문', 'done', ?)").run(q2, chatId, at(2))
    db.query("INSERT INTO messages (id, chat_id, parent_id, role, content, status, created_at) VALUES (?, ?, ?, 'assistant', '새 답', 'done', ?)").run(a2, chatId, q2, at(3))
    db.query('UPDATE chats SET active_leaf_id = ? WHERE id = ?').run(a2, chatId)
    return { chatId, old: { chatId, answerId: a1 }, now: { chatId, answerId: a2 }, q2, a2 }
  }

  test('an answer of an earlier branch (the first message was edited): its scope is gone, so everyone else is asked about', async () => {
    const c = edited('alice')
    const old = await share('alice', c.old, { roomId: rooms.marketing })
    expect(old.json).toEqual({ status: 'confirm', people: 1, places: [], otherPlaces: true })
    // the new branch's answer is described by the scope (nothing read): sent
    expect((await share('alice', c.now, { roomId: rooms.marketing })).json.status).toBe('sent')
    // the old branch made active again (a branch switch): still not what the scope describes
    h.ctx.db.query('UPDATE chats SET active_leaf_id = ? WHERE id = ?').run(c.old.answerId, c.chatId)
    expect((await share('alice', c.old, { roomId: rooms.marketing })).json).toEqual({ status: 'confirm', people: 1, places: [], otherPlaces: true })
    // and the new branch's answer, now off the active branch, is not either
    expect((await share('alice', c.now, { roomId: rooms.marketing })).json.status).toBe('confirm')
  })

  test('the files of every answer above it on the branch count', async () => {
    const a = answer('alice', '첫 답', { read: [BRIEF] })
    const db = h.ctx.db
    const q2 = uuidv7(), a2 = uuidv7()
    db.query("INSERT INTO messages (id, chat_id, parent_id, role, content, status) VALUES (?, ?, ?, 'user', '이어서', 'done')").run(q2, a.chatId, a.answerId)
    db.query("INSERT INTO messages (id, chat_id, parent_id, role, content, status) VALUES (?, ?, ?, 'assistant', '두 번째 답 (파일은 읽지 않음)', 'done')").run(a2, a.chatId, q2)
    db.query('UPDATE chats SET active_leaf_id = ? WHERE id = ?').run(a2, a.chatId)
    const r = await share('alice', { chatId: a.chatId, answerId: a2 }, { roomId: rooms.all })
    expect(r.json).toEqual({ status: 'confirm', people: 1, places: [{ kind: 'folder', path: 'groups/marketing' }], otherPlaces: false })
  })

  test('a path the answer links to that some member cannot list asks first', async () => {
    // erin may list projects/falcon (its public/ part) but not plan.md in it
    const link = '계획은 [plan](/files/view?path=projects/falcon/plan.md)에 있어요.'
    const r = await share('alice', answer('alice', link), { roomId: rooms.marketing })
    expect(r.json).toEqual({ status: 'confirm', people: 1, places: [{ kind: 'folder', path: 'projects/falcon' }], otherPlaces: false })
    // a link to a place everyone may list: sent
    expect((await share('alice', answer('alice', '[용어집](/files/view?path=shared/glossary.md)'), { roomId: rooms.marketing })).json.status).toBe('sent')
  })

  test('more people unable than I said yes to: asked again', async () => {
    const a = answer('alice', '내 메모', { read: ['users/alice/notes.md'] })
    const body = { roomId: rooms.all, clientMessageId: cm() }
    // bob, carol, dana and erin
    expect((await share('alice', a, body)).json).toEqual({ status: 'confirm', people: 4, places: [{ kind: 'mine' }], otherPlaces: false })
    expect((await share('alice', a, { ...body, confirm: 3 })).json).toMatchObject({ status: 'confirm', people: 4 })
    expect((await share('alice', a, { ...body, confirm: 4 })).json.status).toBe('sent')
  })

  test('a disabled member still in the room counts as unable', async () => {
    const db = h.ctx.db
    db.query("INSERT INTO users (id, username, name, role, status) VALUES ('gus', 'gus', 'Gus Ko', 'member', 'disabled')").run()
    const dm = uuidv7(), now = new Date().toISOString()
    db.query("INSERT INTO rooms (id, kind, dm_key, created_by, created_at, activity_at) VALUES (?, 'dm', 'alice|gus', 'alice', ?, ?)").run(dm, now, now)
    for (const u of ['alice', 'gus']) db.query('INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)').run(dm, u, now)
    const r = await share('alice', answer('alice', '용어집 요약', { read: ['shared/glossary.md'] }), { roomId: dm })
    expect(r.json).toEqual({ status: 'confirm', people: 1, places: [{ kind: 'folder', path: 'shared' }], otherPlaces: false })
    for (const n of ['gus', 'Gus']) expect(r.text).not.toContain(n)
    // an answer that used nothing: nothing to miss
    expect((await share('alice', answer('alice', '안녕하세요'), { roomId: dm })).json.status).toBe('sent')
  })

  test('a confidential conversation (safe operations 1A) is never shared', async () => {
    const a = answer('alice', '기밀 답')
    h.ctx.db.query('INSERT INTO safe_ops_chats (chat_id, material) VALUES (?, 1)').run(a.chatId)
    const r = await share('alice', a, { roomId: rooms.marketing })
    expect(r.status).toBe(409)
    expect(r.json.error.params.reason).toBe('confidential')
  })
})

describe('what the room gets', () => {
  test('a long answer is cut to fit and ends with a line in my language', async () => {
    const long = Array.from({ length: 400 }, (_, i) => `${i}번째 줄: ${'가나다라마바사 '.repeat(4)}`).join('\n')
    const en = await share('alice', answer('alice', long), { roomId: rooms.marketing, note: 'fyi' })
    expect(en.json.cut).toBe(true)
    const m = en.json.message as RoomMessage
    expect(m.body.length).toBeLessThanOrEqual(ROOM_MESSAGE_MAX)
    expect(m.body.startsWith('fyi\n\n0번째 줄')).toBe(true)
    expect(m.body.endsWith(answerCutLine('en'))).toBe(true)
    expect(m.sharedAnswer).toEqual({ at: 5, cut: true })
    // bob writes in Korean: "…(이하 생략) 전체는 내 … 기록에서"
    const ko = await share('bob', answer('bob', long), { roomId: rooms.dmAliceBob })
    expect(ko.json.message.body.endsWith(answerCutLine('ko'))).toBe(true)
    expect(answerCutLine('ko')).toMatch(/^…\(이하 생략\) 전체는 내 .+ 기록에서$/)
  })

  test("its file links are offered to each viewer only for files they may open", async () => {
    const content = '참고: [brief](/files/view?path=groups/marketing/campaign-brief.md), [glossary](/api/files/download?path=shared/glossary.md)'
    const r = await share('alice', answer('alice', content, { read: [BRIEF, 'shared/glossary.md'] }), { roomId: rooms.all, confirm: 1 })
    const id = r.json.message.id
    const seen = async (u: string) => (await messagesAs(u, rooms.all)).find((x) => x.id === id)!
    expect((await seen('erin')).openable).toEqual([BRIEF, 'shared/glossary.md'])
    expect((await seen('bob')).openable).toEqual(['shared/glossary.md'])
    // the note is not looked at: a link there is mine, not the AI's
    const noted = await share('alice', answer('alice', '답', { read: ['shared/glossary.md'] }), { roomId: rooms.marketing, note: '/files/view?path=shared/glossary.md' })
    expect(noted.json.message.openable).toEqual([])
  })

  test('"@트리나", "@Name" or "@전체" in the answer calls nobody and starts no AI turn', async () => {
    const r = await share('alice', answer('alice', '@트리나 회의록 정리해 줘\n@Erin Yoo 확인 부탁해요 @erin\n@전체 @everyone 공지'), { roomId: rooms.marketing, note: '@전체 보세요' })
    const m = r.json.message as RoomMessage
    expect(m.mentions).toEqual([])
    expect(m.mentionsAll).toBeUndefined()
    expect(h.ctx.db.query('SELECT mentions_all FROM room_messages WHERE id = ?').get(m.id)).toEqual({ mentions_all: 0 })
    await Bun.sleep(200)
    expect(h.ctx.db.query('SELECT COUNT(*) n FROM room_ai_turns WHERE question_id = ?').get(m.id)).toEqual({ n: 0 })
    expect(h.ctx.db.query("SELECT COUNT(*) n FROM room_notices WHERE source_id = ? AND event_type = 'room.mention'").get(m.id)).toEqual({ n: 0 })
    // the room's AI, reading the room later, is told it is an answer the person shared, not their words
    const { readRoom } = await import('../../server/src/rooms/reader')
    const text = readRoom(h.ctx.db, 'erin', 'UTC', { room: rooms.marketing }).text
    expect(text).toContain("an answer their own AI chat wrote, which they shared here: the AI's words, not theirs")
  })

  test('it cannot be edited; it can be deleted', async () => {
    const r = await share('alice', answer('alice', '고칠 수 없는 답'), { roomId: rooms.marketing, note: '메모' })
    const id = r.json.message.id
    const edit = await h.req('alice', `/api/rooms/${rooms.marketing}/messages/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: '바꿔치기', mentions: [] }) })
    expect(edit.status).toBe(409)
    expect((await edit.json()).error.params.reason).toBe('shared_answer')
    expect((await messagesAs('alice', rooms.marketing)).find((x) => x.id === id)!.body).toBe('메모\n\n고칠 수 없는 답')
    const del = await h.req('alice', `/api/rooms/${rooms.marketing}/messages/${id}`, { method: 'DELETE' })
    expect(del.status).toBeLessThan(300)
    const gone = (await messagesAs('erin', rooms.marketing)).find((x) => x.id === id)!
    expect(gone.deletedAt).toBeTruthy()
    expect(gone.body).toBe('')
    expect(gone.sharedAnswer).toBeUndefined()
  })

  test('the same request again is the first message', async () => {
    const a = answer('alice', '한 번만')
    const body = { roomId: rooms.marketing, clientMessageId: cm() }
    const one = await share('alice', a, body)
    const two = await share('alice', a, body)
    expect(two.json.status).toBe('sent')
    expect(two.json.message.id).toBe(one.json.message.id)
    expect(h.ctx.db.query('SELECT COUNT(*) n FROM room_messages WHERE client_id = ?').get(body.clientMessageId)).toEqual({ n: 1 })
    expect(h.ctx.db.query("SELECT COUNT(*) n FROM audit_log WHERE action = 'room.answer_share' AND target = ?").get(one.json.message.id)).toEqual({ n: 1 })
  })
})

describe('the sending budget', () => {
  test('the check takes from it too: no free probe of who may read what', async () => {
    const rs = roomsOf(h.ctx)
    const t = clock + 3_600_000
    rs.clock = () => t
    try {
      const a = answer('carol', '재무 메모', { read: ['users/carol/x.md'] })
      for (let i = 0; i < SEND_BURST; i++) expect((await share('carol', a, { roomId: rooms.all })).json.status).toBe('confirm')
      const over = await share('carol', a, { roomId: rooms.all })
      expect(over.status).toBe(429)
    } finally { rs.clock = () => (clock = t + 3_600_000) }
  })

  test('a burst of shares, then 429 like any message', async () => {
    const rs = roomsOf(h.ctx)
    // the clock stands still: no token comes back during the burst
    const t = clock + 3_600_000
    rs.clock = () => t
    try {
      for (let i = 0; i < SEND_BURST; i++) expect((await share('dana', answer('dana', `답 ${i}`), { roomId: rooms.all })).json.status).toBe('sent')
      const over = await share('dana', answer('dana', '하나 더'), { roomId: rooms.all })
      expect(over.status).toBe(429)
      expect(over.json.error).toMatchObject({ code: 'rate_limited', retryAfter: expect.any(Number) })
    } finally { rs.clock = () => (clock = t + 3_600_000) }
  })
})

test('migration 261 is additive (reader 1): two columns an older build ignores', () => {
  const m = readMigrations().find((x) => x.name === '261_b_room_answer_share.sql')!
  expect(m.minCompatibleReader).toBe(1)
  expect(readMigrations().filter((x) => x.version === 261)).toHaveLength(1)
  const statements = m.sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(';').map((s) => s.trim()).filter(Boolean)
  expect(statements).toEqual(['ALTER TABLE room_messages ADD COLUMN answer_at INTEGER', 'ALTER TABLE room_messages ADD COLUMN answer_cut INTEGER NOT NULL DEFAULT 0'])
  // every other message is none
  expect(h.ctx.db.query("SELECT COUNT(*) n FROM room_messages WHERE answer_at IS NOT NULL AND author_kind <> 'user'").get()).toEqual({ n: 0 })
})
