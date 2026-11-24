// S-119 (scenario QA 11-22): sending to an outside guest and to the person the user named.
//  - post_to_room to a guest's 1:1 chat (made or not): the card says she is a guest from outside.
//  - share_with_person whose only match is a guest: the AI is told so (files are never shared with a guest) instead of
//    "nobody matches".
//  - "하늘님(외부 디자이너)한테도 보내줘" right after a post to 김민지 made a second card to 김민지: a post to a person whose
//    name the asker's own message does not hold, while it names someone else, is refused (no card); the message naming
//    the recipient, or nobody, still gets the card.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { roomsOf } from '../../server/src/rooms/service'
import { namesSomeoneElse, POST_TO_ROOM_DESCRIPTION } from '../../server/src/chat/post-to-room'

setDefaultTimeout(60_000)
const cm = () => 'cm-' + crypto.randomUUID()
// the fake engine's directives as JSON escapes: the person's own words are only what the test writes around them
const opaque = (j: string) => j.replace(/"(?:[^"\\]|\\.)*"/g, (q) => q.replace(/\\.|[\p{L}\p{N}]/gu, (c) => (c.length > 1 ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)))
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + opaque(JSON.stringify(d))).join('\n')
const post = (args: Record<string, unknown>) => fake({ tool: 'post_to_room', args, sayResult: true })
const share = (args: Record<string, unknown>) => fake({ tool: 'share_with_person', args, sayResult: true })

let h: Harness
let sock: TestSocket
let clock = Date.now()
beforeAll(async () => {
  h = await startHarness({ name: 'b-send-to-guest', askUserTimeoutMs: 6000, stallTimeoutMs: 60_000 })
  const db = h.ctx.db
  roomsOf(h.ctx).clock = () => (clock += 10_000)
  db.query("INSERT INTO users (id, username, name, role, status, deleted_at) VALUES ('minji', 'minji', '김민지', 'member', 'active', NULL)").run()
  db.query("INSERT INTO users (id, username, name, role, status, deleted_at) VALUES ('junho', 'junho', '박준호', 'member', 'active', NULL)").run()
  db.query("INSERT INTO users (id, username, name, role, status, deleted_at, guest) VALUES ('haneul', 'haneul', '정하늘', 'member', 'active', NULL, 1)").run()
  // the guest's place: a group chat of bob's (so bob reaches her)
  const room = await h.api('bob').call(API.createRoom, { body: { kind: 'group', userIds: ['minji'], name: 'design-outside' } })
  db.query('INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)').run(room.id, 'haneul', new Date().toISOString())
  db.query("INSERT INTO guests (user_id, place_kind, place_id, room_id, ai, created_at) VALUES ('haneul', 'room', ?, ?, 'none', ?)").run(room.id, room.id, new Date().toISOString())
  sock = await h.ws('bob', { windowId: 'win-guest-bob' })
  await sock.next('hello')
  const abs = path.join(h.ctx.files.fx.root, 'users', 'bob', 'logo.png')
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, 'png')
})
afterAll(async () => { sock?.close(); await h?.close() })

type Card = { question: string }
async function turn(content: string, o: { answer?: string } = {}) {
  const chatId = (await h.api('bob').call(API.createChat, { body: {} })).id
  const r = await h.api('bob').call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  let card: Card | null = null
  if (o.answer !== undefined) {
    const c = await sock.next('turn.request', (f) => f.data.turnId === r.turnId)
    card = c.data.request as unknown as Card
    await h.api('bob').call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: c.data.request.requestId, answer: o.answer } })
  }
  const done = await sock.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 30_000)
  const cards = sock.frames.filter((f) => f.type === 'turn.request' && (f as { data: { turnId?: string } }).data.turnId === r.turnId).length
  return { content: done.data.message.content as string, card, cards }
}

