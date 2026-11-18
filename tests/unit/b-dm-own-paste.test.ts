// "Your own paste is yours to send" (docs/decisions/20261118-dm-own-paste.md, chat/own-paste.ts): text the person
// pasted in their own message goes to the teammate they name as their own words, even in a chat that read rooms where
// that teammate has earlier answers hidden from them (answer_share_hidden). Looking up a room or a person by name (the
// rooms list) does not count as reading room messages. Content the AI brought in from a room is still never sent past
// a member with hidden answers, and the refusal says what the person can do instead.
// The fixture team (b-harness): alice and erin in marketing, bob in finance.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, uuidv7, type Room, type RoomMessage } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { roomsOf } from '../../server/src/rooms/service'
import { OWN_PASTE_NEXT } from '../../server/src/chat/post-to-room'
import { ownPaste } from '../../server/src/chat/own-paste'
import { ROOM_NAMES_ONLY, roomMessagesSeen } from '../../server/src/chat/read-rooms'

setDefaultTimeout(60_000)
const cm = () => 'cm-' + crypto.randomUUID()
// the fake engine's directives with their strings as JSON escapes: the person's own words are only what the test writes
const opaque = (j: string) => j.replace(/"(?:[^"\\]|\\.)*"/g, (q) => q.replace(/\\.|[\p{L}\p{N}]/gu, (c) => (c.length > 1 ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)))
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + opaque(JSON.stringify(d))).join('\n')
const post = (args: Record<string, unknown>) => fake({ tool: 'post_to_room', args, sayResult: true })

/** a made-up vendor notice, Korean, with a version table (no real company, product or address) */
const EMAIL = [
  '[안내] 가나다소프트 자바 보안 패치 적용 안내',
  '',
  '안녕하세요, 가나다소프트 기술지원팀입니다.',
  '아래 제품을 쓰시는 고객께 보안 패치 적용을 안내드립니다.',
  '',
  '| 제품 | 현재 버전 | 패치 버전 | 적용 기한 |',
  '| --- | --- | --- | --- |',
  '| 예시 서버 A | 8.0.401 | 8.0.431 | 2026-12-01 |',
  '| 예시 서버 B | 11.0.24 | 11.0.27 | 2026-12-01 |',
  '| 예시 콘솔 | 17.0.12 | 17.0.15 | 2026-12-15 |',
  '',
  '패치 전에 꼭 백업해 주시고, 문의는 담당 엔지니어에게 주세요.',
  '감사합니다.',
].join('\n')

let h: Harness
let sock: TestSocket
let marketing = '', dm = ''
let clock = Date.now()
beforeAll(async () => {
  h = await startHarness({ name: 'b-dm-own-paste', askUserTimeoutMs: 6000, stallTimeoutMs: 60_000 })
  // the contract's group ids (and a team room's groupId) are UUIDv7; the fixture's are short (as b-post-to-room)
  const db = h.ctx.db
  db.exec('PRAGMA foreign_keys = OFF')
  for (const g of ['marketing', 'finance']) {
    const id = uuidv7()
    for (const sql of ['UPDATE groups SET id = ?1 WHERE id = ?2', 'UPDATE group_members SET group_id = ?1 WHERE group_id = ?2', "UPDATE folder_rules SET subject_id = ?1 WHERE subject_type = 'group' AND subject_id = ?2", 'UPDATE rooms SET group_id = ?1 WHERE group_id = ?2'])
      db.query(sql).run(id, g)
  }
  db.exec('PRAGMA foreign_keys = ON')
  roomsOf(h.ctx).clock = () => (clock += 10_000)
  const mine = (await h.api('alice').call(API.listRooms)).items as Room[]
  marketing = mine.find((r) => r.kind === 'team' && r.name === 'Marketing')!.id
  // alice and erin already have a 1:1 chat (as in the report)
  dm = roomsOf(h.ctx).openDm('alice', 'erin').id
  // an earlier answer in marketing is hidden from erin (she joined after it: docs/DECISIONS.md "지난 대화")
  const old = await h.api('alice').call(API.sendRoomMessage, { params: { id: marketing }, body: { body: 'MKT-OLD-ANSWER budget 4,200', clientMessageId: cm(), mentions: [], fileIds: [] } })
  const seq = (h.ctx.db.query('SELECT seq FROM room_messages WHERE id = ?').get(old.id) as { seq: number }).seq
  h.ctx.db.query('INSERT INTO room_hidden_answers (room_id, user_id, message_id, see_seq) VALUES (?, ?, ?, ?)').run(marketing, 'erin', old.id, seq)
  sock = await h.ws('alice', { windowId: 'win-own-paste' })
  await sock.next('hello')
})
afterAll(async () => { sock?.close(); await h?.close() })

