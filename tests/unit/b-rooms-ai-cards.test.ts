// The cards of a question to the AI in a room come back (docs/DECISIONS.md "대화방의 확인 카드는 다시 읽는다"): a card is
// sent once over the socket (turn.request), so a reload, another browser or a reconnect the server could not resume
// would leave the question waiting for an answer nobody can give. GET /api/rooms/:id/ai/requests lists the open cards of
// the caller's own questions in the room, as GET /api/chats/:id/requests does for a chat. With the fake engine through
// the real launcher and gate: the asker gets the card back (a new socket, another window) and can answer it from there;
// another member gets nothing of it (no card, no event, not its words) and cannot answer it; someone outside the room
// gets 404; an answered or timed-out card is gone from the list; a question in a thread brings its card back too; a member
// taken out of the room and a disabled account get none (the asker taken out or disabled: the question stops, its card
// closes). The list carries no chat id (RoomTurnRequest).
//
// The room is alice, erin, carol and dana (the people who may read groups/marketing): alice asks, erin is the other
// member, bob is outside the room.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, uuidv7, type OpenTurnRequest, type RoomMessage, type RoomTurnRequest, type TurnRequest } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'

setDefaultTimeout(120_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
type Ask = Extract<TurnRequest, { kind: 'ask_user' }>

let h: Harness
const ws: Record<string, TestSocket> = {}
beforeAll(async () => {
  h = await startHarness({ name: 'b-rooms-ai-cards', askUserTimeoutMs: 4000, turnTimeoutMs: 60_000 })
  // the contract's group ids (and a team room's groupId) are UUIDv7; the fixture's are short
  const db = h.ctx.db
  db.exec('PRAGMA foreign_keys = OFF')
  for (const g of ['marketing', 'finance']) {
    const id = uuidv7()
    for (const sql of ['UPDATE groups SET id = ?1 WHERE id = ?2', 'UPDATE group_members SET group_id = ?1 WHERE group_id = ?2', "UPDATE folder_rules SET subject_id = ?1 WHERE subject_type = 'group' AND subject_id = ?2", 'UPDATE rooms SET group_id = ?1 WHERE group_id = ?2'])
      db.query(sql).run(id, g)
  }
  db.exec('PRAGMA foreign_keys = ON')
  for (const u of ['alice', 'bob', 'erin']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

let groups = 0
let n = 0
/** a team room of its own: a new group of these people, made by the owner */
async function teamRoom(memberIds = ['alice', 'erin', 'carol', 'dana']): Promise<string> {
  const g = await h.api('dana').call(API.createGroup, { body: { name: `cards-room-${++groups}`, memberIds } })
  const r = (await h.api(memberIds[0]!).call(API.listRooms)).items.find((x) => x.kind === 'team' && x.groupId === g.id)
  if (!r) throw new Error('no team room')
  return r.id
}
/** a folder of its own under groups/marketing (alice, erin, carol and dana may read and write it) */
function folder(): string {
  const rel = `groups/marketing/cards-${++n}`
  fs.mkdirSync(path.join(h.team, rel), { recursive: true })
  return rel
}
const exists = (rel: string) => fs.existsSync(path.join(h.team, rel))
const send = (user: string, roomId: string, body: string, threadRootId?: string): Promise<RoomMessage> =>
  h.api(user).call(API.sendRoomMessage, { params: { id: roomId }, body: { body, clientMessageId: cm(), mentions: [], fileIds: [], ...(threadRootId ? { threadRootId } : {}) } })
const cardsOf = async (user: string, roomId: string, window?: string) => (await h.api(user, window ? { window } : {}).call(API.listRoomAiRequests, { params: { id: roomId } })).items

/** @트리나 asks to save a new team file (the room's change card): the question, its turn and the first card it raised,
 * as the socket of the asker got it */
async function raise(user: string, roomId: string, threadRootId?: string): Promise<{ q: RoomMessage; turnId: string; open: RoomTurnRequest; sent: OpenTurnRequest; file: string }> {
  const file = `${folder()}/견적서_acme.md`
  const q = await send(user, roomId, `@트리나 save it\n${fake({ tool: 'write', args: { file_path: file, content: '# acme\n- 의자 12개\n' } }, { say: 'done' })}`, threadRootId)
  const turnId = (await ws[user]!.next('room.ai.run', (f) => f.data.run.questionId === q.id, 20_000)).data.run.turnId
  const f = await ws[user]!.next('turn.request', (x) => x.data.turnId === turnId, 30_000)
  // the list gives the card as the socket sent it, without the room session's chat id
  const { chatId: _session, ...open } = f.data
  return { q, turnId, open, sent: f.data, file }
}
const ended = (user: string, turnId: string) => ws[user]!.next('room.ai.run', (f) => f.data.run.turnId === turnId && ['done', 'stopped', 'error'].includes(f.data.run.state), 40_000)
const answer = (user: string, turnId: string, c: Ask, value = c.options![0]!.value) =>
  h.req(user, `/api/turns/${turnId}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'ask_user', requestId: c.requestId, answer: value }) })

describe('the open cards of my questions in a room', () => {
  test('the asker gets the card back as the socket sent it (a reload, another browser) and can answer it from there; answered, it is gone', async () => {
    const roomId = await teamRoom()
    const { turnId, open, file } = await raise('alice', roomId)
    const c = open.request as Ask
    expect(c).toMatchObject({ kind: 'ask_user', origin: 'server' })
    // the same card as the socket sent it, without its chat id: the room session's chat is never listed or opened
    expect(await cardsOf('alice', roomId)).toEqual([open])
    expect((await cardsOf('alice', roomId))[0]).not.toHaveProperty('chatId')
    // another window of alice's (another browser, the phone), and a new socket that did not resume: no event brings
    // the card again, the list does
    const other = await h.ws('alice')
    try {
      await other.next('hello')
      await Bun.sleep(300)
      expect(other.frames.some((f) => f.type === 'turn.request')).toBe(false)
      expect(await cardsOf('alice', roomId, 'win-phone')).toEqual([open])
    } finally { other.close() }
    // GET /api/rooms/:id/ai still names the question as mine, waiting
    expect((await h.api('alice').call(API.getRoomAi, { params: { id: roomId } })).mine.map((r) => r.turnId)).toEqual([turnId])
    // answered from "the other browser": the answer goes on, the card is no longer listed
    expect((await answer('alice', turnId, c)).status).toBe(204)
    expect(await cardsOf('alice', roomId)).toEqual([])
    expect((await ended('alice', turnId)).data.run.state).toBe('done')
    expect(exists(file)).toBe(true)
    expect(await cardsOf('alice', roomId)).toEqual([])
  })

  test('another member gets nothing of it (no card, no event, not its words) and cannot answer it; someone outside the room gets 404', async () => {
    const roomId = await teamRoom()
    const erinFrom = ws.erin!.frames.length
    const { turnId, open, file } = await raise('alice', roomId)
    const c = open.request as Ask
    // erin sees that the AI is answering someone, nothing more
    expect(await cardsOf('erin', roomId)).toEqual([])
    const erinAi = await h.api('erin').call(API.getRoomAi, { params: { id: roomId } })
    expect(erinAi).toMatchObject({ answering: 1, mine: [] })
    // (the question's own message holds the test's file name and text: it is the room's; the card's words are not)
    const seen = JSON.stringify(ws.erin!.frames.slice(erinFrom))
    expect(c.question.length).toBeGreaterThan(20)
    for (const words of [c.requestId, c.question, c.note ?? c.question, JSON.stringify(c.options)]) expect(seen).not.toContain(words)
    expect(ws.erin!.frames.slice(erinFrom).some((f) => f.type === 'turn.request' || f.type === 'room.ai.step' || f.type === 'room.ai.run')).toBe(false)
    // her answer is refused as for a turn that is not hers (404), and the card stays open for alice
    const refused = await answer('erin', turnId, c)
    expect(refused.status).toBe(404)
    expect(JSON.stringify(await refused.json())).not.toContain(c.question)
    expect(await cardsOf('alice', roomId)).toEqual([open])
    // bob is not in the room: the room is not found, for the list as for the room's AI state
    expect((await h.req('bob', `/api/rooms/${roomId}/ai/requests`)).status).toBe(404)
    expect((await answer('bob', turnId, c)).status).toBe(404)
    // the asker's answer still counts
    expect((await answer('alice', turnId, c)).status).toBe(204)
    expect((await ended('alice', turnId)).data.run.state).toBe('done')
    expect(exists(file)).toBe(true)
  })

  test('a card nobody answered: timed out, it is no longer listed', async () => {
    const roomId = await teamRoom()
    const { turnId, open, file } = await raise('alice', roomId)
    expect(await cardsOf('alice', roomId)).toEqual([open])
    const closed = await ws.alice!.next('turn.request.closed', (f) => f.data.requestId === open.request.requestId, 20_000)
    expect(closed.data.reason).toBe('timeout')
    expect(await cardsOf('alice', roomId)).toEqual([])
    await ended('alice', turnId)
    expect(await cardsOf('alice', roomId)).toEqual([])
    expect(exists(file)).toBe(false)
  })

  test('a question in a thread: its card comes back with the room, its run says the thread', async () => {
    const roomId = await teamRoom()
    const root = await send('erin', roomId, '견적서는 이 스레드에서 정리해요')
    const { q, turnId, open } = await raise('alice', roomId, root.id)
    expect(q.threadRootId).toBe(root.id)
    expect(await cardsOf('alice', roomId)).toEqual([open])
    const mine = (await h.api('alice').call(API.getRoomAi, { params: { id: roomId } })).mine
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({ turnId, threadRootId: root.id })
    expect(await cardsOf('erin', roomId)).toEqual([])
    // "허용 안 함": the card goes, nothing is saved
    expect((await answer('alice', turnId, open.request as Ask, 'skip')).status).toBe(204)
    expect(await cardsOf('alice', roomId)).toEqual([])
    expect((await ended('alice', turnId)).data.run.state).toBe('done')
  })

  test("the room's list holds only this room's questions: my card in another room is not in it", async () => {
    const a = await teamRoom()
    const b = await teamRoom()
    const { turnId, open } = await raise('alice', a)
    expect(await cardsOf('alice', b)).toEqual([])
    expect(await cardsOf('alice', a)).toEqual([open])
    expect((await answer('alice', turnId, open.request as Ask, 'skip')).status).toBe(204)
    await ended('alice', turnId)
  })
})

describe('people no longer in the room, or no longer on the team', () => {
  test('a member taken out of the room gets no list; the asker taken out: the question stops, its card closes, and they get none', async () => {
    // a group chat of dana's (she manages it) with alice and erin
    const roomId = (await h.api('dana').call(API.createRoom, { body: { kind: 'group', userIds: ['alice', 'erin'] } })).id
    const { turnId, open } = await raise('alice', roomId)
    expect(await cardsOf('alice', roomId)).toEqual([open])
    expect(await cardsOf('erin', roomId)).toEqual([])
    await h.api('dana').call(API.removeRoomMember, { params: { id: roomId, userId: 'erin' } })
    expect((await h.req('erin', `/api/rooms/${roomId}/ai/requests`)).status).toBe(404)
    // the asker taken out (rooms/ai.ts stopFor): no list for her there, and the card is closed for good
    await h.api('dana').call(API.removeRoomMember, { params: { id: roomId, userId: 'alice' } })
    await ws.alice!.next('turn.request.closed', (f) => f.data.requestId === open.request.requestId, 20_000)
    expect((await h.req('alice', `/api/rooms/${roomId}/ai/requests`)).status).toBe(404)
    expect((await answer('alice', turnId, open.request as Ask)).status).toBe(409)
    expect(h.rt().execFor(turnId)?.openRequests() ?? []).toEqual([])
  })

  test('a disabled account: its question stops and its card closes; it gets no list, and the others get none of its card', async () => {
    // (the last test of the file: erin is disabled here and enabled again at the end)
    const roomId = await teamRoom()
    const { turnId, open } = await raise('erin', roomId)
    expect(await cardsOf('erin', roomId)).toEqual([open])
    await h.api('dana').call(API.updateUser, { params: { id: 'erin' }, body: { status: 'disabled' } })
    try {
      // its turns stop (admin/users.ts stopTurnsOf) and it leaves the team rooms
      for (let i = 0; i < 200 && h.rt().execFor(turnId); i++) await Bun.sleep(50)
      expect(h.rt().execFor(turnId)).toBeUndefined()
      const mine = await h.req('erin', `/api/rooms/${roomId}/ai/requests`)
      // (out of the team room: 404; a real sign-in of a disabled account has no session left at all)
      expect(mine.status).toBe(404)
      expect(JSON.stringify(await mine.json().catch(() => null))).not.toContain(open.request.requestId)
      expect(await cardsOf('alice', roomId)).toEqual([])
      expect((await answer('erin', turnId, open.request as Ask)).status).not.toBe(204)
    } finally {
      await h.api('dana').call(API.updateUser, { params: { id: 'erin' }, body: { status: 'active' } })
    }
  })
})
