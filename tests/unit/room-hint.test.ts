// A team file search also says when the person's rooms mention the same words (server/src/chat/room-hint.ts; AI scenario
// FLOW-03: the answer was only in the client's group chat, and the AI searched files only). Through the real turn and
// the fake engine: the grep result gets one line for the main AI in the person's own chat; counted as the rooms tool
// searches (only rooms they are in, after they joined, no hidden answers); no room name or message text; each word once
// a turn; nothing for a sub-agent, a scheduled run, a Slack chat, a room's side chat, a regular expression, a stop word.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, uuidv7 } from '@mycel/shared/api'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { hintsHere, MAX_LOOKUPS, plainWords } from '../../server/src/chat/room-hint'
import { roomMatchCount } from '../../server/src/rooms/reader'
import type { TurnExec } from '../../server/src/chat/turn'

setDefaultTimeout(90_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const grep = (pattern: string) => ({ tool: 'grep', args: { pattern }, sayResult: true })
const LINE = 'chat rooms also mention'

let h: Harness, sock: TestSocket, mine: string
const db = () => h.ctx.db
/** a message straight into a room (an AI answer when `ai`, private to someone when `privateTo`) */
function put(roomId: string, author: string | null, body: string, o: { ai?: boolean; privateTo?: string } = {}) {
  const seq = (db().query('UPDATE rooms SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq').get(roomId) as { last_seq: number }).last_seq
  const id = uuidv7()
  db().query(`INSERT INTO room_messages (id, room_id, seq, author_kind, author_id, asked_by, visibility, visible_to, body, mentions, created_at, thread_root_id, thread_root_seq)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, NULL, NULL)`).run(id, roomId, seq, o.ai ? 'ai' : 'user', o.ai ? null : author, o.ai ? 'bob' : null, o.privateTo ? 'private' : 'room', o.privateTo ?? null, body, new Date().toISOString())
  return { id, seq }
}
beforeAll(async () => {
  h = await startHarness({ name: 'room-hint', stallTimeoutMs: 60_000 })
  sock = await h.ws('alice'); await sock.next('hello')
  const say = (user: string, roomId: string, body: string, threadRootId?: string) => h.api(user).call(API.sendRoomMessage, { params: { id: roomId }, body: { body, clientMessageId: 'cm-' + crypto.randomUUID(), mentions: [], ...(threadRootId ? { threadRootId } : {}) } })
  // alice's group chat about a client: the answer is a thread reply
  mine = (await h.api('alice').call(API.createRoom, { body: { kind: 'group', userIds: ['bob', 'erin'], name: '라마바카페 건' } })).id
  const root = await say('alice', mine, '라마바카페에서 단가 26,500원 요청했어요.')
  await say('bob', mine, '토요일은 퀵으로만 가능해요.', root.id)
  // a group chat alice is not in
  const other = (await h.api('bob').call(API.createRoom, { body: { kind: 'group', userIds: ['erin', 'carol'], name: 'not alice' } })).id
  await say('bob', other, '보라색프로젝트 일정은 비밀이에요.')
})
afterAll(async () => { sock?.close(); await h?.close() })

const newChat = async () => (await h.api('alice').call(API.createChat, { body: {} })).id
const turn = async (content: string, chat?: string) => (await ask(h, sock, 'alice', chat ?? await newChat(), content, { ms: 30_000 })).done.content

describe('a grep of team files and the person\'s rooms', () => {
  test('words a room of theirs mentions: one line, counted, no room name or text, once a turn', async () => {
    const a = await turn(fake(grep('토요일|Saturday'), grep('토요일')))
    expect(a).toContain('The user\'s chat rooms also mention "토요일" (1 message in 1 room). When you are looking for an answer the files do not hold, search them with rooms (query) and read the threads before saying nothing answers it.')
    expect(a).not.toContain('라마바카페 건')
    expect(a).not.toContain('퀵으로만')
    expect(a.split(LINE).length).toBe(2)
  })

  test('only rooms the person is in; nothing for regular expressions, short or stop words, or no match', async () => {
    expect(await turn(fake(grep('보라색프로젝트')))).not.toContain(LINE)
    expect(await turn(fake(grep('토요일.*퀵')))).not.toContain(LINE)
    expect(await turn(fake(grep('없는단어xyz')))).not.toContain(LINE)
    expect(await turn(fake(grep('파일|report')))).not.toContain(LINE)
  })

  test('a sub-agent\'s grep gets no line and does not use up the word for the main AI', async () => {
    const a = await turn(fake({ agents: [{ id: 'toolu_RH1', type: 'general-purpose', description: 'Look', steps: [{ tool: 'grep', args: { pattern: '토요일' }, sayChildResult: true }] }] }, grep('토요일')))
    // the child's result is said first (sayChildResult), then the main AI's: the line only once, in the main one
    expect(a.split(LINE).length).toBe(2)
    expect(a.lastIndexOf(LINE)).toBeGreaterThan(a.indexOf('No matches'))
  })

  test('no line in a room\'s side chat, a Slack chat or a scheduled run', async () => {
    const side = await newChat()
    db().query('UPDATE chats SET side_room_id = ? WHERE id = ?').run(mine, side)
    expect(await turn(fake(grep('토요일')), side)).not.toContain(LINE)
    const slack = await newChat()
    db().query("INSERT INTO slack_threads (team_id, channel_id, thread_ts, user_id, chat_id, created_at) VALUES ('T', 'C', ?, 'alice', ?, ?)").run(String(Date.now()), slack, new Date().toISOString())
    expect(await turn(fake(grep('토요일')), slack)).not.toContain(LINE)
    const s = h.rt().schedules.create('alice', { title: 'hint', prompt: fake(grep('토요일')), repeat: 'daily', time: '09:00' }, undefined, { allowedUrls: [], writeConnections: [] })
    const r = h.rt().schedules.runNow('alice', s.id)
    await waitFor(() => ['done', 'error', 'stopped'].includes((db().query('SELECT status FROM turns WHERE chat_id = ?').get(r.chatId) as { status: string } | null)?.status ?? ''), { timeoutMs: 60_000 })
    const answer = (db().query("SELECT content FROM messages WHERE chat_id = ? AND role = 'assistant'").get(r.chatId) as { content: string }).content
    expect(answer).toContain('No matches')
    expect(answer).not.toContain(LINE)
  })

  test('not offered (shared, guest, template, draft chats have no rooms tool): no line', () => {
    expect(hintsHere({ spec: { clientKind: 'web', chatId: 'x' }, fromSlack: false, rt: { db: db() } } as unknown as TurnExec, false)).toBe(false)
  })
})

describe('counted as the rooms tool searches', () => {
  test('messages from before the person joined, private answers and hidden answers are not counted', () => {
    const room = mine
    expect(roomMatchCount(db(), 'alice', '토요일')).toEqual({ messages: 1, rooms: 1, more: false })
    put(room, null, '숨긴답변단어 AI answer', { ai: true })
    const hidden = put(room, null, '숨긴답변단어 again', { ai: true })
    put(room, null, '숨긴답변단어 private', { ai: true, privateTo: 'bob' })
    expect(roomMatchCount(db(), 'alice', '숨긴답변단어').messages).toBe(2)
    db().query('INSERT INTO room_hidden_answers (room_id, user_id, message_id, see_seq) VALUES (?, ?, ?, ?)').run(room, 'alice', hidden.id, hidden.seq)
    expect(roomMatchCount(db(), 'alice', '숨긴답변단어').messages).toBe(1)
    // joined after it was said: alice sees from a later position
    put(room, 'bob', '합류전단어 before alice')
    const at = (db().query('SELECT last_seq FROM rooms WHERE id = ?').get(room) as { last_seq: number }).last_seq
    const before = db().query('SELECT visible_from_seq, history_from_seq FROM room_members WHERE room_id = ? AND user_id = ?').get(room, 'alice') as { visible_from_seq: number; history_from_seq: number | null }
    db().query('UPDATE room_members SET visible_from_seq = ?, history_from_seq = NULL WHERE room_id = ? AND user_id = ?').run(at, room, 'alice')
    try { expect(roomMatchCount(db(), 'alice', '합류전단어').messages).toBe(0) } finally {
      db().query('UPDATE room_members SET visible_from_seq = ?, history_from_seq = ? WHERE room_id = ? AND user_id = ?').run(before.visible_from_seq, before.history_from_seq, room, 'alice')
    }
    expect(roomMatchCount(db(), 'alice', '합류전단어').messages).toBe(1)
  })

  test('at most 20 counted, then "or more"', () => {
    for (let i = 0; i < 22; i++) put(mine, 'bob', `많은단어 ${i}`)
    expect(roomMatchCount(db(), 'alice', '많은단어')).toEqual({ messages: 20, rooms: 1, more: true })
  })
})

describe('plain words', () => {
  test('"a|b" of letters, digits, spaces and . _ - with an optional (?i), split at spaces; 3+ characters, no stop words; at most four', () => {
    expect(plainWords('라마바|Lamaba')).toEqual(['라마바', 'Lamaba'])
    expect(plainWords('(?i)brand guide')).toEqual(['brand', 'guide'])
    expect(plainWords('v1.2 spec')).toEqual(['v1.2', 'spec'])
    expect(plainWords('ab|cd')).toEqual([])
    expect(plainWords('the report|파일')).toEqual([])
    for (const p of ['토요일.*퀵', '[ab]c', 'x+', '\\bword', '(a|b)', '']) expect(plainWords(p), p).toEqual([])
    expect(plainWords('aaa|bbb|ccc|ddd|eee')).toHaveLength(4)
    expect(plainWords(42)).toEqual([])
    expect(MAX_LOOKUPS).toBe(8)
  })
})
