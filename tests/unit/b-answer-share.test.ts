// "대화방에 보내기" (shared/src/api/chats.ts shareAnswerToRoom, server/src/chat/answer-share.ts): a finished answer of my
// own AI chat goes to a room I am in as my message (my note, then the answer; RoomMessage.sharedAnswer). Covered: who
// may (my own chat only; not a room's AI session, a deleted chat, another chat's message; a room I am not in answers like
// one that does not exist), what may be sent (a finished answer only), "confirm" when something applies: a row per linked
// file (how many cannot open it; a file I cannot open is never named) with what may be attached, and one provenance line
// (how many cannot see material it used, the places I may name myself, never who; the files of every answer on its
// branch, the scope's other sources, an answer the scope does not describe, a disabled member), the hash rule (a copy
// every member can open, saved on this branch, still there with that hash), the confirmKey (a member swapped for another
// is a new key) and attaching (my access checked again, 10 files, 50 MB), older clients' confirm = that number, a long
// answer cut with a line in my language, its file links per viewer, no mention and no room AI whatever its text says, no
// edit, the same request again, a confidential conversation, the sending budget (the check too), and the audit row.
// Chats, answers, their read scope and their turns' saves are written straight into the database (the fixture team: alice
// and erin in marketing, bob in finance, carol admin, dana owner).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { API, ROOM_MESSAGE_MAX, SMALL_UPLOAD_MAX, uuidv7, type AnswerShareFile, type Room, type RoomMessage } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { roomsOf, SEND_BURST } from '../../server/src/rooms/service'
import { roomFilesOf } from '../../server/src/rooms/files'
import { answerCutLine } from '../../server/src/chat/answer-share'
import { readMigrations } from '../../server/src/db'
import { addSources, type ReadSource } from '../../server/src/chat/read-scope'
import { SourceLog } from '../../server/src/files/sources'

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