type Card = { question: string; details?: { label: string; text: string }[] }
/** one turn of alice in a new chat; `answer`: the card's answer (none: no card expected) */
async function turn(content: string, answer?: string) {
  const chatId = (await h.api('alice').call(API.createChat, { body: {} })).id
  const r = await h.api('alice').call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  let card = null as Card | null
  if (answer !== undefined) {
    const c = await sock.next('turn.request', (f) => f.data.turnId === r.turnId)
    card = c.data.request as unknown as Card
    await h.api('alice').call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: c.data.request.requestId, answer } })
  }
  const done = await sock.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 30_000)
  return { chatId, answerId: r.assistantMessage.id as string, content: done.data.message.content as string, card }
}
const lastDm = async () => ((await h.api('erin').call(API.listRoomMessages, { params: { id: dm }, query: {} })).items as RoomMessage[]).at(-1)
const roomsSeen = (chatId: string) => (h.ctx.db.query('SELECT rooms_seen FROM chats WHERE id = ?').get(chatId) as { rooms_seen: number }).rooms_seen

describe('the person\'s own paste', () => {
  test('the report: a pasted email, "send this to Erin", the AI looks the name up in the rooms list and sends it as her own words: it goes (it was refused as hidden answers)', async () => {
    const r = await turn([EMAIL, '', '이거 Erin에게 DM보내줘', fake({ tool: 'rooms', args: {} }), post({ room: 'Erin', text: EMAIL, own_words: true })].join('\n'), 'send')
    expect(r.card!.details!.at(-1)!.text).toBe(EMAIL)
    expect(JSON.parse(r.content)).toMatchObject({ status: 'sent', room_id: dm })
    const m = (await lastDm())!
    expect(m.body).toBe(EMAIL)
    expect(m.author?.id).toBe('alice')
    // the list showed names only: every gate of a read room still applies (true), not as room messages
    expect(roomsSeen(r.chatId)).toBe(ROOM_NAMES_ONLY)
  })

  test('even after the AI read a room where Erin has hidden answers: her own paste goes, as she wrote it (the AI\'s spacing does not)', async () => {
    const spaced = EMAIL.replace(/\n\n/g, '\n').replace(/ \| /g, '  |  ')
    const r = await turn([EMAIL, '', '이거 Erin에게 보내줘', fake({ tool: 'room_read', args: { room: marketing } }), post({ room: 'Erin', text: spaced, own_words: true })].join('\n'), 'send')
    expect(roomsSeen(r.chatId)).toBe(1)
    expect(JSON.parse(r.content)).toMatchObject({ status: 'sent', room_id: dm })
    expect((await lastDm())!.body).toBe(EMAIL)
  })

  test('an AI-written message with nothing of a room in it, after only a name lookup: goes on the card, no "conversation" source line', async () => {
    const r = await turn(['Erin에게 요약 보내줘', fake({ tool: 'rooms', args: {} }), post({ room: 'Erin', text: 'Summary: patch the servers by Dec 1.' })].join('\n'), 'send')
    expect(JSON.parse(r.content)).toMatchObject({ status: 'sent' })
    expect((await lastDm())!.body).toBe('Summary: patch the servers by Dec 1.')
  })
})

describe('room content the AI brought in is still guarded', () => {
  test('a summary of a room where Erin has hidden answers is refused, confirmed or not, and the refusal offers the own-words step', async () => {
    const before = (await lastDm())!.id
    const r = await turn(['마케팅방 요약해서 Erin에게 보내줘', fake({ tool: 'room_read', args: { room: marketing } }), post({ room: 'Erin', text: 'Summary: MKT-OLD-ANSWER budget 4,200' })].join('\n'))
    expect(r.content).toContain('Nothing was posted')
    expect(r.content).toContain(OWN_PASTE_NEXT)
    expect((await lastDm())!.id).toBe(before)
  })

  test('own_words with room content the person never wrote is refused the same way', async () => {
    const before = (await lastDm())!.id
    const r = await turn(['Erin한테 그대로 전해줘', fake({ tool: 'room_read', args: { room: marketing } }), post({ room: 'Erin', text: 'MKT-OLD-ANSWER budget 4,200', own_words: true })].join('\n'))
    expect(r.content).toContain('Nothing was posted')
    expect((await lastDm())!.id).toBe(before)
  })

  test('a paste with one word changed, with room content added, or inside a quote line is not the person\'s own', async () => {
    const before = (await lastDm())!.id
    for (const [said, text] of [
      [EMAIL, EMAIL.replace('8.0.431', '8.0.499')],
      [EMAIL, `${EMAIL}\nMKT-OLD-ANSWER budget 4,200`],
      [EMAIL.split('\n').map((l) => `> ${l}`).join('\n'), EMAIL],
      // an invisible character the AI put in
      [EMAIL, EMAIL.replace('보안', '보​안')],
    ]) {
      const r = await turn([said, 'Erin에게 보내줘', fake({ tool: 'room_read', args: { room: marketing } }), post({ room: 'Erin', text, own_words: true })].join('\n'))
      expect(r.content).toContain('Nothing was posted')
    }
    expect((await lastDm())!.id).toBe(before)
  })
})