describe('a guest', () => {
  test('the card for a new 1:1 chat with a guest says she is from outside', async () => {
    const r = await turn(`하늘님한테 시안 보내줘\n${post({ room: '정하늘', text: '시안 보내드려요', own_words: true })}`, { answer: 'no' })
    expect(r.card!.question).toContain('정하늘님과의 새 1:1 대화로 보낼까요?')
    expect(r.card!.question).toContain('정하늘님은 게스트(외부)예요. 초대받은 곳만 볼 수 있어요.')
  })

  test('a teammate\'s card has no guest line', async () => {
    const r = await turn(`민지님한테 보내줘\n${post({ room: '김민지', text: '견적서 보내요', own_words: true })}`, { answer: 'no' })
    expect(r.card!.question).not.toContain('게스트')
  })

  test('share_with_person to a guest says she is a guest, not "nobody matches"', async () => {
    const r = await turn(`logo.png 하늘님한테 공유해줘\n${share({ paths: ['users/bob/logo.png'], people: ['정하늘'] })}`)
    expect(r.content).toContain('정하늘 is an outside guest, and files cannot be shared with a guest')
    expect(r.content).toContain('post_to_room')
    expect(r.content).not.toContain('no teammate or group matches')
  })
})

describe('only the person the message names', () => {
  test('"하늘님(외부 디자이너)한테도 보내줘" never sends to 김민지 again (refused, no card)', async () => {
    const r = await turn(`하늘님(외부 디자이너)한테도 보내줘\n${post({ room: '김민지', text: '견적서 보내요' })}`)
    expect(r.cards).toBe(0)
    expect(r.content).toContain("the user's message names 정하늘, not 김민지. Ask the user who it should go to.")
    expect(r.content).toContain('never mean sending again to the earlier ones')
  })

  test('the message names the recipient (it goes: the explicit ask), or nobody (the card shows)', async () => {
    // (the text is the person's dictated words: a text the AI wrote goes on a card, docs/decisions/20261124-sends-verbatim.md)
    const named = await turn(`${post({ room: '김민지', text: '견적서 보내요' })}\n김민지님한테도 보내줘: 견적서 보내요`)
    expect(named.content).not.toContain('Ask the user who it should go to')
    expect(named.content).toContain('"status":"sent"')
    const nobody = await turn(`이거 보내줘\n${post({ room: '김민지', text: '견적서 보내요' })}`, { answer: 'no' })
    expect(nobody.card).not.toBeNull()
  })

  test('namesSomeoneElse: given names, the recipient named too, and doubt', () => {
    const db = h.ctx.db
    expect(namesSomeoneElse(db, '하늘님한테도 보내줘', 'bob', 'minji')).toBe('정하늘')
    expect(namesSomeoneElse(db, 'send it to haneul too', 'bob', 'minji')).toBe('정하늘')
    // the recipient named as well: no refusal
    expect(namesSomeoneElse(db, '민지님하고 하늘님한테 보내줘', 'bob', 'minji')).toBeNull()
    // a name only as the subject of the text, not as whom it goes to: no refusal
    expect(namesSomeoneElse(db, '하늘님 시안 보내줘', 'bob', 'minji')).toBeNull()
    expect(namesSomeoneElse(db, '', 'bob', 'minji')).toBeNull()
    // whom it came from, not whom it goes to: 한테서, 께서, 에게서, "한테 받은"
    expect(namesSomeoneElse(db, '준호한테서 받은 파일 보내줘', 'bob', 'minji')).toBeNull()
    expect(namesSomeoneElse(db, '준호님께서 주신 자료 보내줘', 'bob', 'minji')).toBeNull()
    expect(namesSomeoneElse(db, '준호에게서 온 거 보내줘', 'bob', 'minji')).toBeNull()
    expect(namesSomeoneElse(db, '준호한테 받은 거 보내줘', 'bob', 'minji')).toBeNull()
    // a recipient chosen by title (팀장님): someone named only as where it came from is no other recipient
    expect(namesSomeoneElse(db, '팀장님께 보내줘. 준호한테 받은 거야', 'bob', 'minji')).toBeNull()
    // still: 준호 as the recipient
    expect(namesSomeoneElse(db, '준호한테 보내줘', 'bob', 'minji')).toBe('박준호')
    expect(POST_TO_ROOM_DESCRIPTION).toContain('never means sending again to earlier ones')
  })
})