type Read = string | { path: string; sha256: string | null }
const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex')
/** A team file, written on disk; its sha256. */
function put(rel: string, text: string | Buffer): string {
  const abs = path.join(h.ctx.files.fx.root, ...rel.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
  return sha(text)
}
/** The answer's own turn, with the team files it saved (file_events), as the file tools record them. */
function saves(a: { chatId: string; answerId: string }, user: string, saved: { path: string; sha256: string; action?: string }[]) {
  const db = h.ctx.db
  const turnId = uuidv7()
  db.query("INSERT INTO turns (id, chat_id, user_id, engine, status, message_id) VALUES (?, ?, ?, 'claude-code', 'done', ?)").run(turnId, a.chatId, user, a.answerId)
  db.query('UPDATE messages SET turn_id = ? WHERE id = ?').run(turnId, a.answerId)
  for (const f of saved) db.query('INSERT INTO file_events (turn_id, user_id, path, action, size, sha256) VALUES (?, ?, ?, ?, 1, ?)').run(turnId, user, f.path, f.action ?? 'create', f.sha256)
}
/** An answer of `user`'s own chat, written straight into the database: the files it read (with their sha256), the
 * chat's read scope (`listed`: a scope this build started, whose file sources came from reads the lists record; else
 * written as an older build did), what its turn saved. */
function answer(user: string, content: string, o: { read?: Read[]; scope?: ReadSource[]; listed?: boolean; status?: string; roomsSeen?: boolean; roomSession?: string; deleted?: boolean; saved?: { path: string; sha256: string; action?: string }[] } = {}) {
  const db = h.ctx.db
  const chatId = uuidv7(), askId = uuidv7(), answerId = uuidv7()
  db.query('INSERT INTO chats (id, user_id, room_id, session_read_scope, rooms_seen, deleted_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(chatId, user, o.roomSession ?? null, o.scope && !o.listed ? JSON.stringify({ sources: o.scope }) : null, o.roomsSeen ? 1 : 0, o.deleted ? new Date().toISOString() : null)
  if (o.scope && o.listed) addSources(db, chatId, o.scope, { listed: true })
  db.query("INSERT INTO messages (id, chat_id, role, content, status) VALUES (?, ?, 'user', '정리해 줘', 'done')").run(askId, chatId)
  db.query("INSERT INTO messages (id, chat_id, parent_id, role, content, status) VALUES (?, ?, ?, 'assistant', ?, ?)").run(answerId, chatId, askId, content, o.status ?? 'done')
  db.query('UPDATE chats SET active_leaf_id = ? WHERE id = ?').run(answerId, chatId)
  ;(o.read ?? []).forEach((r, i) => {
    const f = typeof r === 'string' ? { path: r, sha256: null } : r
    db.query("INSERT INTO message_sources (message_id, ord, path, sha256, locs, via, by_main, by_subagent) VALUES (?, ?, ?, ?, '[]', 'read', 1, 0)").run(answerId, i, f.path, f.sha256)
  })
  const a = { chatId, askId, answerId }
  if (o.saved) saves(a, user, o.saved)
  return a
}
const link = (p: string, label = p.split('/').pop()) => `[${label}](/files/view?path=${encodeURI(p)})`
const audit = (messageId: string) => JSON.parse((h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'room.answer_share' AND target = ?").get(messageId) as { detail: string }).detail)
const roomFileCount = (messageId: string) => (h.ctx.db.query('SELECT COUNT(*) n FROM room_files WHERE message_id = ?').get(messageId) as { n: number }).n
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
    expect(JSON.parse(row.detail)).toEqual({ roomId: rooms.marketing, people: 0, confirmed: false, cut: false, files: 0 })
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
    // bob (finance) cannot read groups/marketing; carol and dana (admin, owner) and erin may. No linked file: no row
    const marketing = { people: 1, places: [{ kind: 'folder', path: 'groups/marketing' }], otherPlaces: false }
    expect(r.json).toEqual({ status: 'confirm', ...marketing, files: [], provenance: marketing, confirmKey: expect.any(String) })
    for (const n of NAMES) expect(r.text).not.toContain(n)
    expect((await messagesAs('alice', rooms.all)).length).toBe(before)
    // sent with the person's yes; audited as confirmed
    const yes = await share('alice', a, { ...body, confirm: 1 })
    expect(yes.json.status).toBe('sent')
    expect((await messagesAs('alice', rooms.all)).length).toBe(before + 1)
    const row = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'room.answer_share' AND target = ?").get(yes.json.message.id) as { detail: string }
    expect(JSON.parse(row.detail)).toEqual({ roomId: rooms.all, people: 1, confirmed: true, cut: false, files: 0 })
  })

  test('my own folder is "mine"; a folder I cannot read myself is not named', async () => {
    const mine = await share('alice', answer('alice', '내 메모', { read: ['users/alice/notes.md'] }), { roomId: rooms.marketing })
    expect(mine.json).toMatchObject({ status: 'confirm', people: 1, places: [{ kind: 'mine' }], otherPlaces: false, files: [], provenance: { people: 1, places: [{ kind: 'mine' }], otherPlaces: false } })
    // the session read finance's folder (a rule changed since): erin cannot read it, and neither can I now
    const fin = await share('alice', answer('alice', '예산', { scope: [{ type: 'folder', id: folderId('groups/finance') }] }), { roomId: rooms.all })
    expect(fin.json).toMatchObject({ status: 'confirm', people: 1, places: [], otherPlaces: true, provenance: { people: 1, places: [], otherPlaces: true } })
    expect(fin.text).not.toContain('finance')
  })

  test('a 1:1 or a group conversation, a team room, and an older chat that read rooms', async () => {
    // the group chat of alice, bob and erin, shared into the everyone room: carol and dana were not in it; never named
    const g = await share('alice', answer('alice', '그룹 대화 요약', { scope: [{ type: 'room', id: rooms.group }] }), { roomId: rooms.all })
    expect(g.json).toMatchObject({ status: 'confirm', people: 2, places: [{ kind: 'conversation' }], otherPlaces: false, provenance: { people: 2, places: [{ kind: 'conversation' }] } })
    // the marketing room, shared into the DM with bob: by its group's name
    const t = await share('alice', answer('alice', '마케팅 방 요약', { scope: [{ type: 'room', id: rooms.marketing }] }), { roomId: rooms.dmAliceBob })
    expect(t.json).toMatchObject({ status: 'confirm', people: 1, places: [{ kind: 'room', name: 'Marketing' }], otherPlaces: false, provenance: { people: 1, places: [{ kind: 'room', name: 'Marketing' }] } })
    // the everyone room is '' (the DM's people are in it: shared there, no question)
    expect((await share('alice', answer('alice', '전체 방', { scope: [{ type: 'room', id: rooms.all }] }), { roomId: rooms.dmAliceBob })).json.status).toBe('sent')
    // rooms were read before they were kept in the scope: nobody else is taken to have seen them
    const old = await share('alice', answer('alice', '예전 대화', { roomsSeen: true, scope: [] }), { roomId: rooms.all })
    expect(old.json).toMatchObject({ status: 'confirm', people: 4, places: [{ kind: 'conversation' }], otherPlaces: false, provenance: { people: 4, places: [{ kind: 'conversation' }] } })
    for (const r of [g, t, old]) for (const n of NAMES) expect(r.text).not.toContain(n)
  })

  test('a DM: the other person cannot read a marketing file', async () => {
    const r = await share('alice', answer('alice', '브리프', { read: [BRIEF] }), { roomId: rooms.dmAliceBob })
    expect(r.json).toMatchObject({ status: 'confirm', people: 1, places: [{ kind: 'folder', path: 'groups/marketing' }], otherPlaces: false, provenance: { people: 1 } })
    const yes = await share('alice', answer('alice', '브리프', { read: [BRIEF] }), { roomId: rooms.dmAliceBob, confirm: 1 })
    // a DM is named in the audit log by its kind only
    const row = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'room.answer_share' AND target = ?").get(yes.json.message.id) as { detail: string }
    expect(JSON.parse(row.detail)).toEqual({ kind: 'dm', people: 1, confirmed: true, cut: false, files: 0 })
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

  test('an answer of an earlier branch (the first message was edited): its scope is gone, so what it used is not all known', async () => {
    const c = edited('alice')
    const old = await share('alice', c.old, { roomId: rooms.marketing })
    const unknown = { status: 'confirm', people: 1, places: [], otherPlaces: true, files: [], provenance: { people: 1, places: [], otherPlaces: true, unknown: true } }
    expect(old.json).toMatchObject(unknown)
    // the new branch's answer is described by the scope (nothing read): sent
    expect((await share('alice', c.now, { roomId: rooms.marketing })).json.status).toBe('sent')
    // the old branch made active again (a branch switch): still not what the scope describes
    h.ctx.db.query('UPDATE chats SET active_leaf_id = ? WHERE id = ?').run(c.old.answerId, c.chatId)
    expect((await share('alice', c.old, { roomId: rooms.marketing })).json).toMatchObject(unknown)
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
    expect(r.json).toMatchObject({ status: 'confirm', people: 1, places: [{ kind: 'folder', path: 'groups/marketing' }], otherPlaces: false, provenance: { people: 1 } })
  })

  test('a file the answer links to that some member cannot open is a row of its own, not a place it came from', async () => {
    // erin may list projects/falcon (its public/ part) but not open plan.md in it
    const text = '계획은 [plan](/files/view?path=projects/falcon/plan.md)에 있어요.'
    const r = await share('alice', answer('alice', text), { roomId: rooms.marketing })
    expect(r.json).toMatchObject({ status: 'confirm', people: 1, files: [{ name: 'plan.md', path: 'projects/falcon/plan.md', missing: false, attach: 'yes', unable: 1 }], provenance: null })
    // a link to a place everyone may list: sent
    expect((await share('alice', answer('alice', '[용어집](/files/view?path=shared/glossary.md)'), { roomId: rooms.marketing })).json.status).toBe('sent')
  })

  test('more people unable than I said yes to: asked again', async () => {
    const a = answer('alice', '내 메모', { read: ['users/alice/notes.md'] })
    const body = { roomId: rooms.all, clientMessageId: cm() }
    // bob, carol, dana and erin
    expect((await share('alice', a, body)).json).toMatchObject({ status: 'confirm', people: 4, places: [{ kind: 'mine' }], otherPlaces: false })
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
    expect(r.json).toMatchObject({ status: 'confirm', people: 1, places: [{ kind: 'folder', path: 'shared' }], otherPlaces: false, provenance: { people: 1 } })
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

describe('the false alarm: a quote of my own folder copied where the room reads it', () => {
  /** The owner's case: the AI read a quote in my own folder, copied it and its paired file to shared/, and linked the
   * copies. Its scope is one this build started: my own folder came from that read alone. */
  function quoteAnswer(user: string, o: { client?: string; changeCopy?: boolean; listed?: boolean } = {}) {
    const client = o.client ?? `acme-${crypto.randomUUID().slice(0, 8)}`
    const quote = `견적서 ${client}: 단가 12,000원\n`, terms = `조건 ${client}: 30일\n`
    const own = `users/${user}/quotes/${client}-quote.md`
    const qs = put(own, quote), ts = put(`users/${user}/quotes/${client}-terms.md`, terms)
    const copy = `shared/sales/quotes/${client}/${client}-quote.md`, pair = `shared/sales/quotes/${client}/${client}-terms.md`
    put(copy, quote)
    put(pair, terms)
    const a = answer(user, `견적서를 공유 폴더에 복사했어요: ${link(copy)}, ${link(pair)}`, {
      read: [{ path: own, sha256: qs }], scope: [{ type: 'user', id: user }], listed: o.listed ?? true,
      saved: [{ path: copy, sha256: qs }, { path: pair, sha256: ts }],
    })
    return { a, own, copy, pair, qs }
  }

  test('sent at once, no question: the room gets copies every member can open', async () => {
    const { a } = quoteAnswer('alice')
    const r = await share('alice', a, { roomId: rooms.marketing, note: '견적 공유해요' })
    expect(r.json.status).toBe('sent')
    expect(r.json.message.openable).toHaveLength(2)
    expect(audit(r.json.message.id)).toEqual({ roomId: rooms.marketing, people: 0, confirmed: false, cut: false, files: 0 })
    // the everyone room too: the copies are in shared/, which everyone reads
    expect((await share('alice', quoteAnswer('alice').a, { roomId: rooms.all })).json.status).toBe('sent')
  })

  test('a scope written before this build (its "my folder" may be the browser or a connection): counted as before', async () => {
    const r = await share('alice', quoteAnswer('alice', { listed: false }).a, { roomId: rooms.marketing })
    expect(r.json).toMatchObject({ status: 'confirm', files: [{ attach: 'no', unable: 0 }, { attach: 'no', unable: 0 }], provenance: { people: 1, places: [{ kind: 'mine' }], otherPlaces: false } })
  })

  test('the in-app browser and a personal connection stay "mine" whatever was copied', async () => {
    for (const via of ['browser', 'connection'] as const) {
      const { a } = quoteAnswer('alice')
      addSources(h.ctx.db, a.chatId, [{ type: 'user', id: 'alice', via }])
      const r = await share('alice', a, { roomId: rooms.marketing })
      expect(r.json).toMatchObject({ status: 'confirm', provenance: { people: 1, places: [{ kind: 'mine' }] } })
    }
  })

  test('a turn of the branch that never ended saved no source list: the scope\'s places count as they are', async () => {
    const { a } = quoteAnswer('alice')
    h.ctx.db.query("UPDATE turns SET status = 'interrupted' WHERE message_id = ?").run(a.answerId)
    expect((await share('alice', a, { roomId: rooms.marketing })).json).toMatchObject({ status: 'confirm', provenance: { places: [{ kind: 'mine' }] } })
  })

  test('an unlisted input of my own folder (an attachment, make_file\'s source) is not covered by the copy', async () => {
    const { a } = quoteAnswer('alice')
    addSources(h.ctx.db, a.chatId, [{ type: 'user', id: 'alice' }])
    expect((await share('alice', a, { roomId: rooms.marketing })).json).toMatchObject({ status: 'confirm', provenance: { places: [{ kind: 'mine' }] } })
  })
})

describe('the hash rule', () => {
  /** an answer that read my note (with or without its hash) and whose turn saved `saved` */
  function noted(o: { readSha?: boolean; saved?: (n: { text: string; sha: string; id: string }) => { path: string; text?: string }[] } = {}) {
    const id = crypto.randomUUID().slice(0, 8)
    const text = `메모 ${id}\n`, own = `users/alice/notes-${id}.md`
    const s1 = put(own, text)
    const copies = (o.saved?.({ text, sha: s1, id }) ?? []).map((c) => { put(c.path, c.text ?? text); return { path: c.path, sha256: s1 } })
    return answer('alice', '정리했어요', { read: [{ path: own, sha256: o.readSha === false ? null : s1 }], scope: [{ type: 'user', id: 'alice' }], listed: true, saved: copies })
  }

  test('covered: the same content saved on this branch to a place every member can open, still there', async () => {
    expect((await share('alice', noted({ saved: ({ id }) => [{ path: `shared/copies/${id}.md` }] }), { roomId: rooms.all })).json.status).toBe('sent')
  })

  test('a file read without a sha256 is never covered', async () => {
    const r = await share('alice', noted({ readSha: false, saved: ({ id }) => [{ path: `shared/copies/${id}.md` }] }), { roomId: rooms.all })
    expect(r.json).toMatchObject({ status: 'confirm', provenance: { people: 4, places: [{ kind: 'mine' }] } })
  })

  test('the copy must still be there with that hash', async () => {
    let at = ''
    const a = noted({ saved: ({ id }) => [{ path: (at = `shared/copies/${id}-changed.md`) }] })
    put(at, '누가 고쳤어요\n')
    expect((await share('alice', a, { roomId: rooms.all })).json.status).toBe('confirm')
    const b = noted({ saved: ({ id }) => [{ path: (at = `shared/copies/${id}-gone.md`) }] })
    fs.rmSync(path.join(h.ctx.files.fx.root, ...at.split('/')))
    expect((await share('alice', b, { roomId: rooms.all })).json.status).toBe('confirm')
  })

  test('every member must be able to open the copy: groups/marketing is not enough for the everyone room', async () => {
    const a = noted({ saved: ({ id }) => [{ path: `groups/marketing/copies/${id}.md` }] })
    expect((await share('alice', a, { roomId: rooms.all })).json).toMatchObject({ status: 'confirm', provenance: { people: 4 } })
    // the marketing room's members (erin) can: covered there
    expect((await share('alice', a, { roomId: rooms.marketing })).json.status).toBe('sent')
  })

  test('the copy must be saved by a turn on this branch: a sibling answer\'s copy does not count', async () => {
    const id = crypto.randomUUID().slice(0, 8)
    const text = `메모 ${id}\n`, own = `users/alice/notes-${id}.md`, copy = `shared/copies/${id}-sibling.md`
    const s1 = put(own, text)
    put(copy, text)
    const a = answer('alice', '정리했어요', { read: [{ path: own, sha256: s1 }], scope: [{ type: 'user', id: 'alice' }], listed: true })
    // another answer to the same question (regenerated) saved the copy; the shared one did not
    const db = h.ctx.db, other = uuidv7()
    db.query("INSERT INTO messages (id, chat_id, parent_id, role, content, status) VALUES (?, ?, ?, 'assistant', '다른 답', 'done')").run(other, a.chatId, a.askId)
    saves({ chatId: a.chatId, answerId: other }, 'alice', [{ path: copy, sha256: s1 }])
    expect((await share('alice', a, { roomId: rooms.all })).json.status).toBe('confirm')
  })
})

describe('linked files: a row each, the switch, attaching', () => {
  test('a linked private file is a row: how many cannot open it, attach yes; never anyone\'s name', async () => {
    put('users/alice/report.md', '# 보고서\n')
    const r = await share('alice', answer('alice', `보고서: ${link('users/alice/report.md')}`), { roomId: rooms.all })
    expect(r.json).toMatchObject({ status: 'confirm', people: 4, files: [{ name: 'report.md', path: 'users/alice/report.md', missing: false, attach: 'yes', unable: 4 }], provenance: null })
    // (my own folder's path is mine to see)
    for (const n of NAMES.filter((x) => x !== 'alice')) expect(r.text).not.toContain(n)
  })

  test('a file I cannot open now is never named, gone or not mine: the same row, everyone else counted', async () => {
    const r = await share('alice', answer('alice', `${link('groups/finance/budget.md')} ${link('shared/no-such-file.md')} ${link('shared/glossary.md')}`), { roomId: rooms.marketing })
    const hidden = { name: '', missing: true, attach: 'hidden', unable: 1 }
    expect(r.json.files).toEqual([hidden, hidden, { name: 'glossary.md', path: 'shared/glossary.md', missing: false, attach: 'no', unable: 0 }])
    expect(r.text).not.toContain('budget')
    expect(r.text).not.toContain('no-such-file')
  })

  test('attached: the copy goes with the message, every member opens it in the room; the audit counts it', async () => {
    const text = '# 기획안\n', at = 'users/alice/plan-attach.md'
    put(at, text)
    const a = answer('alice', `기획안: ${link(at)}`)
    const body = { roomId: rooms.all, clientMessageId: cm() }
    const ask = await share('alice', a, body)
    expect(ask.json.files[0]).toMatchObject({ path: at, attach: 'yes', unable: 4 })
    const sent = await share('alice', a, { ...body, confirmKey: ask.json.confirmKey, attach: [at] })
    expect(sent.json.status).toBe('sent')
    const m = sent.json.message as RoomMessage
    expect(m.files.map((f) => f.name)).toEqual(['plan-attach.md'])
    expect(audit(m.id)).toEqual({ roomId: rooms.all, people: 0, confirmed: true, cut: false, files: 1 })
    // bob opens the room file; the team file itself stays closed to him
    const f = await h.req('bob', `/api/rooms/${rooms.all}/files/${m.files[0]!.id}`)
    expect(f.status).toBe(200)
    expect(await f.text()).toBe(text)
    expect((await h.req('bob', `/api/files/download?path=${encodeURIComponent(at)}`)).status).toBe(404)
    // the switch off: link only, nothing attached, the people who cannot open it counted
    const b = answer('alice', `기획안: ${link(at)}`)
    const body2 = { roomId: rooms.all, clientMessageId: cm() }
    const ask2 = await share('alice', b, body2)
    const linkOnly = await share('alice', b, { ...body2, confirmKey: ask2.json.confirmKey, attach: [] })
    expect(linkOnly.json.status).toBe('sent')
    expect(linkOnly.json.message.files).toEqual([])
    expect(audit(linkOnly.json.message.id)).toEqual({ roomId: rooms.all, people: 4, confirmed: true, cut: false, files: 0 })
  })

  test('a link to an attached file names its copy (attachedLinks): every link of the text that names it, only files of the message, never the path it was copied from', async () => {
    const db = h.ctx.db
    const at = 'users/alice/deck-attach.html', other = 'users/alice/notes-link-only.md'
    put(at, '<h1>acme</h1>')
    put(other, '# notes\n')
    // the file twice (the second link as an AI may write it) and a file that goes as a link only
    const again = 'users/alice/./deck-attach.html'
    const a = answer('alice', `덱: ${link(at)} · 다시: [덱](/api/files/download?path=${again}) · 메모: ${link(other)}`)
    const body = { roomId: rooms.all, clientMessageId: cm() }
    const ask = await share('alice', a, body)
    expect(ask.json.files.map((f: AnswerShareFile) => f.path)).toEqual([at, other])
    const sent = await share('alice', a, { ...body, confirmKey: ask.json.confirmKey, attach: [at] })
    const m = sent.json.message as RoomMessage
    const fileId = m.files[0]!.id
    const links = [{ path: at, fileId }, { path: again, fileId }]
    // bob cannot open either team file: both links name the copy, the link-only file has none (the app's lock)
    const bobs = (await messagesAs('bob', rooms.all)).find((x) => x.id === m.id)!
    expect(bobs.openable).toEqual([])
    expect(bobs.attachedLinks).toEqual(links)
    // alice may open the team file (openable: the app opens it, live) and gets the same links
    const mine = (await messagesAs('alice', rooms.all)).find((x) => x.id === m.id)!
    expect(mine.openable).toEqual([at, again, other])
    expect(mine.attachedLinks).toEqual(links)
    expect(m.attachedLinks).toEqual(links)
    // kept with the message on the server: the copy, the path it was made from, the links
    const scope = JSON.parse((db.query('SELECT source_scope FROM room_messages WHERE id = ?').get(m.id) as { source_scope: string }).source_scope)
    expect(scope.attached).toEqual([{ file: fileId, path: at, links: [at, again] }])
    // a scope that names a file of another message, or a link the text does not have, gives nothing more; an older
    // message (no `attached`) and a scope that does not read give none: the lock stays as it was
    const foreign = (await roomFilesOf(h.ctx).fromTeamFile('alice', rooms.all, other)).id
    const forged = { ...scope, attached: [...scope.attached, { file: foreign, path: other, links: [other] }, { file: fileId, path: at, links: ['users/alice/never-linked.md'] }] }
    db.query('UPDATE room_messages SET source_scope = ? WHERE id = ?').run(JSON.stringify(forged), m.id)
    expect((await messagesAs('bob', rooms.all)).find((x) => x.id === m.id)!.attachedLinks).toEqual(links)
    roomFilesOf(h.ctx).discardUnsent('alice', rooms.all, [foreign])
    db.query('UPDATE room_messages SET source_scope = ? WHERE id = ?').run(JSON.stringify({ sources: scope.sources, unknown: scope.unknown }), m.id)
    expect((await messagesAs('bob', rooms.all)).find((x) => x.id === m.id)!).not.toHaveProperty('attachedLinks')
    db.query("UPDATE room_messages SET source_scope = '{not json' WHERE id = ?").run(m.id)
    expect((await messagesAs('bob', rooms.all)).find((x) => x.id === m.id)!).not.toHaveProperty('attachedLinks')
    db.query('UPDATE room_messages SET source_scope = ? WHERE id = ?').run(JSON.stringify(scope), m.id)
    // hidden from someone (an old answer they cannot see, docs/DECISIONS.md "지난 대화"): no text, files or links for them
    db.query('INSERT INTO room_hidden_answers (room_id, user_id, message_id, see_seq) VALUES (?, ?, ?, ?)').run(rooms.all, 'erin', m.id, m.seq)
    try {
      const erins = (await messagesAs('erin', rooms.all)).find((x) => x.id === m.id)!
      expect(erins).toMatchObject({ withheld: true, body: '', files: [] })
      expect(erins).not.toHaveProperty('attachedLinks')
      expect(erins).not.toHaveProperty('openable')
    } finally { db.query('DELETE FROM room_hidden_answers WHERE message_id = ?').run(m.id) }
    // deleted: nothing of it
    await h.api('alice').call(API.deleteRoomMessage, { params: { id: rooms.all, messageId: m.id } })
    const gone = (await messagesAs('bob', rooms.all)).find((x) => x.id === m.id)!
    expect(gone.files).toEqual([])
    expect(gone).not.toHaveProperty('attachedLinks')
  })

  test('the copy is named only by the link as the text writes it: the path it was copied from never reaches anyone else', async () => {
    const rel = 'users/alice/acme-quote-q4.html'
    put(rel, '<p>quote</p>')
    // the AI wrote the path another way (a "./" in it): the room gets that text, the server resolved the file
    const written = 'users/alice/./acme-quote-q4.html'
    const a = answer('alice', `견적: [견적서](/files/view?path=${written})`)
    const body = { roomId: rooms.all, clientMessageId: cm() }
    const ask = await share('alice', a, body)
    const sent = await share('alice', a, { ...body, confirmKey: ask.json.confirmKey, attach: [rel] })
    const m = sent.json.message as RoomMessage
    const r = await h.req('bob', `/api/rooms/${rooms.all}/messages`)
    const text = await r.text()
    const bobs = (JSON.parse(text).items as RoomMessage[]).find((x) => x.id === m.id)!
    expect(bobs.attachedLinks).toEqual([{ path: written, fileId: m.files[0]!.id }])
    expect(text).toContain(written)
    expect(text).not.toContain(rel)
    // the realtime event erin gets carries the same, and no more
    const ev = await erinWs.next('room.message', (f) => f.data.message.id === m.id)
    expect(JSON.stringify(ev)).not.toContain(rel)
    expect(ev.data.message.attachedLinks).toEqual([{ path: written, fileId: m.files[0]!.id }])
  })

  test('an AI-made file in my folder is an ordinary row; attached, what its turn used counts too', async () => {
    // made by an answer of another chat that read the marketing brief
    const text = '# 요약본\n', at = 'users/alice/made-summary.md'
    const made = answer('alice', '요약본을 만들었어요', { read: [BRIEF], scope: [], listed: true, saved: [{ path: at, sha256: put(at, text) }] })
    void made
    const a = answer('alice', `요약본: ${link(at)}`, { scope: [], listed: true })
    const r = await share('alice', a, { roomId: rooms.all })
    // the row says who more would see it (the switch's caption); the line: bob cannot read groups/marketing
    expect(r.json).toMatchObject({ status: 'confirm', files: [{ name: 'made-summary.md', attach: 'yes', unable: 4 }], provenance: { people: 1, places: [{ kind: 'folder', path: 'groups/marketing' }] } })
    // in the marketing room everyone reads the brief: only the row
    expect((await share('alice', a, { roomId: rooms.marketing })).json).toMatchObject({ files: [{ attach: 'yes', unable: 1 }], provenance: null })
  })

  test('a linked file read by the answer and attached is left out of the line; link only, it counts', async () => {
    const at = 'users/alice/read-and-linked.md'
    const s1 = put(at, '# 읽은 파일\n')
    const a = answer('alice', `이 파일을 읽었어요: ${link(at)}`, { read: [{ path: at, sha256: s1 }], scope: [{ type: 'user', id: 'alice' }], listed: true })
    const body = { roomId: rooms.marketing, clientMessageId: cm() }
    const r = await share('alice', a, body)
    expect(r.json).toMatchObject({ status: 'confirm', files: [{ path: at, attach: 'yes', unable: 1 }], provenance: null })
    // an older client cannot attach: it is told about both, the file's place too
    expect(r.json.people).toBe(1)
    expect(r.json.places).toEqual([{ kind: 'mine' }])
  })

  test('only files of this answer that may go: anything else is refused, nothing sent', async () => {
    put('users/alice/one.md', '1\n')
    const a = answer('alice', link('users/alice/one.md'))
    const body = { roomId: rooms.all, clientMessageId: cm() }
    const ask = await share('alice', a, body)
    for (const attach of [['users/alice/todo.md'], ['shared/glossary.md'], ['groups/finance/budget.md'], ['users/alice/one.md', 'users/alice/../bob/x.md']]) {
      const r = await share('alice', a, { ...body, confirmKey: ask.json.confirmKey, attach })
      expect(r.status).toBe(400)
    }
    expect(h.ctx.db.query('SELECT COUNT(*) n FROM room_messages WHERE client_id = ?').get(body.clientMessageId)).toEqual({ n: 0 })
    // attach without a key (an older client's confirm): refused too
    expect((await share('alice', a, { ...body, confirm: 4, attach: ['users/alice/one.md'] })).status).toBe(400)
  })

  test('at most 10 files, each at most 50 MB', async () => {
    const paths = Array.from({ length: 11 }, (_, i) => { const p = `users/alice/many/f${i}.md`; put(p, `${i}\n`); return p })
    const big = 'users/alice/many/big.bin'
    put(big, '')
    fs.truncateSync(path.join(h.ctx.files.fx.root, ...big.split('/')), SMALL_UPLOAD_MAX + 1)
    const a = answer('alice', [...paths, big].map((p) => link(p)).join('\n'))
    const body = { roomId: rooms.all, clientMessageId: cm() }
    const ask = await share('alice', a, body)
    const rows = ask.json.files as AnswerShareFile[]
    expect(rows.map((f) => f.attach)).toEqual([...paths.map(() => 'yes' as const), 'too_big' as const])
    // eleven at once: refused by the contract; the big one: not a file that may go
    expect((await share('alice', a, { ...body, confirmKey: ask.json.confirmKey, attach: paths })).status).toBe(400)
    expect((await share('alice', a, { ...body, confirmKey: ask.json.confirmKey, attach: [big] })).status).toBe(400)
    const ten = await share('alice', a, { ...body, confirmKey: ask.json.confirmKey, attach: paths.slice(0, 10) })
    expect(ten.json.status).toBe('sent')
    expect(roomFileCount(ten.json.message.id)).toBe(10)
    expect(audit(ten.json.message.id).files).toBe(10)
    // RoomFiles itself refuses a file over 50 MB
    await expect(roomFilesOf(h.ctx).fromTeamFile('alice', rooms.all, big)).rejects.toMatchObject({ code: 'payload_too_large' })
  })

  test('attaching checks my read access again: lost meanwhile, it is asked again with the file no longer named', async () => {
    const db = h.ctx.db
    put('projects/falcon/attach-me.md', '# Falcon\n')
    const a = answer('alice', `팔콘: ${link('projects/falcon/attach-me.md')}`)
    const body = { roomId: rooms.marketing, clientMessageId: cm() }
    const ask = await share('alice', a, body)
    expect(ask.json.files[0]).toMatchObject({ path: 'projects/falcon/attach-me.md', attach: 'yes', unable: 1 })
    // alice loses projects/falcon (her rule goes)
    const rule = db.query("SELECT r.* FROM folder_rules r JOIN folders f ON f.id = r.folder_id WHERE f.path = 'projects/falcon' AND r.subject_type = 'user' AND r.subject_id = 'alice'").get() as Record<string, unknown>
    db.query('DELETE FROM folder_rules WHERE id = ?').run(rule.id as string)
    try {
      const again = await share('alice', a, { ...body, confirmKey: ask.json.confirmKey, attach: ['projects/falcon/attach-me.md'] })
      expect(again.json).toMatchObject({ status: 'confirm', files: [{ name: '', missing: true, attach: 'hidden' }] })
      expect(again.text).not.toContain('attach-me')
      expect(again.json.confirmKey).not.toBe(ask.json.confirmKey)
      // with the new key the file still cannot go
      expect((await share('alice', a, { ...body, confirmKey: again.json.confirmKey, attach: ['projects/falcon/attach-me.md'] })).status).toBe(400)
      // and RoomFiles answers like a file that is not there
      await expect(roomFilesOf(h.ctx).fromTeamFile('alice', rooms.marketing, 'projects/falcon/attach-me.md')).rejects.toMatchObject({ code: 'not_found' })
      await expect(roomFilesOf(h.ctx).fromTeamFile('alice', rooms.marketing, 'projects/falcon/no-such.md')).rejects.toMatchObject({ code: 'not_found' })
    } finally {
      db.query('INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, ?, ?, ?)').run(rule.id as string, rule.folder_id as string, 'user', 'alice', rule.access as string)
    }
    expect(h.ctx.db.query('SELECT COUNT(*) n FROM room_files WHERE message_id IS NULL AND user_id = ?').get('alice')).toEqual({ n: 0 })
  })

  test('RoomFiles.fromTeamFile: a folder, a link, a file of a room I am not in: 404', async () => {
    const files = roomFilesOf(h.ctx)
    await expect(files.fromTeamFile('alice', rooms.marketing, 'shared')).rejects.toMatchObject({ code: 'not_found' })
    await expect(files.fromTeamFile('alice', rooms.marketing, 'groups/marketing/budget-link.md')).rejects.toMatchObject({ code: 'not_found' })
    await expect(files.fromTeamFile('alice', rooms.finance, 'shared/glossary.md')).rejects.toMatchObject({ code: 'not_found' })
    await expect(files.fromTeamFile('bob', rooms.all, BRIEF)).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('review: what the check does not read, does not miss, and what it costs', () => {
  test('a folder link: everyone may list it, no question; some may not, a row nobody attaches', async () => {
    expect((await share('alice', answer('alice', `[폴더](/files/view?path=groups/marketing)`), { roomId: rooms.marketing })).json.status).toBe('sent')
    const r = await share('alice', answer('alice', `[폴더](/files/view?path=groups/marketing)`), { roomId: rooms.all })
    expect(r.json).toMatchObject({ status: 'confirm', files: [{ name: 'marketing', path: 'groups/marketing', missing: false, attach: 'no', unable: 1 }], provenance: null })
    // a folder I cannot list reads like a missing file
    const hidden = await share('alice', answer('alice', `[폴더](/files/view?path=groups/finance)`), { roomId: rooms.marketing })
    expect(hidden.json.files).toEqual([{ name: '', missing: true, attach: 'hidden', unable: 1 }])
  })

  test('more links than rows: the rest is one row nothing is told about, so the last link is not sent unasked', async () => {
    const open = Array.from({ length: 100 }, (_, i) => { const p = `shared/overflow/g${i}.md`; put(p, `${i}\n`); return link(p) })
    put('users/alice/private-101.md', 'x\n')
    const r = await share('alice', answer('alice', [...open, link('users/alice/private-101.md')].join('\n')), { roomId: rooms.marketing })
    expect(r.json.status).toBe('confirm')
    expect(r.json.files.length).toBeLessThanOrEqual(100)
    expect(r.json.files.at(-1)).toEqual({ name: '', missing: true, attach: 'hidden', unable: 1 })
  })

  test('every ten linked files past the first take one more send: no cheap probe of who opens what', async () => {
    const rs = roomsOf(h.ctx)
    const t = clock + 3_600_000
    rs.clock = () => t
    try {
      const paths = Array.from({ length: 25 }, (_, i) => { const p = `users/bob/probe/f${i}.md`; put(p, `${i}\n`); return p })
      const a = answer('bob', paths.map((p) => link(p)).join('\n'))
      // 3 sends each (1 + 2 for links 11–25): six checks fit the burst of 20, the seventh does not
      for (let i = 0; i < 6; i++) expect((await share('bob', a, { roomId: rooms.all })).json.status).toBe('confirm')
      expect((await share('bob', a, { roomId: rooms.all })).status).toBe(429)
    } finally {
      // the budget refills between requests again for the tests after this one
      clock = t + 3_600_000
      rs.clock = () => (clock += 10_000)
    }
  })

  test('a file moved on this branch keeps its hash: the move covers my note like a copy', async () => {
    const id = crypto.randomUUID().slice(0, 8)
    const text = `메모 ${id}\n`, own = `users/alice/notes-${id}.md`, to = `shared/moved/${id}.md`
    const s1 = put(own, text)
    const a = answer('alice', '옮겼어요', { read: [{ path: own, sha256: s1 }], scope: [{ type: 'user', id: 'alice' }], listed: true })
    fs.rmSync(path.join(h.ctx.files.fx.root, ...own.split('/')))
    put(to, text)
    const db = h.ctx.db
    const turnId = uuidv7()
    db.query("INSERT INTO turns (id, chat_id, user_id, engine, status, message_id) VALUES (?, ?, 'alice', 'claude-code', 'done', ?)").run(turnId, a.chatId, a.answerId)
    db.query("INSERT INTO file_events (turn_id, user_id, path, action, detail) VALUES (?, 'alice', ?, 'delete', ?)").run(turnId, own, JSON.stringify({ movedTo: to, folder: false }))
    db.query("INSERT INTO file_events (turn_id, user_id, path, action, detail) VALUES (?, 'alice', ?, 'create', ?)").run(turnId, to, JSON.stringify({ movedFrom: own, folder: false }))
    expect((await share('alice', a, { roomId: rooms.all })).json.status).toBe('sent')
  })

  test("what made an attachable file is read only from my own chats: another person's chat tells nothing", async () => {
    // erin's AI read her conversations, then saved a file in groups/marketing that alice may open and bob may not
    const at = `groups/marketing/erin-made-${crypto.randomUUID().slice(0, 6)}.md`
    answer('erin', '만들었어요', { scope: [{ type: 'room', id: rooms.group }], saved: [{ path: at, sha256: put(at, '# erin\n') }] })
    const r = await share('alice', answer('alice', `파일: ${link(at)}`, { scope: [], listed: true }), { roomId: rooms.all })
    expect(r.json).toMatchObject({ status: 'confirm', files: [{ attach: 'yes', unable: 1 }], provenance: null })
    // made by my own confidential chat: what made it is not known
    const mine = `users/alice/conf-${crypto.randomUUID().slice(0, 6)}.md`
    const made = answer('alice', '만들었어요', { saved: [{ path: mine, sha256: put(mine, '# conf\n') }] })
    h.ctx.db.query('INSERT INTO safe_ops_chats (chat_id, material) VALUES (?, 1)').run(made.chatId)
    const conf = await share('alice', answer('alice', `파일: ${link(mine)}`, { scope: [], listed: true }), { roomId: rooms.marketing })
    expect(conf.json).toMatchObject({ status: 'confirm', provenance: { unknown: true } })
  })

  test('my choice of files changes the line: asked again for that choice (not as a change), then it goes', async () => {
    const at = 'users/alice/read-choice.md'
    const s1 = put(at, '# 읽고 링크한 파일\n')
    const a = answer('alice', `읽었어요: ${link(at)}`, { read: [{ path: at, sha256: s1 }], scope: [{ type: 'user', id: 'alice' }], listed: true })
    const body = { roomId: rooms.marketing, clientMessageId: cm() }
    const ask = await share('alice', a, body)
    expect(ask.json).toMatchObject({ status: 'confirm', provenance: null })
    // the switch off: the file's place comes into the line
    const choice = await share('alice', a, { ...body, confirmKey: ask.json.confirmKey, attach: [] })
    expect(choice.json).toMatchObject({ status: 'confirm', reason: 'choice', provenance: { people: 1, places: [{ kind: 'mine' }] } })
    const sent = await share('alice', a, { ...body, confirmKey: choice.json.confirmKey, attach: [] })
    expect(sent.json.status).toBe('sent')
    expect(sent.json.message.files).toEqual([])
    // something changed meanwhile is "changed"
    const b = answer('alice', '내 메모', { read: ['users/alice/notes.md'] })
    expect((await share('alice', b, { roomId: rooms.marketing, confirmKey: 'stale' })).json.reason).toBe('changed')
  })

  test('a file seen with two contents in one turn is not taken as listed (the list keeps the last hash)', () => {
    const log = new SourceLog()
    log.note('finance/b.md', 'read', { agent: null, sha256: 'a'.repeat(64) })
    expect(log.has('finance/b.md')).toBe(true)
    log.note('finance/b.md', 'grep', { agent: null })
    expect(log.has('finance/b.md')).toBe(true)
    log.note('finance/b.md', 'read', { agent: null, sha256: 'b'.repeat(64) })
    expect(log.has('finance/b.md')).toBe(false)
  })
})

describe('the confirm key', () => {
  test('the same state gives the same key; one member swapped for another (the same count) is a new one, the old is refused', async () => {
    const db = h.ctx.db
    const g = (await h.api('alice').call(API.createRoom, { body: { kind: 'group', userIds: ['bob', 'erin'] } })).id
    const a = answer('alice', '내 메모 요약', { read: ['users/alice/notes.md'] })
    const body = { roomId: g, clientMessageId: cm() }
    const one = await share('alice', a, body)
    const two = await share('alice', a, body)
    expect(one.json).toMatchObject({ status: 'confirm', people: 2, provenance: { people: 2 } })
    expect(two.json.confirmKey).toBe(one.json.confirmKey)
    // a keyed hash: nothing in it can be read back
    expect(one.json.confirmKey).toMatch(/^[A-Za-z0-9_-]{43}$/)
    // erin leaves, carol joins: still two people who cannot see my folder
    db.query("DELETE FROM room_members WHERE room_id = ? AND user_id = 'erin'").run(g)
    db.query("INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, 'carol', ?)").run(g, new Date().toISOString())
    const swapped = await share('alice', a, { ...body, confirmKey: one.json.confirmKey })
    expect(swapped.json).toMatchObject({ status: 'confirm', people: 2 })
    expect(swapped.json.confirmKey).not.toBe(one.json.confirmKey)
    // an older client's count is the same, so it would go (its known limit); the new key sends
    const sent = await share('alice', a, { ...body, confirmKey: swapped.json.confirmKey })
    expect(sent.json.status).toBe('sent')
    expect(audit(sent.json.message.id)).toEqual({ kind: 'group', people: 2, confirmed: true, cut: false, files: 0 })
  })

  test('a made-up key is refused like an old one', async () => {
    const r = await share('alice', answer('alice', '내 메모', { read: ['users/alice/notes.md'] }), { roomId: rooms.marketing, confirmKey: 'x'.repeat(43) })
    expect(r.json.status).toBe('confirm')
  })

  test('older clients: confirm = the number they were told still sends, nothing attached', async () => {
    put('users/alice/old-client.md', 'old\n')
    const a = answer('alice', `${link('users/alice/old-client.md')}`, { read: ['users/alice/notes.md'] })
    const body = { roomId: rooms.all, clientMessageId: cm() }
    const ask = await share('alice', a, body)
    expect(ask.json.people).toBe(4)
    const r = await share('alice', a, { ...body, confirm: ask.json.people })
    expect(r.json.status).toBe('sent')
    expect(r.json.message.files).toEqual([])
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

describe("a reply in a message's thread (a side chat's answer: threadRootId)", () => {
  const post = (user: string, roomId: string, body: string, extra: Record<string, unknown> = {}) =>
    h.api(user).call(API.sendRoomMessage, { params: { id: roomId }, body: { body, clientMessageId: cm(), mentions: [], fileIds: [], ...extra } }) as Promise<RoomMessage>
  const threadOf = async (user: string, roomId: string, rootId: string) => (await h.api(user).call(API.listRoomThread, { params: { id: roomId, messageId: rootId }, query: {} })).items as RoomMessage[]
  const noticesFor = (user: string, messageId: string) => (h.ctx.db.query('SELECT event_type FROM room_notices WHERE user_id = ? AND source_id = ?').all(user, messageId) as { event_type: string }[]).map((r) => r.event_type)
  const follows = (rootId: string) => (h.ctx.db.query('SELECT user_id FROM room_thread_follows WHERE root_id = ? ORDER BY user_id').all(rootId) as { user_id: string }[]).map((r) => r.user_id)

  test('it goes into the thread, not the timeline: the same message, mark and audit; its author and the root\'s follow it', async () => {
    const root = await post('erin', rooms.marketing, '로고 시안 언제 나와요?')
    const a = answer('alice', '수요일까지 두 개 나와요.', { read: ['shared/glossary.md'] })
    const r = await share('alice', a, { roomId: rooms.marketing, threadRootId: root.id })
    expect(r.status).toBe(200)
    expect(r.json.status).toBe('sent')
    const m = r.json.message as RoomMessage
    expect(m).toMatchObject({ threadRootId: root.id, authorKind: 'user', author: { id: 'alice' }, mentions: [], visibility: 'room', body: '수요일까지 두 개 나와요.', sharedAnswer: { at: 0, cut: false } })
    expect(m.alsoInRoom).toBeFalsy()
    // in the thread, not in the timeline; the root's summary counts it
    expect((await messagesAs('erin', rooms.marketing)).some((x) => x.id === m.id)).toBe(false)
    expect((await threadOf('erin', rooms.marketing, root.id)).map((x) => x.id)).toContain(m.id)
    expect((await messagesAs('erin', rooms.marketing)).find((x) => x.id === root.id)!.thread).toMatchObject({ replyCount: 1, repliers: [{ id: 'alice' }] })
    // erin hears it as a message of the thread
    const ev = await erinWs.next('room.message', (f) => f.data.message.id === m.id)
    expect(ev.data.message).toMatchObject({ threadRootId: root.id, sharedAnswer: { at: 0, cut: false } })
    expect(follows(root.id)).toEqual(['alice', 'erin'])
    expect(audit(m.id)).toEqual({ roomId: rooms.marketing, people: 0, confirmed: false, cut: false, files: 0 })
    // no AI turn, as in the room
    expect(h.ctx.db.query('SELECT COUNT(*) n FROM room_ai_turns WHERE question_id = ?').get(m.id)).toEqual({ n: 0 })
  })

  test("the thread's followers are notified as for any reply (the root's author too); the others are not", async () => {
    // the everyone room: dana starts it, carol replies (both follow it now), dana reads that reply (its notice is read, so
    // the next reply is a notice of its own), then alice shares into it
    const root = await post('dana', rooms.all, '이번 주 배포 일정 정리해 주실 분?')
    const first = await post('carol', rooms.all, '저도 궁금해요', { threadRootId: root.id })
    expect(noticesFor('dana', first.id)).toEqual(['room.dm'])
    await h.api('dana').call(API.markRoomThreadRead, { params: { id: rooms.all, messageId: root.id }, body: { seq: first.seq } })
    const r = await share('alice', answer('alice', '목요일 오후에 배포해요.'), { roomId: rooms.all, threadRootId: root.id })
    expect(r.json.status).toBe('sent')
    const id = r.json.message.id as string
    expect(noticesFor('dana', id)).toEqual(['room.dm'])
    expect(noticesFor('carol', id)).toEqual(['room.dm'])
    expect(noticesFor('bob', id)).toEqual([])
    expect(noticesFor('erin', id)).toEqual([])
    expect(noticesFor('alice', id)).toEqual([])
    expect(follows(root.id)).toEqual(['alice', 'carol', 'dana'])
  })

  test('refused before anything else: another room\'s message, a reply, a deleted one, an event line, a private preview, none at all', async () => {
    const db = h.ctx.db
    const elsewhere = await post('alice', rooms.all, '다른 방 메시지')
    const root = await post('erin', rooms.marketing, '스레드 시작')
    const reply = await post('erin', rooms.marketing, '답글', { threadRootId: root.id })
    const gone = await post('erin', rooms.marketing, '지울 메시지')
    expect((await h.req('erin', `/api/rooms/${rooms.marketing}/messages/${gone.id}`, { method: 'DELETE' })).status).toBeLessThan(300)
    // an event line of the group chat (a rename), and a private AI preview only alice sees
    await h.api('alice').call(API.updateRoom, { params: { id: rooms.group }, body: { name: '스레드 테스트' } })
    const line = (await messagesAs('alice', rooms.group)).find((x) => x.event)!
    expect(line).toBeTruthy()
    const preview = uuidv7()
    const seq = (db.query('UPDATE rooms SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq').get(rooms.marketing) as { last_seq: number }).last_seq
    db.query(`INSERT INTO room_messages (id, room_id, seq, author_kind, author_id, asked_by, visibility, visible_to, body, mentions, created_at) VALUES (?, ?, ?, 'ai', NULL, 'alice', 'private', 'alice', '미리보기', '[]', ?)`).run(preview, rooms.marketing, seq, new Date().toISOString())
    const a = answer('alice', '보내지 않을 답')
    const before = (await threadOf('alice', rooms.marketing, root.id)).length
    // the budget stands still: a refusal takes nothing from it
    const rs = roomsOf(h.ctx)
    const t = clock + 3_600_000
    rs.clock = () => t
    try {
      const refused = []
      for (let i = 0; i < SEND_BURST; i++) {
        for (const [roomId, threadRootId] of [[rooms.marketing, elsewhere.id], [rooms.marketing, reply.id], [rooms.marketing, gone.id], [rooms.group, line.id], [rooms.marketing, preview], [rooms.marketing, uuidv7()]] as const)
          refused.push(await share('alice', a, { roomId, threadRootId }))
      }
      for (const r of refused) {
        expect(r.status).toBe(409)
        expect(r.json.error.params.reason).toBe('thread_root')
      }
      // one answer whatever was wrong
      expect(new Set(refused.map((r) => r.json.error.message)).size).toBe(1)
      // nothing was sent or audited, and the budget is whole: a real share still goes
      expect((await threadOf('alice', rooms.marketing, root.id)).length).toBe(before)
      expect(db.query("SELECT COUNT(*) n FROM audit_log WHERE action = 'room.answer_share' AND json_extract(detail, '$.roomId') = ? AND target IN (SELECT id FROM room_messages WHERE body = '보내지 않을 답')").get(rooms.marketing)).toEqual({ n: 0 })
      expect((await share('alice', a, { roomId: rooms.marketing, threadRootId: root.id })).json.status).toBe('sent')
    } finally { rs.clock = () => (clock = t + 3_600_000) }
    // not an id at all: the body's own check
    expect((await share('alice', a, { roomId: rooms.marketing, threadRootId: 'not-an-id' })).status).toBe(400)
    // a room I am not in: 404 as without a thread, whatever the root
    const fin = await post('bob', rooms.finance, '재무 메시지')
    expect((await share('alice', a, { roomId: rooms.finance, threadRootId: fin.id })).status).toBe(404)
    // a member who joined after the root does not see it: refused the same way (a group chat sees from its join on)
    const g = (await h.api('alice').call(API.createRoom, { body: { kind: 'group', userIds: ['erin', 'dana'] } })).id
    const late = await post('alice', g, '캐럴이 오기 전 메시지')
    await h.api('alice').call(API.inviteRoomMembers, { params: { id: g }, body: { userIds: ['carol'] } })
    const lateRefused = await share('carol', answer('carol', '늦게 온 사람의 답'), { roomId: g, threadRootId: late.id })
    expect(lateRefused.status).toBe(409)
    expect(lateRefused.json.error.params.reason).toBe('thread_root')
  })

  test('a confidential conversation is never shared, to a thread either', async () => {
    const root = await post('erin', rooms.marketing, '기밀 스레드')
    const a = answer('alice', '기밀 답')
    h.ctx.db.query('INSERT INTO safe_ops_chats (chat_id, material) VALUES (?, 1)').run(a.chatId)
    const r = await share('alice', a, { roomId: rooms.marketing, threadRootId: root.id })
    expect(r.status).toBe(409)
    expect(r.json.error.params.reason).toBe('confidential')
    expect(await threadOf('erin', rooms.marketing, root.id)).toEqual([])
  })

  test('"confirm" first as for the room; the yes goes into the thread; a root deleted meanwhile is refused at the yes', async () => {
    const root = await post('dana', rooms.all, '브리프 요약 부탁해요')
    const a = answer('alice', '브리프 요약', { read: [BRIEF] })
    const body = { roomId: rooms.all, threadRootId: root.id, clientMessageId: cm() }
    const ask = await share('alice', a, body)
    // bob (finance) cannot read groups/marketing: the same question as for the room
    expect(ask.json).toMatchObject({ status: 'confirm', people: 1, provenance: { people: 1, places: [{ kind: 'folder', path: 'groups/marketing' }] } })
    expect(await threadOf('dana', rooms.all, root.id)).toEqual([])
    const yes = await share('alice', a, { ...body, confirmKey: ask.json.confirmKey })
    expect(yes.json.status).toBe('sent')
    expect(yes.json.message.threadRootId).toBe(root.id)
    expect(audit(yes.json.message.id)).toEqual({ roomId: rooms.all, people: 1, confirmed: true, cut: false, files: 0 })
    // asked, then the root goes before the yes: refused, nothing sent
    const root2 = await post('dana', rooms.all, '곧 지울 질문')
    const body2 = { roomId: rooms.all, threadRootId: root2.id, clientMessageId: cm() }
    const ask2 = await share('alice', a, body2)
    expect(ask2.json.status).toBe('confirm')
    expect((await h.req('dana', `/api/rooms/${rooms.all}/messages/${root2.id}`, { method: 'DELETE' })).status).toBeLessThan(300)
    const late = await share('alice', a, { ...body2, confirmKey: ask2.json.confirmKey })
    expect(late.status).toBe(409)
    expect(late.json.error.params.reason).toBe('thread_root')
    expect(h.ctx.db.query('SELECT COUNT(*) n FROM room_messages WHERE client_id = ?').get(body2.clientMessageId)).toEqual({ n: 0 })
  })

  test('one id per click: the same id again is the first message (deleted since, too); a new id is a new message', async () => {
    const root = await post('erin', rooms.marketing, '한 번만 보내 주세요')
    const a = answer('alice', '한 번만 가는 답')
    const click = { roomId: rooms.marketing, threadRootId: root.id, clientMessageId: cm() }
    const one = await share('alice', a, click)
    const again = await share('alice', a, click)
    expect(again.json.message.id).toBe(one.json.message.id)
    expect((await threadOf('erin', rooms.marketing, root.id)).length).toBe(1)
    // the same id after the message was deleted: still that message, deleted (the app never reuses an id across clicks)
    expect((await h.req('alice', `/api/rooms/${rooms.marketing}/messages/${one.json.message.id}`, { method: 'DELETE' })).status).toBeLessThan(300)
    const stale = await share('alice', a, click)
    expect(stale.json.status).toBe('sent')
    expect(stale.json.message).toMatchObject({ id: one.json.message.id, deletedAt: expect.any(String), body: '' })
    // a new click is a new id: a new message
    const two = await share('alice', a, { ...click, clientMessageId: cm() })
    expect(two.json.message.id).not.toBe(one.json.message.id)
    expect(two.json.message.threadRootId).toBe(root.id)
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