describe('ownPaste and the names-only mark', () => {
  test('a stretch of one of the person\'s own messages on the branch, as they wrote it; never another author\'s, a server-sent one or a quote', () => {
    const db = h.ctx.db
    const chatId = uuidv7()
    db.query('INSERT INTO chats (id, user_id) VALUES (?, ?)').run(chatId, 'alice')
    const add = (parent: string | null, role: string, content: string, author: string | null, auto = 0) => {
      const id = uuidv7()
      db.query('INSERT INTO messages (id, chat_id, parent_id, role, author_id, content, status, auto_sent) VALUES (?, ?, ?, ?, ?, ?, \'done\', ?)').run(id, chatId, parent, role, author, content, auto)
      return id
    }
    const q1 = add(null, 'user', 'first line\n\nsecond   line\n> quoted secret\n#[Sales](room:01900000-0000-7000-8000-000000000000) room', 'alice')
    const a1 = add(q1, 'assistant', 'AI SAID THIS', null)
    const q2 = add(a1, 'user', 'OTHER AUTHOR TEXT', 'bob')
    const a2 = add(q2, 'assistant', '', null)
    const q3 = add(a2, 'user', 'SERVER SENT TEXT', 'alice', 1)
    const a3 = add(q3, 'assistant', '', null)
    expect(ownPaste(db, 'alice', a3, 'first line second line')).toBe('first line\n\nsecond   line')
    expect(ownPaste(db, 'alice', a3, '  second line  ')).toBe('second   line')
    expect(ownPaste(db, 'alice', a3, 'AI SAID THIS')).toBeNull()
    expect(ownPaste(db, 'alice', a3, 'OTHER AUTHOR TEXT')).toBeNull()
    expect(ownPaste(db, 'alice', a3, 'SERVER SENT TEXT')).toBeNull()
    expect(ownPaste(db, 'alice', a3, 'quoted secret')).toBeNull()
    expect(ownPaste(db, 'alice', a3, 'Sales')).toBeNull()
    expect(ownPaste(db, 'alice', a3, '')).toBeNull()
    // another person's own words are theirs, not alice's
    expect(ownPaste(db, 'bob', a3, 'first line')).toBeNull()
    expect(ownPaste(db, 'bob', a3, 'OTHER AUTHOR TEXT')).toBe('OTHER AUTHOR TEXT')
  })

  test('found in review: a "\\r" inside a quote, text an earlier AI answer showed, a part of a word, a server-written message', () => {
    const db = h.ctx.db
    const chatId = uuidv7()
    db.query('INSERT INTO chats (id, user_id) VALUES (?, ?)').run(chatId, 'alice')
    const add = (parent: string | null, role: string, content: string, author: string | null, cid: string | null = null) => {
      const id = uuidv7()
      db.query("INSERT INTO messages (id, chat_id, parent_id, role, author_id, content, status, client_message_id) VALUES (?, ?, ?, ?, ?, ?, 'done', ?)").run(id, chatId, parent, role, author, content, cid)
      return id
    }
    const summary = 'Room summary: the hidden budget for the next quarter is 4,200 and the vendor is changing in March.'
    const q1 = add(null, 'user', 'summarize the room', 'alice')
    const a1 = add(q1, 'assistant', summary, null)
    const q2 = add(a1, 'user', `> Someone · now\n> harmless\rQUOTED-SECRET merger price 42\n\n${summary}\n\ndo not approve the order`, 'alice')
    const q3 = add(q2, 'user', 'SERVER WROTE THIS FROM A FILE', 'alice', 'skd-rewrite-1')
    const now = add(q3, 'assistant', '', null)
    // the rest of a quoted line after a carriage return is still the quote
    expect(ownPaste(db, 'alice', now, 'QUOTED-SECRET merger price 42')).toBeNull()
    // the AI's earlier summary, copied into the person's message, is not their own
    expect(ownPaste(db, 'alice', now, summary)).toBeNull()
    expect(ownPaste(db, 'alice', now, summary.slice(10, 80))).toBeNull()
    // a whole stretch of words is; a part of a word is not
    expect(ownPaste(db, 'alice', now, 'do not approve the order')).toBe('do not approve the order')
    expect(ownPaste(db, 'alice', now, 'ot approve the order')).toBeNull()
    expect(ownPaste(db, 'alice', now, 'approve the ord')).toBeNull()
    expect(ownPaste(db, 'alice', now, 'SERVER WROTE THIS FROM A FILE')).toBeNull()
  })

  test('roomMessagesSeen: 0 no, names only no, 1 and anything else yes', () => {
    expect(roomMessagesSeen(0)).toBe(false)
    expect(roomMessagesSeen(null)).toBe(false)
    expect(roomMessagesSeen(ROOM_NAMES_ONLY)).toBe(false)
    expect(roomMessagesSeen(1)).toBe(true)
    expect(roomMessagesSeen(7)).toBe(true)
  })
})
